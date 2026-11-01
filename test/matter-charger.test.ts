import { clusters, deviceTypes } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_START_MODE,
  ChargerMatterEvse,
  ENERGY_MANAGEMENT_PART,
  ENERGY_REPORT_INTERVAL_MS,
  MANUAL_MODE,
  METER_PART,
  POWER_SOURCE_PART,
  toMatterEnergy,
  toMatterEvseState,
  toMatterPowerMeasurement,
} from '../src/matter-charger.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import type { ChargerTelemetry } from '../src/types.js';
import { asMatterApi, createLogger, createMatterApi, flush } from './helpers.js';

const { State, SupplyState, FaultState } = clusters.EnergyEvse;

function telemetry(overrides: Partial<ChargerTelemetry> = {}): ChargerTelemetry {
  return { chargerId: 'garage', state: 'charging', fault: false, receivedAt: 1_000_000, ...overrides };
}

function createCharger(setCharging = vi.fn(async () => {}), autoStart = false) {
  const matter = createMatterApi();
  const log = createLogger();
  const charger = new ChargerMatterEvse(asMatterApi(matter), log, 'garage', 'chargecore', setCharging, autoStart);
  return { matter, log, charger, setCharging };
}

function stateUpdates(matter: ReturnType<typeof createMatterApi>, cluster: string, partId?: string) {
  return matter.updateAccessoryState.mock.calls
    .filter(([, name, , part]) => name === cluster && part === partId)
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

describe('Matter EVSE state', () => {
  const matter = asMatterApi(createMatterApi());

  it.each([
    ['available', State.NotPluggedIn],
    ['offline', State.NotPluggedIn],
    ['unknown', State.NotPluggedIn],
    ['connected', State.PluggedInNoDemand],
    ['paused', State.PluggedInNoDemand],
    ['charging', State.PluggedInCharging],
    ['finishing', State.SessionEnding],
  ] as const)('maps %s to EVSE state %i', (state, expected) => {
    expect(toMatterEvseState(matter, telemetry({ state })).state).toBe(expected);
  });

  it('enables supply while a charging session is active', () => {
    expect(toMatterEvseState(matter, telemetry({ charging: true }))).toEqual({
      state: State.PluggedInCharging,
      supplyState: SupplyState.ChargingEnabled,
      faultState: FaultState.NoError,
    });
    expect(toMatterEvseState(matter, telemetry({ state: 'connected', charging: false })).supplyState)
      .toBe(SupplyState.Disabled);
  });

  it('leaves supply state alone when the charging state is unknown', () => {
    expect(toMatterEvseState(matter, telemetry({ state: 'available' }))).not.toHaveProperty('supplyState');
  });

  it('reports faults', () => {
    expect(toMatterEvseState(matter, telemetry({ state: 'faulted', fault: true, charging: false }))).toEqual({
      state: State.Fault,
      supplyState: SupplyState.DisabledError,
      faultState: FaultState.Other,
    });
  });
});

describe('ChargerMatterEvse', () => {
  it('registers an EV charger with its power source, meter and energy management parts', async () => {
    const { matter, charger } = createCharger();
    await charger.register();

    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [charger.accessory]);
    expect(charger.accessory).toMatchObject({
      UUID: matter.uuid.generate('garage:evse'),
      displayName: 'chargecore',
      deviceType: deviceTypes.EnergyEvse,
      serialNumber: 'garage',
      manufacturer: 'ChargeCore',
      context: { chargerId: 'garage' },
      clusters: {
        energyEvse: {
          state: State.NotPluggedIn,
          supplyState: SupplyState.Disabled,
          faultState: FaultState.NoError,
        },
        energyEvseMode: {
          supportedModes: [
            { label: 'Manual', mode: MANUAL_MODE, modeTags: [{ value: 0x4000 }] },
            { label: 'Start on Plug-in', mode: AUTO_START_MODE, modeTags: [{ value: 0x4000 }] },
          ],
          currentMode: MANUAL_MODE,
        },
      },
    });
    expect(charger.accessory.parts).toMatchObject([
      {
        id: POWER_SOURCE_PART,
        deviceType: deviceTypes.PowerSource,
        clusters: { powerSource: { description: 'AC Power' } },
      },
      {
        id: METER_PART,
        deviceType: deviceTypes.ElectricalSensor,
        clusters: {
          electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
          electricalEnergyMeasurement: { cumulativeEnergyImported: null },
        },
      },
      {
        id: ENERGY_MANAGEMENT_PART,
        deviceType: deviceTypes.DeviceEnergyManagement,
        clusters: {
          deviceEnergyManagement: {
            esaType: clusters.DeviceEnergyManagement.EsaType.Evse,
            esaCanGenerate: false,
            forecast: null,
          },
        },
      },
    ]);
  });

  it('forwards Matter enable charging and disable commands to the charger', async () => {
    const { charger, setCharging } = createCharger();
    const handlers = charger.accessory.handlers?.energyEvse;

    await handlers?.enableCharging?.(undefined as never, undefined as never);
    await handlers?.disable?.(undefined as never, undefined as never);

    expect(setCharging.mock.calls).toEqual([['garage', true], ['garage', false]]);
  });

  it('does not restart a session that is already charging', async () => {
    const { charger, setCharging } = createCharger();
    await charger.register();
    charger.update(telemetry({ charging: true }));
    const handlers = charger.accessory.handlers?.energyEvse;

    await handlers?.enableCharging?.(undefined as never, undefined as never);
    expect(setCharging).not.toHaveBeenCalled();

    await handlers?.disable?.(undefined as never, undefined as never);
    expect(setCharging.mock.calls).toEqual([['garage', false]]);
  });

  it('reports the autoStartOnConnect setting as the charging mode', async () => {
    const { matter, charger } = createCharger(undefined, true);
    await charger.register();
    await flush();

    expect(charger.accessory.clusters.energyEvseMode).toMatchObject({ currentMode: AUTO_START_MODE });
    expect(stateUpdates(matter, 'energyEvseMode')).toEqual([{ currentMode: AUTO_START_MODE }]);
  });

  it('rejects changing the charging mode from a controller', async () => {
    const { charger } = createCharger();
    const changeToMode = charger.accessory.handlers?.energyEvseMode?.changeToMode;

    await expect(changeToMode?.({ newMode: MANUAL_MODE }, undefined as never)).resolves.toBeUndefined();
    await expect(changeToMode?.({ newMode: AUTO_START_MODE }, undefined as never))
      .rejects.toThrow('Set autoStartOnConnect in the ChargeCore config to change modes');
  });

  it('maps telemetry into the EVSE cluster and the meter part', async () => {
    const { matter, charger } = createCharger();
    await charger.register();

    charger.update(telemetry({ charging: true, powerW: 7_360, voltageV: 230, currentA: 32, energyKWh: 4.2 }));
    await flush();

    expect(stateUpdates(matter, 'energyEvse')).toEqual([{
      state: State.PluggedInCharging,
      supplyState: SupplyState.ChargingEnabled,
      faultState: FaultState.NoError,
    }]);
    expect(stateUpdates(matter, 'electricalPowerMeasurement', METER_PART)).toEqual([{
      activePower: 7_360_000,
      voltage: 230_000,
      activeCurrent: 32_000,
    }]);
    expect(stateUpdates(matter, 'electricalEnergyMeasurement', METER_PART)).toEqual([
      { cumulativeEnergyImported: { energy: 4_200_000 } },
    ]);
  });

  it('queues telemetry received before registration completes', async () => {
    const { matter, charger } = createCharger();
    let finishRegistration!: () => void;
    matter.registerPlatformAccessories.mockImplementationOnce(
      () => new Promise<void>(resolve => { finishRegistration = resolve; }),
    );

    void charger.register();
    charger.update(telemetry({ powerW: 1_000 }));
    await flush();
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();

    finishRegistration();
    await flush();
    expect(stateUpdates(matter, 'electricalPowerMeasurement', METER_PART)).toEqual([{ activePower: 1_000_000 }]);
  });

  it('drops updates and warns when registration fails', async () => {
    const { matter, log, charger } = createCharger();
    matter.registerPlatformAccessories.mockRejectedValueOnce(new Error('Matter is not enabled'));

    await charger.register();
    charger.update(telemetry({ powerW: 1_000 }));
    await flush();

    expect(matter.updateAccessoryState).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Matter registration failed for charger garage: Matter is not enabled');
  });

  it('reports cumulative energy at most once per interval and only when it changes', async () => {
    const { matter, charger } = createCharger();
    await charger.register();
    const start = 1_000_000;

    charger.update(telemetry({ energyKWh: 1, receivedAt: start }));
    charger.update(telemetry({ energyKWh: 1.1, receivedAt: start + 10_000 }));
    charger.update(telemetry({ energyKWh: 1.2, receivedAt: start + ENERGY_REPORT_INTERVAL_MS }));
    charger.update(telemetry({ energyKWh: 1.2, receivedAt: start + 3 * ENERGY_REPORT_INTERVAL_MS }));
    await flush();

    expect(stateUpdates(matter, 'electricalEnergyMeasurement', METER_PART)).toEqual([
      { cumulativeEnergyImported: { energy: 1_000_000 } },
      { cumulativeEnergyImported: { energy: 1_200_000 } },
    ]);
  });

  it('marks the charger unreachable and clears live readings when telemetry goes stale', async () => {
    const { matter, charger } = createCharger();
    await charger.register();

    charger.update(telemetry({ powerW: 7_000, receivedAt: 1_000 }));
    charger.markOfflineIfStale(50_000, 90_000);
    await flush();
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: true }]);

    charger.markOfflineIfStale(100_000, 90_000);
    await flush();
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: true }, { reachable: false }]);
    expect(stateUpdates(matter, 'electricalPowerMeasurement', METER_PART).at(-1)).toEqual({
      activePower: null,
      voltage: null,
      activeCurrent: null,
    });
  });

  it('starts a previously seen cached charger as unreachable', async () => {
    const matter = createMatterApi();
    const cached = { context: { chargerId: 'garage', lastSeen: 123 } } as never;
    const charger = new ChargerMatterEvse(
      asMatterApi(matter),
      createLogger(),
      'garage',
      'chargecore',
      vi.fn(),
      false,
      cached,
    );

    await charger.register();
    await flush();

    expect(charger.accessory.context.lastSeen).toBe(123);
    expect(stateUpdates(matter, 'bridgedDeviceBasicInformation')).toEqual([{ reachable: false }]);
  });

  it('pushes renames through updatePlatformAccessories', async () => {
    const { matter, charger } = createCharger();
    await charger.register();

    charger.rename('Garage Charger');
    await flush();

    expect(matter.updatePlatformAccessories).toHaveBeenCalledWith([
      expect.objectContaining({ displayName: 'Garage Charger' }),
    ]);
  });
});
