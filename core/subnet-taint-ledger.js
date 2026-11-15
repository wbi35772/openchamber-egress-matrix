'use strict';

/*
 * Historical subnet taint ledger.
 *
 * A /64 prefix or a static exit IP belongs to exactly one matrix slot for the
 * lifetime of the ledger. Re-assigning it to a different slot is impossible,
 * even after the original lease is deleted; the process exits or returns a
 * hard error instead of silently leaking an exit identity into a new account.
 *
 * Rotation keeps the old prefix bound to the same slot, so a pool that hands
 * the old subnet back to the same slot is accepted.
 */

const { mutateJson, readJson } = require('./store-lock');
const { LEDGER_FILE } = require('./matrix-store');
const { normalizePrefix64 } = require('./contract');

function shape() {
  return { version: 1, updatedAt: Date.now(), prefixes: {}, exitIps: {} };
}

function cleanEntry(entry) {
  return {
    prefix64: String((entry && entry.prefix64) || ''),
    exitIp: String((entry && entry.exitIp) || ''),
    leaseId: String((entry && entry.leaseId) || ''),
    matrixSlotId: String((entry && entry.matrixSlotId) || ''),
    firstSeenAt: Number(entry && entry.firstSeenAt) || Date.now(),
    lastSeenAt: Number(entry && entry.lastSeenAt) || Date.now(),
  };
}

function conflictError(kind, value, owner, requester) {
  return Object.assign(new Error(
    `${kind} ${value} 已归属 ${owner.matrixSlotId || '未知槽位'}，拒绝分配给 ${requester.matrixSlotId}`,
  ), {
    code: 'subnet_tainted',
    status: 409,
    details: { kind, value, owner: cleanEntry(owner), requester: cleanEntry(requester) },
  });
}

async function snapshot() {
  const data = await readJson(LEDGER_FILE, shape());
  return {
    version: 1,
    updatedAt: Number(data && data.updatedAt) || 0,
    prefixes: (data && data.prefixes) || {},
    exitIps: (data && data.exitIps) || {},
  };
}

/*
 * Claim all identities for one slot atomically. If any prefix or exit IP is
 * already owned by another slot, nothing is written.
 */
async function claim(identities) {
  const prefix64 = normalizePrefix64(identities && identities.prefix64);
  const exitIp = String((identities && identities.exitIp) || '').trim();
  const matrixSlotId = String((identities && identities.matrixSlotId) || '').trim();
  const leaseId = String((identities && identities.leaseId) || '').trim();
  if (!matrixSlotId) {
    throw Object.assign(new Error('claim 需要 matrixSlotId'), { code: 'invalid_claim' });
  }
  if (identities && identities.prefix64 && !prefix64) {
    throw Object.assign(new Error(`无法解析 IPv6 /64: ${identities.prefix64}`), { code: 'invalid_prefix64' });
  }
  if (!prefix64 && !exitIp) {
    return { changed: false, prefix64: '', exitIp: '', entries: [] };
  }

  return mutateJson(LEDGER_FILE, shape(), (data) => {
    data.prefixes = data.prefixes && typeof data.prefixes === 'object' ? data.prefixes : {};
    data.exitIps = data.exitIps && typeof data.exitIps === 'object' ? data.exitIps : {};
    const now = Date.now();
    const requester = { matrixSlotId, leaseId, prefix64, exitIp };

    if (prefix64) {
      const owner = data.prefixes[prefix64];
      if (owner && owner.matrixSlotId && owner.matrixSlotId !== matrixSlotId) {
        throw conflictError('/64', prefix64, owner, requester);
      }
    }
    if (exitIp) {
      const owner = data.exitIps[exitIp];
      if (owner && owner.matrixSlotId && owner.matrixSlotId !== matrixSlotId) {
        throw conflictError('出口 IP', exitIp, owner, requester);
      }
    }

    const entries = [];
    if (prefix64) {
      const previous = data.prefixes[prefix64] || {};
      const entry = cleanEntry(Object.assign({}, previous, {
        prefix64,
        exitIp: exitIp || previous.exitIp || '',
        leaseId: leaseId || previous.leaseId || '',
        matrixSlotId,
        firstSeenAt: previous.firstSeenAt || now,
        lastSeenAt: now,
      }));
      data.prefixes[prefix64] = entry;
      entries.push(entry);
    }
    if (exitIp) {
      const previous = data.exitIps[exitIp] || {};
      const entry = cleanEntry(Object.assign({}, previous, {
        prefix64: prefix64 || previous.prefix64 || '',
        exitIp,
        leaseId: leaseId || previous.leaseId || '',
        matrixSlotId,
        firstSeenAt: previous.firstSeenAt || now,
        lastSeenAt: now,
      }));
      data.exitIps[exitIp] = entry;
      entries.push(entry);
    }
    return { changed: true, prefix64, exitIp, entries };
  });
}

function isTainted(ledger, identities) {
  const prefix64 = normalizePrefix64(identities && identities.prefix64);
  const exitIp = String((identities && identities.exitIp) || '').trim();
  const matrixSlotId = String((identities && identities.matrixSlotId) || '').trim();
  const check = (owner) => Boolean(owner && owner.matrixSlotId && owner.matrixSlotId !== matrixSlotId);
  return check(prefix64 && ledger.prefixes[prefix64]) || check(exitIp && ledger.exitIps[exitIp]);
}

module.exports = {
  shape,
  snapshot,
  claim,
  isTainted,
  normalizePrefix64,
};
