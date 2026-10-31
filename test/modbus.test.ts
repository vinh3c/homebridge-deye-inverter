import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { decodeTemperature, readHoldingRegisters } from '../src/modbus.js';

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
