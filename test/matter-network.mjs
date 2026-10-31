// Test-only Matter transport: no UDP sockets, LAN advertisements or pairing.
// Modbus uses node:net independently and still reaches the loopback logger.
import '@matter/nodejs';
import { Environment, Network, NetworkSimulator } from '@matter/general';

const simulatedNetwork = new NetworkSimulator();
Environment.default.set(Network, simulatedNetwork.addHost(1));
