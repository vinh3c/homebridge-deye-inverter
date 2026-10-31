import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import { decodeTotalConsumptionEnergy, TotalConsumptionEnergy, TotalImportEnergy } from '../src/energy.js';

const energyCluster = 'electricalEnergyMeasurement';
const testOptions = { host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000 };
type ClusterState = Record<string, any>;

function createMatterHarness() {
  const registrations: MatterAccessory[] = [];
  const states = new Map<string, Record<string, ClusterState>>();
  const updates: { uuid: string; cluster: string; attributes: ClusterState }[] = [];
  const info: string[] = [];
  const warnings: string[] = [];
  const hooks: {
    update?: (uuid: string, cluster: string, attributes: ClusterState, apply: () => void) => void;
    read?: (uuid: string, cluster: string) => void;
  } = {};
  const matter = {
    uuid: { generate: (id: string) => id },
    deviceTypes: { ElectricalSensor: {} },
    getAccessoryState: async (uuid: string, cluster: string) => {
      hooks.read?.(uuid, cluster);
      return structuredClone(states.get(uuid)?.[cluster]);
    },
    registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      for (const accessory of accessories) {
        assert(!states.has(accessory.UUID), 'an existing endpoint must not be registered twice');
        registrations.push(accessory);
        states.set(accessory.UUID, structuredClone(accessory.clusters) as Record<string, ClusterState>);
      }
    },
    updateAccessoryState: async (uuid: string, cluster: string, attributes: ClusterState) => {
      const endpoint = states.get(uuid);
      assert(endpoint, `unknown endpoint ${uuid}`);
      assert(endpoint[cluster], `undeclared cluster ${cluster}`);
      updates.push({ uuid, cluster, attributes: structuredClone(attributes) });
      const apply = () => { endpoint[cluster] = { ...endpoint[cluster], ...structuredClone(attributes) }; };
      if (hooks.update) hooks.update(uuid, cluster, attributes, apply);
      else apply();
    },
  } as unknown as MatterAPI;
  const api = { isMatterEnabled: () => true, matter } as unknown as API;
  const log = {
    info: (message: string) => info.push(message),
    warn: (message: string) => warnings.push(message),
    debug() {},
  } as unknown as Logging;
  const reading = (uuid: string) => states.get(uuid)?.[energyCluster].cumulativeEnergyImported;
  return { api, log, registrations, updates, states, info, warnings, hooks, reading };
}

test('decodes unsigned low-first energy and converts 0.1 kWh to mWh without signed overflow', () => {
  assert.equal(decodeTotalConsumptionEnergy(5677, 0), 567_700_000);
  assert.equal(decodeTotalConsumptionEnergy(100, 1), 6_563_600_000);
  assert.equal(decodeTotalConsumptionEnergy(0, 0x8000), 214_748_364_800_000);
  assert.equal(decodeTotalConsumptionEnergy(0xffff, 0), 6_553_500_000);
  assert.equal(decodeTotalConsumptionEnergy(0, 0), 0);
  assert.throws(() => decodeTotalConsumptionEnergy(undefined!, 0));
});

