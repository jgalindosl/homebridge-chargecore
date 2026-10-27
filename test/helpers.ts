import { EventEmitter } from 'node:events';
import * as hap from '@homebridge/hap-nodejs';
import { deviceTypes, type API, type Logger, type MatterAPI, type MatterAccessory } from 'homebridge';
import { vi } from 'vitest';

export function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type PlatformAccessoriesCall = (plugin: string, platform: string, accessories: MatterAccessory[]) => Promise<void>;

export function createMatterApi() {
  return {
    uuid: hap.uuid,
    deviceTypes,
    registerPlatformAccessories: vi.fn<PlatformAccessoriesCall>(async () => {}),
    updatePlatformAccessories: vi.fn<(accessories: MatterAccessory[]) => Promise<void>>(async () => {}),
    unregisterPlatformAccessories: vi.fn<PlatformAccessoriesCall>(async () => {}),
    updateAccessoryState: vi.fn<
      (uuid: string, cluster: string, attributes: Record<string, unknown>) => Promise<void>
    >(async () => {}),
  };
}

export type FakeMatterApi = ReturnType<typeof createMatterApi>;

export function asMatterApi(matter: FakeMatterApi): MatterAPI {
  return matter as unknown as MatterAPI;
}

/** Minimal PlatformAccessory backed by a real HAP accessory. */
export class FakePlatformAccessory {
  context: Record<string, unknown> = {};
  private readonly hapAccessory: hap.Accessory;

  constructor(public displayName: string, public readonly UUID: string) {
    this.hapAccessory = new hap.Accessory(displayName, UUID);
  }

  get services(): hap.Service[] {
    return this.hapAccessory.services;
  }

  getService(type: typeof hap.Service): hap.Service | undefined {
    return this.hapAccessory.getService(type as never);
  }

  getServiceById(type: typeof hap.Service, subtype: string): hap.Service | undefined {
    return this.hapAccessory.getServiceById(type as never, subtype);
  }

  addService(type: typeof hap.Service, ...args: unknown[]): hap.Service {
    return this.hapAccessory.addService(type as never, ...(args as []));
  }

  removeService(service: hap.Service): void {
    this.hapAccessory.removeService(service);
  }

  updateDisplayName(name: string): void {
    this.displayName = name;
  }
}

export function createApi(matter?: FakeMatterApi) {
  const emitter = new EventEmitter();
  const api = Object.assign(emitter, {
    hap,
    platformAccessory: FakePlatformAccessory,
    matter,
    isMatterEnabled: () => matter !== undefined,
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  });
  return api;
}

export function asApi(api: ReturnType<typeof createApi>): API {
  return api as unknown as API;
}

/** Lets queued promise callbacks (registration, state updates) settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}
