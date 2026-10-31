import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import { ElectricalSensorEndpoint } from '@matter/node/endpoints/electrical-sensor';
import { ElectricalEnergyMeasurement } from '@matter/types/clusters/electrical-energy-measurement';
import { TlvAny, TlvOfModel } from '@matter/types/tlv';
import {
  applyElectricalMeasurementClusters,
  applyElectricalMeasurementDefaults,
  detectElectricalMeasurementClusters,
} from '../node_modules/homebridge/dist/matter/serverHelpers.js';
import { TotalConsumptionEnergy, TotalImportEnergy } from '../src/energy.js';

// Record the plugin's declarations and updates without starting Homebridge, a
// Matter node, a transport or a Modbus connection. The assertions below use
// Homebridge's real behavior builders and Matter's actual on-wire TLV schema.
async function captureMeters() {
  const registrations: MatterAccessory[] = [];
  const states = new Map<string, Record<string, any>>();
  const matter = {
    uuid: { generate: (value: string) => value },
    deviceTypes: { ElectricalSensor: ElectricalSensorEndpoint },
    registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      registrations.push(...accessories);
      for (const accessory of accessories) states.set(accessory.UUID, structuredClone(accessory.clusters!));
    },
    getAccessoryState: async (uuid: string, cluster: string) => states.get(uuid)?.[cluster],
    updateAccessoryState: async (uuid: string, cluster: string, attributes: object) => {
      Object.assign(states.get(uuid)![cluster], attributes);
    },
  } as unknown as MatterAPI;
  const api = { isMatterEnabled: () => true, matter } as unknown as API;
  const log = { info() {}, warn() {}, debug() {} } as unknown as Logging;
  const meters = [new TotalConsumptionEnergy(log, api), new TotalImportEnergy(log, api)];
  for (const meter of meters) await meter.setup('protocol-test', 'DeyeInverter');
  return { registrations, states, meters };
}

test('real Homebridge builders enable cumulative imported energy and required topology for both plugin meters', async () => {
  const { registrations } = await captureMeters();
  assert.equal(registrations.length, 2);
  assert.notEqual(registrations[0].UUID, registrations[1].UUID);
  for (const accessory of registrations) {
    const detection = detectElectricalMeasurementClusters(accessory);
    assert.deepEqual(detection, { hasPowerMeasurement: false, energyFeatures: ['ImportedEnergy', 'CumulativeEnergy'] });
    applyElectricalMeasurementDefaults(accessory, detection);
    const type = applyElectricalMeasurementClusters(ElectricalSensorEndpoint, accessory, detection);
    const energy = type.behaviors.electricalEnergyMeasurement;
    const topology = type.behaviors.powerTopology;
    assert.equal(energy.cluster.id, 0x0091);
    assert.equal(energy.cluster.attributes.cumulativeEnergyImported.id, 0x0001);
    assert.equal(topology.cluster.id, 0x009c);
    assert.equal(topology.features.treeTopology, true);
    const state = new energy.State();
    assert.equal(state.featureMap.importedEnergy, true);
    assert.equal(state.featureMap.cumulativeEnergy, true);
    assert.equal(state.featureMap.exportedEnergy, false);
    assert.equal(state.featureMap.periodicEnergy, false);
    assert.equal(state.cumulativeEnergyImported, null);
    assert.equal(state.cumulativeEnergyExported, undefined);
    assert.equal(state.periodicEnergyImported, undefined);
    assert.equal(type.behaviors.electricalPowerMeasurement, undefined, 'a lifetime counter does not invent instantaneous watts');
    assert.equal(accessory.clusters!.electricalEnergyMeasurement!.accuracy!.measurementType, 14);
    assert.equal(accessory.clusters!.electricalEnergyMeasurement!.cumulativeEnergyReset, undefined);
    assert.equal(typeof energy.prototype.setMeasurement, 'function', 'Homebridge must retain the server helper that emits energy events');
  }
});

test('plugin energy survives real Matter TLV as mWh and converts Unix timestamp exactly once', async () => {
  const { registrations, states, meters } = await captureMeters();
  const options = { host: 'unused', port: 502, unitId: 1, timeoutMs: 1 };
  await meters[0].poll(options, () => false, async () => [100, 1]);
  await meters[1].poll(options, () => false, async () => [50, 1]);
  const schema = TlvOfModel(ElectricalEnergyMeasurement.attributes.cumulativeEnergyImported);
  const expected = [6_563_600_000, 6_558_600_000];
  for (const [index, accessory] of registrations.entries()) {
    const reading = states.get(accessory.UUID)!.electricalEnergyMeasurement.cumulativeEnergyImported;
    assert.equal(reading.energy, expected[index], 'a value above uint32 must remain an exact energy counter');
    assert(Math.abs(reading.endTimestamp - Date.now() / 1000) < 5);
    assert.equal(reading.startTimestamp, undefined, 'the lifetime counter has no known start date');
    const encoded = schema.encode(reading);
    const decoded = schema.decode(encoded) as typeof reading;
    assert.deepEqual({ ...decoded, energy: Number(decoded.energy) }, reading);
    const fields = TlvAny.decode(encoded);
    const energyField = fields.find(field => field.tag?.id === 0)!;
    const endField = fields.find(field => field.tag?.id === 2)!;
    assert.equal(Number(energyField.value), expected[index]);
    assert.equal(Number(endField.value), reading.endTimestamp - 946_684_800, 'wire time uses the Matter epoch; API time uses Unix');
    assert.equal(fields.find(field => field.tag?.id === 1), undefined, 'no invented start timestamp goes on the wire');
  }
  assert.equal(schema.decode(schema.encode(null)), null, 'unavailable is nullable, distinct from zero');
  const zero = { energy: 0, endTimestamp: Math.floor(Date.now() / 1000) };
  assert.deepEqual(schema.decode(schema.encode(zero)), zero);
});

test('real Matter schema rejects the historical double-converted energy timestamp', () => {
  const schema = TlvOfModel(ElectricalEnergyMeasurement.attributes.cumulativeEnergyImported);
  const unixTimestamp = Math.floor(new Date('2026-10-31T10:00:00Z').getTime() / 1000);
  assert.throws(
    () => schema.encode({ energy: 570_700_000, endTimestamp: unixTimestamp - 946_684_800 }),
    /epoch|convert/i,
  );
});
