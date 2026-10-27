import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import { ChargerAccessory } from './charger-accessory.js';
import { ChargeCoreWssServer } from './wss-server.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { ChargeCoreConfig, ChargerContext, ChargerTelemetry } from './types.js';

export class ChargeCorePlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories = new Map<string, PlatformAccessory<ChargerContext>>();
  private readonly handlers = new Map<string, ChargerAccessory>();
  private readonly server: ChargeCoreWssServer;
  private staleTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly config: ChargeCoreConfig,
    private readonly api: API,
  ) {
    this.server = new ChargeCoreWssServer(config, log);

    this.server.on('telemetry', telemetry => this.handleTelemetry(telemetry));
    this.api.on('didFinishLaunching', () => void this.start());
    this.api.on('shutdown', () => void this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    const typedAccessory = accessory as PlatformAccessory<ChargerContext>;
    const chargerId = typedAccessory.context.chargerId;
    if (!chargerId) {
      this.log.warn(`Removing cached ChargeCore accessory without a charger id: ${accessory.displayName}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      return;
    }
    this.cachedAccessories.set(chargerId, typedAccessory);
  }

  private async start(): Promise<void> {
    for (const [chargerId, accessory] of this.cachedAccessories) {
      this.handlers.set(chargerId, this.createHandler(accessory));
    }

    try {
      await this.server.start();
      const checkEveryMs = Math.min((this.config.offlineAfterSeconds ?? 90) * 500, 30_000);
      this.staleTimer = setInterval(() => this.markStaleChargers(), Math.max(checkEveryMs, 1_000));
      this.staleTimer.unref();
    } catch (error) {
      this.log.error(`Unable to start ChargeCore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async shutdown(): Promise<void> {
    if (this.staleTimer) clearInterval(this.staleTimer);
    try {
      await this.server.stop();
    } catch (error) {
      this.log.warn(`Error while stopping ChargeCore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleTelemetry(telemetry: ChargerTelemetry): void {
    let accessory = this.cachedAccessories.get(telemetry.chargerId);
    const displayName = telemetry.name?.trim().slice(0, 64) || `EV Charger ${telemetry.chargerId}`;
    if (!accessory) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${telemetry.chargerId}`);
      accessory = new this.api.platformAccessory<ChargerContext>(displayName, uuid);
      accessory.context.chargerId = telemetry.chargerId;
      this.cachedAccessories.set(telemetry.chargerId, accessory);
      this.handlers.set(telemetry.chargerId, this.createHandler(accessory));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added HomeKit accessory for charger ${telemetry.chargerId}`);
    } else if (accessory.displayName !== displayName) {
      this.handlers.get(telemetry.chargerId)?.rename(displayName);
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(`Renamed HomeKit accessory for charger ${telemetry.chargerId} to ${displayName}`);
    }
    this.handlers.get(telemetry.chargerId)?.update(telemetry);
  }

  private createHandler(accessory: PlatformAccessory<ChargerContext>): ChargerAccessory {
    return new ChargerAccessory(
      this.api,
      this.log,
      accessory,
      (chargerId, enabled) => this.server.setEnabled(chargerId, enabled),
      this.config.exposeVehicleSensor ?? true,
    );
  }

  private markStaleChargers(): void {
    const offlineAfterMs = (this.config.offlineAfterSeconds ?? 90) * 1_000;
    const now = Date.now();
    for (const handler of this.handlers.values()) handler.markOfflineIfStale(now, offlineAfterMs);
  }
}
