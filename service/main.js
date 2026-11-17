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
const { createRouterEngine } = require('../core/router-engine');
const { createRotationCoordinator } = require('../core/rotation-coordinator');
const { createWsHub } = require('../lib/ws');
const matrixStore = require('../core/matrix-store');
const { parseNodeUri, publicNode } = require('../lib/node-uri');
const { createProxygateClient, normalizeSlot, slotDescriptor, syncLeases } = require('../lib/providers/proxygate');
const { releasePort } = require('../lib/ports');
const { syncSubscription } = require('../lib/subscriptions');
const { planLeases, parseStartPort } = require('../lib/lease-batch');
const {
  egressPortForIndex,
  indexForSlotId,
  isControlPlaneHost,
  matrixSlotIdForPort,
  normalizeFingerprint,
  normalizePrefix64,
  normalizeRoutingPlane,
} = require('../core/contract');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.EGRESS_MATRIX_PORT || 0);
const TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');
const HOST = '127.0.0.1';
const BUS_PORT = Number(process.env.OPENCHAMBER_MATRIX_BUS_PORT || 19880);
const BODY_LIMIT = 512 * 1024;
const MASK = '••••••';
const VERSION = require('../package.json').version;

const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-OC-Routing-Plane, X-OC-Matrix-Token';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

const PANEL_ROOT = path.join(__dirname, '..', 'ui');
const PANEL_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-max-age': '86400',
  };
}

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

const engine = createRouterEngine({
  load: store.load,
  save: store.save,
  writeEndpoints: store.writeEndpoints,
  log,
});

const wsHub = createWsHub({ log });
const rotation = createRotationCoordinator({ engine, log, wsHub });

/*
 * Every contract-visible slot transition becomes a SLOT_STATE_UPDATED frame
 * on the local WebSocket hub. The panel merges these into its matrix view so
 * health lights and progress rails move without waiting for the poll timer.
 */
engine.observe((event) => {
  if (!event || event.type !== 'SLOT_STATE_UPDATED' || !event.slot) return;
  wsHub.broadcast('SLOT_STATE_UPDATED', {
    matrixSlotId: event.slot.matrixSlotId,
    slot: event.slot,
    removed: Boolean(event.slot.removed),
  });
});

const startedAt = Date.now();

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }, corsHeaders(), headers));
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

const PANEL_PREFIXES = ['/ui', '/panel'];

function panelPrefix(pathname) {
  for (const prefix of PANEL_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix;
  }
  return '';
}

function notFound(res, message) {
  send(res, 404, { ok: false, error: { code: 'not_found', message } });
}

async function servePanel(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '静态资源只支持 GET/HEAD' } });
  }

  const prefix = panelPrefix(url.pathname);
  if (!prefix) return notFound(res, '静态资源不存在');
  if (url.pathname === prefix) {
    res.writeHead(308, { location: `${prefix}/`, 'cache-control': 'no-store' });
    return res.end();
  }

  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/+/, '');
  } catch {
    return send(res, 400, { ok: false, error: { code: 'bad_path', message: '静态路径无法解码' } });
  }
  if (!relative || relative.endsWith('/')) relative = `${relative}index.html`;
  if (relative.includes('\0')) return notFound(res, '静态资源不存在');

  const file = path.resolve(PANEL_ROOT, relative);
  if (file !== PANEL_ROOT && !file.startsWith(`${PANEL_ROOT}${path.sep}`)) {
    return notFound(res, '静态资源不存在');
  }

  let body;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return notFound(res, '静态资源不存在');
    body = await fs.promises.readFile(file);
  } catch {
    return notFound(res, '静态资源不存在');
  }

  res.writeHead(200, {
    'content-type': PANEL_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
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
  if (patch.controlDomains !== undefined) {
    const list = Array.isArray(patch.controlDomains)
      ? patch.controlDomains
      : String(patch.controlDomains || '').split(/[\n,]+/);
    next.controlDomains = list
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => /^[a-z0-9.-]+$/.test(item));
  }
  return next;
}

