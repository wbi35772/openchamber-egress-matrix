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

function planLeases(state, subscription, options = {}) {
  const prefix = String(options.keyPrefix || subscription.keyPrefix || `sub/${slug(subscription.name)}`)
    .replace(/\/+$/, '');
  const onlyPassed = options.onlyPassed === true;
  const fixedCountry = String(options.country || '').trim().toUpperCase();
  const leased = new Set((state.leases || []).map((lease) => lease.nodeId).filter(Boolean));
  const taken = new Set((state.leases || []).map((lease) => lease.key));
  const specs = [];
  let skipped = 0;

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
    specs.push({
      nodeId: node.id,
      key: leaseKeyFor(state, prefix, node, taken),
      country: fixedCountry || nodeCountry(node),
      exitIp: check ? String(check.exitIp || '') : '',
      checkedAt: check && check.checkedAt ? String(check.checkedAt) : '',
    });
  }

  return { specs, skipped };
}

module.exports = {
  slug,
  leaseKeyFor,
  parseStartPort,
  planLeases,
};
