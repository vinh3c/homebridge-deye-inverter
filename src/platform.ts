import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, MatterAPI, PlatformAccessory, PlatformConfig } from 'homebridge';
import { setTimeout as delay } from 'node:timers/promises';
import { TotalConsumptionEnergy, TotalImportEnergy } from './energy.js';
import { PvSensors, PV_RANGES } from './pv.js';
import { decodeBatteryPercent, decodeTemperature, readRegisterRanges, type ConnectionOptions, type RegisterRange } from './modbus.js';

export const PLUGIN_NAME = 'homebridge-deye-inverter';
export const PLATFORM_NAME = 'DeyeInverter';
const sensors = [
  { key: 'dc', name: 'DC Temperature', register: 90, kind: 'temperature' },
  { key: 'ac', name: 'AC Temperature', register: 91, kind: 'temperature' },
  { key: 'battery', name: 'Battery Temperature', register: 182, kind: 'temperature' },
  { key: 'grid', name: 'Grid', register: 150, kind: 'contact' },
] as const;

export class DeyePlatform implements DynamicPlatformPlugin {
  private static readonly initialized = new WeakSet<API>();
  static isInitialized(api: API): boolean { return DeyePlatform.initialized.has(api); }
  private readonly legacy: PlatformAccessory[] = [];
  private readonly cached = new Map<string, MatterAccessory>();
  private readonly uuids = new Map<string, string>();
  private readonly available = new Set<string>();
  private gridPresent?: boolean;
  private readonly options!: ConnectionOptions;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly energy: TotalConsumptionEnergy;
  private readonly importEnergy: TotalImportEnergy;
  private readonly pv: PvSensors;
  private matter?: MatterAPI;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    this.energy = new TotalConsumptionEnergy(log, api);
    this.importEnergy = new TotalImportEnergy(log, api);
    this.pv = new PvSensors(log, api);
    this.log.info('Starting DeyeInverter platform');
    const host = config.host;
    if (typeof host !== 'string' || !host.trim()) {
      this.log.warn('SETUP REQUIRED: open Homebridge UI > Plugins > Deye Inverter > Plugin Config, enter your logger IP address, click Save, then Restart Homebridge. No connection will be attempted until an IP address is configured.');
      return;
    }
    const port = config.port ?? 502;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');
    this.options = { host: host.trim(), port, unitId: 1, timeoutMs: 5000 };
    DeyePlatform.initialized.add(api);
    api.on('didFinishLaunching', () => { void this.start(); });
    api.on('shutdown', () => {
      this.stopped = true;
      clearTimeout(this.timer);
      this.log.info('Stopping sensor polling');
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    // Cached HAP accessories are removed only after Matter replacements are ready.
    this.legacy.push(accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cached.set(accessory.UUID, accessory);
    this.energy.configureAccessory(accessory);
    this.importEnergy.configureAccessory(accessory);
    this.pv.configureAccessory(accessory);
  }

  private async start(): Promise<void> {
    if (!this.api.isMatterEnabled?.() || !this.api.matter?.deviceTypes.ElectricalSensor) {
      this.log.warn('SETUP REQUIRED: Deye Inverter uses Matter for all seven accessories. Use Homebridge >= 2.2 and enable Matter on this bridge (or its child bridge), then restart. No Modbus polling will start until Matter is enabled.');
      return;
    }
    this.matter = this.api.matter;
    try {
      await this.setupAccessories();
      if (this.stopped) return;
      await this.energy.setup(PLUGIN_NAME, PLATFORM_NAME);
      if (this.stopped) return;
      await this.importEnergy.setup(PLUGIN_NAME, PLATFORM_NAME);
      if (this.stopped) return;
      await this.pv.setup(PLUGIN_NAME, PLATFORM_NAME, () => this.stopped);
      if (this.stopped) return;
      if (this.legacy.length) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.legacy);
        this.log.info(`Removed ${this.legacy.length} legacy HAP accessories after Matter migration. Existing HomeKit automations may need to be recreated for the Matter sensors.`);
      }
      this.log.info(`Ready (Matter): ${sensors.map(sensor => sensor.name).join(', ')}, Total Consumption Energy, Total Import Energy, PV`);
    } catch (error) {
      this.log.error(`Matter sensor setup failed: ${String(error)}. Restart Homebridge after resolving the error.`);
      return;
    }
    this.log.info(`Reading Modbus TCP logger at ${this.options.host}:${this.options.port}`);
    await this.poll();
  }