test('Matter meter reads both words together, throttles, clears failures, recovers and restores cache', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(new Date('2026-10-31T10:00:00Z').getTime());
  let fail = false;
  let requests = 0;
  const server = createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 12) return;
      requests++;
      assert.equal(received[7], 3);
      assert.equal(received.readUInt16BE(8), 85);
      assert.equal(received.readUInt16BE(10), 2);
      const reply = fail ? Buffer.from([0,0,0,0,0,3,1,0x83,2]) : Buffer.from([0,0,0,0,0,7,1,3,4,0x16,0x2d,0,0]);
      received.copy(reply, 0, 0, 2);
      socket.end(reply);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const options = { host: '127.0.0.1', port: address.port, unitId: 1, timeoutMs: 1000 };
  const { api, log, registrations, reading } = createMatterHarness();
  const uuid = 'plugin:totalConsumptionEnergy';
  try {
    const meter = new TotalConsumptionEnergy(log, api);
    await meter.setup('plugin', 'platform');
    assert.equal(registrations.length, 1);
    assert.equal(reading(uuid), null);
    await meter.poll(options, () => false);
    assert.equal(reading(uuid).energy, 567_700_000);
    assert.equal(reading(uuid).endTimestamp, Date.now() / 1000);
    await meter.poll(options, () => false);
    assert.equal(requests, 1);
    fail = true;
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => false);
    assert.equal(reading(uuid), null);
    fail = false;
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => false);
    assert.equal(reading(uuid).energy, 567_700_000);
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => true);
    assert.equal(requests, 3);
    const restored = new TotalConsumptionEnergy(log, api);
    restored.configureAccessory(registrations[0]);
    await restored.setup('plugin', 'platform');
    assert.equal(registrations.length, 1, 'cached meter must not register again');
    assert.equal(reading(uuid), null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('consumption and grid import keep independent endpoints, readings, failures and throttling', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(new Date('2026-10-31T10:00:00Z').getTime());
  const harness = createMatterHarness();
  const consumption = new TotalConsumptionEnergy(harness.log, harness.api);
  const gridImport = new TotalImportEnergy(harness.log, harness.api);
  await consumption.setup('plugin', 'platform');
  await gridImport.setup('plugin', 'platform');
  const [loadAccessory, importAccessory] = harness.registrations;
  assert.notEqual(loadAccessory.UUID, importAccessory.UUID);
  assert.equal(loadAccessory.context.sensorKey, 'totalConsumptionEnergy');
  assert.equal(importAccessory.context.sensorKey, 'totalImportEnergy');
  await consumption.poll(testOptions, () => false, async () => [100, 1]);
  assert.equal(harness.reading(loadAccessory.UUID).energy, 6_563_600_000);
  assert.equal(harness.reading(importAccessory.UUID), null);
  assert.equal(gridImport.isDue(), true, 'polling load must not throttle grid import');
  await gridImport.poll(testOptions, () => false, async () => [50, 1]);
  assert.equal(harness.reading(importAccessory.UUID).energy, 6_558_600_000);
  assert.equal(harness.reading(loadAccessory.UUID).energy, 6_563_600_000);
  t.mock.timers.tick(60_000);
  await consumption.poll(testOptions, () => false, async () => { throw new Error('load read unavailable'); });
  assert.equal(harness.reading(loadAccessory.UUID), null);
  assert.equal(harness.reading(importAccessory.UUID).energy, 6_558_600_000);
  await gridImport.poll(testOptions, () => false, async () => [0, 0]);
  assert.equal(harness.reading(importAccessory.UUID).energy, 0, 'zero is a valid cumulative reading');
  assert.equal(harness.reading(loadAccessory.UUID), null);
  assert(harness.info.some(message => message.includes('Total Import Energy: 0 kWh') && message.includes('Matter state confirmed')));
});

test('energy confirmation waits for the queued measurement to reach its endpoint', async () => {
  const harness = createMatterHarness();
  const meter = new TotalConsumptionEnergy(harness.log, harness.api);
  await meter.setup('plugin', 'platform');
  const uuid = harness.registrations[0].UUID;
  let pending: (() => void) | undefined;
  let pendingReads = 0;
  harness.hooks.update = (_uuid, _cluster, _attributes, apply) => { pending = apply; };
  harness.hooks.read = (readUuid, cluster) => {
    if (!pending || cluster !== energyCluster) return;
    assert.equal(readUuid, uuid);
    assert(!harness.info.some(message => message.includes('Matter state confirmed')), 'queued updates must not be confirmed');
    if (++pendingReads === 3) {
      pending();
      pending = undefined;
    }
  };
  await meter.poll(testOptions, () => false, async () => [5677, 0]);
  assert.equal(pendingReads, 3);
  assert.equal(harness.reading(uuid).energy, 567_700_000);
  assert.equal(harness.info.filter(message => message.includes('Matter state confirmed')).length, 1);
  assert.deepEqual(harness.warnings, []);
});

for (const failure of ['rejected', 'not applied'] as const) {
  test(`a measurement ${failure} by Matter is unavailable and never logged as confirmed`, async t => {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(new Date('2026-10-31T10:00:00Z').getTime());
    const harness = createMatterHarness();
    const meter = new TotalConsumptionEnergy(harness.log, harness.api);
    await meter.setup('plugin', 'platform');
    const uuid = harness.registrations[0].UUID;
    let dropped = false;
    harness.hooks.update = (_uuid, _cluster, attributes, apply) => {
      if (attributes.cumulativeEnergyImported === null) {
        dropped = false;
        apply();
      } else if (failure === 'rejected') {
        throw new Error('simulated Matter rejection');
      } else {
        dropped = true;
      }
    };
    harness.hooks.read = () => {
      // Advance only Date so the normal timeout path is exercised immediately.
      if (dropped) t.mock.timers.tick(2001);
    };
    await meter.poll(testOptions, () => false, async () => [5677, 0]);
    assert.equal(harness.reading(uuid), null);
    assert(!harness.info.some(message => message.includes('Matter state confirmed')));
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], failure === 'rejected' ? /simulated Matter rejection/ : /did not apply energy measurement/);
  });
}
