import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import { decodeTotalConsumptionEnergy, TotalConsumptionEnergy } from '../src/energy.js';

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
  const registrations: MatterAccessory[] = [];
  const updates: Record<string, any>[] = [];
  const matter = {
    uuid: { generate: (id: string) => id },
    deviceTypes: { ElectricalSensor: {} },
    getAccessoryState: async () => updates.at(-1) ?? {},
    registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => { registrations.push(...accessories); },
    updateAccessoryState: async (_uuid: string, cluster: string, state: Record<string, any>) => {
      assert.equal(cluster, 'electricalEnergyMeasurement'); updates.push(state);
    },
  } as unknown as MatterAPI;
  const api = { isMatterEnabled: () => true, matter } as unknown as API;
  const log = { info() {}, warn() {}, debug() {} } as unknown as Logging;
  try {
    const meter = new TotalConsumptionEnergy(log, api);
    await meter.setup('plugin', 'platform');
    assert.equal(registrations.length, 1);
    assert.equal(updates.at(-1)!.cumulativeEnergyImported, null);
    await meter.poll(options, () => false);
    assert.equal(updates.at(-1)!.cumulativeEnergyImported.energy, 567_700_000);
    assert.equal(updates.at(-1)!.cumulativeEnergyImported.endTimestamp, Date.now() / 1000);
    await meter.poll(options, () => false);
    assert.equal(requests, 1);
    fail = true;
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => false);
    assert.equal(updates.at(-1)!.cumulativeEnergyImported, null);
    fail = false;
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => false);
    assert.equal(updates.at(-1)!.cumulativeEnergyImported.energy, 567_700_000);
    t.mock.timers.tick(60_000);
    await meter.poll(options, () => true);
    assert.equal(requests, 3);
    const restored = new TotalConsumptionEnergy(log, api);
    restored.configureAccessory(registrations[0]);
    await restored.setup('plugin', 'platform');
    assert.equal(registrations.length, 1, 'cached meter must not register again');
    assert.equal(updates.at(-1)!.cumulativeEnergyImported, null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