  private async setupAccessories(): Promise<void> {
    const matter = this.matter!;
    for (const sensor of sensors) {
      if (this.stopped) return;
      const uuid = matter.uuid.generate(`${PLUGIN_NAME}:${sensor.key}`);
      const cached = this.cached.get(uuid) ?? [...this.cached.values()].find(item => item.context.sensorKey === sensor.key);
      const accessory: MatterAccessory = {
        UUID: cached?.UUID ?? uuid, displayName: sensor.name,
        deviceType: sensor.kind === 'contact' ? matter.deviceTypes.ContactSensor : matter.deviceTypes.TemperatureSensor,
        manufacturer: 'Deye', model: 'Modbus TCP Inverter', serialNumber: `${PLUGIN_NAME}-${sensor.key}`,
        context: { sensorKey: sensor.key },
        clusters: sensor.kind === 'contact'
          ? { booleanState: { stateValue: false }, bridgedDeviceBasicInformation: { reachable: false } }
          : { temperatureMeasurement: { measuredValue: null, minMeasuredValue: -10000, maxMeasuredValue: 20000 }, bridgedDeviceBasicInformation: { reachable: false } },
      };
      if (sensor.key === 'battery') {
        accessory.clusters!.powerSource = {
          status: 0, order: 0, description: 'Deye storage battery',
          batPercentRemaining: null, batPresent: true, batChargeState: 0,
          batFunctionalWhileCharging: true,
        };
      }
      // Cluster topology is fixed when the endpoint is built. Upgrade an old
      // battery endpoint once, keeping its UUID but rebuilding with PowerSource.
      const upgradeBattery = sensor.key === 'battery' && cached && !cached.clusters?.powerSource;
      if (upgradeBattery) {
        await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
        const deadline = Date.now() + 5000;
        while (await matter.getAccessoryState(accessory.UUID, 'temperatureMeasurement') !== undefined) {
          if (Date.now() >= deadline) throw new Error('Battery endpoint upgrade did not finish within 5 seconds');
          await delay(50);
        }
      }
      if (!cached || upgradeBattery) await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      const cluster = sensor.kind === 'contact' ? 'booleanState' : 'temperatureMeasurement';
      const deadline = Date.now() + 5000;
      while (!this.stopped && await matter.getAccessoryState(accessory.UUID, cluster) === undefined) {
        if (Date.now() >= deadline) throw new Error(`${sensor.name}: Matter endpoint did not become ready within 5 seconds`);
        await delay(50);
      }
      if (this.stopped) return;
      this.uuids.set(sensor.key, accessory.UUID);
      await matter.updateAccessoryState(accessory.UUID, 'bridgedDeviceBasicInformation', { reachable: false });
      if (sensor.kind === 'temperature') await matter.updateAccessoryState(accessory.UUID, cluster, { measuredValue: null });
      if (sensor.key === 'battery') await matter.updateAccessoryState(accessory.UUID, 'powerSource', { batPercentRemaining: null, status: 0 });
      this.log.info(`${cached ? 'Restored' : 'Added'} Matter accessory: ${sensor.name}`);
    }
  }

