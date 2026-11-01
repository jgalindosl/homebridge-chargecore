import type {
  ClusterStateMap,
  Logger,
  MatterAPI,
  MatterAccessory,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { ChargerContext, ChargerState, ChargerTelemetry } from './types.js';

type SetCharging = (chargerId: string, charging: boolean) => Promise<void>;
type PowerMeasurement = Partial<ClusterStateMap['electricalPowerMeasurement']>;
type EvseState = Partial<ClusterStateMap['energyEvse']>;

// Energy totals are delivered to controllers as unthrottled Matter events, so
// they are reported at a measured cadence rather than on every meter sample.
export const ENERGY_REPORT_INTERVAL_MS = 30_000;

// Parts the Matter EVSE device type requires next to the charger endpoint.
export const POWER_SOURCE_PART = 'power-source';
export const METER_PART = 'meter';
export const ENERGY_MANAGEMENT_PART = 'energy-management';

// Matter requires at least two EnergyEvseModes. Both charge on demand once
// enabled (the Manual tag, 0x4000, which Homebridge does not export); the
// second also starts a session when a vehicle is plugged in. Which one applies
// is the autoStartOnConnect setting.
export const MANUAL_MODE = 0;
export const AUTO_START_MODE = 1;
const MANUAL_MODE_TAG = 0x4000;

/** Matter UUID for a charger. Distinct from the earlier on/off outlet, which is removed on launch. */
export function matterChargerUuid(matter: MatterAPI, chargerId: string): string {
  return matter.uuid.generate(`${chargerId}:evse`);
}

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

/** Maps charger telemetry to the EnergyEvse state, supply state and fault state attributes. */
export function toMatterEvseState(matter: MatterAPI, telemetry: ChargerTelemetry): EvseState {
  const { State, SupplyState, FaultState } = matter.types.EnergyEvse;
  const states: Record<ChargerState, number> = {
    available: State.NotPluggedIn,
    offline: State.NotPluggedIn,
    unknown: State.NotPluggedIn,
    // OCPP does not say whether a plugged-in vehicle is asking for power
    connected: State.PluggedInNoDemand,
    paused: State.PluggedInNoDemand,
    charging: State.PluggedInCharging,
    finishing: State.SessionEnding,
    faulted: State.Fault,
  };
  const evse: EvseState = {
    state: states[telemetry.state],
    faultState: telemetry.fault ? FaultState.Other : FaultState.NoError,
  };
  if (telemetry.fault) evse.supplyState = SupplyState.DisabledError;
  else if (telemetry.charging !== undefined) {
    evse.supplyState = telemetry.charging ? SupplyState.ChargingEnabled : SupplyState.Disabled;
  }
  return evse;
}

export class ChargerMatterEvse {
  readonly accessory: MatterAccessory<ChargerContext>;
  private lastSeen = 0;
  private online = false;
  private charging?: boolean;
  private readonly currentMode: number;
  private reportedEnergy?: number;
  private energyReportedAt = 0;
  private registration: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly matter: MatterAPI,
    private readonly log: Logger,
    chargerId: string,
    displayName: string,
    setCharging: SetCharging,
    autoStart: boolean,
    cached?: MatterAccessory,
  ) {
    const context = cached?.context as Partial<ChargerContext> | undefined;
    this.lastSeen = context?.lastSeen ?? 0;
    const { EnergyEvse, DeviceEnergyManagement } = matter.types;
    this.currentMode = autoStart ? AUTO_START_MODE : MANUAL_MODE;

    // Controllers resend EnableCharging to change the current limit, so only a
    // change of charging state becomes an OCPP command.
    const handleCharging = async (charging: boolean): Promise<void> => {
      if (this.charging === charging) return;
      this.log.info(`${charging ? 'Starting' : 'Stopping'} charging on charger ${chargerId} (Matter)`);
      await setCharging(chargerId, charging);
    };

    this.accessory = {
      UUID: matterChargerUuid(matter, chargerId),
      displayName,
      deviceType: matter.deviceTypes.EnergyEvse,
      serialNumber: chargerId,
      manufacturer: 'ChargeCore',
      model: 'WebSocket EV Wall Charger',
      firmwareRevision: '1.0',
      context: { chargerId, ...(this.lastSeen ? { lastSeen: this.lastSeen } : {}) },
      clusters: {
        energyEvse: {
          state: EnergyEvse.State.NotPluggedIn,
          supplyState: EnergyEvse.SupplyState.Disabled,
          faultState: EnergyEvse.FaultState.NoError,
        },
        energyEvseMode: {
          supportedModes: [
            { label: 'Manual', mode: MANUAL_MODE, modeTags: [{ value: MANUAL_MODE_TAG }] },
            { label: 'Start on Plug-in', mode: AUTO_START_MODE, modeTags: [{ value: MANUAL_MODE_TAG }] },
          ],
          currentMode: this.currentMode,
        },
      },
      parts: [
        {
          id: POWER_SOURCE_PART,
          displayName: `${displayName} Power`,
          deviceType: matter.deviceTypes.PowerSource,
          // No battery attributes, so Homebridge composes a wired AC source
          clusters: { powerSource: { status: 1, order: 0, description: 'AC Power', wiredCurrentType: 0 } },
        },
        {
          id: METER_PART,
          displayName: `${displayName} Meter`,
          deviceType: matter.deviceTypes.ElectricalSensor,
          // null means "no measurement available"; declaring the attributes is
          // what makes Homebridge compose the AC power and imported cumulative
          // energy features onto the meter endpoint.
          clusters: {
            electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
            electricalEnergyMeasurement: { cumulativeEnergyImported: null },
          },
        },
        {
          id: ENERGY_MANAGEMENT_PART,
          displayName: `${displayName} Energy Management`,
          deviceType: matter.deviceTypes.DeviceEnergyManagement,
          // An EVSE must report a power forecast; declaring one (none yet) turns
          // the feature on.
          clusters: {
            deviceEnergyManagement: {
              esaType: DeviceEnergyManagement.EsaType.Evse,
              esaCanGenerate: false,
              esaState: DeviceEnergyManagement.EsaState.Online,
              forecast: null,
            },
          },
        },
      ],
      handlers: {
        energyEvse: {
          enableCharging: () => handleCharging(true),
          disable: () => handleCharging(false),
        },
        energyEvseMode: {
          changeToMode: async request => {
            if (request?.newMode === this.currentMode) return;
            throw new matter.status.InvalidInState('Set autoStartOnConnect in the ChargeCore config to change modes');
          },
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
    // A cached accessory keeps its cached state, so the mode is set explicitly
    // in case autoStartOnConnect changed since.
    this.setState('energyEvseMode', { currentMode: this.currentMode });
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

    if (telemetry.charging !== undefined) this.charging = telemetry.charging;
    this.setState('energyEvse', toMatterEvseState(this.matter, telemetry));

    const power = toMatterPowerMeasurement(telemetry);
    if (Object.keys(power).length > 0) this.setState('electricalPowerMeasurement', power, METER_PART);

    if (telemetry.energyKWh !== undefined) {
      const energy = toMatterEnergy(telemetry.energyKWh);
      const due = telemetry.receivedAt - this.energyReportedAt >= ENERGY_REPORT_INTERVAL_MS;
      if (energy !== this.reportedEnergy && (this.reportedEnergy === undefined || due)) {
        this.reportedEnergy = energy;
        this.energyReportedAt = telemetry.receivedAt;
        this.setState('electricalEnergyMeasurement', { cumulativeEnergyImported: { energy } }, METER_PART);
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
    this.setState(
      'electricalPowerMeasurement',
      { activePower: null, voltage: null, activeCurrent: null },
      METER_PART,
    );
  }

  private setState(cluster: string, attributes: Record<string, unknown>, partId?: string): void {
    this.whenRegistered(
      `update ${cluster}`,
      () => this.matter.updateAccessoryState(this.accessory.UUID, cluster, attributes, partId),
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
