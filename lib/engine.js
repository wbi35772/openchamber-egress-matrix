'use strict';

/*
 * Egress engine: keeps one local mixed listener per lease (+ a default gateway),
 * probes each one end-to-end, and publishes endpoints for other extensions and
 * local apps.
 */

const { createMixedProxy } = require('./local-proxy');
const { connectUpstream } = require('./upstream');
const { parseNodeUri, publicNode } = require('./node-uri');
const { allocatePort, releasePort } = require('./ports');
const { probeViaProxy } = require('./probe');

const DEFAULT_LANE = 'default';

function createEngine(options) {
  const load = options.load;
  const save = options.save;
  const writeEndpoints = options.writeEndpoints;
  const log = options.log || (() => {});
  const probeIntervalMs = options.probeIntervalMs || 5 * 60 * 1000;

  const listeners = new Map();
  const parsed = new Map();
  let queue = Promise.resolve();
  let timer = null;
  let running = false;

  function descriptorFor(state, lease) {
    if (!lease) return null;
    if (lease.provider === 'proxygate') {
      const slot = lease.slot;
      if (!slot) throw Object.assign(new Error('代理槽位尚未同步'), { code: 'slot_missing' });
      const host = slot.host || state.proxygate.socksHost;
      if (!host) throw Object.assign(new Error('proxygate 缺少 socksHost'), { code: 'socks_host_missing' });
      const user = encodeURIComponent(slot.username || '');
      const pass = encodeURIComponent(state.proxygate.socksPassword || '');
      const uri = `socks5://${user}:${pass}@${host}:${slot.port}`;
      return parseNodeUri(uri);
    }
    const node = (state.nodes || []).find((entry) => entry.id === lease.nodeId);
    if (!node) throw Object.assign(new Error('租约引用的节点不存在'), { code: 'node_missing' });
    const cacheKey = `${node.id}|${node.updatedAt || ''}|${node.uri}`;
    if (parsed.has(cacheKey)) return parsed.get(cacheKey);
    const descriptor = parseNodeUri(node.uri);
    parsed.set(cacheKey, descriptor);
    return descriptor;
  }

  function primaryLease(state) {
    const leases = state.leases || [];
    if (state.settings.primary) {
      const found = leases.find((lease) => lease.id === state.settings.primary);
      if (found) return found;
    }
    return leases[0] || null;
  }

  function buildDesired(state) {
    const desired = new Map();
    const errors = [];
    for (const lease of state.leases || []) {
      let descriptor;
      try {
        descriptor = descriptorFor(state, lease);
      } catch (error) {
        errors.push({ key: lease.key, error: error.message, code: error.code || 'descriptor_failed' });
        continue;
      }
      if (!descriptor) continue;
      const port = lease.port || allocatePort(state, lease.key);
      lease.port = port;
      desired.set(lease.key, {
        kind: 'lease',
        key: lease.key,
        lease,
        descriptor,
        port,
        signature: `${port}|${JSON.stringify(descriptor)}`,
      });
    }

    const primary = primaryLease(state);
    if (primary && desired.has(primary.key)) {
      const port = Number(state.settings.defaultPort) || 25001;
      const base = desired.get(primary.key);
      desired.set(DEFAULT_LANE, {
        kind: 'default',
        key: DEFAULT_LANE,
        lease: primary,
        descriptor: base.descriptor,
        port,
        signature: `${port}|${JSON.stringify(base.descriptor)}|default`,
      });
    }
    return { desired, errors };
  }

  async function openLane(state, want) {
    const upstreamFor = (target) => connectUpstream(want.descriptor, target);
    let port = want.port;
    let proxy = null;
    let lastError = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        proxy = await createMixedProxy({ port, upstreamFor, log });
        break;
      } catch (error) {
        lastError = error;
        if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
        if (want.kind === 'default') {
          port += 1;
          continue;
        }
        releasePort(state, want.key);
        port = allocatePort(state, want.key);
        want.port = port;
      }
    }
    if (!proxy) throw lastError || new Error('端口分配失败');

    if (want.lease && want.kind === 'lease') {
      want.lease.port = port;
      if (state.ports[want.key] !== port) state.ports[want.key] = port;
    }
    if (want.kind === 'default' && Number(state.settings.defaultPort) !== port) {
      state.settings.defaultPort = port;
    }

    const entry = {
      key: want.key,
      kind: want.kind,
      leaseId: want.lease ? want.lease.id : '',
      descriptor: want.descriptor,
      port,
      signature: want.signature.replace(/^\d+\|/, `${port}|`),
      proxy,
      startedAt: Date.now(),
      result: null,
      lastError: '',
    };
    listeners.set(want.key, entry);
    log(`入口 ${want.key} 监听 127.0.0.1:${port} (${want.descriptor.protocol})`);
    return entry;
  }

  async function reconcileOnce(reason) {
    const state = load();
    const { desired, errors } = buildDesired(state);

    for (const [key, entry] of [...listeners.entries()]) {
      const want = desired.get(key);
      if (!want || want.signature !== entry.signature) {
        await entry.proxy.close();
        listeners.delete(key);
        log(`入口 ${key} 已关闭${reason ? ` (${reason})` : ''}`);
      }
    }

    for (const [key, want] of desired.entries()) {
      if (listeners.has(key)) continue;
      try {
        await openLane(state, want);
      } catch (error) {
        errors.push({ key, error: error.message, code: error.code || 'listen_failed' });
        if (want.lease) {
          want.lease.ok = false;
          want.lease.error = error.message;
          want.lease.checkedAt = new Date().toISOString();
        }
        log(`入口 ${key} 启动失败: ${error.message}`);
      }
    }

    save(state);
    publish(state, errors);
    return { lanes: listeners.size, errors };
  }

  function laneInfo(state, entry) {
    const result = entry.result || {};
    const lane = {
      key: entry.key,
      kind: entry.kind,
      leaseId: entry.leaseId,
      host: '127.0.0.1',
      port: entry.port,
      proxy: `http://127.0.0.1:${entry.port}`,
      socks: `socks5://127.0.0.1:${entry.port}`,
      country: '',
      exitIp: result.exitIp || '',
      ok: Boolean(result.ok),
      checkedAt: result.checkedAt || '',
      error: entry.lastError || '',
      stats: { ...entry.proxy.stats },
    };
    if (entry.leaseId) {
      const lease = (state.leases || []).find((item) => item.id === entry.leaseId);
      if (lease) lane.country = lease.country || '';
    }
    return lane;
  }

  function publish(state, errors) {
    const lanes = [...listeners.values()].map((entry) => laneInfo(state, entry));
    const byKey = {};
    for (const lane of lanes) byKey[lane.key] = lane;
    const endpoints = {
      version: 1,
      updatedAt: new Date().toISOString(),
      host: '127.0.0.1',
      primary: state.settings.primary || '',
      default: byKey[DEFAULT_LANE] || null,
      byKey,
      lanes,
    };
    try {
      writeEndpoints(endpoints);
    } catch (error) {
      log(`写入入口文件失败: ${error.message}`);
    }
    if (errors && errors.length) {
      endpoints.errors = errors;
    }
    return endpoints;
  }

  async function probeOnce() {
    const state = load();
    const probeUrl = state.settings.probeUrl || 'https://api.ipify.org';
    const entries = [...listeners.values()];
    for (const entry of entries) {
      try {
        const result = await probeViaProxy({ host: '127.0.0.1', port: entry.port, url: probeUrl, timeoutMs: 20000 });
        entry.result = {
          ok: true,
          exitIp: result.exitIp,
          checkedAt: new Date().toISOString(),
        };
        entry.lastError = '';
        if (entry.kind === 'lease' && entry.leaseId) {
          const lease = (state.leases || []).find((item) => item.id === entry.leaseId);
          if (lease) {
            lease.exitIp = result.exitIp;
            lease.ok = true;
            lease.exitIpCheckedAt = entry.result.checkedAt;
            lease.checkError = '';
          }
        }
      } catch (error) {
        entry.result = {
          ok: false,
          exitIp: '',
          checkedAt: new Date().toISOString(),
        };
        entry.lastError = error.message;
        if (entry.kind === 'lease' && entry.leaseId) {
          const lease = (state.leases || []).find((item) => item.id === entry.leaseId);
          if (lease) {
            lease.ok = false;
            lease.checkError = error.message;
          }
        }
        log(`入口 ${entry.key} 端到端探测失败: ${error.message}`);
      }
    }
    save(state);
    publish(state);
    return status();
  }

  function enqueue(task) {
    queue = queue.then(task, task);
    return queue;
  }

  async function reconcile(reason) {
    return enqueue(() => reconcileOnce(reason));
  }

  async function probe() {
    return enqueue(() => probeOnce());
  }

  async function start() {
    if (running) return status();
    running = true;
    await reconcile('start');
    void probe();
    timer = setInterval(() => {
      void reconcile('tick').then(() => probe());
    }, probeIntervalMs);
    if (timer.unref) timer.unref();
    return status();
  }

  async function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    for (const entry of listeners.values()) {
      try { await entry.proxy.close(); } catch { /* ignore */ }
    }
    listeners.clear();
  }

  function status() {
    const state = load();
    const lanes = [...listeners.values()].map((entry) => laneInfo(state, entry));
    return {
      running,
      primary: state.settings.primary || '',
      defaultPort: Number(state.settings.defaultPort) || 25001,
      lanes,
      nodes: (state.nodes || []).map((node) => ({
        id: node.id,
        name: node.name,
        createdAt: node.createdAt || '',
        node: safeParse(node.uri),
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  function safeParse(uri) {
    try {
      return publicNode(parseNodeUri(uri));
    } catch (error) {
      return { error: error.message };
    }
  }

  async function probeDescriptor(descriptor, urlOverride) {
    const state = load();
    const url = urlOverride || state.settings.probeUrl || 'https://api.ipify.org';
    const proxy = await createMixedProxy({
      port: 0,
      upstreamFor: (target) => connectUpstream(descriptor, target, { timeoutMs: 15000 }),
      log,
    });
    try {
      return await probeViaProxy({ host: '127.0.0.1', port: proxy.port, url, timeoutMs: 25000 });
    } finally {
      await proxy.close();
    }
  }

  async function probeNode(nodeId) {
    const state = load();
    const node = (state.nodes || []).find((entry) => entry.id === nodeId);
    if (!node) throw Object.assign(new Error('节点不存在'), { status: 404 });
    const descriptor = parseNodeUri(node.uri);
    const result = await probeDescriptor(descriptor);
    node.lastCheck = { ok: true, exitIp: result.exitIp, checkedAt: new Date().toISOString() };
    save(state);
    return result;
  }

  function publishNow() {
    return publish(load());
  }

  return {
    start,
    stop,
    reconcile,
    probe,
    status,
    probeDescriptor,
    probeNode,
    publishNow,
    descriptorFor,
    primaryLease,
    listeners,
  };
}

module.exports = { createEngine, DEFAULT_LANE };
