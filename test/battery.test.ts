import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MatterAccessory, MatterAPI } from 'homebridge';
import { PowerSourceServer } from '@matter/node/behaviors/power-source';
import { PowerSource } from '@matter/types/clusters/power-source';
import { TlvOfModel } from '@matter/types/tlv';
import { deviceTypes } from '../node_modules/homebridge/dist/matter/types.js';
import { AccessoryManager } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import { createBatteryTemperatureType, readBatteryEndpointList } from '../src/battery.js';

const batterySource = PowerSourceServer.with('Battery', 'Rechargeable');

function batteryAccessory(onScope?: (endpoint: number) => void): MatterAccessory {
  return {
    UUID: 'battery-scope-test', displayName: 'Battery Temperature',
    deviceType: createBatteryTemperatureType({ deviceTypes } as MatterAPI, onScope),
    manufacturer: 'Deye', model: 'Modbus TCP Inverter', serialNumber: 'scope-test', context: {},
    clusters: {
      temperatureMeasurement: { measuredValue: null },
      powerSource: {
        status: 0, order: 0, description: 'Deye storage battery',
        batPercentRemaining: null, batPresent: true, batChargeState: 0, batFunctionalWhileCharging: true,
      },
    },
  };
}

// Exercise Homebridge's real device-type preparation, then invoke the custom
// initialization hook with assigned endpoint numbers. No Matter node, bridge,
// endpoint owner, transport or device advertisement is started by this test.
async function preparedHook(onScope?: (endpoint: number) => void) {
  const accessory = batteryAccessory(onScope);
  const declared = accessory.deviceType.behaviors.temperatureMeasurement;
  const { deviceType } = await new AccessoryManager().prepareDeviceType(accessory);
  assert.equal(deviceType.behaviors.temperatureMeasurement, declared, 'Homebridge must retain the scope initialization hook');
  assert(deviceType.behaviors.powerSource, 'Homebridge must compose the declared PowerSource');
  return { hook: declared.prototype.initialize, sourceBehavior: deviceType.behaviors.powerSource };
}

test('battery source defaults to node scope, and the custom initializer replaces it with the assigned endpoint only', async () => {
  const assigned: number[] = [];
  const { hook, sourceBehavior } = await preparedHook(endpoint => assigned.push(endpoint));
  const schema = TlvOfModel(PowerSource.attributes.endpointList);
  for (const number of [2, 37, 61439]) {
    const own = new batterySource.State();
    assert.deepEqual(own.endpointList, [], 'the Matter default means the entire node, not just this sensor');
    own.batPercentRemaining = 166;
    own.status = 1;
    await hook.call({
      endpoint: { number, behaviors: { supported: { powerSource: sourceBehavior } } },
      agent: { load: async (behavior: unknown) => {
        assert.equal(behavior, sourceBehavior);
        return { state: own };
      } },
    });
    assert.deepEqual(own.endpointList, [number]);
    assert.equal(own.batPercentRemaining, null, 'cached SOC must not reactivate before a fresh inverter read');
    assert.equal(own.status, 0);
    assert.deepEqual(schema.decode(schema.encode(own.endpointList)), [number]);
  }
  assert.deepEqual(assigned, [2, 37, 61439], 'scope persistence receives the actual assigned endpoint');
});

test('scope readback accepts only one assigned application endpoint', () => {
  for (const endpointList of [undefined, [], [0], [65535], [-1], [1.5], ['37'], [37, 83]]) {
    assert.throws(() => readBatteryEndpointList({ endpointList }), /scope/i);
  }
  assert.throws(() => readBatteryEndpointList(undefined), /scope/i);
  assert.throws(() => readBatteryEndpointList({ endpointList: [83] }, 37), /match/i);
  assert.deepEqual(readBatteryEndpointList({ endpointList: [37] }, 37), [37]);
  const state = { endpointList: [37] };
  const result = readBatteryEndpointList(state);
  assert.deepEqual(result, [37]);
  result.push(83);
  assert.deepEqual(state.endpointList, [37], 'callers must not mutate the live endpoint list through a shared array');
});

test('battery scope initializer fails when its power source or assigned endpoint is unavailable', async () => {
  const { hook, sourceBehavior } = await preparedHook();
  await assert.rejects(hook.call({
    endpoint: { number: 37, behaviors: { supported: {} } },
    agent: { load: async () => { throw new Error('must not load a missing behavior'); } },
  }), /powerSource|PowerSource|scope/i);
  await assert.rejects(hook.call({
    endpoint: { number: undefined, behaviors: { supported: { powerSource: sourceBehavior } } },
    agent: { load: async () => ({ state: new batterySource.State() }) },
  }), /endpoint|scope/i);
});
