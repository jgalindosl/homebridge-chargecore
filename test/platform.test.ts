import * as hap from '@homebridge/hap-nodejs';
import type { MatterAccessory } from 'homebridge';
import { afterEach, describe, expect, it } from 'vitest';
import { ChargeCorePlatform } from '../src/platform.js';
import { DEVICE_NAME, PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import type { ChargeCoreConfig, ChargerTelemetry } from '../src/types.js';
import {
  asApi,
  createApi,
  createLogger,
  createMatterApi,
  FakePlatformAccessory,
  flush,
  type FakeMatterApi,
} from './helpers.js';

const config: ChargeCoreConfig = { platform: 'ChargeCore', host: '127.0.0.1', port: 0 };

const LEGACY_EVE_POWER_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

function telemetry(overrides: Partial<ChargerTelemetry> = {}): ChargerTelemetry {
  return {
    chargerId: 'garage',
    name: DEVICE_NAME,
    state: 'charging',
    enabled: true,
    powerW: 7_400,
    energyKWh: 3.5,
    fault: false,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('ChargeCorePlatform', () => {
  let api: ReturnType<typeof createApi> | undefined;

  afterEach(async () => {
    api?.emit('shutdown');
    await flush();
    api = undefined;
  });

  async function launch(matter?: FakeMatterApi, setup?: (platform: ChargeCorePlatform) => void) {
    api = createApi(matter);
    const platform = new ChargeCorePlatform(createLogger(), config, asApi(api));
    setup?.(platform);
    api.emit('didFinishLaunching');
    await flush();
    const emitTelemetry = (value: ChargerTelemetry) => (platform as any).server.emit('telemetry', value);
    return { api, platform, emitTelemetry };
  }

  it('registers a HAP accessory and a Matter outlet for a newly discovered charger', async () => {
    const matter = createMatterApi();
    const { api, emitTelemetry } = await launch(matter);

    emitTelemetry(telemetry());
    await flush();

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [
      expect.objectContaining({ UUID: matter.uuid.generate('garage:matter'), displayName: DEVICE_NAME }),
    ]);
    const uuid = matter.uuid.generate('garage:matter');
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'electricalPowerMeasurement', {
      activePower: 7_400_000,
    });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'electricalEnergyMeasurement', {
      cumulativeEnergyImported: { energy: 3_500_000 },
    });

    emitTelemetry(telemetry({ powerW: 3_700 }));
    await flush();
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'electricalPowerMeasurement', {
      activePower: 3_700_000,
    });
  });

  it('re-registers cached Matter outlets with handlers at launch', async () => {
    const matter = createMatterApi();
    const cached = {
      UUID: matter.uuid.generate('garage:matter'),
      displayName: DEVICE_NAME,
      context: { chargerId: 'garage' },
    } as unknown as MatterAccessory;
    const orphan = { UUID: 'orphan', displayName: 'Orphan', context: {} } as unknown as MatterAccessory;

    await launch(matter, platform => {
      platform.configureMatterAccessory(cached);
      platform.configureMatterAccessory(orphan);
    });

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [orphan]);
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    const [registered] = matter.registerPlatformAccessories.mock.calls[0]![2];
    expect(registered).toMatchObject({ UUID: cached.UUID, context: { chargerId: 'garage' } });
    expect(registered?.handlers?.onOff?.on).toBeTypeOf('function');
  });

  it('adds a Matter outlet for chargers that only have a cached HAP accessory', async () => {
    const matter = createMatterApi();
    await launch(matter, platform => {
      const accessory = new FakePlatformAccessory(DEVICE_NAME, hap.uuid.generate(`${PLUGIN_NAME}:garage`));
      accessory.context.chargerId = 'garage';
      platform.configureAccessory(accessory as never);
    });

    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [
      expect.objectContaining({ UUID: matter.uuid.generate('garage:matter') }),
    ]);
  });

  it('keeps the HAP accessory working when Matter is not enabled', async () => {
    const { api, emitTelemetry } = await launch(undefined);

    emitTelemetry(telemetry());
    await flush();

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('removes legacy Eve/Home+ characteristics from cached HAP outlets', async () => {
    let accessory!: FakePlatformAccessory;
    await launch(createMatterApi(), platform => {
      accessory = new FakePlatformAccessory(DEVICE_NAME, hap.uuid.generate(`${PLUGIN_NAME}:garage`));
      accessory.context.chargerId = 'garage';
      const outlet = accessory.addService(hap.Service.Outlet, DEVICE_NAME);
      outlet.addCharacteristic(new hap.Characteristic('Current Consumption', LEGACY_EVE_POWER_UUID, {
        format: hap.Formats.FLOAT,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
      }));
      platform.configureAccessory(accessory as never);
    });

    const outlet = accessory.getService(hap.Service.Outlet)!;
    expect(outlet.characteristics.map(characteristic => characteristic.UUID)).not.toContain(LEGACY_EVE_POWER_UUID);
    expect(outlet.getCharacteristic(hap.Characteristic.On)).toBeDefined();
  });
});
