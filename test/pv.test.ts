import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegisterSnapshot, groupRegisterRanges } from '../src/modbus.js';
import { decodePvWord, PV_RANGES, readPvPower } from '../src/pv.js';

test('PV reports sum of inverter watts, including valid zero readings', () => {
  const snapshot = new RegisterSnapshot();
  snapshot.set({ address: 186, count: 2 }, [940, 1190]);
  assert.deepEqual(readPvPower(snapshot), { powerW: 2130, raw: [940, 1190] });
  snapshot.set({ address: 186, count: 2 }, [0, 0]);
  assert.equal(readPvPower(snapshot).powerW, 0);
  snapshot.set({ address: 186, count: 2 }, [0, 1190]);
  assert.equal(readPvPower(snapshot).powerW, 1190);
  assert.equal(decodePvWord(65535), null);
  assert.equal(decodePvWord(null), null);
});

test('PV does not report a partial sum when one input is unavailable; full poll uses three compact requests', () => {
  const snapshot = new RegisterSnapshot();
  snapshot.set({ address: 186, count: 2 }, [65535, 1190]);
  assert.equal(readPvPower(snapshot).powerW, null);
  snapshot.set({ address: 186, count: 2 }, new Error('read failed'));
  assert.equal(readPvPower(snapshot).powerW, null);
  assert.deepEqual(groupRegisterRanges([
    { address: 78, count: 3 }, { address: 85, count: 2 }, { address: 90, count: 2 },
    { address: 150, count: 1 }, { address: 182, count: 1 }, { address: 184, count: 1 }, ...PV_RANGES,
  ]), [{ address: 78, count: 14 }, { address: 150, count: 1 }, { address: 182, count: 6 }]);
});
