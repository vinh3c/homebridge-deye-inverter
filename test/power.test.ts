import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegisterSnapshot, groupRegisterRanges } from '../src/modbus.js';
import { decodeElectricalWord, electricalSensors, POWER_RANGES, readElectrical } from '../src/power.js';

test('electrical words preserve signed -1, charging/export and valid zero; unsigned sentinel is unavailable', () => {
  assert.equal(decodeElectricalWord(65535, true), -1);
  assert.equal(decodeElectricalWord(65036, true), -500);
  assert.equal(decodeElectricalWord(64536, true, 0.01), -10);
  assert.equal(decodeElectricalWord(65535), null);
  assert.equal(decodeElectricalWord(0), 0);
  for (const raw of [null, -1, 65536, NaN, 1.5]) assert.equal(decodeElectricalWord(raw), null);
});

test('PV inputs remain independent and partial failures preserve other attributes and sensors', () => {
  const snapshot = new RegisterSnapshot();
  snapshot.set({ address: 186, count: 2 }, [65535, 1190]);
  snapshot.set({ address: 109, count: 4 }, [3800, 25, 4000, 30]);
  assert.deepEqual(readElectrical(snapshot, electricalSensors[0]), { powerW: null, voltageV: 380, currentA: 2.5, raw: { power: 65535, voltage: 3800, current: 25 } });
  assert.equal(readElectrical(snapshot, electricalSensors[1]).powerW, 1190);
  snapshot.set({ address: 109, count: 4 }, new Error('failed block'));
  assert.equal(readElectrical(snapshot, electricalSensors[1]).voltageV, null);
  assert.equal(readElectrical(snapshot, electricalSensors[1]).powerW, 1190);
});

test('full polling batches only nearby registers and omits retired energy registers', () => {
  assert.deepEqual(groupRegisterRanges([
    { address: 90, count: 2 }, { address: 182, count: 3 }, { address: 150, count: 1 }, ...POWER_RANGES,
  ]), [
    { address: 90, count: 2 }, { address: 109, count: 4 }, { address: 150, count: 1 }, { address: 157, count: 4 },
    { address: 169, count: 1 }, { address: 178, count: 14 },
  ]);
});
