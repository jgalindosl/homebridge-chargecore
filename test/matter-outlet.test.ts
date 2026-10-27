import { deviceTypes } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import {
  ChargerMatterOutlet,
  ENERGY_REPORT_INTERVAL_MS,
  toMatterEnergy,
  toMatterPowerMeasurement,
} from '../src/matter-outlet.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import type { ChargerTelemetry } from '../src/types.js';
import { asMatterApi, createLogger, createMatterApi, flush } from './helpers.js';

function telemetry(overrides: Partial<ChargerTelemetry> = {}): ChargerTelemetry {
  return { chargerId: 'garage', state: 'charging', fault: false, receivedAt: 1_000_000, ...overrides };
}

function createOutlet(setCharging = vi.fn(async () => {})) {
  const matter = createMatterApi();
  const log = createLogger();
  const outlet = new ChargerMatterOutlet(asMatterApi(matter), log, 'garage', 'chargecore', setCharging);
  return { matter, log, outlet, setCharging };
}

function stateUpdates(matter: ReturnType<typeof createMatterApi>, cluster: string) {
  return matter.updateAccessoryState.mock.calls
    .filter(([, name]) => name === cluster)
    .map(([, , attributes]) => attributes);
}

describe('Matter unit conversion', () => {
  it('converts OCPP W, V and A to Matter mW, mV and mA', () => {
    expect(toMatterPowerMeasurement(telemetry({ powerW: 7_400, voltageV: 230.4, currentA: 32.15 }))).toEqual({
      activePower: 7_400_000,
      voltage: 230_400,
      activeCurrent: 32_150,
    });
  });

  it('only includes measurements the charger reported', () => {
    expect(toMatterPowerMeasurement(telemetry({ powerW: 0 }))).toEqual({ activePower: 0 });
    expect(toMatterPowerMeasurement(telemetry())).toEqual({});
  });

  it('converts kWh to mWh', () => {
    expect(toMatterEnergy(12.345)).toBe(12_345_000);
    expect(toMatterEnergy(0.0004)).toBe(400);
  });
});

describe('ChargerMatterOutlet', () => {
  it('registers an on/off outlet that declares power and imported energy measurement', async () => {
    const { matter, outlet } = createOutlet();
    await outlet.register();

    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [outlet.accessory]);
    expect(outlet.accessory).toMatchObject({
      UUID: matter.uuid.generate('garage:matter'),
      displayName: 'chargecore',
      deviceType: deviceTypes.OnOffOutlet,
      serialNumber: 'garage',
      manufacturer: 'ChargeCore',
      context: { chargerId: 'garage' },
      clusters: {
        onOff: { onOff: false },
        electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
        electricalEnergyMeasurement: { cumulativeEnergyImported: null },
      },
    });
  });

  it('forwards Matter on/off commands to the charger', async () => {
    const { outlet, setCharging } = createOutlet();
    const handlers = outlet.accessory.handlers?.onOff;

    await handlers?.on?.(undefined as never, undefined as never);
    await handlers?.off?.(undefined as never, undefined as never);

    expect(setCharging.mock.calls).toEqual([['garage', true], ['garage', false]]);
  });

  it('maps telemetry into the onOff, power and energy clusters', async () => {
    const { matter, outlet } = createOutlet();
    await outlet.register();

    outlet.update(telemetry({ charging: true, powerW: 7_360, voltageV: 230, currentA: 32, energyKWh: 4.2 }));
    await flush();

    const uuid = outlet.accessory.UUID;
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'onOff', { onOff: true });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'electricalPowerMeasurement', {
      activePower: 7_360_000,
      voltage: 230_000,
      activeCurrent: 32_000,
    });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(uuid, 'electricalEnergyMeasurement', {
      cumulativeEnergyImported: { energy: 4_200_000 },
    });
  });

  it('queues telemetry received before registration completes', async () => {
    const { matter, outlet } = createOutlet();
    let finishRegistration!: () => void;
    matter.registerPlatformAccessories.mockImplementationOnce(
      () => new Promise<void>(resolve => { finishRegistration = resolve; }),
    );

    void outlet.register();
    outlet.update(telemetry({ powerW: 1_000 }));
    await flush();
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();

    finishRegistration();
    await flush();
    expect(stateUpdates(matter, 'electricalPowerMeasurement')).toEqual([{ activePower: 1_000_000 }]);
  });

  it('drops updates and warns when registration fails', async () => {
    const { matter, log, outlet } = createOutlet();
    matter.registerPlatformAccessories.mockRejectedValueOnce(new Error('Matter is not enabled'));

    await outlet.register();
    outlet.update(telemetry({ powerW: 1_000 }));
    await flush();

    expect(matter.updateAccessoryState).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Matter registration failed for charger garage: Matter is not enabled');
  });

  it('reports cumulative energy at most once per interval and only when it changes', async () => {
    const { matter, outlet } = createOutlet();
    await outlet.register();
    const start = 1_000_000;

    outlet.update(telemetry({ energyKWh: 1, receivedAt: start }));
    outlet.update(telemetry({ energyKWh: 1.1, receivedAt: start + 10_000 }));
    outlet.update(telemetry({ energyKWh: 1.2, receivedAt: start + ENERGY_REPORT_INTERVAL_MS }));
    outlet.update(telemetry({ energyKWh: 1.2, receivedAt: start + 3 * ENERGY_REPORT_INTERVAL_MS }));
    await flush();

    expect(stateUpdates(matter, 'electricalEnergyMeasurement')).toEqual([
      { cumulativeEnergyImported: { energy: 1_000_000 } },
      { cumulativeEnergyImported: { energy: 1_200_000 } },
    ]);
  });

  it('marks the outlet unreachable and clears live readings when telemetry goes stale', async () => {
    const { matter, outlet } = createOutlet();
    await outlet.register();

    outlet.update(telemetry({ powerW: 7_000, receivedAt: 1_000 }));
    outlet.markOfflineIfStale(50_000, 90_000);
    await flush();
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: true }]);

    outlet.markOfflineIfStale(100_000, 90_000);
    await flush();
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: true }, { reachable: false }]);
    expect(stateUpdates(matter, 'electricalPowerMeasurement').at(-1)).toEqual({
      activePower: null,
      voltage: null,
      activeCurrent: null,
    });
  });

  it('starts a previously seen cached outlet as unreachable', async () => {
    const matter = createMatterApi();
    const cached = { context: { chargerId: 'garage', lastSeen: 123 } } as never;
    const outlet = new ChargerMatterOutlet(asMatterApi(matter), createLogger(), 'garage', 'chargecore', vi.fn(), cached);

    await outlet.register();
    await flush();

    expect(outlet.accessory.context.lastSeen).toBe(123);
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: false }]);
  });

  it('pushes renames through updatePlatformAccessories', async () => {
    const { matter, outlet } = createOutlet();
    await outlet.register();

    outlet.rename('Garage Charger');
    await flush();

    expect(matter.updatePlatformAccessories).toHaveBeenCalledWith([
      expect.objectContaining({ displayName: 'Garage Charger' }),
    ]);
  });
});
