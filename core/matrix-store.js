'use strict';

/*
 * Shared matrix state directory: ~/.openchamber/matrix-state/
 *
 * egress-leases.json       authoritative slot leases (strict contract fields)
 * subnet-taint-ledger.json historical /64 and exit-IP ownership
 * callbacks.json           registered rotation freeze/resume endpoints
 * rotation-events.json     append-only bus event ring (last 500)
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { mutateJson, readJson } = require('./store-lock');
const { validateLeaseRecord } = require('./contract');

const STATE_DIR = process.env.OPENCHAMBER_MATRIX_STATE_DIR
  ? path.resolve(process.env.OPENCHAMBER_MATRIX_STATE_DIR)
  : path.join(os.homedir(), '.openchamber', 'matrix-state');

const LEASES_FILE = path.join(STATE_DIR, 'egress-leases.json');
const LEDGER_FILE = path.join(STATE_DIR, 'subnet-taint-ledger.json');
const CALLBACKS_FILE = path.join(STATE_DIR, 'callbacks.json');
const EVENTS_FILE = path.join(STATE_DIR, 'rotation-events.json');

const MAX_EVENTS = 500;

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function leasesShape() {
  return { version: 1, updatedAt: now(), leases: [] };
}

async function loadLeases() {
  const data = await readJson(LEASES_FILE, leasesShape());
  return {
    version: 1,
    updatedAt: Number(data && data.updatedAt) || 0,
    leases: Array.isArray(data && data.leases) ? data.leases : [],
  };
}

async function listLeases() {
  return (await loadLeases()).leases;
}

async function replaceLeases(records) {
  const clean = [];
  const rejected = [];
  for (const record of Array.isArray(records) ? records : []) {
    const errors = validateLeaseRecord(record);
    if (errors.length) rejected.push({ record, errors });
    else clean.push(record);
  }
  await mutateJson(LEASES_FILE, leasesShape(), (data) => {
    data.version = 1;
    data.leases = clean;
  });
  return { written: clean.length, rejected };
}

async function patchLease(matrixSlotId, patch) {
  return mutateJson(LEASES_FILE, leasesShape(), (data) => {
    const list = Array.isArray(data.leases) ? data.leases : [];
    const found = list.find((item) => item.matrixSlotId === matrixSlotId);
    if (!found) return null;
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'egressFingerprint' && value && typeof value === 'object') {
        found.egressFingerprint = Object.assign({}, found.egressFingerprint, value);
      } else {
        found[key] = value;
      }
    }
    found.updatedAt = now();
    return found;
  });
}

async function removeLease(matrixSlotId) {
  return mutateJson(LEASES_FILE, leasesShape(), (data) => {
    const before = Array.isArray(data.leases) ? data.leases.length : 0;
    data.leases = (data.leases || []).filter((item) => item.matrixSlotId !== matrixSlotId);
    return { removed: before - data.leases.length };
  });
}

async function findLease(matrixSlotId) {
  const list = await listLeases();
  return list.find((item) => item.matrixSlotId === matrixSlotId) || null;
}

function callbacksShape() {
  return { version: 1, updatedAt: now(), callbacks: [] };
}

async function listCallbacks() {
  const data = await readJson(CALLBACKS_FILE, callbacksShape());
  return Array.isArray(data && data.callbacks) ? data.callbacks : [];
}

async function registerCallback(entry) {
  const url = String(entry && entry.url ? entry.url : '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error('回调地址必须是 http(s) URL'), { code: 'invalid_callback_url' });
  }
  return mutateJson(CALLBACKS_FILE, callbacksShape(), (data) => {
    data.callbacks = Array.isArray(data.callbacks) ? data.callbacks : [];
    const clientId = String(entry.clientId || '').trim() || 'client';
    const events = Array.isArray(entry.events) && entry.events.length
      ? entry.events.map((item) => String(item).toUpperCase())
      : ['PRE_ROTATION_FREEZE', 'POST_ROTATION_RESUME', 'ROTATION_FAILED', 'LEASE_CHANGED'];
    const existing = data.callbacks.find((item) => item.url === url && item.clientId === clientId);
    if (existing) {
      existing.events = events;
      existing.updatedAt = now();
      return existing;
    }
    const record = {
      id: newId('cb'),
      clientId,
      url,
      events,
      registeredAt: now(),
      updatedAt: now(),
    };
    data.callbacks.push(record);
    return record;
  });
}

async function removeCallback(id) {
  return mutateJson(CALLBACKS_FILE, callbacksShape(), (data) => {
    const before = (data.callbacks || []).length;
    data.callbacks = (data.callbacks || []).filter((item) => item.id !== id);
    return { removed: before - data.callbacks.length };
  });
}

function eventsShape() {
  return { version: 1, updatedAt: now(), events: [] };
}

async function appendEvent(type, payload = {}) {
  return mutateJson(EVENTS_FILE, eventsShape(), (data) => {
    data.events = Array.isArray(data.events) ? data.events : [];
    const event = Object.assign({
      id: newId('evt'),
      type: String(type || '').toUpperCase(),
      at: now(),
    }, payload);
    data.events.push(event);
    if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);
    return event;
  });
}

async function listEvents(limit = 100) {
  const data = await readJson(EVENTS_FILE, eventsShape());
  const events = Array.isArray(data && data.events) ? data.events : [];
  return events.slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 100)));
}

module.exports = {
  STATE_DIR,
  LEASES_FILE,
  LEDGER_FILE,
  CALLBACKS_FILE,
  EVENTS_FILE,
  MAX_EVENTS,
  newId,
  loadLeases,
  listLeases,
  replaceLeases,
  patchLease,
  removeLease,
  findLease,
  listCallbacks,
  registerCallback,
  removeCallback,
  appendEvent,
  listEvents,
};
