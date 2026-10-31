import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeTemperature, readHoldingRegisters } from './modbus.js';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} phải là số nguyên từ ${min} đến ${max}`);
  return value;
}

async function main() {
  const options = {
    host: process.env.MODBUS_HOST ?? '192.168.5.190',
    port: integer('MODBUS_PORT', 502, 1, 65535),
    unitId: integer('MODBUS_UNIT_ID', 1, 1, 247),
    timeoutMs: integer('MODBUS_TIMEOUT_MS', 5000, 1, 60000),
  };
  const interval = integer('POLL_INTERVAL_MS', 10000, 1000, 3600000);
  // Installed inverter: SUN-6K-SG05LP1-EU-SM2-P (single-phase hybrid).
  let profile = process.env.DEYE_PROFILE ?? 'single';
  if (!['auto', 'single', 'three'].includes(profile)) throw new Error('DEYE_PROFILE phải là auto, single hoặc three');
  let deviceType: number | null = null;
  if (profile === 'auto') {
    [deviceType] = await readHoldingRegisters(options, 0, 1);
    if (deviceType === 0x0300) profile = 'single';
    else if ([0x0500, 0x0600, 0x0601].includes(deviceType)) profile = 'three';
    else throw new Error(`Loại máy 0x${deviceType.toString(16)} chưa được hỗ trợ tự động. Xác nhận bảng thanh ghi và đặt DEYE_PROFILE=single hoặc three.`);
  }
  const dcAddress = integer('DC_REGISTER', profile === 'single' ? 90 : 540, 0, 65535);
  const acAddress = integer('AC_REGISTER', profile === 'single' ? 91 : 541, 0, 65535);
  const batteryAddress = integer('BATTERY_REGISTER', profile === 'single' ? 182 : 586, 0, 65535);
  const gridAddress = profile === 'single' || process.env.GRID_REGISTER !== undefined
    ? integer('GRID_REGISTER', 150, 0, 65535) : undefined;
  const gridOnly = process.argv.includes('--grid-only');
  if (gridOnly && gridAddress === undefined) throw new Error('Cần đặt GRID_REGISTER khi dùng --grid-only với profile three');
  let gridPresent = false;
  const offsets = [integer('DC_OFFSET', 1000, 0, 3000), integer('AC_OFFSET', 1000, 0, 3000), integer('BATTERY_OFFSET', 1000, 0, 3000)];
  const once = process.argv.includes('--once');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.error(`Modbus TCP ${options.host}:${options.port}, Slave ID ${options.unitId}, profile=${profile}${deviceType === null ? '' : `, type=0x${deviceType.toString(16)}`}`);
  try {
    while (!controller.signal.aborted) {
      try {
        // Read sequentially: many loggers only support one outstanding request.
        const raw: number[] = [];
        const addresses = gridOnly ? [gridAddress!] : [dcAddress, acAddress, batteryAddress, ...(gridAddress === undefined ? [] : [gridAddress])];
        for (const address of addresses) {
          if (controller.signal.aborted) return;
          const [value] = await readHoldingRegisters(options, address, 1);
          raw.push(value);
        }
        const temperatures = gridOnly ? [] : raw.slice(0, 3).map((value, i) => decodeTemperature(value, offsets[i]));
        const gridRaw = gridAddress === undefined ? undefined : raw[gridOnly ? 0 : 3];
        if (gridRaw === 0xffff) throw new Error('Grid voltage unavailable (raw=65535); trạng thái Grid không xác định');
        const gridVoltageV = gridRaw === undefined ? undefined : gridRaw / 10;
        if (gridVoltageV !== undefined) gridPresent = gridVoltageV >= (gridPresent ? 80 : 100);
        console.log(JSON.stringify({
          time: new Date().toISOString(),
          dcC: temperatures[0], acC: temperatures[1], batteryC: temperatures[2],
          gridVoltageV,
          grid: gridVoltageV === undefined ? undefined : gridPresent ? 'On' : 'Off',
          contact: gridVoltageV === undefined ? undefined : gridPresent ? 'Closed' : 'Open',
          raw: gridOnly ? { grid: gridRaw } : { dc: raw[0], ac: raw[1], battery: raw[2], grid: gridRaw },
          registers: gridOnly ? { grid: gridAddress } : { dc: dcAddress, ac: acAddress, battery: batteryAddress, grid: gridAddress },
        }));
      } catch (error) {
        if (once) throw error;
        console.error(new Date().toISOString(), error instanceof Error ? error.message : error);
      }
      if (once) break;
      await delay(interval, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
