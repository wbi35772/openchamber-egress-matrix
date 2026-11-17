'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'service-test-token';

function request(port, { method = 'GET', path: requestPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, child, stderrText) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`service exited early with ${child.exitCode}: ${stderrText()}`);
    }
    try {
      const res = await request(port, { path: '/health', headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('service did not become healthy');
}

test('service exposes CORS, bus health and both panel roots', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-egress-service-'));
  const port = await freePort();
  const busPort = await freePort();
  const child = spawn(process.execPath, ['service/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_MATRIX_BUS_PORT: String(busPort),
      EGRESS_MATRIX_DATA_DIR: dataDir,
      OPENCHAMBER_MATRIX_STATE_DIR: path.join(dataDir, 'matrix'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrText = '';
  child.stderr.on('data', (chunk) => { stderrText += chunk.toString(); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(port, child, () => stderrText);

  const preflight = await request(port, {
    method: 'OPTIONS',
    path: '/api/v1/egress/state',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization, content-type, x-oc-routing-plane, x-oc-matrix-token',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  const allowedHeaders = String(preflight.headers['access-control-allow-headers']).toLowerCase();
  for (const name of ['authorization', 'content-type', 'x-oc-routing-plane', 'x-oc-matrix-token']) {
    assert.equal(allowedHeaders.includes(name), true, `missing ${name} in allow-headers`);
  }
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

  const busPreflight = await request(busPort, {
    method: 'OPTIONS',
    path: '/api/v1/egress/state',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type, x-oc-routing-plane, x-oc-matrix-token',
    },
  });
  assert.equal(busPreflight.status, 204);
  assert.equal(busPreflight.headers['access-control-allow-origin'], '*');
  assert.equal(
    String(busPreflight.headers['access-control-allow-headers']).toLowerCase().includes('x-oc-matrix-token'),
    true,
  );

  const busHealth = await request(busPort, { path: '/api/v1/egress/bus-health' });
  assert.equal(busHealth.status, 200);
  assert.equal(busHealth.headers['access-control-allow-origin'], '*');
  assert.equal(JSON.parse(busHealth.body).service, 'egress-matrix');

  const health = await request(port, {
    path: '/api/v1/egress/bus-health',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(health.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'egress-matrix');
  assert.equal(typeof payload.activeSlots, 'number');
  assert.equal(typeof payload.warpPoolSize, 'number');
  assert.equal(payload.wsClientsCount, 0);
  assert.equal(Number.isNaN(Date.parse(payload.timestamp)), false);

  const uiRedirect = await request(port, { path: '/ui' });
  assert.equal(uiRedirect.status, 308);
  assert.equal(uiRedirect.headers.location, '/ui/');

  const panelRedirect = await request(port, { path: '/panel' });
  assert.equal(panelRedirect.status, 308);
  assert.equal(panelRedirect.headers.location, '/panel/');

  for (const panelPath of ['/ui/', '/panel/']) {
    const index = await request(port, { path: panelPath });
    assert.equal(index.status, 200, `${panelPath} should serve the panel`);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /egress-matrix-panel\.js/);
  }

  for (const assetPath of ['/ui/egress-matrix-panel.js', '/panel/egress-matrix-panel.js']) {
    const asset = await request(port, { path: assetPath });
    assert.equal(asset.status, 200, `${assetPath} should serve the panel script`);
    assert.match(asset.headers['content-type'], /javascript/);
    assert.equal(asset.body.length > 1000, true);
  }

  const traversal = await request(port, { path: '/panel/..%2fservice/main.js' });
  assert.equal(traversal.status, 404);

  const head = await request(port, { method: 'HEAD', path: '/panel/' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});
