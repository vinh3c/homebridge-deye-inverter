import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { decodeTemperature, readHoldingRegisters, type ConnectionOptions } from './modbus.js';

export const PLUGIN_NAME = 'homebridge-deye-inverter';
export const PLATFORM_NAME = 'DeyeInverter';

const sensors = [
  { key: 'dc', name: 'DC Temperature', register: 90 },
  { key: 'ac', name: 'AC Temperature', register: 91 },
  { key: 'battery', name: 'Battery Temperature', register: 182 },
] as const;

export class DeyePlatform implements DynamicPlatformPlugin {
  private static readonly initialized = new WeakSet<API>();

  static isInitialized(api: API): boolean {
    return DeyePlatform.initialized.has(api);
  }

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly services = new Map<string, Service>();
  private readonly values = new Map<string, number>();
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
      this.log.info('Ready: DC Temperature, AC Temperature, Battery Temperature');
      void this.poll();
    });
    api.on('shutdown', () => {
      this.log.info('Stopping temperature polling');
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
      // Reuse existing sensors, including accessories created before generic IDs.
      let accessory = this.cached.get(uuid) ?? [...this.cached.values()].find(item =>
        item.context.sensorKey === sensor.key ||
        item.getService(Service.TemperatureSensor)?.getCharacteristic(Characteristic.Name).value === name);
      const isNew = !accessory;
      accessory ??= new this.api.platformAccessory(name, uuid);
      accessory.displayName = name;
      accessory.context.sensorKey = sensor.key;
      accessory.getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'Deye')
        .setCharacteristic(Characteristic.Model, 'Modbus TCP Inverter')
        .setCharacteristic(Characteristic.SerialNumber, `${PLUGIN_NAME}-${sensor.key}`);
      const service = accessory.getService(Service.TemperatureSensor) ?? accessory.addService(Service.TemperatureSensor, name);
      service.setCharacteristic(Characteristic.Name, name);
      service.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 200, minStep: 0.1 })
        .onGet(() => {
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
        try {
          this.log.debug(`Reading ${sensor.name}: register ${sensor.register} at ${this.options.host}:${this.options.port}`);
          const [raw] = await readHoldingRegisters(this.options, sensor.register, 1);
          const value = decodeTemperature(raw);
          if (value === null) throw new Error(`Invalid temperature word: ${raw}`);
          if (this.stopped) return;
          const firstOrRecovered = !this.values.has(sensor.key);
          this.values.set(sensor.key, value);
          service.updateCharacteristic(Characteristic.CurrentTemperature, value);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
          const reading = `${sensor.name}: ${value} °C (register=${sensor.register}, raw=${raw})`;
          if (firstOrRecovered) this.log.info(reading);
          else this.log.debug(reading);
        } catch (error) {
          if (this.stopped) return;
          this.values.delete(sensor.key);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
          service.updateCharacteristic(Characteristic.CurrentTemperature, new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          this.log.warn(`${sensor.name} read failed at ${this.options.host}:${this.options.port}, register ${sensor.register}: ${error instanceof Error ? error.message : String(error)}. Will retry next cycle.`);
        }
      }
    } finally {
      // Schedule after completion; never overlap requests on the logger.
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.intervalMs);
    }
  }
}
