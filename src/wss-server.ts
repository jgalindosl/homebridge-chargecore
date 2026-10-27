import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from 'homebridge';
import { DEVICE_NAME, WEBSOCKET_PATH } from './settings.js';
import type {
  ChargeCoreConfig,
  ChargerTelemetry,
} from './types.js';

interface PendingCommand {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  socket: WebSocket;
}

interface ClientState {
  alive: boolean;
  chargerId?: string;
  connectorId?: number;
  transactionId?: number;
  telemetry?: Partial<Omit<ChargerTelemetry, 'chargerId' | 'receivedAt'>>;
}

type JsonObject = Record<string, unknown>;

// idTag presented to the charger for sessions started from HomeKit or Matter (OCPP max 20 chars).
const REMOTE_ID_TAG = 'homebridge';
class OcppMessageError extends Error {}

export interface ChargeCoreServerEvents {
  telemetry: [ChargerTelemetry];
}

export class ChargeCoreWssServer extends EventEmitter<ChargeCoreServerEvents> {
  private server?: HttpServer | HttpsServer;
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly clientState = new WeakMap<WebSocket, ClientState>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly path = WEBSOCKET_PATH;

  constructor(
    private readonly config: ChargeCoreConfig,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    const tls = this.config.tls;
    if (tls && (!tls.certPath || !tls.keyPath)) {
      throw new Error('tls.certPath and tls.keyPath must both be set when TLS is configured');
    }

    const requestHandler = (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket' });
      response.end('WebSocket endpoint only\n');
    };

    if (tls) {
      const [cert, key, ca] = await Promise.all([
        readFile(tls.certPath),
        readFile(tls.keyPath),
        tls.clientCaPath ? readFile(tls.clientCaPath) : undefined,
      ]);
      this.server = createServer({
        cert,
        key,
        minVersion: 'TLSv1.2',
        ca,
        requestCert: Boolean(ca),
        rejectUnauthorized: Boolean(ca),
      }, requestHandler);
    } else {
      this.server = createHttpServer(requestHandler);
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.config.maxPayloadBytes ?? 65_536,
      perMessageDeflate: false,
    });

