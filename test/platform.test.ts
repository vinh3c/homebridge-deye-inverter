import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { HomebridgeAPI } from 'homebridge/lib/api.js';
import type { Logging, PlatformAccessory } from 'homebridge';
import register from '../src/index.js';
import { DeyePlatform } from '../src/platform.js';

const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {}, success() {}, log() {} }) as unknown as Logging;
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for platform update');
    await delay(10);
  }
}

test('registers dynamic platform without starting CLI', () => {
  const api = new HomebridgeAPI();
  let registered = false;
  api.on('registerPlatform', (name, constructor, plugin) => {
    assert.equal(name, 'DeyeInverter');
    assert.equal(plugin, 'homebridge-deye-inverter');
    assert.equal(constructor, DeyePlatform);
    registered = true;
  });
  register(api);
  assert(registered);
});

test('creates three HAP sensors, restores cache, faults and recovers, stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failBattery = false;
  const registers: number[] = [];
  const server = createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', data => {
      received = Buffer.concat([received, data]);
      if (received.length < 12) return;
      const address = received.readUInt16BE(8);
      registers.push(address);
      const raw = address === 90 ? 1624 : address === 91 ? 1559 : failBattery ? 65535 : 1340;
      const response = Buffer.from([0, 0, 0, 0, 0, 5, 1, 3, 2, 0, 0]);
      received.copy(response, 0, 0, 2);
      response.writeUInt16BE(raw, 9);
      socket.end(response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const api = new HomebridgeAPI();
  const added: PlatformAccessory[] = [];
  const updated: PlatformAccessory[] = [];
  api.on('registerPlatformAccessories', accessories => added.push(...accessories));
  api.on('updatePlatformAccessories', accessories => updated.push(...accessories));
  const cached = new api.platformAccessory('Old DC', api.hap.uuid.generate('homebridge-deye-inverter:deye-sg05lp1:dc'));
  const platform = new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1', port: address.port }, api);
  platform.configureAccessory(cached);
  const { Service, Characteristic } = api.hap;
  const sensor = (accessory: PlatformAccessory) => accessory.getService(Service.TemperatureSensor)!;
  try {
    api.signalFinished();
    assert.equal(added.length, 2);
    assert.deepEqual(updated, [cached]);
    const ac = added.find(a => a.displayName === 'AC Temperature')!;
    const battery = added.find(a => a.displayName === 'Battery Temperature')!;
    await until(() => sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).value === 34);
    assert(Math.abs(Number(await sensor(cached).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()) - 62.4) < 1e-8);
    assert(Math.abs(Number(await sensor(ac).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()) - 55.9) < 1e-8);
    assert.deepEqual(registers.slice(0, 3), [90, 91, 182]);
    failBattery = true;
    t.mock.timers.tick(10_000);
    await until(() => sensor(battery).getCharacteristic(Characteristic.StatusFault).value === 1);
    await assert.rejects(sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest());
    assert.equal(sensor(ac).getCharacteristic(Characteristic.StatusFault).value, 0);
    failBattery = false;
    t.mock.timers.tick(10_000);
    await until(() => sensor(battery).getCharacteristic(Characteristic.StatusFault).value === 0);
    assert.equal(await sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest(), 34);
    api.signalShutdown();
    const requests = registers.length;
    t.mock.timers.tick(60_000);
    await delay(20);
    assert.equal(registers.length, requests);
  } finally {
    api.signalShutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('rejects invalid configuration', () => {
  assert.throws(() => new DeyePlatform(log, { platform: 'DeyeInverter', host: '' }, new HomebridgeAPI()), /host/);
  assert.throws(() => new DeyePlatform(log, { platform: 'DeyeInverter', port: 0 }, new HomebridgeAPI()), /port/);
});
