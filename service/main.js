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
const { releasePort, pool } = require('../lib/ports');
const { syncSubscription } = require('../lib/subscriptions');

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

function parsePort(value, label = '端口') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error(`${label}必须是 1-65535 的整数`), { status: 400, code: 'invalid_port' });
  }
  return port;
}

function portOwner(state, port, exceptKey) {
  for (const [key, value] of Object.entries(state.ports || {})) {
    if (key !== exceptKey && Number(value) === port) return `租约 ${key}`;
  }
  for (const lease of state.leases || []) {
    if (lease.key !== exceptKey && Number(lease.port) === port) return `租约 ${lease.key}`;
  }
  if (Number(state.settings.defaultPort) === port) return '默认网关';
  return '';
}

function claimPort(state, key, port) {
  const owner = portOwner(state, port, key);
  if (owner) {
    throw Object.assign(new Error(`端口 ${port} 已被${owner}占用`), { status: 409, code: 'port_taken' });
  }
  state.ports = state.ports || {};
  state.ports[key] = port;
  return port;
}

function slug(text) {
  const cleaned = String(text || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'node';
}

function leaseKeyFor(state, prefix, node) {
  const base = `${prefix}/${slug(node.name)}`;
  const taken = new Set((state.leases || []).map((lease) => lease.key));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function autoLeaseNodes(state, subscription, options = {}) {
  const prefix = String(options.keyPrefix || subscription.keyPrefix || `sub/${slug(subscription.name)}`).replace(/\/+$/, '');
  const startPort = options.startPort === undefined ? 0 : parsePort(options.startPort, '起始端口');
  const country = String(options.country || '').trim().toUpperCase();
  let created = 0;
  let nextPort = startPort;

  for (const node of state.nodes || []) {
    if (node.subscriptionId !== subscription.id) continue;
    if ((state.leases || []).some((lease) => lease.nodeId === node.id)) continue;
    const key = leaseKeyFor(state, prefix, node);
    const lease = {
      id: store.newId('lease'),
      key,
      provider: 'static',
      nodeId: node.id,
      country,
      port: 0,
      ok: null,
      createdAt: new Date().toISOString(),
    };
    if (nextPort) {
      claimPort(state, key, nextPort);
      lease.port = nextPort;
      nextPort += 1;
    }
    state.leases.push(lease);
    created += 1;
  }
  return created;
}

function subscriptionView(state, subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    url: subscription.url,
    keyPrefix: subscription.keyPrefix || '',
    autoLease: Boolean(subscription.autoLease),
    nodeCount: (state.nodes || []).filter((node) => node.subscriptionId === subscription.id).length,
    leaseCount: (state.leases || []).filter((lease) => {
      const node = store.findNode(state, lease.nodeId);
      return node && node.subscriptionId === subscription.id;
    }).length,
    lastSyncAt: subscription.lastSyncAt || '',
    lastError: subscription.lastError || '',
    createdAt: subscription.createdAt || '',
  };
}

async function applySubscription(state, subscription) {
  const result = await syncSubscription(state, subscription, {});
  if (subscription.autoLease) {
    result.createdLeases = autoLeaseNodes(state, subscription);
  }
  fillPrimary(state);
  store.save(state);
  await engine.reconcile('subscription-sync');
  return result;
}

function configView(state) {
  return {
    ok: true,
    version: VERSION,
    settings: state.settings,
    nodes: (state.nodes || []).map((node) => {
      let view = null;
      try { view = publicNode(parseNodeUri(node.uri)); } catch (error) { view = { error: error.message }; }
      return {
        id: node.id,
        name: node.name,
        subscriptionId: node.subscriptionId || '',
        createdAt: node.createdAt,
        lastCheck: node.lastCheck || null,
        node: view,
      };
    }),
    subscriptions: (state.subscriptions || []).map((subscription) => subscriptionView(state, subscription)),
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
      exitIpCheckedAt: lease.exitIpCheckedAt || '',
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
  const lanesOf = () => [...engine.listeners.values()].filter((item) => item.leaseId === id);
  let entries = lanesOf();
  if (!entries.length) {
    await engine.reconcile('probe-lease');
    entries = lanesOf();
  }
  const entry = entries[0];
  if (!entry) {
    throw Object.assign(new Error('租约入口尚未就绪，检查节点或代理配置'), { status: 409, code: 'lane_not_ready' });
  }

  let result;
  try {
    result = await probeViaProxy({
      host: '127.0.0.1',
      port: entry.port,
      url: state.settings.probeUrl || 'https://api.ipify.org',
      timeoutMs: 25000,
    });
  } catch (error) {
    state = store.load();
    const failed = store.findLease(state, id);
    if (failed) {
      failed.ok = false;
      failed.checkError = error.message;
      failed.exitIpCheckedAt = new Date().toISOString();
      store.save(state);
    }
    const checkedAt = new Date().toISOString();
    for (const item of entries) {
      item.result = { ok: false, exitIp: '', checkedAt };
      item.lastError = error.message;
    }
    engine.publishNow();
    throw error;
  }

  state = store.load();
  const fresh = store.findLease(state, id);
  if (fresh) {
    fresh.ok = true;
    fresh.exitIp = result.exitIp;
    fresh.exitIpCheckedAt = new Date().toISOString();
    fresh.checkError = '';
    store.save(state);
  }
  const checkedAt = new Date().toISOString();
  for (const item of entries) {
    item.result = { ok: true, exitIp: result.exitIp, checkedAt };
    item.lastError = '';
  }
  engine.publishNow();
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

async function listRoutes(req, res, url, body) {
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

  if (url.pathname === '/api/subscriptions' && req.method === 'GET') {
    const state = store.load();
    return send(res, 200, { ok: true, subscriptions: (state.subscriptions || []).map((sub) => subscriptionView(state, sub)) });
  }

  if (url.pathname === '/api/subscriptions' && req.method === 'POST') {
    const state = store.load();
    const urlText = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(urlText)) {
      throw Object.assign(new Error('订阅地址必须是 http(s) URL'), { status: 400, code: 'invalid_subscription_url' });
    }
    if ((state.subscriptions || []).some((sub) => sub.url === urlText)) {
      throw Object.assign(new Error('这个订阅已经添加过了'), { status: 409, code: 'subscription_exists' });
    }
    state.subscriptions = state.subscriptions || [];
    const subscription = {
      id: store.newId('sub'),
      name: String(body.name || '').trim() || `订阅 ${state.subscriptions.length + 1}`,
      url: urlText,
      keyPrefix: String(body.keyPrefix || '').trim().replace(/\/+$/, ''),
      autoLease: Boolean(body.autoLease),
      lastSyncAt: '',
      lastError: '',
      createdAt: new Date().toISOString(),
    };
    state.subscriptions.push(subscription);
    store.save(state);
    let synced = true;
    let result = {};
    try {
      result = await applySubscription(state, subscription);
    } catch (error) {
      synced = false;
      const failed = store.load();
      const fresh = (failed.subscriptions || []).find((sub) => sub.id === subscription.id);
      if (fresh) {
        fresh.lastError = error.message;
        store.save(failed);
      }
      result = { error: error.message, code: error.code || 'subscription_sync_failed' };
    }
    return send(res, 201, { ok: true, synced, subscription: subscriptionView(store.load(), subscription), result, config: configView(store.load()) });
  }

  if (parts[0] === 'api' && parts[1] === 'subscriptions' && id) {
    const state = store.load();
    const subscription = (state.subscriptions || []).find((sub) => sub.id === id);
    if (!subscription) throw Object.assign(new Error('订阅不存在'), { status: 404, code: 'subscription_missing' });

    if (req.method === 'PATCH') {
      if (body.name !== undefined) subscription.name = String(body.name || '').trim() || subscription.name;
      if (body.url !== undefined) {
        const urlText = String(body.url || '').trim();
        if (!/^https?:\/\//i.test(urlText)) {
          throw Object.assign(new Error('订阅地址必须是 http(s) URL'), { status: 400, code: 'invalid_subscription_url' });
        }
        subscription.url = urlText;
      }
      if (body.keyPrefix !== undefined) subscription.keyPrefix = String(body.keyPrefix || '').trim().replace(/\/+$/, '');
      if (body.autoLease !== undefined) subscription.autoLease = Boolean(body.autoLease);
      store.save(state);
      return send(res, 200, { ok: true, subscription: subscriptionView(store.load(), subscription), config: configView(store.load()) });
    }

    if (req.method === 'DELETE') {
      const nodeIds = new Set((state.nodes || []).filter((node) => node.subscriptionId === id).map((node) => node.id));
      const used = (state.leases || []).filter((lease) => nodeIds.has(lease.nodeId));
      for (const lease of used) releasePort(state, lease.key);
      state.leases = (state.leases || []).filter((lease) => !nodeIds.has(lease.nodeId));
      state.nodes = (state.nodes || []).filter((node) => !nodeIds.has(node.id));
      state.subscriptions = (state.subscriptions || []).filter((sub) => sub.id !== id);
      fillPrimary(state);
      store.save(state);
      return engine.reconcile('subscription-delete').then(() => send(res, 200, {
        ok: true,
        removedNodes: nodeIds.size,
        removedLeases: used.length,
      }));
    }

    if (parts[3] === 'sync' && req.method === 'POST') {
      try {
        const result = await applySubscription(state, subscription);
        return send(res, 200, { ok: true, result, config: configView(store.load()) });
      } catch (error) {
        const failed = store.load();
        const fresh = (failed.subscriptions || []).find((sub) => sub.id === id);
        if (fresh) {
          fresh.lastError = error.message;
          store.save(failed);
        }
        throw error;
      }
    }

    if (parts[3] === 'leases' && req.method === 'POST') {
      const created = autoLeaseNodes(state, subscription, {
        keyPrefix: body.keyPrefix,
        startPort: body.startPort,
        country: body.country,
      });
      fillPrimary(state);
      store.save(state);
      return engine.reconcile('subscription-leases').then(() => send(res, 201, {
        ok: true,
        created,
        config: configView(store.load()),
      }));
    }
  }

  if (url.pathname === '/api/leases' && req.method === 'GET') {
    return send(res, 200, { ok: true, leases: store.load().leases || [], primary: store.load().settings.primary });
  }

  if (url.pathname === '/api/leases/batch' && req.method === 'POST') {
    const state = store.load();
    const subscription = (state.subscriptions || []).find((sub) => sub.id === String(body.subscriptionId || ''));
    if (!subscription) throw Object.assign(new Error('先选择一个订阅'), { status: 400, code: 'subscription_missing' });
    const created = autoLeaseNodes(state, subscription, {
      keyPrefix: body.keyPrefix,
      startPort: body.startPort,
      country: body.country,
    });
    fillPrimary(state);
    store.save(state);
    return engine.reconcile('leases-batch').then(() => send(res, 201, {
      ok: true,
      created,
      config: configView(store.load()),
    }));
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
    if (body.port !== undefined && body.port !== '' && body.port !== null) {
      lease.port = claimPort(state, key, parsePort(body.port));
    }
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
        if (key && key !== lease.key) {
          if ((state.leases || []).some((entry) => entry.key === key)) {
            throw Object.assign(new Error('租约 key 重复'), { status: 409, code: 'lease_key_exists' });
          }
          const oldKey = lease.key;
          const carried = Number(state.ports && state.ports[oldKey]);
          if (Number.isInteger(carried) && carried > 0) {
            delete state.ports[oldKey];
            const owner = portOwner(state, carried, key);
            if (owner) {
              state.ports[oldKey] = carried;
              throw Object.assign(new Error(`端口 ${carried} 已被${owner}占用`), { status: 409, code: 'port_taken' });
            }
            state.ports[key] = carried;
          }
          lease.key = key;
        }
      }
      if (body.port !== undefined && body.port !== '' && body.port !== null) {
        const port = parsePort(body.port);
        claimPort(state, lease.key, port);
        lease.port = port;
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
