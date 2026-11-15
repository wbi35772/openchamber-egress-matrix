'use strict';

/*
 * proxygate pool adapter.
 *
 * Talks to a running proxygate instance over its API-key protected pool routes
 * (`/api/v1/pool/...`) and turns slots into egress leases. Platform-free: the
 * caller supplies base URL, auth header and the public SOCKS host.
 */

const { parseNodeUri } = require('../node-uri');
const { newId } = require('../store');

function providerError(message, code, extra) {
  return Object.assign(new Error(message), { code: code || 'proxygate_error' }, extra || {});
}

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSlot(raw) {
  const slot = raw || {};
  return {
    slotId: String(slot.slotId || slot.slot_id || slot.id || ''),
    username: String(slot.username || ''),
    port: number(slot.port),
    country: String(slot.country || ''),
    countryShort: String(slot.countryShort || slot.country_short || '').toUpperCase(),
    state: String(slot.state || ''),
    exitIp: String(slot.exitIp || slot.exit_ip || slot.activeIp || slot.active_ip || ''),
    nodeIp: String(slot.nodeIp || slot.node_ip || ''),
    asnOrg: String(slot.asnOrg || slot.asn_org || ''),
    asn: number(slot.asn),
    source: String(slot.source || ''),
    protocol: String(slot.protocol || 'socks'),
    residential: Boolean(slot.residential),
    chained: Boolean(slot.chained),
    healthy: slot.healthy === true,
    qualityScore: number(slot.qualityScore || slot.quality_score),
    pingMs: number(slot.pingMs || slot.ping_ms),
    lastError: String(slot.lastError || slot.last_error || ''),
  };
}

function createProxygateClient(options) {
  const baseUrl = trimBase(options.baseUrl);
  const authHeader = String(options.authHeader || 'x-api-key');
  const authValue = String(options.authValue || '');
  const timeoutMs = Number(options.timeoutMs) || 15000;
  if (!baseUrl) throw providerError('proxygate 地址为空', 'proxygate_url_missing');
  if (!authValue) throw providerError('proxygate API Key 为空', 'proxygate_key_missing');

  async function request(method, path, body) {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: Object.assign(
          { accept: 'application/json' },
          body === undefined ? {} : { 'content-type': 'application/json' },
          { [authHeader]: authValue }
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 400) };
        }
      }
      if (!response.ok) {
        const detail = payload && (payload.error || payload.message);
        throw providerError(
          `proxygate HTTP ${response.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
          'proxygate_http_error',
          { status: response.status, body: payload }
        );
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw providerError(`proxygate 请求超时 (${timeoutMs} ms)`, 'proxygate_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function slots() {
    const payload = await request('GET', '/api/v1/pool/slots');
    const list = Array.isArray(payload) ? payload : (payload && (payload.slots || payload.data)) || [];
    return {
      host: String((payload && payload.host) || ''),
      enabled: payload && payload.enabled !== false,
      slots: (Array.isArray(list) ? list : []).map(normalizeSlot),
    };
  }

  async function allocate(body) {
    const payload = await request('POST', '/api/v1/pool/allocate', body || {});
    return normalizeSlot(payload && (payload.slot || payload));
  }

  async function rotate(slotId) {
    const payload = await request('POST', `/api/v1/pool/rotate/${encodeURIComponent(slotId)}`);
    return normalizeSlot(payload && (payload.slot || payload));
  }

  return { baseUrl, slots, allocate, rotate };
}

function slotDescriptor(slot, config) {
  const host = String((slot && slot.host) || config.socksHost || '').trim();
  if (!host) {
    throw providerError('proxygate 槽位缺少公开 SOCKS 主机', 'proxygate_host_missing');
  }
  const port = number(slot.port);
  if (!port) throw providerError('proxygate 槽位缺少端口', 'proxygate_slot_port_missing');
  const username = encodeURIComponent(String(slot.username || ''));
  const password = encodeURIComponent(String(config.socksPassword || ''));
  const auth = username ? `${username}${password ? `:${password}` : ''}@` : '';
  return parseNodeUri(`socks5://${auth}${host}:${port}`);
}

function slotKey(slot) {
  const short = String(slot.countryShort || slot.country || '').toUpperCase();
  const label = short || 'ANY';
  return `pg/${label}/${slot.slotId}`;
}

function syncLeases(state, payload, options) {
  const opts = options || {};
  const max = Math.max(1, number(opts.max) || 32);
  const prune = opts.prune !== false;
  const slots = (payload.slots || []).filter((slot) => slot.slotId && slot.port > 0).slice(0, max);
  const seen = new Set();
  let added = 0;
  let updated = 0;

  state.leases = Array.isArray(state.leases) ? state.leases : [];
  for (const slot of slots) {
    const snapshot = Object.assign({}, slot, { host: payload.host || state.proxygate.socksHost || '' });
    seen.add(snapshot.slotId);
    const existing = state.leases.find(
      (lease) => lease.provider === 'proxygate' && lease.slotId === snapshot.slotId
    );
    if (existing) {
      existing.slot = snapshot;
      existing.country = snapshot.countryShort || snapshot.country || existing.country || '';
      existing.ok = snapshot.healthy;
      updated += 1;
      continue;
    }
    state.leases.push({
      id: newId('lease'),
      key: slotKey(snapshot),
      provider: 'proxygate',
      slotId: snapshot.slotId,
      slot: snapshot,
      country: snapshot.countryShort || snapshot.country || '',
      port: 0,
      ok: snapshot.healthy,
      createdAt: new Date().toISOString(),
    });
    added += 1;
  }

  let removed = 0;
  if (prune) {
    state.leases = state.leases.filter((lease) => {
      if (lease.provider !== 'proxygate') return true;
      if (seen.has(lease.slotId)) return true;
      removed += 1;
      return false;
    });
  }

  if (!state.settings.primary) {
    const first = state.leases.find((lease) => lease.provider === 'proxygate');
    if (first) state.settings.primary = first.id;
  }

  return { added, updated, removed, total: slots.length };
}

module.exports = {
  createProxygateClient,
  normalizeSlot,
  slotDescriptor,
  slotKey,
  syncLeases,
};