function warpPatch(current, patch) {
  const next = Object.assign({}, current);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.cooldownMs !== undefined) {
    const value = Number(patch.cooldownMs);
    if (!Number.isInteger(value) || value < 1000 || value > 3600000) {
      throw Object.assign(new Error('cooldownMs 必须是 1000-3600000 的整数'), {
        status: 400,
        code: 'invalid_setting',
      });
    }
    next.cooldownMs = value;
  }
  if (patch.endpoints !== undefined) {
    const list = Array.isArray(patch.endpoints)
      ? patch.endpoints
      : String(patch.endpoints || '').split(/\n+/);
    next.endpoints = list.map((item) => String(item || '').trim()).filter(Boolean);
  }
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

function autoLeaseNodes(state, subscription, options = {}) {
  const startPort = parseStartPort(options.startPort);
  const plan = planLeases(state, subscription, options);
  let nextPort = startPort;
  for (const spec of plan.specs) {
    const lease = {
      id: store.newId('lease'),
      key: spec.key,
      provider: 'static',
      nodeId: spec.nodeId,
      country: spec.country,
      port: 0,
      matrixSlotId: nextPort ? matrixSlotIdForPort(nextPort) : '',
      ok: null,
      exitIp: spec.exitIp || '',
      exitIpCheckedAt: spec.checkedAt || '',
      createdAt: new Date().toISOString(),
    };
    if (nextPort) {
      claimPort(state, lease.key, nextPort);
      lease.port = nextPort;
      nextPort += 1;
    }
    state.leases.push(lease);
  }
  return { created: plan.specs.length, skipped: plan.skipped };
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
    result.createdLeases = autoLeaseNodes(state, subscription).created;
  }
  fillPrimary(state);
  store.save(state);
  await engine.reconcile('subscription-sync');
  return result;
}

function configView(state) {
  const engineStatus = engine.status();
  const slots = engineStatus.slots || [];
  const slotsById = new Map(slots.map((slot) => [slot.matrixSlotId, slot]));
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
        uri: node.uri,
        subscriptionId: node.subscriptionId || '',
        createdAt: node.createdAt,
        lastCheck: node.lastCheck || null,
        node: view,
      };
    }),
    subscriptions: (state.subscriptions || []).map((subscription) => subscriptionView(state, subscription)),
    proxygate: maskProxygate(state.proxygate),
    leases: (state.leases || []).map((lease) => {
      const slot = slotsById.get(lease.matrixSlotId) || null;
      return {
        id: lease.id,
        key: lease.key,
        provider: lease.provider,
        nodeId: lease.nodeId || '',
        slotId: lease.slotId || '',
        country: lease.country || '',
        port: slot ? slot.egressPort : (lease.egressPort || 0),
        ok: lease.ok,
        exitIp: lease.exitIp || '',
        exitIpCheckedAt: lease.exitIpCheckedAt || '',
        checkError: lease.checkError || '',
        createdAt: lease.createdAt || '',
        matrixSlotId: slot ? slot.matrixSlotId : (lease.matrixSlotId || ''),
        egressPort: slot ? slot.egressPort : (lease.egressPort || 0),
        routingPlane: normalizeRoutingPlane(slot ? slot.routingPlane : lease.routingPlane),
        healthState: slot ? slot.healthState : 'COOLDOWN',
        egressFingerprint: normalizeFingerprint(slot ? slot.egressFingerprint : lease.egressFingerprint),
        leaseId: slot ? slot.leaseId : (lease.leaseId || ''),
      };
    }),
    slots,
    primary: state.settings.primary || '',
    dataDir: store.DATA_DIR,
    matrix: { dataDir: matrixStore.STATE_DIR, leases: matrixStore.LEASES_FILE, ledger: matrixStore.LEDGER_FILE },
    files: { endpoints: store.ENDPOINTS_FILE, proxies: store.PROXIES_FILE },
    lanes: engineStatus.lanes,
    warp: engineStatus.warp,
    abuse: engineStatus.abuse,
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

const NODE_PROBE_BATCH = 12;
const nodeProbeJob = {
  running: false,
  total: 0,
  done: 0,
  passed: 0,
  failed: 0,
  subscriptionId: '',
  startedAt: '',
  finishedAt: '',
  error: '',
};
let pendingNodeChecks = [];

function nodeProbeStatus() {
  return Object.assign({}, nodeProbeJob);
}

