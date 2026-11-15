'use strict';

/*
 * Abuse guard for egress slots.
 *
 * Hard blocks: loopback, RFC1918 / ULA / link-local / CGNAT / multicast,
 * cloud metadata endpoints. Soft block: a slot that touches high-risk service
 * ports (22, 23, 445, 3389) more than `scanThreshold` times inside
 * `scanWindowMs` is quarantined and locked for `lockMs`.
 *
 * The guard never rewrites the target and never falls back to a direct
 * connection; a blocked request is an error surfaced to the client.
 */

const HIGH_RISK_PORTS = Object.freeze([22, 23, 445, 3389]);
const METADATA_HOSTS = Object.freeze([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
]);

function canonical(host) {
  return String(host || '').trim().toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isMetadataIpv4(parts) {
  return parts[0] === 169 && parts[1] === 254 && parts[2] === 169 && parts[3] === 254;
}

function isPrivateIpv6(host) {
  const value = canonical(host);
  if (!value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fe8') || value.startsWith('fe9')
    || value.startsWith('fea') || value.startsWith('feb')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('ff')) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) {
    const parts = parseIpv4(mapped[1]);
    return Boolean(parts && (isPrivateIpv4(parts) || isMetadataIpv4(parts)));
  }
  return false;
}

function classifyHost(host) {
  const value = canonical(host);
  if (!value) return { kind: 'invalid' };
  if (METADATA_HOSTS.includes(value)) return { kind: 'metadata' };
  if (value === 'localhost' || value.endsWith('.localhost')) return { kind: 'private' };
  const v4 = parseIpv4(value);
  if (v4) {
    if (isMetadataIpv4(v4)) return { kind: 'metadata' };
    if (isPrivateIpv4(v4)) return { kind: 'private' };
    return { kind: 'public' };
  }
  if (value.includes(':') && isPrivateIpv6(value)) {
    return { kind: 'private' };
  }
  return { kind: 'public' };
}

function createAbuseGuard(options = {}) {
  const scanWindowMs = Number(options.scanWindowMs) > 0 ? Number(options.scanWindowMs) : 60_000;
  const scanThreshold = Number(options.scanThreshold) > 0 ? Number(options.scanThreshold) : 5;
  const lockMs = Number(options.lockMs) > 0 ? Number(options.lockMs) : 5 * 60_000;
  const hits = new Map();
  const locks = new Map();

  function prune(slotId, now) {
    const list = (hits.get(slotId) || []).filter((stamp) => now - stamp <= scanWindowMs);
    if (list.length) hits.set(slotId, list);
    else hits.delete(slotId);
    const until = locks.get(slotId);
    if (until && until <= now) locks.delete(slotId);
  }

  function lockState(slotId, now) {
    prune(slotId, now);
    const until = locks.get(slotId);
    return until && until > now ? until : 0;
  }

  function evaluate(slotId, target, meta = {}) {
    const now = Number(meta.now) || Date.now();
    const slot = String(slotId || '');
    const host = canonical(target && target.host);
    const port = Number(target && target.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { allow: false, code: 'invalid_target', reason: '目标地址或端口非法' };
    }
    const lockedUntil = lockState(slot, now);
    if (lockedUntil) {
      return {
        allow: false,
        code: 'abuse_scan_locked',
        reason: '槽位因高危端口批量探测被隔离',
        lockUntil: lockedUntil,
        quarantine: true,
      };
    }
    const kind = classifyHost(host).kind;
    if (kind === 'metadata') {
      return {
        allow: false,
        code: 'metadata_endpoint_blocked',
        reason: '禁止访问云元数据地址',
        quarantine: true,
      };
    }
    if (kind === 'private') {
      return {
        allow: false,
        code: 'private_network_blocked',
        reason: '禁止访问内网、回环或链路本地地址',
      };
    }
    if (HIGH_RISK_PORTS.includes(port)) {
      const list = (hits.get(slot) || []).filter((stamp) => now - stamp <= scanWindowMs);
      list.push(now);
      hits.set(slot, list);
      if (list.length >= scanThreshold) {
        locks.set(slot, now + lockMs);
        hits.delete(slot);
        return {
          allow: false,
          code: 'abuse_scan_detected',
          reason: `槽位在 ${Math.round(scanWindowMs / 1000)} 秒内命中高危端口 ${list.length} 次`,
          lockUntil: now + lockMs,
          quarantine: true,
        };
      }
    }
    return { allow: true, code: 'ok', reason: '' };
  }

  function quarantine(slotId, until) {
    const now = Date.now();
    const target = Number(until) > now ? Number(until) : now + lockMs;
    locks.set(String(slotId || ''), target);
    return target;
  }

  function release(slotId) {
    hits.delete(String(slotId || ''));
    locks.delete(String(slotId || ''));
  }

  function snapshot() {
    const now = Date.now();
    const result = {};
    for (const slotId of new Set([...hits.keys(), ...locks.keys()])) {
      result[slotId] = {
        hits: (hits.get(slotId) || []).filter((stamp) => now - stamp <= scanWindowMs).length,
        lockUntil: lockState(slotId, now),
      };
    }
    return result;
  }

  return {
    evaluate,
    quarantine,
    release,
    snapshot,
    config: { scanWindowMs, scanThreshold, lockMs, highRiskPorts: HIGH_RISK_PORTS },
  };
}

module.exports = {
  HIGH_RISK_PORTS,
  METADATA_HOSTS,
  canonical,
  classifyHost,
  isPrivateIpv4,
  isMetadataIpv4,
  createAbuseGuard,
};
