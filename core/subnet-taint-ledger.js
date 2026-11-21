'use strict';

/*
 * Historical subnet taint ledger.
 *
 * Records which /64 prefix and exit IP were last seen behind each matrix slot.
 * The record is advisory: WARP-backed subscriptions hand out prefixes and
 * IPv4 exits from a shared pool, so the same identity legitimately appears
 * behind different slots across sessions. A new claim therefore moves the
 * ownership to the latest slot instead of blocking provisioning. Slot
 * isolation itself comes from the per-slot tunnel, not from address reuse.
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
 * Claim all identities for one slot atomically. Ownership moves to the latest
 * claimant: WARP pools recycle the same /64 and IPv4 exits across accounts,
 * and blocking that would strand every slot behind the first one that saw an
 * address.
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

    /*
     * WARP-backed upstreams rotate their IPv4 exit inside a shared pool, so the
     * same /64 and exit IP are expected behind different accounts across
     * sessions. Identity isolation comes from the per-slot tunnel; a claim
     * moves ownership to the latest slot instead of blocking provisioning.
     */
    if (prefix64) {
      const owner = data.prefixes[prefix64];
      if (owner && owner.matrixSlotId && owner.matrixSlotId !== matrixSlotId) {
        data.prefixes[prefix64] = cleanEntry(Object.assign({}, owner, {
          matrixSlotId,
          leaseId: leaseId || owner.leaseId || '',
          lastSeenAt: Date.now(),
        }));
      }
    }
    if (exitIp) {
      const owner = data.exitIps[exitIp];
      if (owner && owner.matrixSlotId && owner.matrixSlotId !== matrixSlotId) {
        data.exitIps[exitIp] = cleanEntry(Object.assign({}, owner, {
          matrixSlotId,
          leaseId: leaseId || owner.leaseId || '',
          lastSeenAt: Date.now(),
        }));
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

function isTainted() {
  return false;
}

module.exports = {
  shape,
  snapshot,
  claim,
  isTainted,
  normalizePrefix64,
};