function flushNodeChecks() {
  if (!pendingNodeChecks.length) return;
  const batch = pendingNodeChecks;
  pendingNodeChecks = [];
  try {
    const state = store.load();
    for (const item of batch) {
      const node = store.findNode(state, item.nodeId);
      if (node) node.lastCheck = item.lastCheck;
    }
    store.save(state);
  } catch (error) {
    log(`写入体检结果失败: ${error.message}`);
  }
}

function startNodeProbeJob(body = {}) {
  if (nodeProbeJob.running) {
    throw Object.assign(new Error('节点体检正在进行'), { status: 409, code: 'node_probe_running' });
  }
  const state = store.load();
  const subscriptionId = String(body.subscriptionId || '');
  const force = body.force === true;
  const ttlMs = Math.max(0, Number(body.ttlMs) || 0);
  const limit = Math.max(0, Math.min(Number(body.limit) || 0, 5000));
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 16, 64));
  const now = Date.now();

  let nodes = (state.nodes || []).slice();
  if (subscriptionId) nodes = nodes.filter((node) => node.subscriptionId === subscriptionId);
  if (!force && ttlMs > 0) {
    nodes = nodes.filter((node) => {
      const check = node.lastCheck;
      if (!check || !check.checkedAt) return true;
      const at = Date.parse(check.checkedAt);
      return !Number.isFinite(at) || now - at > ttlMs;
    });
  }
  if (limit) nodes = nodes.slice(0, limit);

  nodeProbeJob.running = true;
  nodeProbeJob.total = nodes.length;
  nodeProbeJob.done = 0;
  nodeProbeJob.passed = 0;
  nodeProbeJob.failed = 0;
  nodeProbeJob.subscriptionId = subscriptionId;
  nodeProbeJob.startedAt = new Date().toISOString();
  nodeProbeJob.finishedAt = '';
  nodeProbeJob.error = '';
  pendingNodeChecks = [];

  const queue = nodes.slice();
  const workers = new Array(Math.min(concurrency, Math.max(queue.length, 1))).fill(0).map(async () => {
    while (queue.length) {
      const node = queue.shift();
      let result;
      try {
        result = await engine.probeNode(node.id, { deep: true, persist: false });
      } catch (error) {
        result = {
          ok: false,
          lastCheck: {
            ok: false,
            exitIp: '',
            asn: '',
            country: '',
            countryCode: '',
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            error: error.message,
          },
        };
      }
      pendingNodeChecks.push({ nodeId: node.id, lastCheck: result.lastCheck });
      if (result.ok) nodeProbeJob.passed += 1;
      else nodeProbeJob.failed += 1;
      nodeProbeJob.done += 1;
      if (pendingNodeChecks.length >= NODE_PROBE_BATCH) flushNodeChecks();
    }
  });

  Promise.all(workers).then(() => {
    flushNodeChecks();
    nodeProbeJob.running = false;
    nodeProbeJob.finishedAt = new Date().toISOString();
    log(`节点体检完成: ${nodeProbeJob.passed}/${nodeProbeJob.total} 通过`);
  }).catch((error) => {
    flushNodeChecks();
    nodeProbeJob.running = false;
    nodeProbeJob.finishedAt = new Date().toISOString();
    nodeProbeJob.error = error.message;
    log(`节点体检中断: ${error.message}`);
  }).then(() => {
    engine.reconcile('node-probe').catch((error) => log(`体检后同步失败: ${error.message}`));
  });

  return nodeProbeStatus();
}

async function probeLease(id) {
  let state = store.load();
  const lease = store.findLease(state, id);
  if (!lease) throw Object.assign(new Error('租约不存在'), { status: 404, code: 'lease_missing' });

  if (!lease.matrixSlotId) {
    await engine.reconcile('probe-lease');
    state = store.load();
    const refreshed = store.findLease(state, id);
    if (refreshed && refreshed.matrixSlotId) lease.matrixSlotId = refreshed.matrixSlotId;
  }
  if (!lease.matrixSlotId) {
    throw Object.assign(new Error('租约尚未分配矩阵槽位，先同步节点'), {
      status: 409,
      code: 'lane_not_ready',
    });
  }

  const result = await engine.probeSlot(lease.matrixSlotId, { deep: true });
  if (!result || !result.ok) {
    throw Object.assign(new Error((result && result.error) || '出口探测失败'), {
      status: 502,
      code: 'probe_failed',
      matrixSlotId: lease.matrixSlotId,
    });
  }
  return {
    ok: true,
    matrixSlotId: lease.matrixSlotId,
    egressPort: Number(lease.egressPort) || 0,
    exitIp: result.exitIp || '',
    egressFingerprint: result.fingerprint || null,
  };
}

