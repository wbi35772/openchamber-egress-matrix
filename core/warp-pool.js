'use strict';

/*
 * WARP overflow pool.
 *
 * Only used by leases on the ELASTIC_DATA plane when their static upstream
 * fails. Control-plane traffic never reaches this module: the router throws a
 * fail-closed error instead.
 *
 * Endpoints are ordinary proxy URIs (socks5:// or http://...), so a local WARP
 * client, a remote WARP gateway or a chained socks pool all work the same.
 */

const { parseNodeUri } = require('../lib/node-uri');
const { connectUpstream } = require('../lib/upstream');

const SUPPORTED = new Set(['socks', 'vless', 'trojan']);

function endpointList(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item || '').trim()).filter(Boolean);
  return String(raw || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createWarpPool(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
  const cooldownMs = Number(options.cooldownMs) > 0 ? Number(options.cooldownMs) : 60_000;
  const health = new Map();
  let cursor = 0;
  let cachedSignature = '';

  function config() {
    const source = getConfig() || {};
    return {
      enabled: Boolean(source.enabled),
      endpoints: endpointList(source.endpoints),
      cooldownMs: Number(source.cooldownMs) > 0 ? Number(source.cooldownMs) : cooldownMs,
    };
  }

  function descriptors() {
    const list = config().endpoints;
    const signature = list.join('\n');
    if (signature === cachedSignature) return list.map((uri) => ({ uri, descriptor: health.get(uri)?.descriptor })).filter((item) => item.descriptor);
    cachedSignature = signature;
    for (const uri of list) {
      const current = health.get(uri) || { failures: 0, cooldownUntil: 0, lastError: '', lastUsedAt: 0 };
      try {
        const descriptor = parseNodeUri(uri);
        if (!SUPPORTED.has(descriptor.protocol)) throw new Error(`不稳定协议 ${descriptor.protocol}`);
        current.descriptor = descriptor;
        current.lastError = '';
      } catch (error) {
        current.descriptor = null;
        current.lastError = error.message;
      }
      health.set(uri, current);
    }
    return list.map((uri) => ({ uri, descriptor: health.get(uri)?.descriptor })).filter((item) => item.descriptor);
  }

  function usable(entry, now, cooling) {
    if (!entry.descriptor) return false;
    const state = health.get(entry.uri);
    return !state || !state.cooldownUntil || state.cooldownUntil <= now;
  }

  function markFailure(uri, error) {
    const state = health.get(uri) || { failures: 0, cooldownUntil: 0, lastError: '', lastUsedAt: 0 };
    state.failures += 1;
    state.lastError = (error && (error.message || String(error))) || 'unknown failure';
    state.cooldownUntil = Date.now() + config().cooldownMs;
    health.set(uri, state);
    log(`WARP 端点 ${uri.replace(/\/\/[^@]*@/, '//***@')} 失败: ${state.lastError}`);
  }

  function markSuccess(uri) {
    const state = health.get(uri) || { failures: 0, cooldownUntil: 0, lastError: '', lastUsedAt: 0 };
    state.failures = 0;
    state.cooldownUntil = 0;
    state.lastError = '';
    state.lastUsedAt = Date.now();
    health.set(uri, state);
  }

  function available() {
    if (!config().enabled) return false;
    const now = Date.now();
    return descriptors().some((entry) => usable(entry, now));
  }

  async function connect(target, meta = {}) {
    const cfg = config();
    if (!cfg.enabled) {
      throw Object.assign(new Error('未启用 WARP 溢出池'), { code: 'warp_unavailable' });
    }
    const entries = descriptors();
    if (!entries.length) {
      throw Object.assign(new Error('WARP 溢出池没有可用端点'), { code: 'warp_unavailable' });
    }
    const now = Date.now();
    const ordered = [];
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[(cursor + offset) % entries.length];
      if (usable(entry, now)) ordered.push(entry);
    }
    if (!ordered.length) {
      throw Object.assign(new Error('WARP 溢出池全部端点处于冷却'), { code: 'warp_unavailable' });
    }
    let lastError = null;
    for (const entry of ordered) {
      try {
        const tunnel = await connectUpstream(entry.descriptor, target, {
          timeoutMs: Number(meta.timeoutMs) > 0 ? Number(meta.timeoutMs) : timeoutMs,
        });
        markSuccess(entry.uri);
        cursor = (entries.findIndex((item) => item.uri === entry.uri) + 1) % entries.length;
        return tunnel;
      } catch (error) {
        markFailure(entry.uri, error);
        lastError = error;
      }
    }
    throw Object.assign(new Error(`WARP 溢出失败: ${lastError ? lastError.message : '未知错误'}`), {
      code: 'warp_overflow_failed',
      cause: lastError,
    });
  }

  function status() {
    const cfg = config();
    descriptors();
    const now = Date.now();
    const endpoints = cfg.endpoints.map((uri) => {
      const state = health.get(uri) || {};
      const descriptor = state.descriptor || null;
      return {
        host: descriptor ? descriptor.server : '',
        port: descriptor ? descriptor.port : 0,
        protocol: descriptor ? descriptor.protocol : '',
        failures: Number(state.failures) || 0,
        cooldownUntil: Number(state.cooldownUntil) || 0,
        healthy: Boolean(descriptor) && (!state.cooldownUntil || state.cooldownUntil <= now),
        lastError: state.lastError || '',
      };
    });
    return {
      enabled: cfg.enabled,
      total: endpoints.length,
      healthy: endpoints.filter((item) => item.healthy).length,
      available: available(),
      endpoints,
    };
  }

  return { available, connect, status, markFailure, markSuccess };
}

module.exports = { createWarpPool, endpointList };