  private async poll(): Promise<void> {
    const matter = this.matter!;
    try {
      const energyDue = this.energy.isDue();
      const importDue = this.importEnergy.isDue();
      const ranges: RegisterRange[] = sensors.map(sensor => ({ address: sensor.register, count: 1 }));
      ranges.push({ address: 184, count: 1 });
      ranges.push(...PV_RANGES);
      if (energyDue) ranges.push({ address: 85, count: 2 });
      if (importDue) ranges.push({ address: 78, count: 3 });
      const snapshot = await readRegisterRanges(this.options, ranges, () => this.stopped);
      this.log.debug(`Modbus blocks: ${snapshot.requests.map(range => `${range.address}+${range.count}`).join(', ')}`);
      for (const sensor of sensors) {
        if (this.stopped) return;
        const uuid = this.uuids.get(sensor.key)!;
        try {
          const [raw] = snapshot.get(sensor.register);
          if (this.stopped) return;
          let display: string;
          if (sensor.kind === 'contact') {
            if (raw === 0xffff) throw new Error(`Invalid grid voltage word: ${raw}`);
            const voltage = raw / 10;
            const present = voltage >= (this.gridPresent ? 80 : 100);
            // Matter ContactSensor: true = contact detected (closed) = Grid On.
            await matter.updateAccessoryState(uuid, 'booleanState', { stateValue: present });
            this.gridPresent = present;
            display = `${present ? 'power available (closed)' : 'power unavailable (open)'}, ${voltage} V`;
          } else {
            const temperature = decodeTemperature(raw);
            if (temperature === null) throw new Error(`Invalid temperature word: ${raw}`);
            // Matter uses hundredths of a degree Celsius.
            await matter.updateAccessoryState(uuid, 'temperatureMeasurement', { measuredValue: Math.round(temperature * 100) });
            display = `${temperature} °C`;
          }
          await matter.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: true });
          const reading = `${sensor.name}: ${display} (register=${sensor.register}, raw=${raw})`;
          if (this.available.has(sensor.key)) this.log.debug(reading);
          else this.log.info(reading);
          this.available.add(sensor.key);
        } catch (error) {
          if (this.stopped) return;
          this.available.delete(sensor.key);
          this.log.warn(`${sensor.name} read/update failed at ${this.options.host}:${this.options.port}, register ${sensor.register}: ${String(error)}. Will retry next cycle.`);
          try {
            // BooleanState cannot be null; failed voltage reads mark Grid unreachable.
            await matter.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: false });
            if (sensor.kind === 'temperature') await matter.updateAccessoryState(uuid, 'temperatureMeasurement', { measuredValue: null });
          } catch (updateError) {
            this.log.warn(`Could not mark ${sensor.name} unavailable: ${String(updateError)}`);
          }
        }
      }
      if (!this.stopped) {
        const uuid = this.uuids.get('battery')!;
        try {
          const [raw] = snapshot.get(184);
          const batteryPercent = decodeBatteryPercent(raw);
          if (batteryPercent === null) throw new Error(`Invalid battery SOC word: ${raw}`);
          await matter.updateAccessoryState(uuid, 'powerSource', { batPercentRemaining: batteryPercent * 2, status: 1 });
          const reading = `Battery Percent: ${batteryPercent}% (register=184, raw=${raw})`;
          if (this.available.has('batteryPercent')) this.log.debug(reading);
          else this.log.info(reading);
          this.available.add('batteryPercent');
        } catch (error) {
          this.available.delete('batteryPercent');
          this.log.warn(`Battery Percent read/update failed at ${this.options.host}:${this.options.port}, register 184: ${String(error)}. Will retry next cycle.`);
          try { await matter.updateAccessoryState(uuid, 'powerSource', { batPercentRemaining: null, status: 0 }); }
          catch (updateError) { this.log.warn(`Could not mark battery percentage unavailable: ${String(updateError)}`); }
        }
      }
      await this.pv.publish(snapshot, () => this.stopped);
      if (energyDue) await this.energy.poll(this.options, () => this.stopped, async () => snapshot.get(85, 2));
      if (importDue) await this.importEnergy.poll(this.options, () => this.stopped, async () => [snapshot.get(78)[0], snapshot.get(80)[0]]);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => { void this.poll(); }, 10_000);
    }
  }
}
