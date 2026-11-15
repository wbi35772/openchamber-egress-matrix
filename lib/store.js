'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.EGRESS_MATRIX_DATA_DIR
  ? path.resolve(process.env.EGRESS_MATRIX_DATA_DIR)
  : path.join(os.homedir(), '.openchamber-egress-matrix');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.txt');

const DEFAULTS = {
  version: 1,
  settings: {
    listenHost: '127.0.0.1',
    defaultPort: 25001,
    portBase: 25101,
    portSize: 100,
    probeUrl: 'https://api.ipify.org',
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
  ports: {},
  updatedAt: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return clone(DEFAULTS);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return clone(DEFAULTS);
  }
  const state = Object.assign(clone(DEFAULTS), parsed || {});
  state.settings = Object.assign(clone(DEFAULTS.settings), parsed && parsed.settings);
  state.proxygate = Object.assign(clone(DEFAULTS.proxygate), parsed && parsed.proxygate);
  state.nodes = Array.isArray(state.nodes) ? state.nodes : [];
  state.leases = Array.isArray(state.leases) ? state.leases : [];
  state.ports = state.ports && typeof state.ports === 'object' ? state.ports : {};
  return state;
}

function save(state) {
  ensureDir();
  const next = Object.assign({}, state, { updatedAt: new Date().toISOString() });
  const body = JSON.stringify(next, null, 2);
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, body, 'utf8');
  try {
    fs.renameSync(temp, STATE_FILE);
  } catch {
    fs.rmSync(STATE_FILE, { force: true });
    fs.renameSync(temp, STATE_FILE);
  }
  return next;
}

function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return result === undefined ? state : result;
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

module.exports = {
  DATA_DIR,
  STATE_FILE,
  ENDPOINTS_FILE,
  PROXIES_FILE,
  DEFAULTS,
  load,
  save,
  update,
  writeEndpoints,
  findNode,
  findLease,
  newId,
};
