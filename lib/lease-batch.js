'use strict';

/*
 * Lease batch planning.
 *
 * Turns a subscription into a list of lease specs without touching ports or
 * ids; the service keeps port claiming and persistence. Selection rules live
 * here so filtering (probe verdict, country, duplicate nodes) stays testable.
 */

const contract = require('../core/contract');

function slug(text) {
  const cleaned = String(text || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'node';
}

function leaseKeyFor(state, prefix, node, takenOverride) {
  const base = `${prefix}/${slug(node.name)}`;
  const taken = takenOverride || new Set((state.leases || []).map((lease) => lease.key));
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  const key = `${base}-${index}`;
  taken.add(key);
  return key;
}

function parseStartPort(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value).trim();
  const slot = text.match(/^slot[-_ ]?(\d{1,3})$/i);
  if (slot) {
    const index = Number(slot[1]);
    if (index >= 1 && index <= contract.SLOT_COUNT) return contract.egressPortForIndex(index);
    throw Object.assign(new Error(`起始槽位 ${text} 超出 slot-001..slot-250`), {
      status: 400,
      code: 'invalid_start_slot',
    });
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('起始端口必须是 1-65535 的整数，或 slot-001 形式'), {
      status: 400,
      code: 'invalid_start_port',
    });
  }
  return port;
}

function nodeCountry(node) {
  const check = node && node.lastCheck;
  if (!check || !check.ok) return '';
  return String(check.countryCode || '').toUpperCase();
}

/*
 * A node whose probed exit IP is already owned by another matrix slot can
 * never be leased again: the /64/exit ledger forbids identity reuse across
 * accounts. Snapshot shape is core/subnet-taint-ledger.snapshot().
 */
function isTaintedExit(exitIp, snapshot, matrixSlotId) {
  const ip = String(exitIp || '').trim();
  if (!ip || !snapshot || !snapshot.exitIps) return false;
  const owner = snapshot.exitIps[ip];
  if (!owner) return false;
  const ownerSlot = String((owner && owner.matrixSlotId) || '');
  if (!ownerSlot) return true;
  return ownerSlot !== String(matrixSlotId || '');
}

function filterTainted(specs, snapshot, matrixSlotId) {
  const kept = [];
  const tainted = [];
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (isTaintedExit(spec.exitIp, snapshot, matrixSlotId)) tainted.push(spec);
    else kept.push(spec);
  }
  return { specs: kept, tainted };
}

function planLeases(state, subscription, options = {}) {
  const prefix = String(options.keyPrefix || subscription.keyPrefix || `sub/${slug(subscription.name)}`)
    .replace(/\/+$/, '');
  const onlyPassed = options.onlyPassed === true;
  const fixedCountry = String(options.country || '').trim().toUpperCase();
  const leased = new Set((state.leases || []).map((lease) => lease.nodeId).filter(Boolean));
  const taken = new Set((state.leases || []).map((lease) => lease.key));
  const snapshot = options.ledgerSnapshot || null;
  const matrixSlotId = String(options.matrixSlotId || '');
  const specs = [];
  let skipped = 0;
  let tainted = 0;

  for (const node of state.nodes || []) {
    if (node.subscriptionId !== subscription.id) continue;
    if (leased.has(node.id)) continue;
    const check = node.lastCheck && node.lastCheck.ok === true ? node.lastCheck : null;
    if (onlyPassed) {
      if (!check || !String(check.exitIp || '')) {
        skipped += 1;
        continue;
      }
    }
    if (snapshot && isTaintedExit(check && check.exitIp, snapshot, matrixSlotId)) {
      tainted += 1;
      continue;
    }
    specs.push({
      nodeId: node.id,
      key: leaseKeyFor(state, prefix, node, taken),
      country: fixedCountry || nodeCountry(node),
      exitIp: check ? String(check.exitIp || '') : '',
      checkedAt: check && check.checkedAt ? String(check.checkedAt) : '',
    });
  }

  return { specs, skipped, tainted };
}

/*
 * Rotate a batch of matrix slots through the rotation coordinator. Each slot
 * keeps the freeze / swap / ledger / resume chain; one failure never aborts
 * the rest unless `stopOnError` is set.
 */
async function rotateBatch(rotation, matrixSlotIds, applyFor, options = {}) {
  if (!rotation || typeof rotation.rotate !== 'function') throw new Error('rotateBatch 需要 rotation coordinator');
  const ids = (Array.isArray(matrixSlotIds) ? matrixSlotIds : []).map((id) => String(id || '')).filter(Boolean);
  const results = [];
  for (const matrixSlotId of ids) {
    try {
      const slot = await rotation.rotate(matrixSlotId, (context) => applyFor(matrixSlotId, context), options);
      results.push({ matrixSlotId, ok: true, slot });
    } catch (error) {
      results.push({
        matrixSlotId,
        ok: false,
        code: error.code || 'rotation_failed',
        error: error.message || String(error),
      });
      if (options.stopOnError) break;
    }
  }
  return {
    total: ids.length,
    rotated: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    results,
  };
}

module.exports = {
  slug,
  leaseKeyFor,
  parseStartPort,
  isTaintedExit,
  filterTainted,
  planLeases,
  rotateBatch,
};
