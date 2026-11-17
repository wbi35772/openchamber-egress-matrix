'use strict';

/*
 * Unified configuration store.
 *
 * state.json remains the human-editable config (settings, nodes, proxygate,
 * warp, subscriptions). Slot records are additionally mirrored into the
 * authoritative matrix-store (egress-leases.json) so every consumer sees one
 * contract-shaped lease per matrix slot.
 *
 * Reads are served from a process-hot cache; writes update the cache
 * immediately and are serialized through core/store-lock's atomic JSON path.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('../core/contract');
const matrixStore = require('../core/matrix-store');
const storeLock = require('../core/store-lock');

const DATA_DIR = process.env.EGRESS_MATRIX_DATA_DIR
  ? path.resolve(process.env.EGRESS_MATRIX_DATA_DIR)
  : path.join(os.homedir(), '.openchamber-egress-matrix');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.txt');

const DEFAULTS = {
  version: 2,
  settings: {
    listenHost: '127.0.0.1',
    defaultPort: 25001,
    probeUrl: 'https://api.ipify.org',
    controlDomains: [],
    primary: '',
  },
  nodes: [],
  leases: [],
  proxygate: {
    enabled: false,
    baseUrl: '',
    authHeader: 'x-api-key',
    authValue: '',
    country: '',
    socksHost: '',
    socksPassword: '',
  },
  warp: {
    enabled: false,
    endpoints: [],
    cooldownMs: 60000,
  },
  ports: {},
  subscriptions: [],
  updatedAt: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/*
 * Hot cache. `load()` never returns the cache object itself, so callers keep
 * their usual mutate-then-save pattern without leaking unsaved changes.
 */
let cache = null;
let dirty = false;
let writeQueue = Promise.resolve();
let mirrorQueue = Promise.resolve();

function normalize(parsed) {
  const state = Object.assign(clone(DEFAULTS), parsed || {});
  state.settings = Object.assign(clone(DEFAULTS.settings), parsed && parsed.settings);
  state.proxygate = Object.assign(clone(DEFAULTS.proxygate), parsed && parsed.proxygate);
  state.warp = Object.assign(clone(DEFAULTS.warp), parsed && parsed.warp);
  state.nodes = Array.isArray(state.nodes) ? state.nodes : [];
  state.leases = Array.isArray(state.leases) ? state.leases : [];
  state.ports = state.ports && typeof state.ports === 'object' ? state.ports : {};
  state.subscriptions = Array.isArray(state.subscriptions) ? state.subscriptions : [];
  return state;
}

function load() {
  if (cache) return clone(cache);
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    cache = normalize(null);
    return clone(cache);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    parsed = null;
  }
  cache = normalize(parsed);
  return clone(cache);
}

function invalidate() {
  cache = null;
}

/*
 * Map a config lease onto the strict contract record. Leases without a matrix
 * slot are config-only and stay out of egress-leases.json.
 */
