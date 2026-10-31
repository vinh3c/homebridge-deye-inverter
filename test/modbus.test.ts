import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { decodeBatteryPercent, decodeTemperature, readHoldingRegisters, groupRegisterRanges, readRegisterRanges } from '../src/modbus.js';

async function withLogger(respond: (socket: Socket, request: Buffer) => void, check: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 12) respond(socket, buffer);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await check(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const options = (port: number) => ({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 200 });

test('reads a fragmented TCP response and sends FC03 to the exact register', async () => {
  await withLogger((socket, request) => {
    assert.equal(request.readUInt16BE(4), 6);
    assert.equal(request[7], 3);
    assert.equal(request.readUInt16BE(8), 540);
    assert.equal(request.readUInt16BE(10), 2);
    const reply = Buffer.from([0, 0, 0, 0, 0, 7, 1, 3, 4, 0x05, 0xdc, 0x05, 0xaa]);
    request.copy(reply, 0, 0, 2);
    socket.write(reply.subarray(0, 5));
    setTimeout(() => socket.end(reply.subarray(5)), 10);
  }, async port => {
    assert.deepEqual(await readHoldingRegisters(options(port), 540, 2), [1500, 1450]);
  });
});

test('reports Modbus exceptions', async () => {
  await withLogger((socket, request) => {
    const reply = Buffer.from([0, 0, 0, 0, 0, 3, 1, 0x83, 2]);
    request.copy(reply, 0, 0, 2);
    socket.end(reply);
  }, async port => {
    await assert.rejects(readHoldingRegisters(options(port), 540, 1), /exception 0x2/);
  });
});

test('rejects a response for another transaction', async () => {
  await withLogger((socket, request) => {
    const reply = Buffer.from([0, 0, 0, 0, 0, 5, 1, 3, 2, 5, 220]);
    reply.writeUInt16BE((request.readUInt16BE(0) + 1) & 65535);
    socket.end(reply);
  }, async port => {
    await assert.rejects(readHoldingRegisters(options(port), 540, 1), /transaction/);
  });
});

test('times out when a logger stays silent', async () => {
  await withLogger(() => {}, async port => {
    await assert.rejects(readHoldingRegisters(options(port), 540, 1), /Hết thời gian/);
  });
});

test('decodes offset temperatures including negatives and missing values', () => {
  assert.equal(decodeTemperature(1505), 50.5);
  assert.equal(decodeTemperature(950), -5);
  assert.equal(decodeTemperature(1250), 25);
  assert.equal(decodeTemperature(250, 0), 25);
  assert.equal(decodeTemperature(65535), null);
});

test('battery SOC accepts 0–100 percent and rejects unavailable or invalid words', () => {
  for (const value of [0, 1, 83, 100]) assert.equal(decodeBatteryPercent(value), value);
  for (const value of [-1, 101, 65535, NaN, 50.5]) assert.equal(decodeBatteryPercent(value), null);
});

test('groups nearby words without crossing large gaps or splitting energy values', () => {
  assert.deepEqual(groupRegisterRanges([
    { address: 182, count: 1 }, { address: 90, count: 1 }, { address: 91, count: 1 },
    { address: 150, count: 1 }, { address: 85, count: 2 },
  ]), [{ address: 85, count: 7 }, { address: 150, count: 1 }, { address: 182, count: 1 }]);
  assert.deepEqual(groupRegisterRanges([{ address: 90, count: 1 }, { address: 91, count: 1 }]), [{ address: 90, count: 2 }]);
  assert.deepEqual(groupRegisterRanges([{ address: 85, count: 2 }]), [{ address: 85, count: 2 }]);
  assert.deepEqual(groupRegisterRanges([{ address: 78, count: 3 }, { address: 85, count: 2 }, { address: 90, count: 2 }]), [{ address: 78, count: 14 }]);
  assert.deepEqual(groupRegisterRanges([{ address: 78, count: 3 }, { address: 85, count: 2 }]), [{ address: 78, count: 9 }]);
  assert.throws(() => groupRegisterRanges([{ address: 65535, count: 2 }]));
});

test('batch maps words by address and continues independent blocks after a Modbus error', async () => {
  const requests: [number, number][] = [];
  await withLogger((socket, request) => {
    const address = request.readUInt16BE(8);
    const count = request.readUInt16BE(10);
    requests.push([address, count]);
    const reply = address === 150 ? Buffer.from([0, 0, 0, 0, 0, 3, 1, 0x83, 2]) : Buffer.alloc(9 + count * 2);
    request.copy(reply, 0, 0, 2);
    if (address !== 150) {
      reply.writeUInt16BE(3 + count * 2, 4); reply[6] = 1; reply[7] = 3; reply[8] = count * 2;
      for (let i = 0; i < count; i++) reply.writeUInt16BE(address + i, 9 + i * 2);
    }
    socket.end(reply);
  }, async port => {
    const snapshot = await readRegisterRanges(options(port), [
      { address: 85, count: 2 }, { address: 90, count: 2 }, { address: 150, count: 1 }, { address: 182, count: 1 },
    ]);
    assert.deepEqual(snapshot.get(85, 2), [85, 86]);
    assert.deepEqual(snapshot.get(90, 2), [90, 91]);
    assert.throws(() => snapshot.get(150), /exception/);
    assert.deepEqual(snapshot.get(182), [182]);
    assert.throws(() => snapshot.get(200), /was not read/);
    assert.deepEqual(requests, [[85, 7], [150, 1], [182, 1]]);
  });
});
