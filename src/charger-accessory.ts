import type {
  API,
  Characteristic,
  CharacteristicValue,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import type { ChargerContext, ChargerTelemetry } from './types.js';

type SetCharging = (chargerId: string, charging: boolean) => Promise<void>;

// Eve-style energy characteristics and the custom charger state characteristic
// from earlier versions. Energy is now reported through the Matter outlet.
const LEGACY_CHARACTERISTIC_UUIDS = new Set([
  'E863F10D-079E-48FF-8F27-9C2605A29F52',
  'E863F10C-079E-48FF-8F27-9C2605A29F52',
  'E863F10A-079E-48FF-8F27-9C2605A29F52',
  'E863F126-079E-48FF-8F27-9C2605A29F52',
  '7A1E0001-4A7C-4C53-9F27-434841524745',
]);

export class ChargerAccessory {
  private readonly outlet: Service;
  private readonly vehicleSensor?: Service;
  private readonly onCharacteristic: Characteristic;
  private lastSeen = 0;
  private online = false;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory<ChargerContext>,
    private readonly setCharging: SetCharging,
    exposeVehicleSensor: boolean,
  ) {
    const { Service, Characteristic } = api.hap;
    const chargerId = accessory.context.chargerId;
    this.lastSeen = accessory.context.lastSeen ?? 0;

    this.outlet = accessory.getService(Service.Outlet)
      ?? accessory.addService(Service.Outlet, accessory.displayName);
    this.outlet.setPrimaryService(true);
    this.outlet.addOptionalCharacteristic(Characteristic.StatusActive);
    this.outlet.addOptionalCharacteristic(Characteristic.StatusFault);

    this.onCharacteristic = this.outlet.getCharacteristic(Characteristic.On)
      .onGet(() => this.onCharacteristic.value ?? false)
      .onSet(async (value: CharacteristicValue) => {
        const charging = Boolean(value);
        this.log.info(`${charging ? 'Starting' : 'Stopping'} charging on charger ${chargerId}`);
        await this.setCharging(chargerId, charging);
      });

    for (const characteristic of [...this.outlet.characteristics]) {
      if (LEGACY_CHARACTERISTIC_UUIDS.has(characteristic.UUID)) this.outlet.removeCharacteristic(characteristic);
    }

    const existingVehicleSensor = accessory.getServiceById(Service.ContactSensor, 'vehicle-connected');
    if (exposeVehicleSensor) {
      this.vehicleSensor = existingVehicleSensor
        ?? accessory.addService(Service.ContactSensor, `${accessory.displayName} Vehicle`, 'vehicle-connected');
      this.vehicleSensor.addOptionalCharacteristic(Characteristic.StatusActive);
      this.vehicleSensor.addOptionalCharacteristic(Characteristic.StatusFault);
    } else if (existingVehicleSensor) {
      accessory.removeService(existingVehicleSensor);
    }

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'ChargeCore')
      .setCharacteristic(Characteristic.Model, 'WebSocket EV Wall Charger')
      .setCharacteristic(Characteristic.SerialNumber, chargerId)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0');

    if (this.lastSeen > 0) this.markOffline();
  }

  update(telemetry: ChargerTelemetry): void {
    const { Characteristic } = this.api.hap;
    this.lastSeen = telemetry.receivedAt;
    this.online = true;
    this.accessory.context.lastSeen = telemetry.receivedAt;

    if (telemetry.charging !== undefined) {
      this.onCharacteristic.updateValue(telemetry.charging);
    }
    this.outlet.updateCharacteristic(
      Characteristic.OutletInUse,
      telemetry.state === 'charging' || (telemetry.powerW ?? 0) > 50,
    );
    this.outlet.updateCharacteristic(Characteristic.StatusActive, true);
    this.outlet.updateCharacteristic(
      Characteristic.StatusFault,
      telemetry.fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
    );

    if (this.vehicleSensor) {
      this.vehicleSensor.updateCharacteristic(
        Characteristic.ContactSensorState,
        telemetry.vehicleConnected
          ? Characteristic.ContactSensorState.CONTACT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      this.vehicleSensor.updateCharacteristic(Characteristic.StatusActive, true);
      this.vehicleSensor.updateCharacteristic(
        Characteristic.StatusFault,
        telemetry.fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
      );
    }
  }

  rename(displayName: string): void {
    const { Characteristic } = this.api.hap;
    this.accessory.updateDisplayName(displayName);
    this.outlet.updateCharacteristic(Characteristic.Name, displayName);
    this.vehicleSensor?.updateCharacteristic(Characteristic.Name, `${displayName} Vehicle`);
  }

  markOfflineIfStale(now: number, offlineAfterMs: number): void {
    if (this.online && now - this.lastSeen > offlineAfterMs) this.markOffline();
  }

  private markOffline(): void {
    const { Characteristic } = this.api.hap;
    this.online = false;
    this.outlet.updateCharacteristic(Characteristic.OutletInUse, false);
    this.outlet.updateCharacteristic(Characteristic.StatusActive, false);
    this.outlet.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    if (this.vehicleSensor) {
      this.vehicleSensor.updateCharacteristic(Characteristic.StatusActive, false);
      this.vehicleSensor.updateCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.GENERAL_FAULT,
      );
    }
  }
}
