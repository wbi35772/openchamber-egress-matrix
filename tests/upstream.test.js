'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const ws = require('../lib/ws');
const { parseNodeUri } = require('../lib/node-uri');
const {
  connectUpstream,
  encodeTrojanRequest,
  createVlessResponseDecoder,
} = require('../lib/upstream');

const UUID = 'b94bf8c2-1111-2222-3333-444455556666';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch { value = false; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor 超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function startVlessServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new Set();

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const parser = new ws.FrameParser();
    let requestSeen = false;

    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x2) continue;
        if (!requestSeen) {
          requestSeen = true;
          socket.write(ws.encodeFrame(0x2, Buffer.from([0, 0]), { mask: false }));
          continue;
        }
        socket.write(ws.encodeFrame(0x2, frame.payload, { mask: false }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      })
    );
  });
}

test('vless handshake over websocket and byte echo', async () => {
  const upstream = await startVlessServer();
  let tunnel;
  try {
    const descriptor = parseNodeUri(`vless://${UUID}@127.0.0.1:${upstream.port}?type=ws&path=/proxy`);
    tunnel = await connectUpstream(descriptor, { host: 'echo.example', port: 80 });
    const chunks = [];
    tunnel.onData((chunk) => chunks.push(chunk));

    tunnel.write(Buffer.from('hello through ws'));
    await waitFor(() => Buffer.concat(chunks).length >= 'hello through ws'.length);

    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello through ws');
  } finally {
    if (tunnel) tunnel.close();
    await upstream.close();
  }
});

test('vless response decoder strips the response header even when split', () => {
  const decode = createVlessResponseDecoder();
  assert.equal(decode(Buffer.from([0])).length, 0);
  assert.equal(decode(Buffer.from([0])).length, 0);
  assert.equal(decode(Buffer.from('abc')).toString(), 'abc');
});

test('trojan request uses sha224 password and domain address type', () => {
  const body = encodeTrojanRequest({ password: 'secret' }, { host: 'example.com', port: 443 });
  const hash = crypto.createHash('sha224').update('secret').digest('hex');
  assert.equal(body.subarray(0, 56).toString('latin1'), hash);
  assert.equal(body[56], 0x0d);
  assert.equal(body[57], 0x0a);
  assert.equal(body[58], 0x01);
  assert.equal(body[59], 0x03);
  assert.equal(body.readUInt8(60), 'example.com'.length);
  assert.equal(body.subarray(61, 61 + 11).toString(), 'example.com');
  assert.equal(body.readUInt16BE(72), 443);
});
