import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { decodeTemperature, readHoldingRegisters, type ConnectionOptions } from './modbus.js';

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

  static isInitialized(api: API): boolean {
    return DeyePlatform.initialized.has(api);
  }

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly services = new Map<string, Service>();
  private readonly values = new Map<string, number>();
  private gridPresent?: boolean;
  private readonly options!: ConnectionOptions;
  private readonly intervalMs = 10_000;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    this.log.info('Starting DeyeInverter platform');
    const integer = (key: string, fallback: number, min: number, max: number) => {
      const value = config[key] ?? fallback;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
      }
      return value;
    };
    const host = config.host;
    if (typeof host !== 'string' || !host.trim()) {
      this.log.warn('SETUP REQUIRED: open Homebridge UI > Plugins > Deye Inverter > Plugin Config, enter your logger IP address, click Save, then Restart Homebridge. No connection will be attempted until an IP address is configured.');
      return;
    }
    this.options = {
      host: host.trim(), port: integer('port', 502, 1, 65535),
      unitId: 1, timeoutMs: 5000,
    };
    DeyePlatform.initialized.add(api);
    this.log.info(`Connecting to Modbus TCP logger at ${this.options.host}:${this.options.port}`);
    // One inverter per platform; fixed identity survives IP and display name changes.
    api.on('didFinishLaunching', () => {
      this.log.info(`Homebridge finished launching; setting up sensors (${this.cached.size} cached accessories)`);
      this.setupAccessories();
      this.log.info(`Ready: ${sensors.map(sensor => sensor.name).join(', ')}`);
      void this.poll();
    });
    api.on('shutdown', () => {
      this.log.info('Stopping sensor polling');
      this.stopped = true;
      clearTimeout(this.timer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loaded cached accessory: ${accessory.displayName}`);
    this.cached.set(accessory.UUID, accessory);
  }

  private setupAccessories(): void {
    const { Service, Characteristic } = this.api.hap;
    for (const sensor of sensors) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${sensor.key}`);
      const name = sensor.name;
      const serviceType = sensor.kind === 'contact' ? Service.ContactSensor : Service.TemperatureSensor;
      const readingType = sensor.kind === 'contact' ? Characteristic.ContactSensorState : Characteristic.CurrentTemperature;
      // Reuse existing sensors, including accessories created before generic IDs.
      let accessory = this.cached.get(uuid) ?? [...this.cached.values()].find(item =>
        item.context.sensorKey === sensor.key ||
        item.getService(serviceType)?.getCharacteristic(Characteristic.Name).value === name);
      const isNew = !accessory;
      accessory ??= new this.api.platformAccessory(name, uuid);
      accessory.displayName = name;
      accessory.context.sensorKey = sensor.key;
      accessory.getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'Deye')
        .setCharacteristic(Characteristic.Model, 'Modbus TCP Inverter')
        .setCharacteristic(Characteristic.SerialNumber, `${PLUGIN_NAME}-${sensor.key}`);
      const service = accessory.getService(serviceType) ?? accessory.addService(serviceType, name);
      service.setCharacteristic(Characteristic.Name, name);
      const reading = service.getCharacteristic(readingType);
      if (sensor.kind === 'temperature') reading.setProps({ minValue: -100, maxValue: 200, minStep: 0.1 });
      reading.onGet(() => {
          const value = this.values.get(sensor.key);
          if (value === undefined) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return value;
        });
      service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
      this.services.set(sensor.key, service);
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added accessory: ${name}`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`Restored accessory: ${name}`);
      }
    }
  }

  private async poll(): Promise<void> {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    try {
      for (const sensor of sensors) {
        if (this.stopped) return;
        const service = this.services.get(sensor.key)!;
        const readingType = sensor.kind === 'contact' ? Characteristic.ContactSensorState : Characteristic.CurrentTemperature;
        try {
          this.log.debug(`Reading ${sensor.name}: register ${sensor.register} at ${this.options.host}:${this.options.port}`);
          const [raw] = await readHoldingRegisters(this.options, sensor.register, 1);
          let value: number;
          if (sensor.kind === 'contact') {
            if (raw === 0xffff) throw new Error(`Invalid grid voltage word: ${raw}`);
            // Grid-side L1-N voltage is in 0.1 V. Hysteresis avoids contact chatter.
            const voltage = raw / 10;
            const present = voltage >= (this.gridPresent ? 80 : 100);
            value = present ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
            if (!this.stopped) this.gridPresent = present;
          } else {
            const temperature = decodeTemperature(raw);
            if (temperature === null) throw new Error(`Invalid temperature word: ${raw}`);
            value = temperature;
          }
          if (this.stopped) return;
          const firstOrRecovered = !this.values.has(sensor.key);
          this.values.set(sensor.key, value);
          service.updateCharacteristic(readingType, value);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
          const display = sensor.kind === 'contact' ? `${value === 0 ? 'power available (closed)' : 'power unavailable (open)'}, ${raw / 10} V` : `${value} °C`;
          const reading = `${sensor.name}: ${display} (register=${sensor.register}, raw=${raw})`;
          if (firstOrRecovered) this.log.info(reading);
          else this.log.debug(reading);
        } catch (error) {
          if (this.stopped) return;
          this.values.delete(sensor.key);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
          service.updateCharacteristic(readingType, new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          this.log.warn(`${sensor.name} read failed at ${this.options.host}:${this.options.port}, register ${sensor.register}: ${error instanceof Error ? error.message : String(error)}. Will retry next cycle.`);
        }
      }
    } finally {
      // Schedule after completion; never overlap requests on the logger.
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.intervalMs);
    }
  }
}
