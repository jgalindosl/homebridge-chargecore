import type {
  API,
  Characteristic as HapCharacteristic,
  CharacteristicProps,
  Service,
} from 'homebridge';

export interface ChargeCoreCharacteristics {
  currentConsumption: HapCharacteristic;
  totalConsumption: HapCharacteristic;
  voltage: HapCharacteristic;
  electricCurrent: HapCharacteristic;
  chargerState: HapCharacteristic;
}

export function attachChargeCoreCharacteristics(api: API, service: Service): ChargeCoreCharacteristics {
  const { Characteristic, Formats, Perms } = api.hap;
  const readNotify = [Perms.PAIRED_READ, Perms.NOTIFY];

  const candidates: ChargeCoreCharacteristics = {
    currentConsumption: new Characteristic(
      'Current Consumption',
      'E863F10D-079E-48FF-8F27-9C2605A29F52',
      numericProps(Formats.FLOAT, 'W', readNotify, 0, 100_000, 0.1),
    ),
    totalConsumption: new Characteristic(
      'Total Consumption',
      'E863F10C-079E-48FF-8F27-9C2605A29F52',
      numericProps(Formats.FLOAT, 'kWh', readNotify, 0, 1_000_000, 0.001),
    ),
    voltage: new Characteristic(
      'Voltage',
      'E863F10A-079E-48FF-8F27-9C2605A29F52',
      numericProps(Formats.FLOAT, 'V', readNotify, 0, 1_000, 0.1),
    ),
    electricCurrent: new Characteristic(
      'Electric Current',
      'E863F126-079E-48FF-8F27-9C2605A29F52',
      numericProps(Formats.FLOAT, 'A', readNotify, 0, 500, 0.01),
    ),
    chargerState: new Characteristic(
      'Charger State',
      '7A1E0001-4A7C-4C53-9F27-434841524745',
      {
        format: Formats.STRING,
        perms: readNotify,
      },
    ),
  };

  return {
    currentConsumption: attach(service, candidates.currentConsumption),
    totalConsumption: attach(service, candidates.totalConsumption),
    voltage: attach(service, candidates.voltage),
    electricCurrent: attach(service, candidates.electricCurrent),
    chargerState: attach(service, candidates.chargerState),
  };
}

function attach(service: Service, candidate: HapCharacteristic): HapCharacteristic {
  const existing = service.characteristics.find(characteristic => characteristic.UUID === candidate.UUID);
  return existing ?? service.addCharacteristic(candidate);
}

function numericProps(
  format: CharacteristicProps['format'],
  unit: string,
  perms: CharacteristicProps['perms'],
  minValue: number,
  maxValue: number,
  minStep: number,
): CharacteristicProps {
  return { format, unit, perms, minValue, maxValue, minStep } as CharacteristicProps;
}
