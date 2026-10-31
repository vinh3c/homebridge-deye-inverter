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
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly services = new Map<string, Service>();
  private readonly values = new Map<string, number>();
  private readonly options: ConnectionOptions;
  private readonly intervalMs = 10_000;
  private readonly identity = 'deye-sg05lp1';
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    const integer = (key: string, fallback: number, min: number, max: number) => {
      const value = config[key] ?? fallback;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
      }
      return value;
    };
    const host = config.host ?? '192.168.5.60';
    if (typeof host !== 'string' || !host.trim()) throw new Error('host must be a non-empty hostname or IP');
    this.options = {
      host: host.trim(), port: integer('port', 502, 1, 65535),
      unitId: 1, timeoutMs: 5000,
    };
    // One inverter per platform; fixed identity survives IP and display name changes.
    api.on('didFinishLaunching', () => {
      this.setupAccessories();
      void this.poll();
    });
    api.on('shutdown', () => {
      this.stopped = true;
      clearTimeout(this.timer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setupAccessories(): void {
    const { Service, Characteristic } = this.api.hap;
    for (const sensor of sensors) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.identity}:${sensor.key}`);
      const name = sensor.name;
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      accessory ??= new this.api.platformAccessory(name, uuid);
      accessory.displayName = name;
      accessory.getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'Deye')
        .setCharacteristic(Characteristic.Model, 'SUN-6K-SG05LP1-EU-SM2-P')
        .setCharacteristic(Characteristic.SerialNumber, `${this.identity}-${sensor.key}`);
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
      if (isNew) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      else this.api.updatePlatformAccessories([accessory]);
    }
  }

  private async poll(): Promise<void> {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    try {
      for (const sensor of sensors) {
        if (this.stopped) return;
        const service = this.services.get(sensor.key)!;
        try {
          const [raw] = await readHoldingRegisters(this.options, sensor.register, 1);
          const value = decodeTemperature(raw);
          if (value === null) throw new Error(`Invalid temperature word: ${raw}`);
          if (this.stopped) return;
          this.values.set(sensor.key, value);
          service.updateCharacteristic(Characteristic.CurrentTemperature, value);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
          this.log.debug(`${sensor.name}: ${value} °C (raw=${raw})`);
        } catch (error) {
          if (this.stopped) return;
          this.values.delete(sensor.key);
          service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
          service.updateCharacteristic(Characteristic.CurrentTemperature, new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          this.log.warn(`${sensor.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      // Schedule after completion; never overlap requests on the logger.
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.intervalMs);
    }
  }
}
