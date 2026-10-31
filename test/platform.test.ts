import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { deviceTypes } from '../node_modules/homebridge/dist/matter/types.js';
import { AccessoryManager } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import type { Logging, MatterAccessory, MatterAPI } from 'homebridge';
import register from '../src/index.js';
import { DeyePlatform } from '../src/platform.js';

const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {}, success() {}, log() {} }) as unknown as Logging;

async function initializeBatteryScope(accessory: MatterAccessory, state: Record<string, any>, number: number): Promise<void> {
  const { deviceType } = await new AccessoryManager().prepareDeviceType(accessory);
  const behavior = deviceType.behaviors.temperatureMeasurement;
  await behavior.prototype.initialize.call({
    endpoint: { number, behaviors: { supported: deviceType.behaviors } },
    agent: { load: async (source: unknown) => {
      assert.equal(source, deviceType.behaviors.powerSource);
      return { state: state.powerSource };
    } },
  });
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for platform update');
    await delay(10);
  }
}

test('registers dynamic platform without starting CLI', () => {
  const api = new HomebridgeAPI();
  api.on('registerPlatform', (name, constructor, plugin) => {
    assert.equal(name, 'DeyeInverter'); assert.equal(plugin, 'homebridge-deye-inverter'); assert.equal(constructor, DeyePlatform);
  });
  register(api);
});

