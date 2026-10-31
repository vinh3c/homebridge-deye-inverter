import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('all eight accessories use real Matter endpoints and keep battery scope through legacy-cache migration and restart', { timeout: 60000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'deye-matter-'));
  let batterySoc = 83;
  const logger = createServer(socket => {
    // The Homebridge child may be stopped while a poll connection is open.
    socket.on('error', error => { if (error.code !== 'ECONNRESET') throw error; });
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 12) return;
      const address = data.readUInt16BE(8);
      const count = data.readUInt16BE(10);
      const reply = Buffer.alloc(9 + count * 2);
      data.copy(reply, 0, 0, 2);
      reply.writeUInt16BE(3 + count * 2, 4);
      reply[6] = 1; reply[7] = 3; reply[8] = count * 2;
      for (let i = 0; i < count; i++) reply.writeUInt16BE({ 78: 50, 79: 5000, 80: 1, 85: 100, 86: 1, 90: 1500, 91: 1400, 109: 3800, 110: 25, 111: 4000, 112: 30, 186: 940, 187: 1190, 182: 1300, 184: batterySoc, 150: 2300, 157: 2300, 160: 65486, 169: 65436, 178: 1800, 179: 800, 183: 5120, 190: 65036, 191: 64536 }[address + i] ?? 0, 9 + i * 2);
      socket.end(reply);
    });
  });
  await new Promise(resolve => logger.listen(0, '127.0.0.1', resolve));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await writeFile(join(storage, 'config.json'), JSON.stringify({
    bridge: { name: 'Deye Matter Integration', username: '0E:DE:01:02:03:06', pin: '031-45-154', port, bind: ['fake0'], hap: { enabled: false }, matter: { enabled: true, port: port + 1 } },
    platforms: [{ platform: 'DeyeInverter', host: '127.0.0.1', port: logger.address().port }], accessories: [],
  }));
  let child;
  let originalBatteryIdentity;
  try {
    for (const [index, run] of ['Added', 'Restored', 'Restored'].entries()) {
      batterySoc = [83, 27, 54][index];
      let output = '';
      child = spawn(process.execPath, ['--import', pathToFileURL(resolve('test/matter-network.mjs')).href, resolve('node_modules/homebridge/bin/homebridge.js'), '-D', '-U', storage, '-P', resolve('.'), '--strict-plugin-resolution'], { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      const deadline = Date.now() + 15000;
      while (!output.includes('Battery Power: -500 W') && Date.now() < deadline && child.exitCode === null) await delay(50);
      for (const name of ['PV1', 'PV2', 'Grid Power', 'Load Power', 'Battery Power']) assert(output.includes(`${run} Matter accessory: ${name}`), output);
      assert(!output.includes('Failed to update'), output);
      assert(!output.includes('Failed to register Matter accessory'), output);
      assert(!output.includes('Matter sensor setup failed'), output);
      assert(!output.includes('Removing orphaned Matter accessory'), output);
      // Wait for Homebridge's debounced cache write, then verify its actual state.
      await delay(2200);
      const cache = JSON.parse(await readFile(join(storage, 'matter', '0EDE01020306', 'accessories.json'), 'utf8'));
      assert.equal(cache.length, 8);
      for (const accessory of cache) {
        assert.equal(accessory.plugin, 'homebridge-deye-inverter', `${accessory.displayName} must retain plugin ownership after restore`);
        assert.equal(accessory.platform, 'DeyeInverter', `${accessory.displayName} must retain platform ownership after restore`);
      }
      const byKey = Object.fromEntries(cache.map(accessory => [accessory.context.sensorKey, accessory]));
      assert.equal(byKey.dc.deviceType.name, 'TemperatureSensor');
      assert.equal(byKey.dc.clusters.temperatureMeasurement.measuredValue, 5000);
      assert.equal(byKey.ac.clusters.temperatureMeasurement.measuredValue, 4000);
      assert.equal(byKey.battery.clusters.temperatureMeasurement.measuredValue, 3000);
      assert.equal(byKey.battery.clusters.powerSource.batPercentRemaining, batterySoc * 2);
      assert.equal(byKey.battery.clusters.powerSource.description, 'Deye storage battery');
      // The assigned number comes from the real endpoint Ready log, independently
      // of the plugin's scope initializer and persisted accessory declaration.
      const ready = [...output.matchAll(new RegExp(`${byKey.battery.uuid} ready endpoint#:\\s*(\\d+)`, 'g'))];
      assert(ready.length > 0, output);
      const batteryEndpoint = Number(ready.at(-1)[1]);
      assert(batteryEndpoint > 1);
      assert(output.includes(`Battery SOC scope: Battery Temperature only (endpoint=${batteryEndpoint})`), output);
      assert.deepEqual(byKey.battery.clusters.powerSource.endpointList, [batteryEndpoint], 'the persisted source must cover only its real endpoint');
      const identity = { uuid: byKey.battery.uuid, endpoint: batteryEndpoint };
      if (originalBatteryIdentity) assert.deepEqual(identity, originalBatteryIdentity, 'migration/restart must preserve battery identity and assigned endpoint');
      else originalBatteryIdentity = identity;
      for (const key of ['dc', 'ac', 'pv1', 'pv2', 'gridPower', 'loadPower', 'batteryPower']) {
        assert.equal(byKey[key].clusters.powerSource, undefined, `${key} must not carry the storage battery source`);
      }
      for (const [key, mode, power, voltage, current] of [
        ['pv1', 1, 940000, 380000, 2500], ['pv2', 1, 1190000, 400000, 3000],
        ['gridPower', 2, -100000, 230000, -500], ['loadPower', 2, 1800000, 230000, 8000],
        ['batteryPower', 1, -500000, 51200, -10000],
      ]) {
        assert.equal(byKey[key].deviceType.name, 'ElectricalSensor');
        const epm = byKey[key].clusters.electricalPowerMeasurement;
        assert.equal(epm.powerMode, mode); assert.equal(epm.activePower, power);
        assert.equal(epm.voltage, voltage); assert.equal(epm.activeCurrent, current);
        assert.equal(byKey[key].clusters.bridgedDeviceBasicInformation.reachable, true);
      }
      for (const key of ['grid', 'pv', 'totalConsumptionEnergy', 'totalImportEnergy']) assert.equal(byKey[key], undefined);
      for (const key of ['dc', 'ac', 'battery']) assert.equal(byKey[key].clusters.bridgedDeviceBasicInformation.reachable, true);
      assert(output.includes('Ready (Matter): DC Temperature, AC Temperature, Battery Temperature, PV1, PV2, Grid Power, Load Power, Battery Power'), output);
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      child = undefined;
      if (index === 0) {
        // Reproduce an installed older plugin's node-wide source and stale SOC.
        // Change the cache only after shutdown so Homebridge cannot overwrite it.
        for (const key of ['grid', 'pv', 'totalConsumptionEnergy', 'totalImportEnergy']) {
          cache.push({ ...byKey.pv1, deviceType: key === 'grid' ? { name: 'ContactSensor', code: 21 } : byKey.pv1.deviceType, uuid: (await import('node:crypto')).randomUUID(), displayName: key, context: { sensorKey: key },
            clusters: key === 'grid' ? { booleanState: { stateValue: true } } : key === 'pv' ? { electricalPowerMeasurement: { powerMode: 1, activePower: 1000 } } : { electricalEnergyMeasurement: { cumulativeEnergyImported: null } } });
        }
        byKey.battery.clusters.powerSource.endpointList = [];
        byKey.battery.clusters.powerSource.batPercentRemaining = 198;
        await writeFile(join(storage, 'matter', '0EDE01020306', 'accessories.json'), JSON.stringify(cache));
      }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => logger.close(resolve));
    assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
    assert(basename(storage).startsWith('deye-matter-'));
    await rm(storage, { recursive: true, force: true });
  }
});
