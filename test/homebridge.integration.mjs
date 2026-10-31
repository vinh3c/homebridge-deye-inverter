import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('real Homebridge loads the built plugin and exposes three sensors over HAP', { timeout: 30000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'deye-homebridge-'));
  const logger = createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 12) return;
      const raw = { 90: 1624, 91: 1559, 182: 1340 }[data.readUInt16BE(8)];
      const reply = Buffer.from([0, 0, 0, 0, 0, 5, 1, 3, 2, 0, 0]);
      data.copy(reply, 0, 0, 2);
      reply.writeUInt16BE(raw, 9);
      socket.end(reply);
    });
  });
  await new Promise(resolve => logger.listen(0, '127.0.0.1', resolve));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const hapPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await writeFile(join(storage, 'config.json'), JSON.stringify({
    bridge: { name: 'Deye Test Bridge', username: '0E:DE:01:02:03:04', pin: '031-45-154', port: hapPort, bind: ['127.0.0.1'], advertiser: 'ciao' },
    platforms: [{ platform: 'DeyeInverter', host: '127.0.0.1', port: logger.address().port }],
    accessories: [],
  }));
  let output = '';
  const pluginPath = resolve(process.env.DEYE_TEST_PLUGIN_PATH ?? '.');
  const child = spawn(process.execPath, [resolve('node_modules/homebridge/bin/homebridge'), '-I', '-Q', '-U', storage, '-P', pluginPath, '--strict-plugin-resolution'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    let sensors = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${hapPort}/accessories`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        sensors = body.accessories.flatMap(a => a.services).filter(s => s.type === '8A');
        const temperatures = sensors.map(s => s.characteristics.find(c => c.type === '11')?.value);
        if (sensors.length === 3 && temperatures.every(v => typeof v === 'number' && v > 0)) break;
      } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.equal(sensors.length, 3, output);
    const names = sensors.map(s => s.characteristics.find(c => c.type === '23').value);
    assert.deepEqual(names.sort(), ['AC Temperature', 'Battery Temperature', 'DC Temperature']);
    const temperatures = sensors.map(s => Number(s.characteristics.find(c => c.type === '11').value.toFixed(1)));
    assert.deepEqual(temperatures.sort((a, b) => a - b), [34, 55.9, 62.4]);
    // Verify Homebridge's persisted accessory cache, not just plugin API calls.
    await delay(100);
    const cache = JSON.parse(await readFile(join(storage, 'accessories', 'cachedAccessories'), 'utf8'));
    assert.equal(cache.length, 3);
    assert.match(output, /Plugin loaded \(Homebridge /, 'entry point must log even before platform setup');
    assert.match(output, /Starting DeyeInverter platform/);
    for (const name of ['DC Temperature', 'AC Temperature', 'Battery Temperature']) {
      assert(output.includes(`Added accessory: ${name}`), `Missing accessory registration log: ${name}`);
      assert(output.includes(`${name}: `), `Missing first temperature reading log: ${name}`);
    }
    assert(!output.includes('SETUP REQUIRED'), 'configured platform must not emit a missing configuration warning');
    console.log(output);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => logger.close(resolve));
    assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
    assert(basename(storage).startsWith('deye-homebridge-'));
    await rm(storage, { recursive: true, force: true });
  }
});
