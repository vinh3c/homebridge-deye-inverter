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

test('logs plugin loading and detects a missing platform configuration', t => {
  const info = t.mock.method(console, 'info', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const api = new HomebridgeAPI();
  register(api);
  assert.match(String(info.mock.calls[0].arguments[0]), /Plugin loaded/);
  api.signalFinished();
  const messages = warn.mock.calls.map(call => String(call.arguments[0])).join('\n');
  assert.match(messages, /SETUP REQUIRED/);
  assert.match(messages, /Homebridge UI > Plugins > Deye Inverter > Plugin Config/);
  assert.match(messages, /click Save, then Restart Homebridge/);
  assert(!messages.includes('platforms and restart'), 'setup instructions should use the UI instead of manual JSON edits');
});

test('creates four HAP sensors, restores cache, faults and recovers, stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failBattery = false;
  let gridRaw = 2300;
  const registers: number[] = [];
  const server = createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', data => {
      received = Buffer.concat([received, data]);
      if (received.length < 12) return;
      const address = received.readUInt16BE(8);
      registers.push(address);
      const raw = address === 150 ? gridRaw : address === 90 ? 1624 : address === 91 ? 1559 : failBattery ? 65535 : 1340;
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
  cached.addService(api.hap.Service.TemperatureSensor, 'DC Temperature');
  const platform = new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1', port: address.port }, api);
  platform.configureAccessory(cached);
  const { Service, Characteristic } = api.hap;
  const sensor = (accessory: PlatformAccessory) => accessory.getService(Service.TemperatureSensor)!;
  try {
    api.signalFinished();
    assert.equal(added.length, 3);
    assert.deepEqual(updated, [cached]);
    assert.equal(cached.getService(Service.AccessoryInformation)!.getCharacteristic(Characteristic.Model).value, 'Modbus TCP Inverter');
    const ac = added.find(a => a.displayName === 'AC Temperature')!;
    const battery = added.find(a => a.displayName === 'Battery Temperature')!;
    const grid = added.find(a => a.displayName === 'Grid')!.getService(Service.ContactSensor)!;
    await assert.rejects(grid.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest());
    const waitForCycle = async () => {
      const count = registers.length;
      t.mock.timers.tick(10_000);
      await until(() => registers.length >= count + 4);
      // Allow the final response to complete and the next poll to be scheduled.
      await delay(20);
    };
    await until(() => sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).value === 34);
    await until(() => grid.getCharacteristic(Characteristic.StatusFault).value === 0);
    await delay(20);
    assert.equal(await grid.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest(), 0);
    assert(Math.abs(Number(await sensor(cached).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()) - 62.4) < 1e-8);
    assert(Math.abs(Number(await sensor(ac).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()) - 55.9) < 1e-8);
    assert.deepEqual(registers.slice(0, 4), [90, 91, 182, 150]);
    failBattery = true;
    await waitForCycle();
    await until(() => sensor(battery).getCharacteristic(Characteristic.StatusFault).value === 1);
    await assert.rejects(sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest());
    assert.equal(sensor(ac).getCharacteristic(Characteristic.StatusFault).value, 0);
    failBattery = false;
    await waitForCycle();
    await until(() => sensor(battery).getCharacteristic(Characteristic.StatusFault).value === 0);
    assert.equal(await sensor(battery).getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest(), 34);
    for (const [raw, expected] of [[900, 0], [800, 0], [799, 1], [0, 1], [900, 1], [999, 1], [1000, 0]]) {
      gridRaw = raw;
      await waitForCycle();
      assert.equal(await grid.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest(), expected, `grid raw=${raw}`);
    }
    gridRaw = 65535;
    await waitForCycle();
    assert.equal(grid.getCharacteristic(Characteristic.StatusFault).value, 1);
    await assert.rejects(grid.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest());
    assert.equal(sensor(ac).getCharacteristic(Characteristic.StatusFault).value, 0);
    gridRaw = 2300;
    await waitForCycle();
    assert.equal(grid.getCharacteristic(Characteristic.StatusFault).value, 0);
    assert.equal(await grid.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest(), 0);
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

test('missing IP logs setup instructions and does not register sensors', t => {
  const warn = t.mock.method(log, 'warn', () => {});
  for (const host of [undefined, '', '   ']) {
    const api = new HomebridgeAPI();
    const registerAccessories = t.mock.method(api, 'registerPlatformAccessories', () => {});
    new DeyePlatform(log, { platform: 'DeyeInverter', host }, api);
    api.signalFinished();
    assert.equal(DeyePlatform.isInitialized(api), false);
    assert.equal(registerAccessories.mock.callCount(), 0);
  }
  assert.equal(warn.mock.callCount(), 3);
  assert.match(String(warn.mock.calls[0].arguments[0]), /SETUP REQUIRED.*Plugin Config/);
});

test('rejects invalid port', () => {
  assert.throws(() => new DeyePlatform(log, { platform: 'DeyeInverter', host: '127.0.0.1', port: 0 }, new HomebridgeAPI()), /port/);
});
