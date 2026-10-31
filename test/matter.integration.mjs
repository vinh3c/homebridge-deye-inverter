import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('all seven accessories use real Matter endpoints and restore after restart without HAP sensors', { timeout: 45000 }, async () => {
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
      for (let i = 0; i < count; i++) reply.writeUInt16BE({ 78: 50, 79: 5000, 80: 1, 85: 100, 86: 1, 90: 1500, 91: 1400, 109: 3800, 110: 25, 111: 4000, 112: 30, 186: 940, 187: 1190, 182: 1300, 184: batterySoc, 150: 2300 }[address + i] ?? 0, 9 + i * 2);
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
  try {
    for (const run of ['Added', 'Restored']) {
      batterySoc = run === 'Added' ? 83 : 27;
      let output = '';
      child = spawn(process.execPath, ['--import', pathToFileURL(resolve('test/matter-network.mjs')).href, resolve('node_modules/homebridge/bin/homebridge.js'), '-D', '-U', storage, '-P', resolve('.'), '--strict-plugin-resolution'], { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      const deadline = Date.now() + 15000;
      while (!output.includes('Total Import Energy: 6558.6 kWh') && Date.now() < deadline && child.exitCode === null) await delay(50);
      assert(output.includes(`${run} Matter accessory: Total Consumption Energy`), output);
      assert(output.includes('Total Consumption Energy: 6563.6 kWh'), output);
      assert(output.includes(`${run} Matter accessory: Total Import Energy`), output);
      assert(output.includes('Total Import Energy: 6558.6 kWh'), output);
      assert(output.includes('energyImported: { energy: 6563600000'), output);
      assert(!output.includes('Failed to update'), output);
      // Wait for Homebridge's debounced cache write, then verify its actual state.
      await delay(2200);
      const cache = JSON.parse(await readFile(join(storage, 'matter', '0EDE01020306', 'accessories.json'), 'utf8'));
      assert.equal(cache.length, 7);
      const byKey = Object.fromEntries(cache.map(accessory => [accessory.context.sensorKey, accessory]));
      assert.equal(byKey.dc.deviceType.name, 'TemperatureSensor');
      assert.equal(byKey.dc.clusters.temperatureMeasurement.measuredValue, 5000);
      assert.equal(byKey.ac.clusters.temperatureMeasurement.measuredValue, 4000);
      assert.equal(byKey.battery.clusters.temperatureMeasurement.measuredValue, 3000);
      assert.equal(byKey.battery.clusters.powerSource.batPercentRemaining, batterySoc * 2);
      assert.equal(byKey.battery.clusters.powerSource.description, 'Deye storage battery');
      for (const key of ['pv']) {
        assert.equal(byKey[key].deviceType.name, 'ElectricalSensor');
        assert.equal(byKey[key].clusters.electricalPowerMeasurement.powerMode, 1);
        assert.equal(byKey[key].clusters.bridgedDeviceBasicInformation.reachable, true);
      }
      assert.equal(byKey.pv.clusters.electricalPowerMeasurement.activePower, 2130000);
      assert.equal(byKey.pv.clusters.electricalPowerMeasurement.voltage, undefined);
      assert.equal(byKey.pv.clusters.electricalPowerMeasurement.activeCurrent, undefined);
      assert.equal(byKey.pv1, undefined);
      assert.equal(byKey.pv2, undefined);
      assert.equal(byKey.grid.deviceType.name, 'ContactSensor');
      assert.equal(byKey.grid.clusters.booleanState.stateValue, true);
      for (const key of ['dc', 'ac', 'battery', 'grid']) assert.equal(byKey[key].clusters.bridgedDeviceBasicInformation.reachable, true);
      assert.equal(byKey.totalConsumptionEnergy.deviceType.name, 'ElectricalSensor');
      assert.equal(byKey.totalImportEnergy.deviceType.name, 'ElectricalSensor');
      assert.notEqual(byKey.totalImportEnergy.uuid, byKey.totalConsumptionEnergy.uuid);
      assert.equal(byKey.totalImportEnergy.clusters.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 6_558_600_000);
      assert(output.includes('Ready (Matter): DC Temperature, AC Temperature, Battery Temperature, Grid, Total Consumption Energy'), output);
      assert(!output.includes('Added accessory:'), 'plugin must not register HAP accessories');
      const measurement = byKey.totalConsumptionEnergy.clusters.electricalEnergyMeasurement.cumulativeEnergyImported;
      assert.equal(measurement.energy, 6_563_600_000);
      assert(Math.abs(measurement.endTimestamp - Date.now() / 1000) < 15);
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      child = undefined;
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
