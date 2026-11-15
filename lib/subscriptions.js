'use strict';

/*
 * Subscription import: fetch a URI list (plain or base64), validate each node,
 * and upsert it into state.nodes. No external deps; Node 24 fetch is used.
 */

const { parseNodeUri } = require('./node-uri');
const { newId } = require('./store');

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const NAME_LIMIT = 64;

function decodeSubscription(text) {
  const body = String(text || '').trim();
  if (!body) return '';
  if (body.includes('://')) return body;
  const compact = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/\-_]+=*$/.test(compact)) return body;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return decoded.includes('://') ? decoded : body;
  } catch {
    return body;
  }
}

function parseSubscriptionText(text) {
  const body = decodeSubscription(text);
  const seen = new Set();
  const uris = [];
  const errors = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('://')) continue;
    if (seen.has(line)) continue;
    try {
      parseNodeUri(line);
      seen.add(line);
      uris.push(line);
    } catch (error) {
      errors.push({ line: line.slice(0, 120), error: error.message });
    }
  }

  return { uris, errors };
}

function fragmentName(uri) {
  const hash = uri.indexOf('#');
  if (hash < 0) return '';
  try {
    return decodeURIComponent(uri.slice(hash + 1)).trim().slice(0, NAME_LIMIT);
  } catch {
    return '';
  }
}

function nodeName(descriptor, uri) {
  const fragment = fragmentName(uri);
  if (fragment) return fragment;
  const host = descriptor.server || 'node';
  return `${descriptor.protocol} ${host}:${descriptor.port}`.slice(0, NAME_LIMIT);
}

function importNodes(state, subscription, uris) {
  state.nodes = Array.isArray(state.nodes) ? state.nodes : [];
  const byUri = new Map(state.nodes.map((node) => [node.uri, node]));
  let added = 0;
  let updated = 0;
  const errors = [];

  for (const uri of uris) {
    let descriptor;
    try {
      descriptor = parseNodeUri(uri);
    } catch (error) {
      errors.push({ line: uri.slice(0, 120), error: error.message });
      continue;
    }
    const existing = byUri.get(uri);
    if (existing) {
      existing.subscriptionId = subscription.id;
      updated += 1;
      continue;
    }
    const node = {
      id: newId('node'),
      name: nodeName(descriptor, uri),
      uri,
      subscriptionId: subscription.id,
      createdAt: new Date().toISOString(),
    };
    state.nodes.push(node);
    byUri.set(uri, node);
    added += 1;
  }

  subscription.lastSyncAt = new Date().toISOString();
  subscription.lastError = '';
  subscription.nodeCount = uris.length;
  return { added, updated, total: state.nodes.filter((node) => node.subscriptionId === subscription.id).length };
}

async function fetchSubscription(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'egress-matrix/0.1', accept: 'text/plain,*/*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`订阅返回 HTTP ${response.status}`), { code: 'subscription_http' });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw Object.assign(new Error('订阅内容超过 2 MB'), { code: 'subscription_too_large' });
    const text = await response.text();
    if (text.length > MAX_BYTES) throw Object.assign(new Error('订阅内容超过 2 MB'), { code: 'subscription_too_large' });
    if (/<html|<!doctype/i.test(text.slice(0, 256))) {
      throw Object.assign(new Error('订阅返回了 HTML 页面，检查地址是否需要登录或鉴权'), { code: 'subscription_html' });
    }
    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error(`订阅请求超时 (${timeoutMs} ms)`), { code: 'subscription_timeout' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function syncSubscription(state, subscription, options) {
  const text = await fetchSubscription(subscription.url, options);
  const parsed = parseSubscriptionText(text);
  if (!parsed.uris.length) {
    throw Object.assign(new Error('订阅里没有可解析的节点'), {
      code: 'subscription_empty',
      errors: parsed.errors,
    });
  }
  const result = importNodes(state, subscription, parsed.uris);
  return Object.assign(result, { errors: parsed.errors });
}

module.exports = {
  decodeSubscription,
  parseSubscriptionText,
  importNodes,
  fetchSubscription,
  syncSubscription,
};