test('logs setup instructions when platform configuration is missing', t => {
  t.mock.method(console, 'info', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const api = new HomebridgeAPI();
  register(api); api.signalFinished();
  assert.match(warn.mock.calls.map(call => String(call.arguments[0])).join('\n'), /SETUP REQUIRED.*Plugin Config/s);
});

test('creates only Matter sensors, migrates HAP cache, preserves measurements, recovers faults and stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failBattery = false;
  let batterySocRaw = 83;
  let pv1PowerRaw = 940;
  let gridRaw = 2300;
  const registers: number[] = [];
  const server = createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', data => {
      received = Buffer.concat([received, data]);
      if (received.length < 12) return;
      const address = received.readUInt16BE(8);
      const count = received.readUInt16BE(10);
      registers.push(address);
      const response = Buffer.alloc(9 + count * 2);
      received.copy(response, 0, 0, 2);
      response.writeUInt16BE(3 + count * 2, 4); response[6] = 1; response[7] = 3; response[8] = count * 2;
      for (let i = 0; i < count; i++) {
        const raw = ({ 78: 1234, 79: 5000, 80: 0, 90: 1624, 91: 1559, 186: pv1PowerRaw, 187: 1190, 182: failBattery ? 65535 : 1340, 184: batterySocRaw, 150: gridRaw, 85: 5677, 86: 0 } as Record<number, number>)[address + i] ?? 0;
        response.writeUInt16BE(raw, 9 + i * 2);
      }
      socket.end(response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const api = new HomebridgeAPI();
  const added: MatterAccessory[] = [];
  const state = new Map<string, Record<string, any>>();
  const dcUuid = api.hap.uuid.generate('homebridge-deye-inverter:dc');
  const dcCache = { UUID: dcUuid, context: { sensorKey: 'dc' }, clusters: { temperatureMeasurement: { measuredValue: 9999 }, bridgedDeviceBasicInformation: { reachable: true } } } as unknown as MatterAccessory;
  state.set(dcUuid, structuredClone(dcCache.clusters!));
  const batteryUuid = api.hap.uuid.generate('homebridge-deye-inverter:battery');
  const oldBattery = { UUID: batteryUuid, context: { sensorKey: 'battery' }, clusters: { temperatureMeasurement: { measuredValue: 9999 }, bridgedDeviceBasicInformation: { reachable: true } } } as unknown as MatterAccessory;
  state.set(batteryUuid, structuredClone(oldBattery.clusters!));
  const oldPv = { UUID: api.hap.uuid.generate('homebridge-deye-inverter:pv'), context: { sensorKey: 'pv' }, clusters: { electricalPowerMeasurement: { activePower: 9000 } } } as unknown as MatterAccessory;
  state.set(oldPv.UUID, structuredClone(oldPv.clusters!));
  const oldGrid = { UUID: api.hap.uuid.generate('homebridge-deye-inverter:grid'), context: { sensorKey: 'grid' }, clusters: { booleanState: { stateValue: true } } } as unknown as MatterAccessory;
  state.set(oldGrid.UUID, structuredClone(oldGrid.clusters!));
  const upgraded: string[] = [];
  const matter = {
    uuid: api.hap.uuid,
    deviceTypes,
    registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      for (const accessory of accessories) {
        added.push(accessory);
        const clusters = structuredClone(accessory.clusters!);
        if (accessory.context.sensorKey === 'battery') await initializeBatteryScope(accessory, clusters, 37);
        state.set(accessory.UUID, clusters);
      }
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      assert(state.has(api.hap.uuid.generate('homebridge-deye-inverter:gridPower')), 'replacement must be ready before removing total PV');
      for (const accessory of accessories) { upgraded.push(accessory.UUID); state.delete(accessory.UUID); }
    },
    updateAccessoryState: async (uuid: string, cluster: string, values: Record<string, unknown>) => {
      if (cluster === 'powerSource') assert.deepEqual(values.endpointList, [37], 'every SOC update must preserve its scope');
      if (cluster === 'powerSource' && values.batPercentRemaining != null) {
        assert.equal(uuid, batteryUuid, 'SOC must target the battery endpoint');
        assert.deepEqual(state.get(uuid)!.powerSource.endpointList, [37], 'SOC must never become active at node scope');
      }
      Object.assign(state.get(uuid)![cluster] ??= {}, values);
    },
    getAccessoryState: async (uuid: string, cluster: string) => state.get(uuid)?.[cluster],
  } as unknown as MatterAPI;
  Object.defineProperty(api, 'matter', { value: matter });
  t.mock.method(api, 'isMatterEnabled', () => true);
  const hapRegistration = t.mock.method(api, 'registerPlatformAccessories', () => {});
  const unregister = t.mock.method(api, 'unregisterPlatformAccessories', () => {});
  const legacy = new api.platformAccessory('Old DC', api.hap.uuid.generate('legacy-dc'));
  const platform = new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1', port: address.port }, api);
  platform.configureAccessory(legacy); platform.configureMatterAccessory(dcCache);
  platform.configureMatterAccessory(oldBattery);
  platform.configureMatterAccessory(oldPv);
  platform.configureMatterAccessory(oldGrid);
  const sensor = (key: string) => state.get(api.hap.uuid.generate(`homebridge-deye-inverter:${key}`))!;
  const cycle = async () => {
    const count = registers.length;
    t.mock.timers.tick(10_000);
    await until(() => registers.length >= count + 6);
    await delay(20);
  };
  try {
    api.signalFinished();
    await until(() => sensor('batteryPower')?.electricalPowerMeasurement.activePower === 0);
    await delay(20);
    assert.equal(added.length, 9, 'all cached and new accessories must register current ownership');
    assert.equal(added.find(accessory => accessory.context.sensorKey === 'dc')!.UUID, dcUuid);
    assert.equal(hapRegistration.mock.callCount(), 0);
    assert.deepEqual(unregister.mock.calls[0].arguments[2], [legacy]);
    assert.equal(sensor('dc').temperatureMeasurement.measuredValue, 6240);
    assert.equal(sensor('ac').temperatureMeasurement.measuredValue, 5590);
    assert.equal(sensor('battery').temperatureMeasurement.measuredValue, 3400);
    assert.equal(sensor('battery').powerSource.batPercentRemaining, 166, '83% must use Matter half-percent units');
    assert.deepEqual(sensor('battery').powerSource.endpointList, [37]);
    for (const key of ['dc', 'ac', 'grid', 'pv1', 'pv2', 'gridPower', 'loadPower', 'batteryPower']) {
      assert.equal(sensor(key).powerSource, undefined, `${key} must not carry a storage-battery source`);
    }
    assert.deepEqual(upgraded, [oldPv.UUID], 'battery rebuild is delegated to Homebridge; total PV is removed');
    assert.equal(added.find(accessory => accessory.context.sensorKey === 'battery')!.UUID, batteryUuid);
    assert.deepEqual(registers.slice(0, 6), [90, 109, 150, 157, 169, 178]);
    assert.equal(sensor('pv1').electricalPowerMeasurement.powerMode, 1);
    assert.equal(sensor('pv1').electricalPowerMeasurement.activePower, 940000);
    assert.equal(sensor('pv1').electricalPowerMeasurement.voltage, 0);
    assert.equal(sensor('pv1').electricalPowerMeasurement.activeCurrent, 0);
    assert.equal(state.has(oldPv.UUID), false);
    pv1PowerRaw = 65535; await cycle();
    assert.equal(sensor('pv1').electricalPowerMeasurement.activePower, null);
    assert.equal(sensor('pv2').electricalPowerMeasurement.activePower, 1190000);
    assert.equal(sensor('pv1').bridgedDeviceBasicInformation.reachable, false);
    pv1PowerRaw = 0; await cycle();
    assert.equal(sensor('pv1').electricalPowerMeasurement.activePower, 0);
    assert.equal(sensor('pv1').bridgedDeviceBasicInformation.reachable, true);
    failBattery = true; await cycle();
    assert.equal(sensor('battery').temperatureMeasurement.measuredValue, null);
    assert.equal(sensor('battery').bridgedDeviceBasicInformation.reachable, false);
    assert.equal(sensor('ac').bridgedDeviceBasicInformation.reachable, true);
    failBattery = false; await cycle();
    assert.equal(sensor('battery').temperatureMeasurement.measuredValue, 3400);
    assert.equal(sensor('battery').bridgedDeviceBasicInformation.reachable, true);
    batterySocRaw = 65535; await cycle();
    assert.equal(sensor('battery').powerSource.batPercentRemaining, null);
    assert.equal(sensor('battery').temperatureMeasurement.measuredValue, 3400, 'SOC errors must not discard a valid temperature');
    batterySocRaw = 0; await cycle();
    assert.equal(sensor('battery').powerSource.batPercentRemaining, 0);
    batterySocRaw = 100; await cycle();
    assert.equal(sensor('battery').powerSource.batPercentRemaining, 200);
    assert.equal(sensor('grid').booleanState.stateValue, true);
    assert.equal(added.find(accessory => accessory.context.sensorKey === 'grid')!.UUID, oldGrid.UUID);
    gridRaw = 900; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, true, 'hold present down to 80 V');
    gridRaw = 799; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, false);
    gridRaw = 999; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, false, 'restore only at 100 V');
    gridRaw = 1000; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, true);
    gridRaw = 0; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, false);
    assert.equal(sensor('gridPower').electricalPowerMeasurement.voltage, 0);
    assert.equal(sensor('gridPower').electricalPowerMeasurement.activePower, 0);
    gridRaw = 65535; await cycle();
    assert.equal(sensor('gridPower').electricalPowerMeasurement.voltage, null);
    assert.equal(sensor('gridPower').bridgedDeviceBasicInformation.reachable, false);
    assert.equal(sensor('grid').bridgedDeviceBasicInformation.reachable, false);
    gridRaw = 2300; await cycle();
    assert.equal(sensor('grid').booleanState.stateValue, true);
    assert.equal(sensor('grid').bridgedDeviceBasicInformation.reachable, true);
    assert.equal(sensor('gridPower').electricalPowerMeasurement.voltage, 230000);
    assert.equal(sensor('gridPower').bridgedDeviceBasicInformation.reachable, true);
    assert.equal(added.find(accessory => accessory.context.sensorKey === 'grid')!.deviceType, deviceTypes.ContactSensor);
    api.signalShutdown();
    const requests = registers.length;
    t.mock.timers.tick(60_000); await delay(20);
    assert.equal(registers.length, requests);
  } finally {
    api.signalShutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const previousScope of [[], [12]] as number[][]) {
  test(`restored battery source with scope ${JSON.stringify(previousScope)} is rebuilt and uses its current endpoint`, async () => {
    const api = new HomebridgeAPI();
    const batteryUuid = api.hap.uuid.generate('homebridge-deye-inverter:battery');
    const cached = {
      UUID: batteryUuid, context: { sensorKey: 'battery' }, deviceType: deviceTypes.TemperatureSensor,
      clusters: {
        temperatureMeasurement: { measuredValue: 3200 },
        powerSource: { status: 1, order: 0, description: 'Deye storage battery', endpointList: previousScope, batPercentRemaining: 166 },
      },
    } as MatterAccessory;
    const state = new Map<string, Record<string, any>>([[batteryUuid, structuredClone(cached.clusters!)]]);
    const removed: string[] = [];
    const added: MatterAccessory[] = [];
    const matter = {
      uuid: api.hap.uuid, deviceTypes,
      getAccessoryState: async (uuid: string, cluster: string) => state.get(uuid)?.[cluster],
      unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
        for (const accessory of accessories) { removed.push(accessory.UUID); state.delete(accessory.UUID); }
      },
      registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
        for (const accessory of accessories) {
          added.push(accessory);
          const clusters = structuredClone(accessory.clusters!);
          if (accessory.context.sensorKey === 'battery') await initializeBatteryScope(accessory, clusters, 83);
          state.set(accessory.UUID, clusters);
        }
      },
      updateAccessoryState: async (uuid: string, cluster: string, attributes: object) => Object.assign(state.get(uuid)![cluster] ??= {}, attributes),
    } as unknown as MatterAPI;
    const platform = new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1' }, api);
    Object.defineProperty(api, 'matter', { value: matter });
    platform.configureMatterAccessory(cached);
    // Exercise only setup; no platform launch, timer, bridge or Modbus polling.
    (platform as any).matter = matter;
    try {
      await (platform as any).setupAccessories();
      assert.deepEqual(removed, [], 'registering explicit topology lets Homebridge rebuild atomically');
      const replacement = added.find(accessory => accessory.context.sensorKey === 'battery');
      assert.equal(replacement?.UUID, batteryUuid, 'migration preserves the accessory identity');
      assert.deepEqual(replacement?.clusters?.powerSource?.endpointList, [83], 'the scope initializer updates the cache declaration too');
      assert.deepEqual(state.get(batteryUuid)!.powerSource.endpointList, [83], 'cached global/stale scope must not survive');
      assert.equal(state.get(batteryUuid)!.powerSource.batPercentRemaining, null, 'restored SOC stays unavailable until a fresh read');
    } finally {
      api.signalShutdown();
    }
  });
}

test('Matter disabled creates no accessories and retains old HAP cache', async t => {
  const api = new HomebridgeAPI();
  const warn = t.mock.method(log, 'warn', () => {});
  const hap = t.mock.method(api, 'registerPlatformAccessories', () => {});
  const unregister = t.mock.method(api, 'unregisterPlatformAccessories', () => {});
  const platform = new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1' }, api);
  platform.configureAccessory(new api.platformAccessory('Old Grid', api.hap.uuid.generate('old')));
  api.signalFinished();
  await delay(10);
  assert.equal(hap.mock.callCount(), 0); assert.equal(unregister.mock.callCount(), 0);
  assert.match(String(warn.mock.calls[0].arguments[0]), /enable Matter/);
  api.signalShutdown();
});

test('missing IP logs setup instructions and invalid port is rejected', t => {
  t.mock.method(log, 'warn', () => {});
  for (const host of [undefined, '', '   ']) {
    const api = new HomebridgeAPI(); new DeyePlatform(log, { platform: 'DeyeInverter', host }, api);
    assert.equal(DeyePlatform.isInitialized(api), false);
  }
  assert.throws(() => new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1', port: 0 }, new HomebridgeAPI()), /port/);
});
