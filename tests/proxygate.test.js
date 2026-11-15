'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createProxygateClient,
  normalizeSlot,
  slotDescriptor,
  slotKey,
  syncLeases,
} = require('../lib/providers/proxygate');

function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== 'secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      if (req.method === 'GET' && req.url === '/api/v1/pool/slots') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          host: 'socks.example',
          slots: [
            { slotId: 's1', username: 'u1', port: 10801, countryShort: 'jp', healthy: true, exitIp: '1.1.1.1' },
            { slot_id: 's2', username: 'u2', port: 10802, country_short: 'US', healthy: false },
            { slotId: '', username: 'broken', port: 10803 },
          ],
        }));
      }
      if (req.method === 'POST' && req.url === '/api/v1/pool/rotate/s1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ slotId: 's1', port: 10801, healthy: true, activeIp: '9.9.9.9' }));
      }
      if (req.method === 'POST' && req.url === '/api/v1/pool/allocate') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ slot: { slotId: 's9', port: 10999, healthy: true } }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

test('client normalizes slots and keeps the auth header', async () => {
  const stub = await startStub();
  const client = createProxygateClient({ baseUrl: stub.baseUrl, authValue: 'secret' });
  const payload = await client.slots();
  assert.equal(payload.host, 'socks.example');
  assert.equal(payload.slots.length, 3);
  assert.equal(payload.slots[0].countryShort, 'JP');
  assert.equal(payload.slots[0].exitIp, '1.1.1.1');
  assert.equal(payload.slots[1].countryShort, 'US');
  assert.equal(payload.slots[1].healthy, false);
  assert.equal(stub.calls[0].key, 'secret');

  const rotated = await client.rotate('s1');
  assert.equal(rotated.exitIp, '9.9.9.9');

  const allocated = await client.allocate({ country: 'JP' });
  assert.equal(allocated.slotId, 's9');
  await new Promise((resolve) => stub.server.close(resolve));
});

test('client surfaces http errors with status', async () => {
  const stub = await startStub();
  const client = createProxygateClient({ baseUrl: stub.baseUrl, authValue: 'wrong' });
  await assert.rejects(() => client.slots(), (error) => {
    assert.equal(error.code, 'proxygate_http_error');
    assert.equal(error.status, 401);
    return true;
  });
  await new Promise((resolve) => stub.server.close(resolve));
});

test('slot key and descriptor point at the public socks host', () => {
  const slot = normalizeSlot({ slotId: 's1', username: 'u1', port: 10801, countryShort: 'jp' });
  assert.equal(slotKey(slot), 'pg/JP/s1');

  const descriptor = slotDescriptor(
    { username: 'u1', port: 10801, host: 'socks.example' },
    { socksHost: '', socksPassword: 'p@ss' }
  );
  assert.equal(descriptor.protocol, 'socks');
  assert.equal(descriptor.server, 'socks.example');
  assert.equal(descriptor.port, 10801);
  assert.equal(descriptor.username, 'u1');
  assert.equal(descriptor.password, 'p@ss');
});

test('syncLeases adds, updates and prunes by slot id', () => {
  const state = {
    settings: { primary: '' },
    proxygate: { socksHost: 'socks.example' },
    leases: [],
  };
  const first = {
    host: 'socks.example',
    slots: [
      normalizeSlot({ slotId: 's1', port: 10801, countryShort: 'JP', healthy: true }),
      normalizeSlot({ slotId: 's2', port: 10802, countryShort: 'US', healthy: false }),
    ],
  };

  const added = syncLeases(state, first, { prune: false });
  assert.equal(added.added, 2);
  assert.equal(state.leases.length, 2);
  assert.equal(state.leases[0].key, 'pg/JP/s1');
  assert.equal(state.leases[0].port, 0);
  assert.ok(state.settings.primary);

  const second = {
    host: 'socks.example',
    slots: [normalizeSlot({ slotId: 's1', port: 10801, countryShort: 'JP', healthy: false })],
  };
  const updated = syncLeases(state, second, { prune: true });
  assert.equal(updated.updated, 1);
  assert.equal(updated.removed, 1);
  assert.equal(state.leases.length, 1);
  assert.equal(state.leases[0].ok, false);
});
