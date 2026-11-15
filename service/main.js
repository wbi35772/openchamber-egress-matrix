'use strict';

/*
 * Egress Matrix local service.
 *
 * Contract (OpenChamber host): HTTP on 127.0.0.1, port and bearer token from
 * OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN.
 *
 * Owns the whole egress plane: static nodes, proxygate slots, leases, local
 * mixed listeners and the endpoints file other apps read. No external config
 * files are required.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/store');
const { createEngine } = require('../lib/engine');
const { parseNodeUri, publicNode } = require('../lib/node-uri');
const { createProxygateClient, normalizeSlot, slotDescriptor, syncLeases } = require('../lib/providers/proxygate');
const { probeViaProxy } = require('../lib/probe');
const { releasePort } = require('../lib/ports');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.EGRESS_MATRIX_PORT || 0);
const TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');
const HOST = '127.0.0.1';
const BODY_LIMIT = 512 * 1024;
const MASK = '••••••';
const VERSION = require('../package.json').version;

function log(message) {
  try { process.stderr.write(`[egress-matrix] ${message}\n`); } catch { /* ignore */ }
}

if (!PORT) {
  log('missing OPENCHAMBER_SERVICE_PORT');
  process.exit(1);
}
if (!TOKEN && process.env.EGRESS_MATRIX_DEV !== '1') {
  log('missing OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const engine = createEngine({
  load: store.load,
  save: store.save,
  writeEndpoints: store.writeEndpoints,
  log,
});

const startedAt = Date.now();

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }, headers));
  res.end(body);
}