async function egressState() {
  const status = engine.status();
  let callbacks = [];
  let events = [];
  try { callbacks = await matrixStore.listCallbacks(); } catch (error) { log(`读取回调失败: ${error.message}`); }
  try { events = await matrixStore.listEvents(50); } catch (error) { log(`读取旋转事件失败: ${error.message}`); }
  return {
    ok: true,
    version: VERSION,
    updatedAt: new Date().toISOString(),
    defaultPort: status.defaultPort,
    primary: status.primary,
    slots: status.slots || [],
    lanes: status.lanes || [],
    warp: status.warp || null,
    abuse: status.abuse || null,
    callbacks,
    events,
  };
}

function resolveLeaseForSlot(state, matrixSlotId) {
  const slot = engine.getSlot(matrixSlotId);
  if (!slot) return null;
  const lease = (state.leases || []).find((entry) => entry.id === slot.intentId
    || entry.matrixSlotId === matrixSlotId);
  return lease ? { slot, lease } : null;
}

async function rotateMatrixSlot(matrixSlotId, body = {}) {
  const result = await rotation.rotate(String(matrixSlotId), async ({ slot }) => {
    const state = store.load();
    const found = resolveLeaseForSlot(state, slot.matrixSlotId);
    if (!found) {
      throw Object.assign(new Error('租约配置不存在'), { status: 404, code: 'lease_missing' });
    }
    const lease = found.lease;
    let descriptor = null;

    if (body.nodeId) {
      const node = store.findNode(state, String(body.nodeId));
      if (!node) throw Object.assign(new Error('节点不存在'), { status: 404, code: 'node_missing' });
      lease.nodeId = node.id;
      delete lease.nodeUri;
      descriptor = parseNodeUri(node.uri);
    } else if (body.nodeUri) {
      descriptor = parseNodeUri(String(body.nodeUri));
      lease.nodeUri = String(body.nodeUri);
    } else if (body.slotId) {
      const client = ensureProxygate(state);
      const payload = await client.rotate(String(body.slotId));
      const normalized = normalizeSlot(payload.slot || payload);
      lease.slotId = normalized.slotId;
      lease.slot = normalized;
      descriptor = parseNodeUri(slotDescriptor(normalized, state.proxygate));
    } else {
      throw Object.assign(new Error('旋转需要 nodeId、nodeUri 或 slotId'), {
        status: 400,
        code: 'rotation_target_required',
      });
    }

    lease.rotationCount = Number(lease.rotationCount || 0) + 1;
    store.save(state);

    let probed = null;
    try {
      probed = await engine.probeDescriptor(descriptor, { deep: true });
    } catch (error) {
      log(`旋转前探测失败: ${error.message}`);
    }

    const supplied = normalizeFingerprint(body.egressFingerprint || {});
    const exitIp = (probed && probed.exitIp) || supplied.exitIp || '';
    if (!exitIp) {
      throw Object.assign(new Error('换血校验失败：新上游未返回出口 IP'), {
        status: 502,
        code: 'rotation_probe_failed',
      });
    }
    if (probed && supplied.exitIp && probed.exitIp !== supplied.exitIp) {
      log(`旋转指纹不一致: 探测 ${probed.exitIp} / 提交 ${supplied.exitIp}，以探测为准`);
    }
    return {
      descriptor,
      egressFingerprint: {
        exitIp,
        ipv6Prefix64: normalizePrefix64((probed && probed.ipv6Prefix64) || supplied.ipv6Prefix64 || ''),
        asn: (probed && probed.asn) || supplied.asn || '',
        leaseId: '',
      },
    };
  }, { reason: String(body.reason || 'manual') });

  await engine.reconcile('rotation');
  return result;
}

