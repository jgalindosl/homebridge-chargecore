import type { PlatformConfig } from 'homebridge';

export type ChargerState =
  | 'available'
  | 'connected'
  | 'charging'
  | 'paused'
  | 'finishing'
  | 'faulted'
  | 'offline'
  | 'unknown';

export interface ChargeCoreConfig extends PlatformConfig {
  platform: 'ChargeCore';
  name?: string;
  host?: string;
  port?: number;
  tls?: {
    certPath: string;
    keyPath: string;
    clientCaPath?: string;
  };
  offlineAfterSeconds?: number;
  maxPayloadBytes?: number;
  logWebSocketTraffic?: boolean;
  commandAckTimeoutSeconds?: number;
  allowedChargerIds?: string[];
  exposeVehicleSensor?: boolean;
  autoStartOnConnect?: boolean;
}

export interface ChargerTelemetry {
  chargerId: string;
  name?: string;
  charging?: boolean;
  state: ChargerState;
  powerW?: number;
  energyKWh?: number;
  currentA?: number;
  voltageV?: number;
  vehicleConnected?: boolean;
  fault: boolean;
  receivedAt: number;
}

export interface ChargerContext {
  chargerId: string;
  lastSeen?: number;
}