function failure(res, error) {
  const status = Number.isInteger(error && error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 502;
  send(res, status, {
    ok: false,
    error: {
      code: (error && error.code) || 'internal_error',
      message: error && error.message ? error.message : String(error),
      status,
    },
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${TOKEN}`;
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function maskProxygate(config) {
  return Object.assign({}, config, {
    authValue: config.authValue ? MASK : '',
    socksPassword: config.socksPassword ? MASK : '',
  });
}

function settingsPatch(current, patch) {
  const next = Object.assign({}, current);
  if (patch.listenHost !== undefined) next.listenHost = String(patch.listenHost || '127.0.0.1');
  for (const key of ['defaultPort', 'portBase', 'portSize']) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw Object.assign(new Error(`${key} 必须是 1-65535 的整数`), { status: 400, code: 'invalid_setting' });
    }
    if (key === 'portSize' && (value < 1 || value > 1000)) {
      throw Object.assign(new Error('portSize 必须是 1-1000'), { status: 400, code: 'invalid_setting' });
    }
    next[key] = value;
  }
  if (patch.probeUrl !== undefined) next.probeUrl = String(patch.probeUrl || 'https://api.ipify.org');
  if (patch.primary !== undefined) next.primary = String(patch.primary || '');
  return next;
}

function proxygatePatch(current, patch) {
  const next = Object.assign({}, current);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl || '').trim();
  if (patch.authHeader !== undefined) next.authHeader = String(patch.authHeader || 'x-api-key').trim();
  if (patch.authValue !== undefined && patch.authValue !== MASK) next.authValue = String(patch.authValue || '');
  if (patch.country !== undefined) next.country = String(patch.country || '').trim().toUpperCase();
  if (patch.socksHost !== undefined) next.socksHost = String(patch.socksHost || '').trim();
  if (patch.socksPassword !== undefined && patch.socksPassword !== MASK) {
    next.socksPassword = String(patch.socksPassword || '');
  }
  return next;
}

function ensureProxygate(state) {
  if (!state.proxygate.baseUrl) {
    throw Object.assign(new Error('先在面板里填写 proxygate 地址'), { status: 400, code: 'proxygate_url_missing' });
  }
  if (!state.proxygate.authValue) {
    throw Object.assign(new Error('先在面板里填写 proxygate API Key'), { status: 400, code: 'proxygate_key_missing' });
  }
  return createProxygateClient(state.proxygate);
}

function lastSnapshot(state, slotId) {
  const lease = (state.leases || []).find((entry) => entry.provider === 'proxygate' && entry.slotId === slotId);
  return lease ? lease.slot : null;
}

function fillPrimary(state) {
  if (state.settings.primary) {
    const exists = (state.leases || []).some((lease) => lease.id === state.settings.primary);
    if (exists) return;
  }
  const first = (state.leases || [])[0];
  state.settings.primary = first ? first.id : '';
}

function configView(state) {
  return {
    ok: true,
    version: VERSION,
    settings: state.settings,
    nodes: (state.nodes || []).map((node) => {
      let view = null;
      try { view = publicNode(parseNodeUri(node.uri)); } catch (error) { view = { error: error.message }; }
      return { id: node.id, name: node.name, createdAt: node.createdAt, lastCheck: node.lastCheck || null, node: view };
    }),
    proxygate: maskProxygate(state.proxygate),
    leases: (state.leases || []).map((lease) => ({
      id: lease.id,
      key: lease.key,
      provider: lease.provider,
      nodeId: lease.nodeId || '',
      slotId: lease.slotId || '',
      country: lease.country || '',
      port: lease.port || 0,
      ok: lease.ok,
      exitIp: lease.exitIp || '',
      checkError: lease.checkError || '',
      createdAt: lease.createdAt || '',
    })),
    primary: state.settings.primary || '',
    dataDir: store.DATA_DIR,
    files: { endpoints: store.ENDPOINTS_FILE, proxies: store.PROXIES_FILE },
    lanes: engine.status().lanes,
  };
}

function endpointsView() {
  try {
    return JSON.parse(fs.readFileSync(store.ENDPOINTS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function runNodeProbe(id) {
  const result = await engine.probeNode(id);
  return result;
}

async function probeLease(id) {
  let state = store.load();
  const lease = store.findLease(state, id);
  if (!lease) throw Object.assign(new Error('租约不存在'), { status: 404, code: 'lease_missing' });
  let entry = [...engine.listeners.values()].find((item) => item.leaseId === id);
  if (!entry) {
    await engine.reconcile('probe-lease');
    entry = [...engine.listeners.values()].find((item) => item.leaseId === id);
  }
  if (!entry) {
    throw Object.assign(new Error('租约入口尚未就绪，检查节点或代理配置'), { status: 409, code: 'lane_not_ready' });
  }
  const result = await probeViaProxy({
    host: '127.0.0.1',
    port: entry.port,
    url: state.settings.probeUrl || 'https://api.ipify.org',
    timeoutMs: 25000,
  });
  state = store.load();
  const fresh = store.findLease(state, id);
  if (fresh) {
    fresh.ok = true;
    fresh.exitIp = result.exitIp;
    fresh.exitIpCheckedAt = new Date().toISOString();
    fresh.checkError = '';
    store.save(state);
  }
  entry.result = { ok: true, exitIp: result.exitIp, checkedAt: new Date().toISOString() };
  entry.lastError = '';
  return result;
}

async function syncProxygate(body) {
  const state = store.load();
  const client = ensureProxygate(state);
  const payload = await client.slots();
  if (payload.host && !state.proxygate.socksHost) state.proxygate.socksHost = payload.host;
  const result = syncLeases(state, payload, { max: body.max, prune: body.prune !== false });
  fillPrimary(state);
  store.save(state);
  await engine.reconcile('proxygate-sync');
  void engine.probe();
  return Object.assign({ ok: true, host: payload.host || state.proxygate.socksHost, slots: payload.slots.length }, result);
}

async function allocateProxygate(body) {
  const state = store.load();
  const client = ensureProxygate(state);
  const raw = await client.allocate({
    country: String(body.country || state.proxygate.country || '').toUpperCase() || undefined,
    protocol: 'socks',
  });
  const slot = Object.assign(normalizeSlot(raw), { host: state.proxygate.socksHost || raw.host || '' });
  if (!slot.slotId) throw Object.assign(new Error('proxygate 未返回槽位 ID'), { status: 502, code: 'slot_missing' });
  slotDescriptor(slot, state.proxygate);
  const existing = state.leases.find((lease) => lease.provider === 'proxygate' && lease.slotId === slot.slotId);
  if (existing) {
    existing.slot = slot;
    existing.country = slot.countryShort || slot.country || existing.country;
    store.save(state);
    await engine.reconcile('slot-refresh');
    return { ok: true, lease: existing, reused: true };
  }
  const key = `pg/${slot.countryShort || slot.country || 'ANY'}/${slot.slotId}`;
  const lease = {
    id: store.newId('lease'),
    key,
    provider: 'proxygate',
    slotId: slot.slotId,
    slot,
    country: slot.countryShort || slot.country || '',
    port: 0,
    ok: slot.healthy,
    createdAt: new Date().toISOString(),
  };
  state.leases.push(lease);
  fillPrimary(state);
  store.save(state);
  await engine.reconcile('slot-allocate');
  return { ok: true, lease };
}

async function rotateSlot(body) {
  const state = store.load();
  const slotId = String(body.slotId || '');
  if (!slotId) throw Object.assign(new Error('缺少 slotId'), { status: 400, code: 'slot_id_missing' });
  const client = ensureProxygate(state);
  const raw = await client.rotate(slotId);
  const slot = Object.assign(normalizeSlot(raw), { host: state.proxygate.socksHost || raw.host || '' });
  const existing = state.leases.find((lease) => lease.provider === 'proxygate' && lease.slotId === slotId);
  if (existing) {
    existing.slot = slot;
    existing.country = slot.countryShort || slot.country || existing.country;
    existing.ok = slot.healthy;
    existing.exitIp = slot.exitIp || existing.exitIp;
  }
  store.save(state);
  await engine.reconcile('slot-rotate');
  return { ok: true, slot };
}

function nodeFromBody(body) {
  const uri = String(body.uri || '').trim();
  const descriptor = parseNodeUri(uri);
  const name = String(body.name || '').trim() || descriptor.tag || `${descriptor.protocol}-${descriptor.server}`;
  return { uri, name, descriptor };
}

function listRoutes(req, res, url, body) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2] ? decodeURIComponent(parts[2]) : '';

  if (url.pathname === '/api/status') {
    const state = store.load();
    return send(res, 200, {
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      engine: engine.status(),
      endpoints: endpointsView(),
      dataDir: store.DATA_DIR,
    });
  }

  if (url.pathname === '/api/config') {
    if (req.method === 'GET') return send(res, 200, configView(store.load()));
    if (req.method === 'PUT') {
      const state = store.load();
      if (body.settings) state.settings = settingsPatch(state.settings, body.settings);
      if (body.proxygate) state.proxygate = proxygatePatch(state.proxygate, body.proxygate);
      store.save(state);
      return engine.reconcile('config').then(() => send(res, 200, configView(store.load())));
    }
    return send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '方法不支持' } });
  }

  if (url.pathname === '/api/endpoints' && req.method === 'GET') {
    const live = engine.status();
    return send(res, 200, {
      ok: true,
      live,
      file: endpointsView(),
      paths: { endpoints: store.ENDPOINTS_FILE, proxies: store.PROXIES_FILE },
    });
  }

  if (url.pathname === '/api/nodes' && req.method === 'POST') {
    const state = store.load();
    const { uri, name, descriptor } = nodeFromBody(body);
    if ((state.nodes || []).some((node) => node.uri === uri)) {
      throw Object.assign(new Error('这个节点已经添加过了'), { status: 409, code: 'node_exists' });
    }
    const node = { id: store.newId('node'), name, uri, createdAt: new Date().toISOString() };
    state.nodes.push(node);
    fillPrimary(state);
    store.save(state);
    return engine.reconcile('node-add').then(() => send(res, 201, {
      ok: true,
      node: { id: node.id, name: node.name, createdAt: node.createdAt, node: publicNode(descriptor) },
      config: configView(store.load()),
    }));
  }

  if (parts[0] === 'api' && parts[1] === 'nodes' && id) {
    const state = store.load();
    const node = store.findNode(state, id);
    if (!node) throw Object.assign(new Error('节点不存在'), { status: 404, code: 'node_missing' });

    if (req.method === 'PATCH') {
      if (body.name !== undefined) node.name = String(body.name || '').trim() || node.name;
      if (body.uri !== undefined) {
        const parsed = nodeFromBody({ uri: body.uri, name: node.name });
        node.uri = parsed.uri;
      }
      store.save(state);
      return engine.reconcile('node-update').then(() => send(res, 200, { ok: true, config: configView(store.load()) }));
    }

    if (req.method === 'DELETE') {
      const used = (state.leases || []).filter((lease) => lease.nodeId === id);
      for (const lease of used) releasePort(state, lease.key);
      state.leases = (state.leases || []).filter((lease) => lease.nodeId !== id);
      state.nodes = (state.nodes || []).filter((entry) => entry.id !== id);
      fillPrimary(state);
      store.save(state);
      return engine.reconcile('node-delete').then(() => send(res, 200, { ok: true, removedLeases: used.length }));
    }

    if (parts[3] === 'probe' && req.method === 'POST') {
      return runNodeProbe(id).then((result) => send(res, 200, { ok: true, result, config: configView(store.load()) }));
    }
  }

  if (url.pathname === '/api/leases' && req.method === 'GET') {
    return send(res, 200, { ok: true, leases: store.load().leases || [], primary: store.load().settings.primary });
  }

  if (url.pathname === '/api/leases' && req.method === 'POST') {
    const state = store.load();
    const provider = String(body.provider || 'static');
    if (provider === 'proxygate') {
      return allocateProxygate(body).then((result) => send(res, 201, Object.assign({ config: configView(store.load()) }, result)));
    }
    const node = store.findNode(state, String(body.nodeId || ''));
    if (!node) throw Object.assign(new Error('先选择一个节点'), { status: 400, code: 'node_missing' });
    const key = String(body.key || '').trim() || `node/${node.name}`;
    if ((state.leases || []).some((lease) => lease.key === key)) {
      throw Object.assign(new Error('租约 key 重复'), { status: 409, code: 'lease_key_exists' });
    }
    const lease = {
      id: store.newId('lease'),
      key,
      provider: 'static',
      nodeId: node.id,
      country: String(body.country || '').trim().toUpperCase(),
      port: 0,
      ok: null,
      createdAt: new Date().toISOString(),
    };
    state.leases.push(lease);
    if (body.primary || state.leases.length === 1) state.settings.primary = lease.id;
    fillPrimary(state);
    store.save(state);
    return engine.reconcile('lease-add').then(() => send(res, 201, { ok: true, lease: store.findLease(store.load(), lease.id), config: configView(store.load()) }));
  }

  if (parts[0] === 'api' && parts[1] === 'leases' && id) {
    const state = store.load();
    const lease = store.findLease(state, id);
    if (!lease) throw Object.assign(new Error('租约不存在'), { status: 404, code: 'lease_missing' });

    if (req.method === 'PATCH') {
      if (body.key !== undefined) {
        const key = String(body.key || '').trim();
        if (key) lease.key = key;
      }
      if (body.country !== undefined) lease.country = String(body.country || '').trim().toUpperCase();
      if (body.primary) state.settings.primary = lease.id;
      store.save(state);
      return engine.reconcile('lease-update').then(() => send(res, 200, { ok: true, lease, config: configView(store.load()) }));
    }

    if (req.method === 'DELETE') {
      releasePort(state, lease.key);
      state.leases = state.leases.filter((entry) => entry.id !== id);
      fillPrimary(state);
      store.save(state);
      return engine.reconcile('lease-delete').then(() => send(res, 200, { ok: true }));
    }

    if (parts[3] === 'probe' && req.method === 'POST') {
      return probeLease(id).then((result) => send(res, 200, { ok: true, result, config: configView(store.load()) }));
    }
  }

  if (url.pathname === '/api/proxygate/sync' && req.method === 'POST') {
    return syncProxygate(body).then((result) => send(res, 200, Object.assign({ config: configView(store.load()) }, result)));
  }

  if (url.pathname === '/api/proxygate/allocate' && req.method === 'POST') {
    return allocateProxygate(body).then((result) => send(res, 201, Object.assign({ config: configView(store.load()) }, result)));
  }

  if (url.pathname === '/api/proxygate/rotate' && req.method === 'POST') {
    return rotateSlot(body).then((result) => send(res, 200, Object.assign({ config: configView(store.load()) }, result)));
  }

  if (url.pathname === '/api/reconcile' && req.method === 'POST') {
    return engine.reconcile('manual').then(() => send(res, 200, { ok: true, engine: engine.status(), config: configView(store.load()) }));
  }

  if (url.pathname === '/api/probe' && req.method === 'POST') {
    return engine.probe().then(() => send(res, 200, { ok: true, engine: engine.status(), config: configView(store.load()) }));
  }

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, version: VERSION });
  }

  return send(res, 404, { ok: false, error: { code: 'not_found', message: `未知接口 ${req.method} ${url.pathname}` } });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return send(res, 400, { ok: false, error: { code: 'bad_url', message: 'URL 无法解析' } });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' });
    return res.end();
  }

  if (!authorized(req)) {
    return send(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或错误的 Bearer token' } });
  }

  const run = req.method === 'GET' || req.method === 'HEAD'
    ? Promise.resolve({})
    : readBody(req).catch((error) => Promise.reject(error));

  run
    .then((body) => listRoutes(req, res, url, body))
    .catch((error) => {
      if (res.headersSent) {
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      failure(res, error);
    });
});

server.on('error', (error) => {
  log(`服务监听失败: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} v${VERSION}`);
  engine.start().catch((error) => log(`引擎启动失败: ${error.message}`));
});

function shutdown(signal) {
  log(`收到 ${signal}，正在关闭`);
  const done = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  engine.stop().then(done, done);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server };