/*
 * Bind one config lease to an explicit matrix slot. Port math always comes
 * from core/contract; the lease row is the config source of truth, while
 * egress-leases.json receives the mirrored contract record via store.save().
 */
async function bindLease(body = {}) {
  const matrixSlotId = String(body.matrixSlotId || '').trim();
  const index = indexForSlotId(matrixSlotId);
  if (!index) {
    throw Object.assign(new Error('matrixSlotId 必须是 slot-001..slot-250'), {
      status: 400,
      code: 'invalid_slot',
    });
  }
  const state = store.load();
  const leaseId = String(body.leaseId || body.intentId || '').trim();
  let lease = leaseId ? store.findLease(state, leaseId) : null;
  if (!lease && !leaseId && body.key) {
    lease = (state.leases || []).find((entry) => entry.key === String(body.key)) || null;
  }
  if (!lease) {
    throw Object.assign(new Error('租约不存在'), { status: 404, code: 'lease_missing' });
  }
  const owner = (state.leases || []).find((entry) => entry.id !== lease.id
    && entry.matrixSlotId === matrixSlotId);
  if (owner) {
    throw Object.assign(new Error(`槽位 ${matrixSlotId} 已被租约 ${owner.key} 占用`), {
      status: 409,
      code: 'slot_taken',
    });
  }
  lease.matrixSlotId = matrixSlotId;
  lease.egressPort = egressPortForIndex(index);
  store.save(state);
  await engine.reconcile('lease-bind');
  const slot = engine.getSlot(matrixSlotId);
  return {
    matrixSlotId,
    egressPort: lease.egressPort,
    lease: {
      id: lease.id,
      key: lease.key,
      matrixSlotId,
      egressPort: lease.egressPort,
    },
    slot,
  };
}

