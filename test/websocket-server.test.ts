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

  it('starts and stops charging with remote transaction commands', async () => {
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
    const charging: (boolean | undefined)[] = [];
    server.on('telemetry', telemetry => charging.push(telemetry.charging));
    await server.start();

    socket = new WebSocket(`ws://127.0.0.1:${port}/chargecore/remote-charger`, 'ocpp1.6');
    await once(socket, 'open');
    const nextMessage = async (): Promise<unknown[]> => {
      const [data] = await once(socket!, 'message');
      return JSON.parse(data.toString()) as unknown[];
    };

    let reply = nextMessage();
    socket.send(JSON.stringify([2, 'status', 'StatusNotification', { connectorId: 2, status: 'Preparing', errorCode: 'NoError' }]));
    await reply;
    await expect(server.setCharging('remote-charger', false)).rejects.toThrow('no active charging session');

    reply = nextMessage();
    await server.setCharging('remote-charger', true);
    expect(await reply).toMatchObject([2, expect.any(String), 'RemoteStartTransaction', { connectorId: 2, idTag: 'homebridge' }]);

    reply = nextMessage();
    socket.send(JSON.stringify([2, 'start', 'StartTransaction', { connectorId: 2, idTag: 'homebridge', meterStart: 0, timestamp: new Date().toISOString() }]));
    const [, , { transactionId }] = await reply as [number, string, { transactionId: number }];
    expect(transactionId).toBeLessThanOrEqual(2_147_483_647);

    reply = nextMessage();
    await server.setCharging('remote-charger', false);
    expect(await reply).toMatchObject([2, expect.any(String), 'RemoteStopTransaction', { transactionId }]);

    reply = nextMessage();
    socket.send(JSON.stringify([2, 'stop', 'StopTransaction', { transactionId, meterStop: 10, timestamp: new Date().toISOString() }]));
    await reply;
    expect(charging).toEqual([false, true, false]);
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
