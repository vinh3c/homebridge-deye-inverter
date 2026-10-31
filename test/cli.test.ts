import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';

test('CLI emits separate W/A/V with register diagnostics, no energy, using sequential compact reads', async () => {
  const requests: [number, number][] = [];
  const server = createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on('data', data => {
      input = Buffer.concat([input, data]);
      if (input.length < 12) return;
      const start = input.readUInt16BE(8), count = input.readUInt16BE(10);
      requests.push([start, count]);
      const reply = Buffer.alloc(9 + count * 2);
      input.copy(reply, 0, 0, 2);
      reply.writeUInt16BE(3 + count * 2, 4); reply[6] = 1; reply[7] = 3; reply[8] = count * 2;
      const words: Record<number, number> = { 90: 1500, 91: 1400, 109: 3800, 110: 25, 111: 4000, 112: 30, 150: 2300, 157: 2300, 160: 65535, 169: 65436, 178: 1800, 179: 800, 182: 1300, 183: 5120, 184: 83, 186: 940, 187: 1190, 190: 65036, 191: 64536 };
      for (let i = 0; i < count; i++) reply.writeUInt16BE(words[start + i] ?? 0, 9 + i * 2);
      socket.end(reply);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--once'], {
      env: { ...process.env, DOTENV_CONFIG_PATH: '.local/no-cli-test-env', MODBUS_HOST: '127.0.0.1', MODBUS_PORT: String(address.port), MODBUS_UNIT_ID: '1', DEYE_PROFILE: 'single', DC_REGISTER: '90', AC_REGISTER: '91', BATTERY_REGISTER: '182', BATTERY_SOC_REGISTER: '184', GRID_REGISTER: '150', DC_OFFSET: '1000', AC_OFFSET: '1000', BATTERY_OFFSET: '1000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr);
    const reading = JSON.parse(stdout);
    assert.equal(reading.pv1PowerW, 940); assert.equal(reading.pv2PowerW, 1190);
    assert.equal(reading.pv1VoltageV, 380); assert.equal(reading.pv2CurrentA, 3);
    assert.equal(reading.gridPowerW, -100); assert.equal(reading.gridCurrentA, -0.01);
    assert.equal(reading.loadPowerW, 1800); assert.equal(reading.loadVoltageV, 230); assert.equal(reading.loadCurrentA, 8);
    assert.equal(reading.batteryPowerW, -500); assert.equal(reading.batteryVoltageV, 51.2); assert.equal(reading.batteryCurrentA, -10);
    assert.equal(reading.batteryPercent, 83); assert.equal(reading.gridVoltageV, 230);
    for (const key of ['grid', 'contact', 'totalConsumptionEnergy', 'totalImportEnergy', 'energyUnit', 'pvTotalPowerW']) assert.equal(reading[key], undefined);
    assert.deepEqual(reading.raw.gridPower, { power: 65436, voltage: 2300, current: 65535 });
    assert.deepEqual(reading.registers.batteryPower, { power: 190, voltage: 183, current: 191 });
    assert.deepEqual(requests, [[90, 2], [109, 4], [150, 1], [157, 4], [169, 1], [178, 14]]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
