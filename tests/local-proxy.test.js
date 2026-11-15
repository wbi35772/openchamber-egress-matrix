'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');

const { createMixedProxy } = require('../lib/local-proxy');
const { createSocketTunnel } = require('../lib/upstream');

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

function readExactly(socket, size) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < size) return;
      cleanup();
      resolve(buffer.subarray(0, size));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function readUntilClose(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
  });
}

function tcpTunnelFactory(host, port) {
  return () =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }, () => resolve(createSocketTunnel(socket)));
      socket.once('error', reject);
    });
}

function startEcho() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      })
    );
  });
}

test('socks5 greeting, connect and echo', async () => {
  const echo = await startEcho();
  const proxy = await createMixedProxy({ port: 0, upstreamFor: tcpTunnelFactory('127.0.0.1', echo.port) });
  const client = net.connect(proxy.port, '127.0.0.1');

  client.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExactly(client, 2);
  assert.deepEqual([...greeting], [0x05, 0x00]);

  const port = echo.port;
  client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, port >> 8, port & 0xff]));
  const reply = await readExactly(client, 10);
  assert.equal(reply[0], 0x05);
  assert.equal(reply[1], 0x00);

  client.write(Buffer.from('ping'));
  const echoed = await readExactly(client, 4);
  assert.equal(echoed.toString(), 'ping');
  assert.equal(proxy.stats.connections, 1);

  client.destroy();
  await proxy.close();
  await echo.close();
});

test('http connect tunnels raw bytes', async () => {
  const echo = await startEcho();
  const proxy = await createMixedProxy({ port: 0, upstreamFor: tcpTunnelFactory('127.0.0.1', echo.port) });
  const client = net.connect(proxy.port, '127.0.0.1');

  client.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
  const head = await readExactly(client, 'HTTP/1.1 200 Connection Established\r\nProxy-Agent: egress-matrix\r\n\r\n'.length);
  assert.match(head.toString(), /^HTTP\/1\.1 200/);

  client.write(Buffer.from('pong'));
  const echoed = await readExactly(client, 4);
  assert.equal(echoed.toString(), 'pong');

  client.destroy();
  await proxy.close();
  await echo.close();
});

test('absolute-form http is rewritten to origin-form', async () => {
  const requests = [];
  const origin = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-length': 6 });
    res.end('origin');
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port;

  const proxy = await createMixedProxy({ port: 0, upstreamFor: tcpTunnelFactory('127.0.0.1', originPort) });
  const client = net.connect(proxy.port, '127.0.0.1');
  const body = readUntilClose(client);
  client.write(
    'GET http://example.test/hello?x=1 HTTP/1.1\r\nHost: example.test\r\nProxy-Connection: keep-alive\r\n\r\n'
  );

  const text = await body;
  assert.match(text, /200 OK/);
  assert.match(text, /origin$/);
  assert.deepEqual(requests[0], { method: 'GET', url: '/hello?x=1', host: 'example.test' });

  await proxy.close();
  await new Promise((resolve) => {
    origin.closeAllConnections?.();
    origin.close(resolve);
  });
});

test('upstream failure returns 502 and counts the failure', async () => {
  const proxy = await createMixedProxy({
    port: 0,
    upstreamFor: async () => {
      throw new Error('no route');
    },
  });
  const client = net.connect(proxy.port, '127.0.0.1');
  const body = readUntilClose(client);
  client.write('GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n');
  const text = await body;
  assert.match(text, /502 Bad Gateway/);
  await waitFor(() => proxy.stats.failed === 1);
  await proxy.close();
});
