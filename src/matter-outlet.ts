import type {
  ClusterStateMap,
  Logger,
  MatterAPI,
  MatterAccessory,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { ChargerContext, ChargerTelemetry } from './types.js';

type SetEnabled = (chargerId: string, enabled: boolean) => Promise<void>;
type PowerMeasurement = Partial<ClusterStateMap['electricalPowerMeasurement']>;

// Energy totals are delivered to controllers as unthrottled Matter events, so
// they are reported at a measured cadence rather than on every meter sample.
export const ENERGY_REPORT_INTERVAL_MS = 30_000;

/** Converts OCPP telemetry (W, V, A) to Matter ElectricalPowerMeasurement units (mW, mV, mA). */
export function toMatterPowerMeasurement(telemetry: ChargerTelemetry): PowerMeasurement {
  const measurement: PowerMeasurement = {};
  if (telemetry.powerW !== undefined) measurement.activePower = Math.round(telemetry.powerW * 1_000);
  if (telemetry.voltageV !== undefined) measurement.voltage = Math.round(telemetry.voltageV * 1_000);
  if (telemetry.currentA !== undefined) measurement.activeCurrent = Math.round(telemetry.currentA * 1_000);
  return measurement;
}

/** Converts kWh to the milliwatt-hours used by Matter ElectricalEnergyMeasurement. */
export function toMatterEnergy(energyKWh: number): number {
  return Math.round(energyKWh * 1_000_000);
}

export class ChargerMatterOutlet {
  readonly accessory: MatterAccessory<ChargerContext>;
  private lastSeen = 0;
  private online = false;
  private reportedEnergy?: number;
  private energyReportedAt = 0;
  private registration: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly matter: MatterAPI,
    private readonly log: Logger,
    chargerId: string,
    displayName: string,
    setEnabled: SetEnabled,
    cached?: MatterAccessory,
  ) {
    const context = cached?.context as Partial<ChargerContext> | undefined;
    this.lastSeen = context?.lastSeen ?? 0;

    const handleOnOff = async (enabled: boolean): Promise<void> => {
      this.log.info(`${enabled ? 'Enabling' : 'Disabling'} charger ${chargerId} (Matter)`);
      await setEnabled(chargerId, enabled);
    };

    this.accessory = {
      UUID: matter.uuid.generate(`${chargerId}:matter`),
      displayName,
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: chargerId,
      manufacturer: 'ChargeCore',
      model: 'WebSocket EV Wall Charger',
      firmwareRevision: '1.0',
      context: { chargerId, ...(this.lastSeen ? { lastSeen: this.lastSeen } : {}) },
      clusters: {
        onOff: { onOff: false },
        // null means "no measurement available"; declaring the attributes is
        // what makes Homebridge compose the AC power and imported cumulative
        // energy features onto the outlet endpoint.
        electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
        electricalEnergyMeasurement: { cumulativeEnergyImported: null },
      },
      handlers: {
        onOff: {
          on: () => handleOnOff(true),
          off: () => handleOnOff(false),
        },
      },
    };
  }

  /** Registers (or re-attaches to a cached) Matter accessory; state updates queue behind it. */
  register(): Promise<void> {
    this.registration = this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory])
      .then(() => true, error => {
        this.logError('registration', error);
        return false;
      });
    if (this.lastSeen > 0) this.markOffline();
    return this.registration.then(() => undefined);
  }

  get chargerId(): string {
    return this.accessory.context.chargerId;
  }

  update(telemetry: ChargerTelemetry): void {
    this.accessory.context.lastSeen = telemetry.receivedAt;
    this.lastSeen = telemetry.receivedAt;
    if (!this.online) {
      this.online = true;
      this.setState('bridgedDeviceBasicInformation', { reachable: true });
    }

    if (telemetry.enabled !== undefined) this.setState('onOff', { onOff: telemetry.enabled });

    const power = toMatterPowerMeasurement(telemetry);
    if (Object.keys(power).length > 0) this.setState('electricalPowerMeasurement', power);

    if (telemetry.energyKWh !== undefined) {
      const energy = toMatterEnergy(telemetry.energyKWh);
      const due = telemetry.receivedAt - this.energyReportedAt >= ENERGY_REPORT_INTERVAL_MS;
      if (energy !== this.reportedEnergy && (this.reportedEnergy === undefined || due)) {
        this.reportedEnergy = energy;
        this.energyReportedAt = telemetry.receivedAt;
        this.setState('electricalEnergyMeasurement', { cumulativeEnergyImported: { energy } });
      }
    }
  }

  rename(displayName: string): void {
    this.accessory.displayName = displayName;
    this.whenRegistered('rename', () => this.matter.updatePlatformAccessories([this.accessory]));
  }

  markOfflineIfStale(now: number, offlineAfterMs: number): void {
    if (this.online && now - this.lastSeen > offlineAfterMs) this.markOffline();
  }

  markOffline(): void {
    this.online = false;
    this.setState('bridgedDeviceBasicInformation', { reachable: false });
    this.setState('electricalPowerMeasurement', { activePower: null, voltage: null, activeCurrent: null });
  }

  private setState(cluster: string, attributes: Record<string, unknown>): void {
    this.whenRegistered(
      `update ${cluster}`,
      () => this.matter.updateAccessoryState(this.accessory.UUID, cluster, attributes),
    );
  }

  private whenRegistered(action: string, run: () => Promise<void>): void {
    this.registration
      .then(registered => registered ? run() : undefined)
      .catch(error => this.logError(action, error));
  }

  private logError(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(`Matter ${action} failed for charger ${this.chargerId}: ${message}`);
  }
}
