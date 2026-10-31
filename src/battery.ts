import type { MatterAccessory, MatterAPI } from 'homebridge';

/** Scope the existing SOC detail to its own accessory before it becomes ready. */
export function createBatteryTemperatureType(matter: MatterAPI, onScope?: (endpoint: number) => void): MatterAccessory['deviceType'] {
  const temperature = matter.deviceTypes.TemperatureSensor;
  const Base = temperature.behaviors.temperatureMeasurement;

  class ScopedBatteryTemperature extends Base {
    override async initialize(): Promise<void> {
      await super.initialize();
      // Matter assigns the number before running cluster initializers. Never
      // infer it from registration order: other plugins share the same bridge.
      const number = this.endpoint.number;
      if (!Number.isInteger(number) || number <= 0 || number >= 0xffff) {
        throw new Error('Battery SOC requires an assigned application endpoint number');
      }
      const behavior = this.endpoint.behaviors.supported.powerSource;
      if (!behavior) throw new Error('Battery SOC requires the PowerSource cluster on its own endpoint');
      const source = await this.agent.load(behavior);
      const state = source.state as { endpointList: number[]; batPercentRemaining: number | null; status: number };
      // An empty EndpointList means the whole Matter node, not this accessory.
      // Do this during construction, before controllers can observe the source.
      state.endpointList = [number];
      state.batPercentRemaining = null;
      state.status = 0;
      onScope?.(number);
    }
  }

  return temperature.with(ScopedBatteryTemperature);
}

export function readBatteryEndpointList(state: Record<string, unknown> | undefined, expectedEndpoint?: number): number[] {
  const list = state?.endpointList;
  if (!Array.isArray(list) || list.length !== 1 || !Number.isInteger(list[0]) || list[0] <= 0 || list[0] >= 0xffff) {
    throw new Error('Battery SOC source is not scoped to one application endpoint');
  }
  if (expectedEndpoint !== undefined && list[0] !== expectedEndpoint) {
    throw new Error('Battery SOC source scope does not match its assigned endpoint');
  }
  return [list[0]];
}
