import { setTimeout as delay } from 'node:timers/promises';
import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import type { RegisterSnapshot } from './modbus.js';

export const PV_RANGES = [{ address: 186, count: 2 }];

export function decodePvWord(raw: number | null): number | null {
  return raw !== null && Number.isInteger(raw) && raw >= 0 && raw < 0xffff ? raw : null;
}

export function readPvPower(snapshot: RegisterSnapshot) {
  const word = (address: number) => {
    try { return snapshot.get(address)[0]; }
    catch { return null; }
  };
  const raw = [word(186), word(187)];
  const powers = raw.map(value => decodePvWord(value));
  return { powerW: powers.every(value => value !== null) ? powers[0]! + powers[1]! : null, raw };
}

export class PvSensors {
  private readonly cached = new Map<string, MatterAccessory>();
  private uuid?: string;
  private available = false;
  private matter?: MatterAPI;

  constructor(private readonly log: Logging, private readonly api: API) {}

  configureAccessory(accessory: MatterAccessory): void {
    if (['pv', 'pv1', 'pv2'].includes(accessory.context.sensorKey)) this.cached.set(accessory.UUID, accessory);
  }

  async setup(plugin: string, platform: string, stopped: () => boolean): Promise<void> {
    if (stopped()) return;
    const matter = this.api.matter!;
    const uuid = matter.uuid.generate(`${plugin}:pv`);
    const cached = this.cached.get(uuid) ?? [...this.cached.values()].find(item => item.context.sensorKey === 'pv');
    const accessory: MatterAccessory = {
      UUID: cached?.UUID ?? uuid, displayName: 'PV',
      deviceType: matter.deviceTypes.ElectricalSensor,
      manufacturer: 'Deye', model: 'PV Total Power', serialNumber: `${plugin}-pv`,
      context: { sensorKey: 'pv' },
      clusters: {
        // Total instantaneous DC generation in mW, without inventing a combined
        // voltage/current for independent MPPT inputs or a cumulative kWh value.
        electricalPowerMeasurement: { powerMode: 1, activePower: null },
        bridgedDeviceBasicInformation: { reachable: false },
      },
    };
    if (!cached) await matter.registerPlatformAccessories(plugin, platform, [accessory]);
    const deadline = Date.now() + 5000;
    while (!stopped() && await matter.getAccessoryState(accessory.UUID, 'electricalPowerMeasurement') === undefined) {
      if (Date.now() >= deadline) throw new Error('PV: Matter endpoint did not become ready within 5 seconds');
      await delay(50);
    }
    if (stopped()) return;
    this.uuid = accessory.UUID;
    await matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', { activePower: null });
    await matter.updateAccessoryState(this.uuid, 'bridgedDeviceBasicInformation', { reachable: false });
    const legacy = [...this.cached.values()].filter(item => ['pv1', 'pv2'].includes(item.context.sensorKey));
    if (legacy.length) await matter.unregisterPlatformAccessories(plugin, platform, legacy);
    this.matter = matter;
    this.log.info(`${cached ? 'Restored' : 'Added'} Matter accessory: PV (total power, registers 186-187)`);
  }

  async publish(snapshot: RegisterSnapshot, stopped: () => boolean): Promise<void> {
    if (!this.matter || !this.uuid || stopped()) return;
    const reading = readPvPower(snapshot);
    try {
      await this.matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', { activePower: reading.powerW === null ? null : reading.powerW * 1000 });
      await this.matter.updateAccessoryState(this.uuid, 'bridgedDeviceBasicInformation', { reachable: reading.powerW !== null });
      const message = `PV Total Power: ${reading.powerW} W (registers=186-187, raw=${reading.raw.join(',')})`;
      if (reading.powerW === null) {
        this.available = false;
        this.log.warn(`${message}; unavailable PV reading, will retry next cycle.`);
      } else {
        if (this.available) this.log.debug(message);
        else this.log.info(message);
        this.available = true;
      }
    } catch (error) {
      this.available = false;
      this.log.warn(`PV Matter update failed: ${String(error)}. Will retry next cycle.`);
      try {
        await this.matter.updateAccessoryState(this.uuid, 'bridgedDeviceBasicInformation', { reachable: false });
        await this.matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', { activePower: null });
      } catch (updateError) { this.log.warn(`Could not mark PV unavailable: ${String(updateError)}`); }
    }
  }
}
