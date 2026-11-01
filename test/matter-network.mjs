// Test-only Matter transport: no UDP sockets, LAN advertisements or pairing.
// Modbus uses node:net independently and still reaches the loopback logger.
import '@matter/nodejs';
import { Environment, Network, NetworkSimulator } from '@matter/general';

const simulatedNetwork = new NetworkSimulator();
Environment.default.set(Network, simulatedNetwork.addHost(1));

// Inspect actual running endpoints, independently of the accessory JSON cache.
import { AccessoryManager } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
let dependencies;
const register = AccessoryManager.prototype.registerAccessory;
AccessoryManager.prototype.registerAccessory = async function (...args) {
  dependencies = args[3];
  return register.apply(this, args);
};
process.on('message', message => {
  if (message !== 'deye-endpoint-snapshot' || !dependencies) return;
  const endpoints = [...dependencies.accessories.values()].map(accessory => {
    const endpoint = accessory.endpoint;
    return {
      key: accessory.context.sensorKey, uuid: accessory.UUID, number: endpoint.number,
      label: endpoint.state.bridgedDeviceBasicInformation?.nodeLabel,
      manufacturer: endpoint.state.bridgedDeviceBasicInformation?.vendorName,
      model: endpoint.state.bridgedDeviceBasicInformation?.productName,
      serial: endpoint.state.bridgedDeviceBasicInformation?.serialNumber,
      servers: endpoint.state.descriptor.serverList,
      types: endpoint.state.descriptor.deviceTypeList,
      source: endpoint.behaviors.supported.powerSource ? {
        scope: endpoint.state.powerSource.endpointList,
        percent: endpoint.state.powerSource.batPercentRemaining,
      } : null,
    };
  });
  process.send?.({ type: 'deye-endpoint-snapshot', endpoints });
});
// The inspection channel must not keep Homebridge alive after SIGTERM.
process.channel?.unref();
