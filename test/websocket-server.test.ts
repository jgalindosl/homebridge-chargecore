import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import type { Logger } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ChargeCoreWssServer } from '../src/wss-server.js';
import type { ChargeCoreConfig } from '../src/types.js';

describe('ChargeCoreWssServer', () => {
  let server: ChargeCoreWssServer | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close();
      await once(socket, 'close');
    }
    await server?.stop();
  });

  it('rejects non-OCPP JSON messages', async () => {
    const port = await findAvailablePort();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const config: ChargeCoreConfig = {
      platform: 'ChargeCore',
      host: '127.0.0.1',
      port,
    };

    server = new ChargeCoreWssServer(config, log);
    await server.start();

    socket = new WebSocket(`ws://127.0.0.1:${port}/chargecore/test-charger`);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ state: 'charging' }));

    const [closeCode] = await closed;
    expect(closeCode).toBe(1007);
    expect(log.warn).toHaveBeenCalledWith('Rejected OCPP message: OCPP message must be a JSON array');
  });

  it('logs raw OCPP messages when traffic logging is enabled', async () => {
    const port = await findAvailablePort();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const config: ChargeCoreConfig = {
      platform: 'ChargeCore',
      host: '127.0.0.1',
      port,
      logWebSocketTraffic: true,
    };

    server = new ChargeCoreWssServer(config, log);
    await server.start();

    socket = new WebSocket(`ws://127.0.0.1:${port}/chargecore/logged-charger`);
    await once(socket, 'open');
    const response = once(socket, 'message');
    const payload = '[2,"heartbeat-request","Heartbeat",{}]';
    socket.send(payload);

    await response;
    expect(log.info).toHaveBeenCalledWith(
      `Incoming WebSocket message [logged-charger]: ${payload}`,
    );
  });

  it('accepts an OCPP 1.6 boot notification and responds as a central system', async () => {
    const port = await findAvailablePort();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const config: ChargeCoreConfig = {
      platform: 'ChargeCore',
      host: '127.0.0.1',
      port,
    };

    server = new ChargeCoreWssServer(config, log);
    const telemetry = new Promise(resolve => server?.once('telemetry', resolve));
    await server.start();

    socket = new WebSocket(`ws://127.0.0.1:${port}/chargecore/ocpp-charger`, 'ocpp1.6');
    await once(socket, 'open');
    const response = once(socket, 'message');
    socket.send(JSON.stringify([
      2,
      'boot-request',
      'BootNotification',
      { chargePointVendor: 'Example', chargePointModel: 'AC100' },
    ]));

    const [data] = await response;
    expect(JSON.parse(data.toString())).toMatchObject([
      3,
      'boot-request',
      { interval: 60, status: 'Accepted' },
    ]);
    await expect(telemetry).resolves.toMatchObject({
      chargerId: 'ocpp-charger',
      name: 'chargecore',
      state: 'unknown',
      fault: false,
    });
  });
});

async function findAvailablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  return port;
}
