import type { API, MatterAccessory, MatterAPI, Logging } from 'homebridge';
import { setTimeout as delay } from 'node:timers/promises';
import { readHoldingRegisters, type ConnectionOptions } from './modbus.js';

export const TOTAL_CONSUMPTION_REGISTER = 85;
export const TOTAL_IMPORT_LOW_REGISTER = 78;
export const TOTAL_IMPORT_HIGH_REGISTER = 80;

const consumption = { key: 'totalConsumptionEnergy', name: 'Total Consumption Energy', low: 85, high: 86, serial: 'deye-total-consumption' };
const gridImport = { key: 'totalImportEnergy', name: 'Total Import Energy', low: TOTAL_IMPORT_LOW_REGISTER, high: TOTAL_IMPORT_HIGH_REGISTER, serial: 'deye-total-import' };

export function decodeTotalConsumptionEnergy(low: number, high: number): number {
  for (const word of [low, high]) {
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) throw new Error('Invalid energy register word');
  }
  // Unsigned 32-bit, low word first. Each tick is 0.1 kWh = 100,000 mWh.
  // Arithmetic avoids JavaScript's signed 32-bit bitwise conversion.
  return (high * 65536 + low) * 100_000;
}

class CumulativeEnergy {
  private cached?: MatterAccessory;
  private matter?: MatterAPI;
  private uuid?: string;
  private lastAttempt?: number;
  private available = false;

  constructor(private readonly log: Logging, private readonly api: API, private readonly definition = consumption) {}

  configureAccessory(accessory: MatterAccessory): void {
    if (accessory.context.sensorKey === this.definition.key) this.cached = accessory;
  }

  async setup(plugin: string, platform: string): Promise<void> {
    if (!this.api.isMatterEnabled?.() || !this.api.matter?.deviceTypes.ElectricalSensor) {
      this.log.warn(`${this.definition.name} requires Homebridge >= 2.2 with Matter enabled.`);
      return;
    }
    const matter = this.api.matter;
    this.uuid = this.cached?.UUID ?? matter.uuid.generate(`${plugin}:${this.definition.key}`);
    const accessory: MatterAccessory = {
      UUID: this.uuid,
      displayName: this.definition.name,
      deviceType: matter.deviceTypes.ElectricalSensor,
      serialNumber: this.definition.serial,
      manufacturer: 'Deye',
      model: 'SUN-6K-SG05LP1-EU-SM2-P',
      context: { sensorKey: this.definition.key },
      clusters: { electricalEnergyMeasurement: { cumulativeEnergyImported: null } },
    };
    if (!this.cached) await matter.registerPlatformAccessories(plugin, platform, [accessory]);
    // Homebridge dispatches registration through an event; its Promise can resolve
    // before the Matter endpoint exists. Wait before sending the initial state.
    const deadline = Date.now() + 5000;
    while (await matter.getAccessoryState(this.uuid, 'electricalEnergyMeasurement') === undefined) {
      if (Date.now() >= deadline) throw new Error('Matter energy endpoint did not become ready within 5 seconds');
      await delay(50);
    }
    // Cached measurements must not look current before the first successful read.
    this.matter = matter;
    await this.updateMeasurement(null);
    this.log.info(`${this.cached ? 'Restored' : 'Added'} Matter accessory: ${this.definition.name} (registers ${this.definition.low},${this.definition.high})`);
  }

  private async updateMeasurement(reading: { energy: number; endTimestamp: number } | null): Promise<void> {
    const matter = this.matter!;
    const uuid = this.uuid!;
    await matter.updateAccessoryState(uuid, 'electricalEnergyMeasurement', { cumulativeEnergyImported: reading });
    // State updates are also dispatched asynchronously by Homebridge. Read back
    // the endpoint so logs describe an applied measurement, not only a queued one.
    const deadline = Date.now() + 2000;
    for (;;) {
      const state = await matter.getAccessoryState(uuid, 'electricalEnergyMeasurement');
      const actual = state?.cumulativeEnergyImported;
      if (reading === null ? actual === null : actual != null && Number(actual.energy) === reading.energy && actual.endTimestamp === reading.endTimestamp) return;
      if (Date.now() >= deadline) throw new Error('Matter endpoint did not apply energy measurement within 2 seconds');
      await delay(25);
    }
  }

  isDue(): boolean {
    return !!this.matter && !!this.uuid && (this.lastAttempt === undefined || Date.now() - this.lastAttempt >= 60_000);
  }

  async poll(options: ConnectionOptions, stopped: () => boolean, readEnergy = async () => {
    const { low, high } = this.definition;
    const words = await readHoldingRegisters(options, low, high - low + 1);
    return [words[0], words[high - low]];
  }): Promise<void> {
    if (!this.isDue() || stopped()) return;
    this.lastAttempt = Date.now();
    try {
      // One request captures both words together; do not read high/low separately.
      const raw = await readEnergy();
      const totalConsumptionEnergyMWh = decodeTotalConsumptionEnergy(raw[0], raw[1]);
      const endTimestamp = Math.floor(Date.now() / 1000); // Homebridge/Matter.js API uses Unix epoch seconds.
      if (stopped()) return;
      await this.updateMeasurement({ energy: totalConsumptionEnergyMWh, endTimestamp });
      const message = `${this.definition.name}: ${totalConsumptionEnergyMWh / 1_000_000} kWh (registers=${this.definition.low},${this.definition.high}, raw=${raw.join(',')})`;
      if (!this.available) this.log.info(message);
      else this.log.debug(message);
      this.available = true;
    } catch (error) {
      if (stopped()) return;
      this.available = false;
      this.log.warn(`${this.definition.name} read/update failed at ${options.host}:${options.port}, registers ${this.definition.low},${this.definition.high}: ${error instanceof Error ? error.message : String(error)}. Will retry in 60 seconds.`);
      try {
        await this.updateMeasurement(null);
      } catch (updateError) {
        this.log.warn(`Could not mark Matter energy unavailable: ${String(updateError)}`);
      }
    }
  }
}

export class TotalConsumptionEnergy extends CumulativeEnergy {
  constructor(log: Logging, api: API) { super(log, api, consumption); }
}

export class TotalImportEnergy extends CumulativeEnergy {
  constructor(log: Logging, api: API) { super(log, api, gridImport); }
}
