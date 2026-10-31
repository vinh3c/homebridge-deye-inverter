import { setTimeout as delay } from 'node:timers/promises';
import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import type { RegisterSnapshot } from './modbus.js';

// Single-phase hybrid map. Read reported active power; V * A is not active AC power.
export const electricalSensors = [
  { key: 'pv1', name: 'PV1', mode: 1, power: 186, voltage: 109, current: 110, voltageScale: 0.1, currentScale: 0.1, signed: false },
  { key: 'pv2', name: 'PV2', mode: 1, power: 187, voltage: 111, current: 112, voltageScale: 0.1, currentScale: 0.1, signed: false },
  { key: 'gridPower', name: 'Grid Power', mode: 2, power: 169, voltage: 150, current: 160, voltageScale: 0.1, currentScale: 0.01, signed: true },
  { key: 'loadPower', name: 'Load Power', mode: 2, power: 178, voltage: 157, current: 179, voltageScale: 0.1, currentScale: 0.01, signed: true },
  { key: 'batteryPower', name: 'Battery Power', mode: 1, power: 190, voltage: 183, current: 191, voltageScale: 0.01, currentScale: 0.01, signed: true },
] as const;
export const POWER_RANGES = electricalSensors.flatMap(sensor => [sensor.power, sensor.voltage, sensor.current].map(address => ({ address, count: 1 })));

export function decodeElectricalWord(raw: number | null, signed = false, scale = 1): number | null {
  if (raw === null || !Number.isInteger(raw) || raw < 0 || raw > 65535) return null;
  // 0xffff means -1 for signed registers, not an unavailable sentinel.
  if (!signed && raw === 65535) return null;
  return (signed && raw >= 32768 ? raw - 65536 : raw) * scale;
}

export function readElectrical(snapshot: RegisterSnapshot, sensor: typeof electricalSensors[number]) {
  const word = (address: number) => { try { return snapshot.get(address)[0]; } catch { return null; } };
  const raw = { power: word(sensor.power), voltage: word(sensor.voltage), current: word(sensor.current) };
  return {
    powerW: decodeElectricalWord(raw.power, sensor.signed),
    voltageV: decodeElectricalWord(raw.voltage, false, sensor.voltageScale),
    currentA: decodeElectricalWord(raw.current, sensor.signed, sensor.currentScale), raw,
  };
}

export class PowerSensors {
  private readonly cached = new Map<string, MatterAccessory>();
  private readonly uuids = new Map<string, string>();
  private readonly available = new Set<string>();
  private matter?: MatterAPI;
  constructor(private readonly log: Logging, private readonly api: API) {}
  configureAccessory(accessory: MatterAccessory): void { this.cached.set(accessory.UUID, accessory); }

  async setup(plugin: string, platform: string, stopped: () => boolean): Promise<void> {
    const matter = this.api.matter!;
    for (const sensor of electricalSensors) {
      if (stopped()) return;
      const uuid = matter.uuid.generate(`${plugin}:${sensor.key}`);
      const cached = this.cached.get(uuid) ?? [...this.cached.values()].find(item => item.context.sensorKey === sensor.key);
      const accessory: MatterAccessory = {
        UUID: cached?.UUID ?? uuid, displayName: sensor.name,
        deviceType: matter.deviceTypes.ElectricalSensor,
        manufacturer: 'Deye', model: 'Modbus TCP Inverter', serialNumber: `deye-${sensor.key}`,
        context: { sensorKey: sensor.key },
        clusters: {
          electricalPowerMeasurement: { powerMode: sensor.mode, activePower: null, voltage: null, activeCurrent: null },
          bridgedDeviceBasicInformation: { reachable: false },
        },
      };
      await matter.registerPlatformAccessories(plugin, platform, [accessory]);
      const deadline = Date.now() + 5000;
      while (!stopped() && await matter.getAccessoryState(accessory.UUID, 'electricalPowerMeasurement') === undefined) {
        if (Date.now() >= deadline) throw new Error(`${sensor.name}: Matter endpoint did not become ready within 5 seconds`);
        await delay(50);
      }
      if (stopped()) return;
      this.uuids.set(sensor.key, accessory.UUID);
      await matter.updateAccessoryState(accessory.UUID, 'electricalPowerMeasurement', { activePower: null, voltage: null, activeCurrent: null });
      await matter.updateAccessoryState(accessory.UUID, 'bridgedDeviceBasicInformation', { reachable: false });
      this.log.info(`${cached ? 'Restored' : 'Added'} Matter accessory: ${sensor.name}`);
    }
    if (stopped()) return;
    const obsolete = [...this.cached.values()].filter(item => ['grid', 'pv', 'totalConsumptionEnergy', 'totalImportEnergy'].includes(item.context.sensorKey));
    if (obsolete.length) {
      await matter.unregisterPlatformAccessories(plugin, platform, obsolete);
      this.log.info(`Removed obsolete Matter accessories: ${obsolete.map(item => item.displayName).join(', ')}`);
    }
    this.matter = matter;
  }

  async publish(snapshot: RegisterSnapshot, stopped: () => boolean): Promise<void> {
    if (!this.matter) return;
    const matter = this.matter;
    const milli = (value: number | null) => value === null ? null : Math.round(value * 1000);
    for (const sensor of electricalSensors) {
      if (stopped()) return;
      const uuid = this.uuids.get(sensor.key)!;
      const reading = readElectrical(snapshot, sensor);
      try {
        await matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', {
          activePower: milli(reading.powerW), voltage: milli(reading.voltageV), activeCurrent: milli(reading.currentA),
        });
        const complete = [reading.powerW, reading.voltageV, reading.currentA].every(value => value !== null);
        await matter.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: complete });
        const message = `${sensor.name}: ${reading.powerW} W, ${reading.voltageV} V, ${reading.currentA} A (registers=${sensor.power},${sensor.voltage},${sensor.current}; raw=${reading.raw.power},${reading.raw.voltage},${reading.raw.current})`;
        if (!complete) { this.available.delete(sensor.key); this.log.warn(`${message}; incomplete reading, will retry next cycle.`); }
        else { if (this.available.has(sensor.key)) this.log.debug(message); else this.log.info(message); this.available.add(sensor.key); }
      } catch (error) {
        this.available.delete(sensor.key);
        this.log.warn(`${sensor.name} Matter update failed: ${String(error)}. Will retry next cycle.`);
        try {
          await matter.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: false });
          await matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', { activePower: null, voltage: null, activeCurrent: null });
        } catch (updateError) { this.log.warn(`Could not mark ${sensor.name} unavailable: ${String(updateError)}`); }
      }
    }
  }
}