    this.server.on('upgrade', (request, socket, head) => {
      const endpointChargerId = chargerIdFromRequestPath(request.url, this.path);
      const peer = request.socket.remoteAddress ?? 'unknown peer';
      const requestPath = request.url?.split('?', 1)[0] ?? '/';
      this.logTraffic(`Upgrade request from ${peer} for ${requestPath}`);
      if (endpointChargerId === null) {
        this.logTraffic(`Rejected upgrade from ${peer}: path not found`);
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      if (!endpointChargerId) {
        this.logTraffic(`Rejected upgrade from ${peer}: charger id is missing from the path`);
        rejectUpgrade(socket, 404, 'Charger ID Required');
        return;
      }
      if (endpointChargerId && this.config.allowedChargerIds?.length
        && !this.config.allowedChargerIds.includes(endpointChargerId)) {
        this.logTraffic(`Rejected upgrade from ${peer}: charger ${endpointChargerId} is not allowed`);
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      this.logTraffic(`Accepted upgrade from ${peer}${endpointChargerId ? ` for charger ${endpointChargerId}` : ''}`);
      this.wss?.handleUpgrade(request, socket, head, client => {
        this.wss?.emit('connection', client, request);
      });
    });

    this.wss.on('connection', (socket, request) => {
      const endpointChargerId = chargerIdFromRequestPath(request.url, this.path);
      if (!endpointChargerId) {
        socket.close(1008, 'Charger ID required');
        return;
      }
      this.logTraffic(`Connection opened for charger ${endpointChargerId}`);
      this.handleConnection(socket, endpointChargerId);
    });
    this.wss.on('error', error => this.log.error(`WebSocket server error: ${error.message}`));

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.config.port ?? 9443, this.config.host ?? '0.0.0.0', () => {
        server.off('error', onError);
        resolve();
      });
    });

    this.heartbeat = setInterval(() => this.runHeartbeat(), 30_000);
    this.heartbeat.unref();
    const scheme = tls ? 'wss' : 'ws';
    this.log.info(
      `WebSocket server listening on ${scheme}://${this.config.host ?? '0.0.0.0'}:${this.config.port ?? 9443}${this.path}`,
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const command of this.pendingCommands.values()) {
      clearTimeout(command.timeout);
      command.reject(new Error('ChargeCore server is stopping'));
    }
    this.pendingCommands.clear();
    for (const socket of this.wss?.clients ?? []) socket.close(1001, 'Server shutting down');

    await Promise.all([
      new Promise<void>(resolve => this.wss ? this.wss.close(() => resolve()) : resolve()),
      new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()),
    ]);
    this.sockets.clear();
  }

  async setCharging(chargerId: string, charging: boolean): Promise<void> {
    const socket = this.sockets.get(chargerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Charger ${chargerId} is not connected`);
    }

    const state = this.clientState.get(socket);
    if (charging) {
      await this.sendCommand(socket, chargerId, 'RemoteStartTransaction', {
        connectorId: state?.connectorId ?? 1,
        idTag: REMOTE_ID_TAG,
      });
      return;
    }

    const transactionId = state?.transactionId;
    if (transactionId === undefined) {
      throw new Error(`Charger ${chargerId} has no active charging session to stop`);
    }
    await this.sendCommand(socket, chargerId, 'RemoteStopTransaction', { transactionId });
  }

  private async sendCommand(socket: WebSocket, chargerId: string, action: string, payload: JsonObject): Promise<void> {
    const requestId = randomUUID();
    const timeoutSeconds = this.config.commandAckTimeoutSeconds ?? 0;
    const message = JSON.stringify([2, requestId, action, payload]);
    this.logTraffic(`Outgoing WebSocket message [${chargerId}]: ${message}`);
    if (timeoutSeconds <= 0) {
      await send(socket, message);
      return;
    }

    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(`Charger ${chargerId} did not acknowledge the command`));
      }, timeoutSeconds * 1_000);
      timeout.unref();
      this.pendingCommands.set(requestId, { resolve, reject, timeout, socket });
    });
    try {
      await send(socket, message);
    } catch (error) {
      const pending = this.pendingCommands.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      throw error;
    }
    await acknowledgement;
  }

  private handleConnection(socket: WebSocket, endpointChargerId: string): void {
    this.clientState.set(socket, { alive: true, chargerId: endpointChargerId });
    this.bindSocket(socket, endpointChargerId);
    socket.on('pong', () => {
      const state = this.clientState.get(socket);
      if (state) state.alive = true;
      this.logTraffic(`Pong received [${state?.chargerId ?? 'unidentified'}]`);
    });
    socket.on('message', (data, isBinary) => void this.handleMessage(socket, data, isBinary));
    socket.on('close', (code, reason) => {
      const chargerId = this.clientState.get(socket)?.chargerId ?? 'unidentified';
      this.logTraffic(`Connection closed [${chargerId}]: code=${code} reason=${reason.toString('utf8') || '<none>'}`);
      this.removeSocket(socket);
    });
    socket.on('error', error => this.log.warn(`Charger WebSocket error: ${error.message}`));
  }

  private async handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    if (this.config.logWebSocketTraffic) {
      const chargerId = this.clientState.get(socket)?.chargerId ?? 'unidentified';
      this.log.info(isBinary
        ? `Incoming WebSocket message [${chargerId}]: <binary frame>`
        : `Incoming WebSocket message [${chargerId}]: ${data.toString('utf8')}`);
    }

    if (isBinary) {
      socket.close(1003, 'Text JSON messages only');
      return;
    }

    try {
      const rawMessage: unknown = JSON.parse(data.toString('utf8'));
      if (!Array.isArray(rawMessage)) throw new OcppMessageError('OCPP message must be a JSON array');
      await this.handleOcppMessage(socket, rawMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unexpected OCPP message error';
      this.log.warn(`Rejected OCPP message: ${detail}`);
      socket.close(1007, 'Invalid OCPP message');
    }
  }

  private async handleOcppMessage(socket: WebSocket, message: unknown[]): Promise<void> {
    const state = this.clientState.get(socket);
    const chargerId = state?.chargerId;
    if (!state || !chargerId) throw new OcppMessageError('OCPP connections require a charger id in the URL');

    const messageType = message[0];
    const requestId = message[1];
    if (typeof requestId !== 'string') throw new OcppMessageError('OCPP message requires a string request id');

    if (messageType === 3) {
      this.handleOcppCallResult(socket, requestId, asObject(message[2]));
      return;
    }
    if (messageType === 4) {
      const code = typeof message[2] === 'string' ? message[2] : 'UnknownError';
      const description = typeof message[3] === 'string' ? message[3] : '';
      this.handleOcppCallError(socket, requestId, code, description);
      return;
    }
    if (messageType !== 2 || typeof message[2] !== 'string') {
      throw new OcppMessageError('unsupported OCPP message frame');
    }

    const action = message[2];
    const payload = asObject(message[3]);
    let response: JsonObject;
    switch (action) {
      case 'BootNotification': {
        state.telemetry = { ...state.telemetry, name: DEVICE_NAME, state: 'unknown', fault: false };
        this.emitOcppTelemetry(chargerId, state);
        response = { currentTime: new Date().toISOString(), interval: 60, status: 'Accepted' };
        break;
      }
      case 'Heartbeat':
        this.emitOcppTelemetry(chargerId, state);
        response = { currentTime: new Date().toISOString() };
        break;
      case 'StatusNotification':
        this.applyOcppStatus(chargerId, state, payload);
        response = {};
        break;
      case 'MeterValues':
        this.applyOcppMeterValues(chargerId, state, payload);
        response = {};
        break;
      case 'Authorize':
        response = { idTagInfo: { status: 'Accepted' } };
        break;
      case 'StartTransaction': {
        const transactionId = this.startTransaction(chargerId, state, payload);
        response = { transactionId, idTagInfo: { status: 'Accepted' } };
        break;
      }
      case 'StopTransaction':
        this.stopTransaction(chargerId, state);
        response = { idTagInfo: { status: 'Accepted' } };
        break;
      case 'DataTransfer':
        response = { status: 'UnknownMessage' };
        break;
      case 'DiagnosticsStatusNotification':
      case 'FirmwareStatusNotification':
        response = {};
        break;
      default:
        await this.sendOcpp(socket, [4, requestId, 'NotSupported', `Action ${action} is not supported`, {}], chargerId);
        return;
    }
    await this.sendOcpp(socket, [3, requestId, response], chargerId);
  }

  private applyOcppStatus(chargerId: string, state: ClientState, payload: JsonObject): void {
    const status = stringValue(payload.status);
    const mapped = mapOcppStatus(status);
    state.telemetry = {
      ...state.telemetry,
      state: mapped.state,
      fault: mapped.fault,
      vehicleConnected: mapped.vehicleConnected,
    };
    // Connector 0 reports the charge point as a whole and never carries a session status.
    const connectorId = integerValue(payload.connectorId);
    if (connectorId === undefined || connectorId > 0) {
      if (connectorId !== undefined) state.connectorId = connectorId;
      state.telemetry.charging = mapped.sessionActive;
    }
    this.emitOcppTelemetry(chargerId, state);
  }

  private startTransaction(chargerId: string, state: ClientState, payload: JsonObject): number {
    // OCPP 1.6 transaction ids are 32-bit integers.
    const transactionId = Math.floor(Date.now() / 1_000) % 2_147_483_647;
    state.transactionId = transactionId;
    const connectorId = integerValue(payload.connectorId);
    if (connectorId !== undefined && connectorId > 0) state.connectorId = connectorId;
    state.telemetry = { ...state.telemetry, charging: true };
    this.emitOcppTelemetry(chargerId, state);
    return transactionId;
  }

  private stopTransaction(chargerId: string, state: ClientState): void {
    delete state.transactionId;
    state.telemetry = { ...state.telemetry, charging: false };
    this.emitOcppTelemetry(chargerId, state);
  }

  private applyOcppMeterValues(chargerId: string, state: ClientState, payload: JsonObject): void {
    // Recovers the session id when the charger reconnects mid-transaction.
    const transactionId = integerValue(payload.transactionId);
    if (transactionId !== undefined) state.transactionId = transactionId;
    const meterValues = Array.isArray(payload.meterValue) ? payload.meterValue : [];
    const latest = asObject(meterValues.at(-1));
    const samples = Array.isArray(latest.sampledValue) ? latest.sampledValue : [];
    const telemetry = { ...state.telemetry };
    for (const rawSample of samples) {
      const sample = asObject(rawSample);
      const value = Number(sample.value);
      if (!Number.isFinite(value)) continue;
      const measurand = stringValue(sample.measurand) ?? 'Energy.Active.Import.Register';
      const unit = stringValue(sample.unit);
      if (measurand === 'Power.Active.Import') telemetry.powerW = unit === 'kW' ? value * 1_000 : value;
      else if (measurand === 'Energy.Active.Import.Register') telemetry.energyKWh = unit === 'Wh' ? value / 1_000 : value;
      else if (measurand === 'Current.Import') telemetry.currentA = value;
      else if (measurand === 'Voltage') telemetry.voltageV = value;
    }
    state.telemetry = telemetry;
    this.emitOcppTelemetry(chargerId, state);
  }

  private emitOcppTelemetry(chargerId: string, state: ClientState): void {
    const telemetry = state.telemetry;
    if (!telemetry) return;
    this.emit('telemetry', {
      chargerId,
      ...telemetry,
      state: telemetry.state ?? 'unknown',
      fault: telemetry.fault ?? false,
      receivedAt: Date.now(),
    });
  }

  private handleOcppCallResult(socket: WebSocket, requestId: string, payload: JsonObject): void {
    const pending = this.pendingCommands.get(requestId);
    if (!pending || pending.socket !== socket) return;
    this.pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    const status = stringValue(payload.status);
    if (!status || status === 'Accepted' || status === 'Scheduled') pending.resolve();
    else pending.reject(new Error(`Charger rejected the OCPP command: ${status}`));
  }

  private handleOcppCallError(socket: WebSocket, requestId: string, code: string, description: string): void {
    const pending = this.pendingCommands.get(requestId);
    if (!pending || pending.socket !== socket) return;
    this.pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(new Error(`OCPP ${code}: ${description}`));
  }

  private async sendOcpp(socket: WebSocket, message: unknown[], chargerId: string): Promise<void> {
    const payload = JSON.stringify(message);
    this.logTraffic(`Outgoing WebSocket message [${chargerId}]: ${payload}`);
    await send(socket, payload);
  }

  private bindSocket(socket: WebSocket, chargerId: string): boolean {
    const state = this.clientState.get(socket);
    if (!state) return false;
    if (state.chargerId && state.chargerId !== chargerId) {
      socket.close(1008, 'A connection cannot change charger identity');
      return false;
    }
    state.chargerId = chargerId;
    const previous = this.sockets.get(chargerId);
    if (previous && previous !== socket) previous.close(4001, 'Replaced by a newer connection');
    this.sockets.set(chargerId, socket);
    return true;
  }

  private removeSocket(socket: WebSocket): void {
    const chargerId = this.clientState.get(socket)?.chargerId;
    if (chargerId && this.sockets.get(chargerId) === socket) this.sockets.delete(chargerId);
    for (const [requestId, pending] of this.pendingCommands) {
      if (pending.socket !== socket) continue;
      this.pendingCommands.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Charger ${chargerId ?? 'connection'} disconnected before acknowledging the command`));
    }
  }

  private runHeartbeat(): void {
    for (const socket of this.wss?.clients ?? []) {
      const state = this.clientState.get(socket);
      if (!state?.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      this.logTraffic(`Ping sent [${state.chargerId ?? 'unidentified'}]`);
      socket.ping();
    }
  }

  private logTraffic(message: string): void {
    if (this.config.logWebSocketTraffic) this.log.info(`[WebSocket traffic] ${message}`);
  }

}

function normalizePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function mapOcppStatus(status: string | undefined): {
  state: ChargerTelemetry['state'];
  fault: boolean;
  vehicleConnected: boolean;
  sessionActive: boolean;
} {
  switch (status) {
    case 'Available': return { state: 'available', fault: false, vehicleConnected: false, sessionActive: false };
    case 'Preparing': return { state: 'connected', fault: false, vehicleConnected: true, sessionActive: false };
    case 'Charging': return { state: 'charging', fault: false, vehicleConnected: true, sessionActive: true };
    case 'SuspendedEV':
    case 'SuspendedEVSE': return { state: 'paused', fault: false, vehicleConnected: true, sessionActive: true };
    case 'Finishing': return { state: 'finishing', fault: false, vehicleConnected: true, sessionActive: false };
    case 'Faulted': return { state: 'faulted', fault: true, vehicleConnected: false, sessionActive: false };
    case 'Unavailable': return { state: 'offline', fault: false, vehicleConnected: false, sessionActive: false };
    default: return { state: 'unknown', fault: false, vehicleConnected: false, sessionActive: false };
  }
}

function requestUrlPath(url: string | undefined): string {
  if (!url) return '/';
  return normalizePath(new URL(url, 'https://localhost').pathname);
}

function chargerIdFromRequestPath(url: string | undefined, basePath: string): string | undefined | null {
  const path = requestUrlPath(url);
  if (path === basePath) return undefined;
  const prefix = basePath === '/' ? '/' : `${basePath}/`;
  if (!path.startsWith(prefix)) return null;

  const encodedId = path.slice(prefix.length);
  if (!encodedId || encodedId.includes('/')) return null;
  try {
    const chargerId = decodeURIComponent(encodedId);
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(chargerId) ? chargerId : null;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function send(socket: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(data, error => error ? reject(error) : resolve());
  });
}