function contractLease(lease) {
  if (!lease || typeof lease !== 'object') return null;
  const index = contract.indexForSlotId(lease.matrixSlotId);
  if (!index) return null;
  const leaseId = String(lease.leaseId || lease.id || '');
  return {
    matrixSlotId: lease.matrixSlotId,
    egressPort: contract.egressPortForIndex(index),
    routingPlane: contract.normalizeRoutingPlane(lease.routingPlane, 'ELASTIC_DATA'),
    healthState: contract.normalizeHealthState(lease.healthState, 'ACTIVE'),
    egressFingerprint: contract.normalizeFingerprint(lease.egressFingerprint, leaseId),
    leaseId,
    intentId: String(lease.id || ''),
    key: String(lease.key || ''),
    provider: String(lease.provider || 'static'),
    nodeId: String(lease.nodeId || ''),
    slotId: String(lease.slotId || ''),
    country: String(lease.country || ''),
    upstreamSignature: String(lease.upstreamSignature || ''),
    rotationEpoch: Number(lease.rotationEpoch) || 0,
    cooldownUntil: Number(lease.cooldownUntil) || 0,
    lastError: String(lease.checkError || lease.lastError || ''),
    createdAt: String(lease.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

function contractLeases(state) {
  const records = [];
  for (const lease of (state && state.leases) || []) {
    const record = contractLease(lease);
    if (record) records.push(record);
  }
  return records;
}

/*
 * Slot cache: the <1ms read path used by GET /lease/:id and the panel.
 * Router-engine pushes every snapshot here; config leases are merged on read.
 */
const slotCache = new Map();

function rememberSlot(record) {
  if (!record || !record.matrixSlotId) return null;
  const existing = slotCache.get(record.matrixSlotId) || {};
  const next = Object.assign({}, existing, record);
  slotCache.set(record.matrixSlotId, next);
  return next;
}

function rememberSlots(records) {
  for (const record of Array.isArray(records) ? records : []) rememberSlot(record);
  return slotCache.size;
}

function forgetSlot(matrixSlotId) {
  slotCache.delete(String(matrixSlotId || ''));
}

function slotLease(matrixSlotId) {
  const id = String(matrixSlotId || '');
  const slot = slotCache.get(id) || null;
  let lease = null;
  if (cache) {
    lease = (cache.leases || []).find((item) => item.matrixSlotId === id
      || (slot && (item.id === slot.intentId || item.leaseId === slot.leaseId))) || null;
  }
  return { slot, lease };
}

function slotsSnapshot() {
  return [...slotCache.values()];
}

function writeFileAtomic(file, body) {
  ensureDir();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, body, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  }
}

function queueStateWrite(next) {
  dirty = true;
  writeQueue = writeQueue.then(
    () => storeLock.writeJsonAtomic(STATE_FILE, next).then(() => {
      dirty = false;
    }),
    () => storeLock.writeJsonAtomic(STATE_FILE, next).then(() => {
      dirty = false;
    }),
  ).catch(() => {});
  return writeQueue;
}

function queueLeaseMirror(state) {
  const records = contractLeases(state);
  if (!records.length) return Promise.resolve();
  mirrorQueue = mirrorQueue.then(
    () => matrixStore.upsertLeases(records).catch(() => {}),
    () => matrixStore.upsertLeases(records).catch(() => {}),
  );
  return mirrorQueue;
}

function save(state) {
  ensureDir();
  const next = normalize(Object.assign({}, state, { updatedAt: new Date().toISOString() }));
  cache = clone(next);
  const snapshot = clone(next);
  queueStateWrite(snapshot);
  queueLeaseMirror(snapshot);
  return clone(next);
}

function flush() {
  return Promise.all([
    writeQueue.catch(() => {}),
    mirrorQueue.catch(() => {}),
  ]).then(() => {});
}

function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return result === undefined ? state : result;
}

function writeEndpoints(endpoints) {
  writeFileAtomic(ENDPOINTS_FILE, `${JSON.stringify(endpoints, null, 2)}\n`);
  const lines = [];
  for (const lane of endpoints.lanes || []) {
    const label = [lane.country || 'ANY', lane.key].filter(Boolean).join(' ');
    lines.push(`${label}\thttp://${lane.host}:${lane.port}\tsocks5://${lane.host}:${lane.port}`);
  }
  writeFileAtomic(PROXIES_FILE, `${lines.join('\n')}${lines.length ? '\n' : ''}`);
}

function findNode(state, id) {
  return (state.nodes || []).find((node) => node.id === id) || null;
}

function findLease(state, id) {
  return (state.leases || []).find((lease) => lease.id === id) || null;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

process.once('exit', () => {
  if (!dirty || !cache) return;
  try {
    ensureDir();
    writeFileAtomic(STATE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch { /* best effort on exit */ }
});

module.exports = {
  DATA_DIR,
  STATE_FILE,
  ENDPOINTS_FILE,
  PROXIES_FILE,
  DEFAULTS,
  load,
  save,
  update,
  flush,
  invalidate,
  writeEndpoints,
  findNode,
  findLease,
  newId,
  contractLease,
  contractLeases,
  rememberSlot,
  rememberSlots,
  forgetSlot,
  slotLease,
  slotsSnapshot,
};
