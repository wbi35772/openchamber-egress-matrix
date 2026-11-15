'use strict';

/*
 * Unified contract for the OpenChamber egress matrix.
 *
 * Every module, API payload and shared state file uses these names and
 * enums. No synonyms, no ad-hoc port math outside this file.
 */

const SLOT_MIN_INDEX = 1;
const SLOT_MAX_INDEX = 250;
const SLOT_COUNT = SLOT_MAX_INDEX - SLOT_MIN_INDEX + 1;
const EGRESS_PORT_BASE = 24000;
const EGRESS_PORT_MIN = EGRESS_PORT_BASE + SLOT_MIN_INDEX;
const EGRESS_PORT_MAX = EGRESS_PORT_BASE + SLOT_MAX_INDEX;

const ROUTING_PLANES = Object.freeze(['STRICT_CONTROL', 'ELASTIC_DATA']);
const HEALTH_STATES = Object.freeze([
  'ACTIVE',
  'COOLDOWN',
  'QUARANTINED',
  'WARP_OVERFLOW',
  'ROTATING',
]);

const DEFAULT_CONTROL_DOMAINS = Object.freeze([
  'api.cloudflare.com',
  'dash.cloudflare.com',
  'api.instabox.sh',
  'api.instabox.tech',
  'auth.instabox.sh',
  'console.instabox.sh',
]);

function isInteger(value) {
  return Number.isInteger(value);
}

function slotIdForIndex(index) {
  if (!isInteger(index) || index < SLOT_MIN_INDEX || index > SLOT_MAX_INDEX) {
    throw Object.assign(new Error(`矩阵槽位索引必须是 ${SLOT_MIN_INDEX}-${SLOT_MAX_INDEX}`), {
      code: 'invalid_slot_index',
    });
  }
  return `slot-${String(index).padStart(3, '0')}`;
}

function indexForSlotId(matrixSlotId) {
  const match = /^slot-(\d{3})$/.exec(String(matrixSlotId || ''));
  if (!match) return 0;
  const index = Number(match[1]);
  return index >= SLOT_MIN_INDEX && index <= SLOT_MAX_INDEX ? index : 0;
}

function egressPortForIndex(index) {
  return EGRESS_PORT_BASE + index;
}

function egressPortForSlotId(matrixSlotId) {
  const index = indexForSlotId(matrixSlotId);
  return index ? egressPortForIndex(index) : 0;
}

function matrixSlotIdForPort(port) {
  const value = Number(port);
  if (!isInteger(value) || value < EGRESS_PORT_MIN || value > EGRESS_PORT_MAX) return '';
  return slotIdForIndex(value - EGRESS_PORT_BASE);
}

function isMatrixPort(port) {
  return Boolean(matrixSlotIdForPort(port));
}

function normalizeRoutingPlane(value, fallback = 'ELASTIC_DATA') {
  const plane = String(value || '').toUpperCase();
  return ROUTING_PLANES.includes(plane) ? plane : fallback;
}

function normalizeHealthState(value, fallback = 'ACTIVE') {
  const state = String(value || '').toUpperCase();
  return HEALTH_STATES.includes(state) ? state : fallback;
}

function normalizePrefix64(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/^\[/, '').replace(/\]$/, '').split('/')[0];
  if (!text.includes(':')) return '';
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  let parts;
  if (halves.length > 1) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return '';
    parts = [...head, ...new Array(fill).fill('0'), ...tail];
  } else {
    parts = head;
  }
  if (parts.length < 4) return '';
  const hextets = parts.slice(0, 4).map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return '';
    return part.toLowerCase().replace(/^0+(?=.)/, '');
  });
  if (hextets.some((part) => !part)) return '';
  return `${hextets.join(':')}::/64`;
}

function hostMatchesDomain(host, domain) {
  const target = String(host || '').toLowerCase().replace(/\.$/, '');
  const root = String(domain || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!target || !root) return false;
  return target === root || target.endsWith(`.${root}`);
}

function isControlPlaneHost(host, domains = DEFAULT_CONTROL_DOMAINS) {
  const list = Array.isArray(domains) && domains.length ? domains : DEFAULT_CONTROL_DOMAINS;
  return list.some((domain) => hostMatchesDomain(host, domain));
}

function emptyFingerprint(leaseId = '') {
  return {
    exitIp: '',
    ipv6Prefix64: '',
    asn: '',
    leaseId: String(leaseId || ''),
    updatedAt: Date.now(),
  };
}

function normalizeFingerprint(value, fallbackLeaseId = '') {
  const source = value && typeof value === 'object' ? value : {};
  return {
    exitIp: String(source.exitIp || ''),
    ipv6Prefix64: normalizePrefix64(source.ipv6Prefix64 || ''),
    asn: String(source.asn || ''),
    leaseId: String(source.leaseId || fallbackLeaseId || ''),
    updatedAt: Number(source.updatedAt) || Date.now(),
  };
}

function validateLeaseRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return ['lease record must be an object'];
  if (!indexForSlotId(record.matrixSlotId)) errors.push('matrixSlotId must be slot-001..slot-250');
  if (!isInteger(record.egressPort)
    || record.egressPort !== egressPortForSlotId(record.matrixSlotId)) {
    errors.push('egressPort must equal 24000 + slot index');
  }
  if (!ROUTING_PLANES.includes(record.routingPlane)) errors.push('routingPlane invalid');
  if (!HEALTH_STATES.includes(record.healthState)) errors.push('healthState invalid');
  if (!record.egressFingerprint || typeof record.egressFingerprint !== 'object') {
    errors.push('egressFingerprint missing');
  } else if (normalizePrefix64(record.egressFingerprint.ipv6Prefix64)
    !== record.egressFingerprint.ipv6Prefix64) {
    errors.push('egressFingerprint.ipv6Prefix64 must be a normalized /64 prefix');
  }
  return errors;
}

module.exports = {
  SLOT_MIN_INDEX,
  SLOT_MAX_INDEX,
  SLOT_COUNT,
  EGRESS_PORT_BASE,
  EGRESS_PORT_MIN,
  EGRESS_PORT_MAX,
  ROUTING_PLANES,
  HEALTH_STATES,
  DEFAULT_CONTROL_DOMAINS,
  slotIdForIndex,
  indexForSlotId,
  egressPortForIndex,
  egressPortForSlotId,
  matrixSlotIdForPort,
  isMatrixPort,
  normalizeRoutingPlane,
  normalizeHealthState,
  normalizePrefix64,
  hostMatchesDomain,
  isControlPlaneHost,
  emptyFingerprint,
  normalizeFingerprint,
  validateLeaseRecord,
};