function egressApiRoutes(req, res, url, body, isBus) {
  if (url.pathname === '/api/v1/egress/bus-health' && req.method === 'GET') {
    const status = engine.status();
    return send(res, 200, {
      ok: true,
      service: 'egress-matrix',
      activeSlots: (status.slots || []).filter((slot) => slot && slot.listener).length,
      warpPoolSize: Number(status.warp && status.warp.total) || 0,
      wsClientsCount: Number(wsHub.clientCount) || 0,
      timestamp: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/v1/egress/state' && req.method === 'GET') {
    return egressState().then((payload) => send(res, 200, payload));
  }

  if (url.pathname === '/api/v1/egress/leases' && req.method === 'GET') {
    return matrixStore.listLeases().then((leases) => send(res, 200, { ok: true, count: leases.length, leases }));
  }

  if (url.pathname === '/api/v1/egress/events' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    return matrixStore.listEvents(limit).then((events) => send(res, 200, { ok: true, events }));
  }

  if (url.pathname === '/api/v1/egress/callbacks' && req.method === 'GET') {
    return matrixStore.listCallbacks().then((callbacks) => send(res, 200, { ok: true, callbacks }));
  }

  if (url.pathname === '/api/v1/egress/callbacks' && req.method === 'POST') {
    return matrixStore.registerCallback({
      clientId: String(body.clientId || '').trim(),
      url: String(body.url || '').trim(),
      events: Array.isArray(body.events) ? body.events : undefined,
    }).then((callback) => send(res, 201, { ok: true, callback }));
  }

  if (url.pathname === '/api/v1/egress/callbacks' && req.method === 'DELETE') {
    const clientId = String(url.searchParams.get('clientId') || body.clientId || '').trim();
    if (!clientId) {
      throw Object.assign(new Error('缺少 clientId'), { status: 400, code: 'client_id_required' });
    }
    return matrixStore.removeCallback(clientId).then(() => send(res, 200, { ok: true }));
  }

  if (url.pathname === '/api/v1/egress/probe' && req.method === 'POST') {
    return engine.probeAll({ deep: Boolean(body.deep) }).then((result) => send(res, 200, {
      ok: true,
      result,
      state: engine.status(),
    }));
  }

  if (url.pathname === '/api/v1/egress/slots' && req.method === 'GET') {
    const status = engine.status();
    return send(res, 200, {
      ok: true,
      count: (status.slots || []).length,
      defaultPort: status.defaultPort,
      primary: status.primary,
      slots: status.slots || [],
      lanes: status.lanes || [],
      updatedAt: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/v1/egress/lease/bind' && req.method === 'POST') {
    return bindLease(body).then((payload) => send(res, 200, Object.assign({ ok: true }, payload)));
  }

  if (url.pathname === '/api/v1/egress/lease/rotate' && req.method === 'POST') {
    let matrixSlotId = String(body.matrixSlotId || '').trim();
    if (!matrixSlotId) {
      const leaseId = String(body.leaseId || body.intentId || '').trim();
      const state = leaseId ? store.load() : null;
      const lease = state ? store.findLease(state, leaseId) : null;
      matrixSlotId = String((lease && lease.matrixSlotId) || '').trim();
    }
    if (!matrixSlotId) {
      throw Object.assign(new Error('旋转需要 matrixSlotId 或已绑定槽位的 leaseId'), {
        status: 400,
        code: 'slot_id_required',
      });
    }
    return rotateMatrixSlot(matrixSlotId, body).then((slot) => send(res, 200, {
      ok: true,
      matrixSlotId,
      slot,
      state: engine.status(),
    }));
  }

  if (url.pathname === '/api/v1/egress/ack-freeze' && req.method === 'POST') {
    const clientId = String(body.clientId || '').trim();
    const eventId = String(body.eventId || '').trim();
    if (!clientId || !eventId) {
      throw Object.assign(new Error('缺少 clientId 或 eventId'), {
        status: 400,
        code: 'ack_invalid',
      });
    }
    const acknowledged = wsHub.ack(clientId, eventId, body.ok !== false);
    return send(res, acknowledged ? 200 : 409, {
      ok: acknowledged,
      clientId,
      eventId,
      acknowledged,
      hub: wsHub.status(),
    });
  }

  const leaseMatch = /^\/api\/v1\/egress\/lease\/([^/]+)$/.exec(url.pathname);
  if (leaseMatch && req.method === 'GET') {
    const matrixSlotId = decodeURIComponent(leaseMatch[1]);
    const cached = store.slotLease(matrixSlotId);
    const slot = cached.slot || engine.getSlot(matrixSlotId);
    if (!slot) {
      throw Object.assign(new Error('槽位不存在'), { status: 404, code: 'slot_missing' });
    }
    return send(res, 200, {
      ok: true,
      matrixSlotId,
      source: cached.slot ? 'cache' : 'engine',
      slot,
      lease: cached.lease,
    });
  }

  const slotMatch = /^\/api\/v1\/egress\/slots\/([^/]+)(?:\/(rotate|quarantine|release|probe|remove))?$/.exec(url.pathname);
  if (slotMatch) {
    const matrixSlotId = decodeURIComponent(slotMatch[1]);
    const action = slotMatch[2] || '';
    if (req.method === 'GET' && !action) {
      const slot = engine.getSlot(matrixSlotId);
      if (!slot) throw Object.assign(new Error('槽位不存在'), { status: 404, code: 'slot_missing' });
      return send(res, 200, { ok: true, slot });
    }
    if (req.method === 'POST' && action === 'rotate') {
      return rotateMatrixSlot(matrixSlotId, body).then((slot) => send(res, 200, {
        ok: true,
        slot,
        state: engine.status(),
      }));
    }
    if (req.method === 'POST' && action === 'quarantine') {
      return engine.quarantineSlot(matrixSlotId, body.reason || 'manual').then((slot) => send(res, 200, {
        ok: true,
        slot,
        state: engine.status(),
      }));
    }
    if (req.method === 'POST' && action === 'release') {
      return engine.releaseSlot(matrixSlotId).then((slot) => send(res, 200, {
        ok: true,
        slot,
        state: engine.status(),
      }));
    }
    if (req.method === 'POST' && action === 'remove') {
      const state = store.load();
      const slot = engine.getSlot(matrixSlotId);
      const leaseId = slot && (slot.intentId || slot.leaseId);
      const lease = leaseId ? store.findLease(state, leaseId) : null;
      if (!lease) throw Object.assign(new Error('槽位没有可移除的租约'), { status: 404, code: 'lease_missing' });
      releasePort(state, lease.key);
      state.leases = (state.leases || []).filter((entry) => entry.id !== lease.id);
      fillPrimary(state);
      store.save(state);
      const removed = { matrixSlotId, leaseId: lease.id, key: lease.key, egressPort: slot.egressPort || 0 };
      return engine.reconcile('slot-remove').then(() => send(res, 200, {
        ok: true,
        removed,
        state: engine.status(),
      }));
    }
    if (req.method === 'POST' && action === 'probe') {
      return engine.probeSlot(matrixSlotId, { deep: body.deep !== false }).then((slot) => send(res, 200, {
        ok: true,
        slot,
        state: engine.status(),
      }));
    }
  }

  send(res, 404, { ok: false, error: { code: 'not_found', message: `未知矩阵接口 ${req.method} ${url.pathname}` } });
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
  if (url.pathname.startsWith('/api/v1/egress')) {
    return egressApiRoutes(req, res, url, body, false);
  }

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
      if (body.warp) state.warp = warpPatch(state.warp, body.warp);
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

  if (url.pathname === '/api/nodes/probe-all' && req.method === 'POST') {
    return send(res, 202, { ok: true, job: startNodeProbeJob(body) });
  }

  if (url.pathname === '/api/nodes/probe-status' && req.method === 'GET') {
    return send(res, 200, { ok: true, job: nodeProbeStatus() });
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
      const plan = autoLeaseNodes(state, subscription, {
        keyPrefix: body.keyPrefix,
        startPort: body.startPort,
        country: body.country,
        onlyPassed: body.onlyPassed !== false,
      });
      fillPrimary(state);
      store.save(state);
      return engine.reconcile('subscription-leases').then(() => send(res, 201, {
        ok: true,
        created: plan.created,
        skipped: plan.skipped,
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
    const plan = autoLeaseNodes(state, subscription, {
      keyPrefix: body.keyPrefix,
      startPort: body.startPort,
      country: body.country,
      onlyPassed: body.onlyPassed !== false,
    });
    fillPrimary(state);
    store.save(state);
    return engine.reconcile('leases-batch').then(() => send(res, 201, {
      ok: true,
      created: plan.created,
      skipped: plan.skipped,
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
    const check = node.lastCheck || null;
    const probedCountry = check && check.ok ? String(check.countryCode || '').toUpperCase() : '';
    const lease = {
      id: store.newId('lease'),
      key,
      provider: 'static',
      nodeId: node.id,
      country: String(body.country || '').trim().toUpperCase() || probedCountry,
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

  if (url.pathname === '/health' || url.pathname === '/healthz') {
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
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (panelPrefix(url.pathname)) {
    servePanel(req, res, url).catch((error) => failure(res, error));
    return;
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

/*
 * Local co-operation bus. Loopback only, no bearer token: openchamber-instabox
 * and openchamber-cloudflare query leases and register rotation callbacks here.
 */
const busServer = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${BUS_PORT}`);
  } catch {
    return send(res, 400, { ok: false, error: { code: 'bad_url', message: 'URL 无法解析' } });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (!url.pathname.startsWith('/api/v1/egress')) {
    return send(res, 404, { ok: false, error: { code: 'not_found', message: '本地总线只暴露 /api/v1/egress' } });
  }

  const run = req.method === 'GET' || req.method === 'HEAD'
    ? Promise.resolve({})
    : readBody(req);
  run
    .then((body) => egressApiRoutes(req, res, url, body, true))
    .catch((error) => {
      if (res.headersSent) {
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      failure(res, error);
    });
});

busServer.on('error', (error) => log(`本地总线监听失败: ${error.message}`));
wsHub.attach(busServer);
if (BUS_PORT > 0) {
  busServer.listen(BUS_PORT, HOST, () => {
    log(`bus listening on http://${HOST}:${BUS_PORT}/api/v1/egress`);
    log(`ws listening on ws://${HOST}:${BUS_PORT}${wsHub.path}`);
  });
}

function shutdown(signal) {
  log(`收到 ${signal}，正在关闭`);
  const done = () => {
    wsHub.close();
    server.close(() => process.exit(0));
    if (BUS_PORT > 0) busServer.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  engine.stop().then(done, done);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, busServer };
