import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  MatterAPI,
  MatterAccessory,
  PlatformAccessory,
} from 'homebridge';
import { ChargerAccessory } from './charger-accessory.js';
import { ChargerMatterOutlet } from './matter-outlet.js';
import { ChargeCoreWssServer } from './wss-server.js';
import { DEVICE_NAME, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { ChargeCoreConfig, ChargerContext, ChargerTelemetry } from './types.js';

export class ChargeCorePlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories = new Map<string, PlatformAccessory<ChargerContext>>();
  private readonly handlers = new Map<string, ChargerAccessory>();
  private readonly cachedMatterAccessories = new Map<string, MatterAccessory>();
  private readonly invalidMatterAccessories: MatterAccessory[] = [];
  private readonly matterOutlets = new Map<string, ChargerMatterOutlet>();
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

  configureMatterAccessory(accessory: MatterAccessory): void {
    const chargerId = (accessory.context as Partial<ChargerContext>).chargerId;
    if (chargerId) this.cachedMatterAccessories.set(chargerId, accessory);
    else this.invalidMatterAccessories.push(accessory);
  }

  private async start(): Promise<void> {
    for (const [chargerId, accessory] of this.cachedAccessories) {
      const handler = this.createHandler(accessory);
      this.handlers.set(chargerId, handler);
      if (accessory.displayName !== DEVICE_NAME) {
        handler.rename(DEVICE_NAME);
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`Renamed HomeKit accessory for charger ${chargerId} to ${DEVICE_NAME}`);
      }
    }
    await this.startMatter();

    try {
      await this.server.start();
      const checkEveryMs = Math.min((this.config.offlineAfterSeconds ?? 90) * 500, 30_000);
      this.staleTimer = setInterval(() => this.markStaleChargers(), Math.max(checkEveryMs, 1_000));
      this.staleTimer.unref();
    } catch (error) {
      this.log.error(`Unable to start ChargeCore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private get matter(): MatterAPI | undefined {
    return this.api.isMatterEnabled?.() ? this.api.matter : undefined;
  }

  private async startMatter(): Promise<void> {
    const matter = this.matter;
    if (!matter) {
      if (this.cachedMatterAccessories.size > 0) {
        this.log.warn('Matter is not enabled for this bridge; ChargeCore Matter outlets will not be updated.');
      }
      return;
    }

    if (this.invalidMatterAccessories.length > 0) {
      this.log.warn(`Removing ${this.invalidMatterAccessories.length} cached Matter accessories without a charger id`);
      try {
        await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.invalidMatterAccessories);
      } catch (error) {
        this.log.warn(`Unable to remove Matter accessories: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const chargerIds = new Set([...this.cachedAccessories.keys(), ...this.cachedMatterAccessories.keys()]);
    await Promise.all([...chargerIds].map(chargerId => {
      const displayName = this.cachedAccessories.get(chargerId)?.displayName
        ?? this.cachedMatterAccessories.get(chargerId)?.displayName
        ?? DEVICE_NAME;
      return this.addMatterOutlet(matter, chargerId, displayName);
    }));
  }

  private addMatterOutlet(matter: MatterAPI, chargerId: string, displayName: string): Promise<void> {
    const outlet = new ChargerMatterOutlet(
      matter,
      this.log,
      chargerId,
      displayName,
      (id, charging) => this.server.setCharging(id, charging),
      this.cachedMatterAccessories.get(chargerId),
    );
    this.matterOutlets.set(chargerId, outlet);
    return outlet.register();
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

    const matter = this.matter;
    if (!matter) return;
    const outlet = this.matterOutlets.get(telemetry.chargerId);
    if (!outlet) {
      void this.addMatterOutlet(matter, telemetry.chargerId, displayName);
      this.log.info(`Added Matter outlet for charger ${telemetry.chargerId}`);
    } else if (outlet.accessory.displayName !== displayName) {
      outlet.rename(displayName);
    }
    this.matterOutlets.get(telemetry.chargerId)?.update(telemetry);
  }

  private createHandler(accessory: PlatformAccessory<ChargerContext>): ChargerAccessory {
    return new ChargerAccessory(
      this.api,
      this.log,
      accessory,
      (chargerId, charging) => this.server.setCharging(chargerId, charging),
      this.config.exposeVehicleSensor ?? true,
    );
  }

  private markStaleChargers(): void {
    const offlineAfterMs = (this.config.offlineAfterSeconds ?? 90) * 1_000;
    const now = Date.now();
    for (const handler of this.handlers.values()) handler.markOfflineIfStale(now, offlineAfterMs);
    for (const outlet of this.matterOutlets.values()) outlet.markOfflineIfStale(now, offlineAfterMs);
  }
}
