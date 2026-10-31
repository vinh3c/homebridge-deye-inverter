import { createConnection } from 'node:net';

export interface ConnectionOptions {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
}

let transactionId = 0;

// logger in Modbus TCP mode: MBAP header + function 03 (no RTU CRC).
export function readHoldingRegisters(options: ConnectionOptions, address: number, count: number): Promise<number[]> {
  if (!Number.isInteger(address) || address < 0 || address > 65535 ||
      !Number.isInteger(count) || count < 1 || count > 125 || address + count > 65536) {
    return Promise.reject(new Error('Địa chỉ/số lượng thanh ghi không hợp lệ'));
  }
  const id = transactionId = (transactionId + 1) & 0xffff;
  const request = Buffer.alloc(12);
  request.writeUInt16BE(id, 0);
  request.writeUInt16BE(6, 4);
  request[6] = options.unitId;
  request[7] = 3;
  request.writeUInt16BE(address, 8);
  request.writeUInt16BE(count, 10);

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port });
    let received: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, values?: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(values!);
    };
    const timer = setTimeout(() => finish(new Error(`Hết thời gian chờ ${options.timeoutMs} ms tại ${options.host}:${options.port}, Slave ID ${options.unitId}, thanh ghi ${address}`)), options.timeoutMs);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Logger đóng kết nối trước khi trả đủ dữ liệu')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 7) return;
      const length = received.readUInt16BE(4);
      if (received.readUInt16BE(0) !== id || received.readUInt16BE(2) !== 0 || received[6] !== options.unitId) {
        return finish(new Error('Phản hồi Modbus sai transaction/protocol/Slave ID'));
      }
      if (length < 3 || length > 254) return finish(new Error('Độ dài MBAP không hợp lệ'));
      if (received.length < length + 6) return;
      if (received[7] === 0x83) return finish(new Error(`Modbus exception 0x${received[8].toString(16)} tại thanh ghi ${address}`));
      if (received[7] !== 3 || received[8] !== count * 2 || length !== 3 + count * 2) {
        return finish(new Error('Function code hoặc số byte phản hồi không hợp lệ'));
      }
      finish(undefined, Array.from({ length: count }, (_, i) => received.readUInt16BE(9 + i * 2)));
    });
  });
}

export function decodeTemperature(raw: number, offset = 1000): number | null {
  // Deye temperature words use an unsigned offset encoding; 0xffff is unavailable.
  return raw === 0xffff || raw > 3000 ? null : (raw - offset) / 10;
}

export function decodeBatteryPercent(raw: number): number | null {
  return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : null;
}

export interface RegisterRange { address: number; count: number }

export function groupRegisterRanges(ranges: readonly RegisterRange[]): RegisterRange[] {
  const groups: RegisterRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.address - b.address)) {
    if (!Number.isInteger(range.address) || !Number.isInteger(range.count) || range.address < 0 || range.count < 1 || range.count > 125 || range.address + range.count > 65536) {
      throw new Error('Invalid register range');
    }
    const previous = groups.at(-1);
    const end = Math.max(range.address + range.count, previous ? previous.address + previous.count : 0);
    // Bridge only small gaps, rather than transferring large unused spans.
    // Nearby blocks measured similar latency to a full 110-word read on the
    // installed logger, while reading far fewer words. Keep multiword values intact.
    if (previous && range.address <= previous.address + previous.count + 4 && end - previous.address <= 16) {
      previous.count = end - previous.address;
    } else groups.push({ ...range });
  }
  return groups;
}

export class RegisterSnapshot {
  readonly requests: RegisterRange[] = [];
  private readonly words = new Map<number, number | Error>();

  set(range: RegisterRange, result: number[] | Error): void {
    this.requests.push(range);
    for (let i = 0; i < range.count; i++) this.words.set(range.address + i, result instanceof Error ? result : result[i]);
  }

  get(address: number, count = 1): number[] {
    return Array.from({ length: count }, (_, i) => {
      const value = this.words.get(address + i);
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Register ${address + i} was not read`);
      return value;
    });
  }
}

export async function readRegisterRanges(options: ConnectionOptions, ranges: readonly RegisterRange[], stopped = () => false): Promise<RegisterSnapshot> {
  const snapshot = new RegisterSnapshot();
  // Sequential blocks avoid overlapping requests on the logger. A failed block
  // faults only its own words; later independent blocks are still read.
  for (const range of groupRegisterRanges(ranges)) {
    if (stopped()) break;
    try {
      snapshot.set(range, await readHoldingRegisters(options, range.address, range.count));
    } catch (error) {
      snapshot.set(range, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return snapshot;
}
