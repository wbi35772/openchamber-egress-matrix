'use strict';

/*
 * Matrix router engine.
 *
 * One runtime slot per lease. Slot index N always listens on 24000 + N and
 * uses exactly one upstream descriptor. Routing policy:
 *   - control-plane hosts and STRICT_CONTROL slots: static upstream only,
 *     fail closed (never WARP, never direct).
 *   - ELASTIC_DATA: static first, WARP pool overflow on connect failure/429.
 *   - abuse guard runs before any upstream connection.
 */

const net = require('node:net');

const { createMixedProxy } = require('../lib/local-proxy');
const { connectUpstream } = require('../lib/upstream');
const { parseNodeUri } = require('../lib/node-uri');
const { probeViaProxy } = require('../lib/probe');
const { probeIdentity } = require('../lib/identity-probe');
const store = require('../lib/store');
const proxygate = require('../lib/providers/proxygate');

const contract = require('./contract');
const sub2port = require('./sub2port');
const { createAbuseGuard } = require('./abuse-guard');
const { createWarpPool } = require('./warp-pool');
const matrixStore = require('./matrix-store');
const ledger = require('./subnet-taint-ledger');

const DEFAULT_LANE = 'default';
const DEFAULT_PROBE_INTERVAL_MS = 60_000;
const COOLDOWN_MS = 30_000;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portBusy(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', (error) => resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES'));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function identityLeaseId(intentId, epoch) {
  return `${String(intentId || 'lease')}#${Number(epoch) || 1}`;
}

function epochOf(leaseId) {
  const match = /#(\d+)$/.exec(String(leaseId || ''));
  return match ? Number(match[1]) : 0;
}

function descriptorFor(state, lease) {
  if (lease.provider === 'proxygate') {
    if (!lease.slot) {
      throw Object.assign(new Error('proxygate 租约缺少槽位信息，先同步槽位'), { code: 'slot_missing' });
    }
    return parseNodeUri(proxygate.slotDescriptor(lease.slot, state.proxygate));
  }
  if (lease.nodeUri) return parseNodeUri(lease.nodeUri);
  const node = store.findNode(state, lease.nodeId);
  if (!node) {
    throw Object.assign(new Error('租约引用的节点不存在'), { code: 'node_missing' });
  }
  return parseNodeUri(node.uri);
}

function signatureOf(descriptor) {
  if (!descriptor) return '';
  return JSON.stringify({
    protocol: descriptor.protocol,
    server: descriptor.server,
    port: descriptor.port,
    username: descriptor.username || '',
    password: descriptor.password || '',
    wsPath: descriptor.wsPath || '',
    tls: Boolean(descriptor.tls),
    sni: descriptor.sni || '',
  });
}

function createRouterEngine(options = {}) {
  const load = options.load;
  const save = options.save;
  const writeEndpoints = options.writeEndpoints;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const probeIntervalMs = Number(options.probeIntervalMs) > 0
    ? Number(options.probeIntervalMs)
    : DEFAULT_PROBE_INTERVAL_MS;

  const runtime = new Map();
  const listeners = new Map();
  const guard = createAbuseGuard(options.abuse || {});
  const warp = createWarpPool({ getConfig: () => (load().warp || {}), log });
  let defaultLane = null;
  let queue = Promise.resolve();
  let timer = null;
  let flushTimer = null;
  let running = false;
  let lastUpdatedAt = '';

  function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  function controlDomains(state) {
    const list = state && state.settings && state.settings.controlDomains;
    return Array.isArray(list) && list.length ? list : contract.DEFAULT_CONTROL_DOMAINS;
  }

  function recordOf(slot) {
    return {
      matrixSlotId: slot.matrixSlotId,
      egressPort: slot.egressPort,
      routingPlane: slot.routingPlane,
      healthState: slot.healthState,
      egressFingerprint: contract.normalizeFingerprint(slot.egressFingerprint, slot.leaseId),
      leaseId: slot.leaseId,
      intentId: slot.intentId,
      key: slot.key,
      provider: slot.provider,
      nodeId: slot.nodeId || '',
      slotId: slot.slotId || '',
      country: slot.country || '',
      upstreamSignature: slot.signature || '',
      rotationEpoch: slot.epoch,
      cooldownUntil: slot.cooldownUntil || 0,
      lastError: slot.lastError || '',
      createdAt: slot.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function snapshotSlot(slot) {
    if (!slot) return null;
    return Object.assign(recordOf(slot), {
      exists: Boolean(slot.descriptor),
      listener: Boolean(slot.lane),
      stats: slot.lane ? Object.assign({}, slot.lane.proxy.stats) : null,
    });
  }

  function lanesNow() {
    const result = [];
    if (defaultLane && defaultLane.proxy) {
      const primary = runtime.get(defaultLane.matrixSlotId);
      result.push({
        key: DEFAULT_LANE,
        kind: 'default',
        leaseId: primary ? primary.intentId : '',
        matrixSlotId: defaultLane.matrixSlotId,
        egressPort: defaultLane.port,
        host: '127.0.0.1',
        port: defaultLane.port,
        proxy: `http://127.0.0.1:${defaultLane.port}`,
        socks: `socks5://127.0.0.1:${defaultLane.port}`,
        country: primary ? primary.country : '',
        routingPlane: primary ? primary.routingPlane : 'ELASTIC_DATA',
        healthState: primary ? primary.healthState : 'COOLDOWN',
        exitIp: primary ? primary.egressFingerprint.exitIp : '',
        egressFingerprint: primary ? primary.egressFingerprint : contract.emptyFingerprint(),
        ok: primary ? primary.healthState === 'ACTIVE' || primary.healthState === 'WARP_OVERFLOW' : false,
        checkedAt: new Date().toISOString(),
        error: primary ? primary.lastError : '没有主线路',
        stats: defaultLane.proxy.stats,
      });
    }
    for (const lane of listeners.values()) {
      if (!lane.slot) continue;
      result.push(laneView(lane.slot));
    }
    return result.sort((left, right) => {
      const a = left.matrixSlotId ? contract.indexForSlotId(left.matrixSlotId) : 0;
      const b = right.matrixSlotId ? contract.indexForSlotId(right.matrixSlotId) : 0;
      return a - b;
    });
  }

  function laneView(slot) {
    return {
      key: slot.key,
      kind: 'lease',
      leaseId: slot.intentId,
      matrixSlotId: slot.matrixSlotId,
      egressPort: slot.egressPort,
      host: '127.0.0.1',
      port: slot.egressPort,
      proxy: `http://127.0.0.1:${slot.egressPort}`,
      socks: `socks5://127.0.0.1:${slot.egressPort}`,
      country: slot.country,
      routingPlane: slot.routingPlane,
      healthState: slot.healthState,
      exitIp: slot.egressFingerprint.exitIp,
      egressFingerprint: slot.egressFingerprint,
      ok: slot.healthState === 'ACTIVE' || slot.healthState === 'WARP_OVERFLOW',
      checkedAt: new Date().toISOString(),
      error: slot.lastError,
      stats: slot.lane ? slot.lane.proxy.stats : null,
    };
  }

  async function persistAll() {
    const records = [...runtime.values()].map(recordOf);
    try {
      const result = await matrixStore.replaceLeases(records);
      if (result && result.rejected && result.rejected.length) {
        log(`持久化拒绝 ${result.rejected.length} 条槽位记录: ${JSON.stringify(result.rejected.slice(0, 3))}`);
      }
      lastUpdatedAt = new Date().toISOString();
    } catch (error) {
      log(`写入 egress-leases.json 失败: ${error.message}`);
    }
  }

  function publish(state = load()) {
    const lanes = lanesNow();
    const byKey = {};
    for (const lane of lanes) byKey[lane.key] = lane;
    const defaultInfo = byKey[DEFAULT_LANE] || null;
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      host: state.settings.listenHost || '127.0.0.1',
      primary: state.settings.primary || '',
      default: defaultInfo,
      byKey,
      lanes,
      slots: [...runtime.values()].map(recordOf).sort((left, right) => {
        return contract.indexForSlotId(left.matrixSlotId) - contract.indexForSlotId(right.matrixSlotId);
      }),
    };
    try {
      writeEndpoints(payload);
    } catch (error) {
      log(`写入 endpoints.json 失败: ${error.message}`);
    }
    return payload;
  }

  function flushSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      enqueue(async () => {
        await persistAll();
        publish();
      }).catch((error) => log(`刷新矩阵状态失败: ${error.message}`));
    }, 80);
  }

  function updateConfigLease(slot, patch) {
    const state = load();
    const lease = store.findLease(state, slot.intentId);
    if (!lease) return;
    Object.assign(lease, patch);
    lease.matrixSlotId = slot.matrixSlotId;
    lease.egressPort = slot.egressPort;
    save(state);
  }

  function markFailure(slot, error) {
    const now = Date.now();
    slot.failures = (slot.failures || []).filter((stamp) => now - stamp <= FAILURE_WINDOW_MS);
    slot.failures.push(now);
    slot.lastError = error && error.message ? error.message : String(error);
    if (slot.failures.length >= FAILURE_THRESHOLD && slot.healthState !== 'QUARANTINED'
      && slot.healthState !== 'ROTATING') {
      slot.healthState = 'COOLDOWN';
      slot.cooldownUntil = now + COOLDOWN_MS;
    }
    flushSoon();
  }

  function markSuccess(slot, viaWarp) {
    slot.failures = [];
    slot.lastError = '';
    if (viaWarp) {
      slot.healthState = 'WARP_OVERFLOW';
    } else if (slot.healthState !== 'QUARANTINED' && slot.healthState !== 'ROTATING') {
      slot.healthState = 'ACTIVE';
      slot.cooldownUntil = 0;
    }
    flushSoon();
  }

  function wrapTunnel(slot, tunnel) {
    let head = '';
    const wrapped = Object.create(tunnel);
    wrapped.onData = (handler) => tunnel.onData((chunk) => {
      if (head.length < 256) {
        try { head += chunk.slice(0, 256 - head.length).toString('latin1'); } catch { /* ignore */ }
        const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head);
        if (match && Number(match[1]) === 429) {
          slot.warpUntil = Date.now() + 30_000;
          slot.lastError = '上游返回 429，弹性流量转入 WARP';
          flushSoon();
        }
      }
      handler(chunk);
    });
    return wrapped;
  }

  async function connectStatic(slot, target) {
    return connectUpstream(slot.descriptor, target, { timeoutMs: 15000 });
  }

  async function connectFor(slot, target, meta = {}) {
    const now = Date.now();
    if (slot.healthState === 'QUARANTINED') {
      throw Object.assign(new Error(`槽位 ${slot.matrixSlotId} 处于隔离状态`), { code: 'slot_quarantined' });
    }
    if (slot.healthState === 'ROTATING') {
      throw Object.assign(new Error(`槽位 ${slot.matrixSlotId} 正在旋转`), { code: 'slot_rotating' });
    }
    if (slot.healthState === 'COOLDOWN' && slot.cooldownUntil > now) {
      throw Object.assign(new Error(`槽位 ${slot.matrixSlotId} 冷却中`), { code: 'slot_cooling' });
    }
    if (!slot.descriptor) {
      throw Object.assign(new Error(`槽位 ${slot.matrixSlotId} 没有上游`), { code: 'upstream_missing' });
    }

    const state = load();
    const verdict = guard.evaluate(slot.matrixSlotId, target, { now });
    if (!verdict.allow) {
      if (verdict.quarantine) {
        await quarantineSlot(slot.matrixSlotId, verdict.reason || verdict.code);
      }
      throw Object.assign(new Error(verdict.reason || verdict.code), {
        code: verdict.code,
        matrixSlotId: slot.matrixSlotId,
        lockUntil: verdict.lockUntil || 0,
      });
    }

    const forced = meta.routingPlane && String(meta.routingPlane).toUpperCase() === 'STRICT_CONTROL';
    const plane = forced || slot.routingPlane === 'STRICT_CONTROL'
      || contract.isControlPlaneHost(target.host, controlDomains(state))
      ? 'STRICT_CONTROL'
      : 'ELASTIC_DATA';

    if (plane === 'STRICT_CONTROL') {
      try {
        const tunnel = await connectStatic(slot, target);
        markSuccess(slot, false);
        return wrapTunnel(slot, tunnel);
      } catch (error) {
        markFailure(slot, error);
        throw Object.assign(new Error(`控制面严格执行失败，已拒绝回退: ${error.message}`), {
          code: 'strict_control_failclosed',
          matrixSlotId: slot.matrixSlotId,
          cause: error.code,
        });
      }
    }

    if (slot.warpUntil > now && warp.available()) {
      try {
        const tunnel = await warp.connect(target, meta);
        markSuccess(slot, true);
        return wrapTunnel(slot, tunnel);
      } catch (error) {
        log(`WARP 预置溢出失败 ${slot.matrixSlotId}: ${error.message}`);
      }
    }

    try {
      const tunnel = await connectStatic(slot, target);
      markSuccess(slot, false);
      return wrapTunnel(slot, tunnel);
    } catch (error) {
      if (warp.available()) {
        try {
          const tunnel = await warp.connect(target, meta);
          markSuccess(slot, true);
          return wrapTunnel(slot, tunnel);
        } catch (warpError) {
          log(`WARP 溢出失败 ${slot.matrixSlotId}: ${warpError.message}`);
        }
      }
      markFailure(slot, error);
      throw Object.assign(new Error(`上游连接失败: ${error.message}`), {
        code: 'upstream_failed',
        matrixSlotId: slot.matrixSlotId,
      });
    }
  }

  async function closeLane(slot) {
    if (!slot || !slot.lane) return;
    const lane = slot.lane;
    slot.lane = null;
    listeners.delete(lane.key);
    try { await lane.proxy.close(); } catch { /* ignore */ }
  }

  async function openLane(slot) {
    if (!slot || slot.lane || !slot.descriptor) return;
    if (slot.healthState === 'ROTATING') return;
    let attempt = 0;
    for (;;) {
      try {
        const proxy = await createMixedProxy({
          host: '127.0.0.1',
          port: slot.egressPort,
          upstreamFor: (target, meta) => connectFor(slot, target, meta),
          log: (message) => log(`[${slot.matrixSlotId}] ${message}`),
        });
        const lane = { key: slot.key, slot, proxy, port: slot.egressPort };
        slot.lane = lane;
        listeners.set(slot.key, lane);
        return;
      } catch (error) {
        if (error && error.code === 'EADDRINUSE' && attempt < 2) {
          attempt += 1;
          await delay(250);
          continue;
        }
        slot.lastError = `监听 ${slot.egressPort} 失败: ${error.message}`;
        if (slot.healthState !== 'QUARANTINED' && slot.healthState !== 'ROTATING') {
          slot.healthState = 'COOLDOWN';
          slot.cooldownUntil = Date.now() + COOLDOWN_MS;
        }
        log(`[${slot.matrixSlotId}] ${slot.lastError}`);
        return;
      }
    }
  }

  async function closeDefault() {
    if (!defaultLane) return;
    const lane = defaultLane;
    defaultLane = null;
    listeners.delete(DEFAULT_LANE);
    try { await lane.proxy.close(); } catch { /* ignore */ }
  }

  async function openDefault(state, primary) {
    if (!primary || !primary.descriptor || !primary.lane) {
      await closeDefault();
      return;
    }
    const port = Number(state.settings.defaultPort);
    if (!port || contract.isMatrixPort(port)) {
      await closeDefault();
      return;
    }
    if (defaultLane && defaultLane.matrixSlotId === primary.matrixSlotId && defaultLane.port === port) return;
    await closeDefault();
    try {
      const proxy = await createMixedProxy({
        host: '127.0.0.1',
        port,
        upstreamFor: (target, meta) => connectFor(primary, target, meta),
        log: (message) => log(`[default] ${message}`),
      });
      defaultLane = { key: DEFAULT_LANE, matrixSlotId: primary.matrixSlotId, port, proxy };
      listeners.set(DEFAULT_LANE, defaultLane);
    } catch (error) {
      log(`默认网关监听 ${port} 失败: ${error.message}`);
    }
  }

  function primarySlot(state) {
    const leases = state.leases || [];
    const primaryId = state.settings.primary;
    const lease = leases.find((entry) => entry.id === primaryId) || leases[0] || null;
    if (!lease) return null;
    return runtime.get(lease.matrixSlotId) || null;
  }

  async function syncOnce(reason) {
    const state = load();
    const existingRecords = new Map();
    try {
      const persisted = await matrixStore.loadLeases();
      for (const record of persisted.leases) existingRecords.set(record.matrixSlotId, record);
    } catch (error) {
      log(`读取 egress-leases.json 失败: ${error.message}`);
    }

    const recordFor = (matrixSlotId, intentId) => existingRecords.get(matrixSlotId)
      || [...existingRecords.values()].find((item) => item.intentId === intentId);

    const used = new Set();
    const ownPorts = new Set();
    for (const slot of runtime.values()) {
      if (slot.lane) ownPorts.add(slot.egressPort);
    }
    if (defaultLane) ownPorts.add(defaultLane.port);

    const planned = [];
    for (const lease of state.leases) {
      let mapping = sub2port.reserve(used, lease.matrixSlotId);
      let target = sub2port.mappingForIndex(mapping);
      let probes = 0;
      while (!ownPorts.has(target.egressPort) && probes < contract.SLOT_COUNT && await portBusy(target.egressPort)) {
        used.add(mapping);
        probes += 1;
        mapping = sub2port.nextFreeIndex(used);
        target = sub2port.mappingForIndex(mapping);
      }
      used.add(mapping);
      lease.matrixSlotId = target.matrixSlotId;
      lease.egressPort = target.egressPort;
      planned.push({ lease, matrixSlotId: target.matrixSlotId, egressPort: target.egressPort });
    }

    const seen = new Set();
    for (const item of planned) {
      const { lease, matrixSlotId, egressPort } = item;
      let slot = runtime.get(matrixSlotId);
      if (slot && slot.intentId !== lease.id) {
        await closeLane(slot);
        runtime.delete(matrixSlotId);
        slot = null;
      }
      if (!slot) {
        const record = recordFor(matrixSlotId, lease.id);
        const epoch = epochOf(record && record.leaseId) || 1;
        slot = {
          matrixSlotId,
          egressPort,
          intentId: lease.id,
          key: lease.key,
          provider: lease.provider,
          nodeId: lease.nodeId || '',
          slotId: lease.slotId || '',
          country: lease.country || '',
          routingPlane: contract.normalizeRoutingPlane(lease.routingPlane),
          healthState: record ? contract.normalizeHealthState(record.healthState) : 'ACTIVE',
          egressFingerprint: record
            ? contract.normalizeFingerprint(record.egressFingerprint, record.leaseId)
            : contract.emptyFingerprint(identityLeaseId(lease.id, epoch)),
          leaseId: record && record.leaseId ? record.leaseId : identityLeaseId(lease.id, epoch),
          epoch,
          descriptor: null,
          signature: '',
          lane: null,
          failures: [],
          cooldownUntil: record && Number(record.cooldownUntil) > Date.now() ? Number(record.cooldownUntil) : 0,
          warpUntil: 0,
          lastError: record ? String(record.lastError || '') : '',
          createdAt: (record && record.createdAt) || lease.createdAt || new Date().toISOString(),
        };
        if (slot.healthState === 'ROTATING') slot.healthState = 'COOLDOWN';
        runtime.set(matrixSlotId, slot);
      }
      seen.add(matrixSlotId);

      slot.key = lease.key;
      slot.provider = lease.provider;
      slot.nodeId = lease.nodeId || '';
      slot.slotId = lease.slotId || '';
      slot.country = lease.country || '';
      if (!slot.country && slot.nodeId) {
        const node = store.findNode(state, slot.nodeId);
        const code = node && node.lastCheck && node.lastCheck.ok
          ? String(node.lastCheck.countryCode || '').toUpperCase()
          : '';
        if (code) {
          slot.country = code;
          lease.country = code;
        }
      }
      slot.routingPlane = contract.normalizeRoutingPlane(lease.routingPlane, slot.routingPlane);
      if (lease.createdAt) slot.createdAt = lease.createdAt;
      if (slot.healthState === 'QUARANTINED') lease.healthState = 'QUARANTINED';

      if (slot.healthState === 'ROTATING') continue;

      let descriptor = null;
      try {
        descriptor = descriptorFor(state, lease);
      } catch (error) {
        slot.lastError = error.message;
        if (slot.healthState !== 'QUARANTINED') slot.healthState = 'COOLDOWN';
        await closeLane(slot);
        continue;
      }
      const signature = signatureOf(descriptor);
      const persistedRecord = recordFor(matrixSlotId, lease.id);
      if (slot.lane && signature !== slot.signature) {
        await closeLane(slot);
      }
      if (signature !== slot.signature) {
        const priorSignature = (persistedRecord && persistedRecord.upstreamSignature) || slot.signature;
        slot.signature = signature;
        slot.descriptor = descriptor;
        if (priorSignature && priorSignature !== signature) {
          slot.epoch += 1;
          slot.leaseId = identityLeaseId(slot.intentId, slot.epoch);
          slot.egressFingerprint = contract.emptyFingerprint(slot.leaseId);
          slot.lastError = '上游已变更，等待探测确认新出口';
          if (slot.healthState !== 'QUARANTINED') slot.healthState = 'ACTIVE';
        }
      } else {
        slot.descriptor = descriptor;
      }
      if (!slot.leaseId) {
        slot.epoch = slot.epoch || 1;
        slot.leaseId = identityLeaseId(slot.intentId, slot.epoch);
      }
      if (!slot.lane) await openLane(slot);
    }

    for (const [matrixSlotId, slot] of runtime) {
      if (seen.has(matrixSlotId)) continue;
      await closeLane(slot);
      runtime.delete(matrixSlotId);
    }

    await openDefault(state, primarySlot(state));
    save(state);
    await persistAll();
    publish(state);
    log(`矩阵协调完成 (${reason || 'manual'}): ${runtime.size} 条槽位`);
    return { slots: runtime.size, listeners: listeners.size };
  }

  async function claimFingerprint(slot, egress) {
    const nextIp = String(egress.exitIp || '');
    const prefix = contract.normalizePrefix64(egress.ipv6Prefix64 || egress.ipv6 || '');
    const asn = String(egress.asn || '');
    const changed = nextIp !== slot.egressFingerprint.exitIp
      || prefix !== slot.egressFingerprint.ipv6Prefix64;
    if (changed && (nextIp || prefix)) {
      slot.epoch += 1;
      slot.leaseId = identityLeaseId(slot.intentId, slot.epoch);
      await ledger.claim({
        prefix64: prefix,
        exitIp: nextIp,
        matrixSlotId: slot.matrixSlotId,
        leaseId: slot.leaseId,
      });
    }
    slot.egressFingerprint = contract.normalizeFingerprint({
      exitIp: nextIp,
      ipv6Prefix64: prefix,
      asn,
      leaseId: slot.leaseId,
    }, slot.leaseId);
  }

  async function probeSlotDirect(slot, options = {}) {
    if (!slot || !slot.lane) {
      return { ok: false, error: '端口未监听' };
    }
    const state = load();
    try {
      const result = await probeViaProxy({
        host: '127.0.0.1',
        port: slot.egressPort,
        url: state.settings.probeUrl || 'https://api.ipify.org',
        timeoutMs: 20000,
      });
      const exitIp = String((result && result.exitIp) || '');
      const needDeep = Boolean(options.deep)
        || !slot.egressFingerprint.exitIp
        || (exitIp && exitIp !== slot.egressFingerprint.exitIp);
      let identity = null;
      if (needDeep) {
        identity = await probeIdentity({ port: slot.egressPort, timeoutMs: 20000 });
      }
      try {
        await claimFingerprint(slot, {
          exitIp: (identity && identity.exitIp) || exitIp,
          ipv6Prefix64: identity && identity.ipv6,
          asn: identity && identity.asn,
        });
      } catch (error) {
        slot.healthState = 'QUARANTINED';
        slot.lastError = error.message;
        await closeLane(slot);
        updateConfigLease(slot, { ok: false, healthState: 'QUARANTINED', checkError: error.message });
        throw error;
      }
      if (slot.healthState !== 'QUARANTINED' && slot.healthState !== 'ROTATING') {
        slot.healthState = 'ACTIVE';
        slot.cooldownUntil = 0;
      }
      slot.failures = [];
      slot.lastError = '';
      slot.checkedAt = new Date().toISOString();
      updateConfigLease(slot, {
        ok: true,
        exitIp: slot.egressFingerprint.exitIp,
        exitIpCheckedAt: slot.checkedAt,
        checkError: '',
        healthState: slot.healthState,
        leaseId: slot.leaseId,
      });
      return { ok: true, exitIp: slot.egressFingerprint.exitIp, fingerprint: slot.egressFingerprint };
    } catch (error) {
      slot.lastError = error.message;
      slot.checkedAt = new Date().toISOString();
      if (slot.healthState !== 'QUARANTINED' && slot.healthState !== 'ROTATING') {
        slot.healthState = 'COOLDOWN';
        slot.cooldownUntil = Date.now() + COOLDOWN_MS;
      }
      updateConfigLease(slot, {
        ok: false,
        healthState: slot.healthState,
        exitIpCheckedAt: slot.checkedAt,
        checkError: error.message,
      });
      return { ok: false, error: error.message };
    } finally {
      await persistAll();
      publish();
    }
  }

  async function probeSlot(matrixSlotId, options = {}) {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) {
        throw Object.assign(new Error(`槽位 ${matrixSlotId} 不存在`), { code: 'slot_missing', status: 404 });
      }
      return probeSlotDirect(slot, options);
    });
  }

  async function probeAll(options = {}) {
    return enqueue(async () => {
      const results = [];
      for (const slot of runtime.values()) {
        if (slot.healthState === 'ROTATING' || slot.healthState === 'QUARANTINED') continue;
        const needsDeep = Boolean(options.deep) || !slot.egressFingerprint.exitIp;
        results.push({ matrixSlotId: slot.matrixSlotId, ...(await probeSlotDirect(slot, { deep: needsDeep })) });
      }
      await persistAll();
      publish();
      return results;
    });
  }

  async function quarantineSlot(matrixSlotId, reason) {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) return null;
      await closeLane(slot);
      slot.healthState = 'QUARANTINED';
      slot.lastError = String(reason || '隔离');
      guard.quarantine(slot.matrixSlotId, Date.now() + guard.config.lockMs);
      updateConfigLease(slot, { ok: false, healthState: 'QUARANTINED', checkError: slot.lastError });
      await persistAll();
      publish();
      return snapshotSlot(slot);
    });
  }

  async function suspendSlot(matrixSlotId, healthState = 'ROTATING') {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) {
        throw Object.assign(new Error(`槽位 ${matrixSlotId} 不存在`), { code: 'slot_missing', status: 404 });
      }
      await closeLane(slot);
      slot.healthState = contract.normalizeHealthState(healthState, 'ROTATING');
      slot.lastError = '';
      await persistAll();
      publish();
      return snapshotSlot(slot);
    });
  }

  async function resumeSlot(matrixSlotId, applied = {}) {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) {
        throw Object.assign(new Error(`槽位 ${matrixSlotId} 不存在`), { code: 'slot_missing', status: 404 });
      }
      if (applied.descriptor) {
        slot.descriptor = applied.descriptor;
        slot.signature = signatureOf(applied.descriptor);
      }
      const fingerprint = contract.normalizeFingerprint(
        applied.egressFingerprint,
        slot.leaseId,
      );
      slot.egressFingerprint = fingerprint;
      slot.leaseId = fingerprint.leaseId || slot.leaseId;
      slot.epoch = epochOf(slot.leaseId) || slot.epoch;
      slot.healthState = 'ACTIVE';
      slot.cooldownUntil = 0;
      slot.failures = [];
      slot.lastError = '';
      await openLane(slot);
      const state = load();
      save(state);
      await persistAll();
      publish(state);
      const probe = await probeSlotDirect(slot, { deep: true });
      return Object.assign(snapshotSlot(slot), { probe });
    });
  }

  async function failSlot(matrixSlotId, reason) {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) return null;
      await closeLane(slot);
      slot.healthState = 'COOLDOWN';
      slot.cooldownUntil = Date.now() + COOLDOWN_MS;
      slot.lastError = String(reason || '旋转失败');
      updateConfigLease(slot, { ok: false, healthState: 'COOLDOWN', checkError: slot.lastError });
      await persistAll();
      publish();
      return snapshotSlot(slot);
    });
  }

  async function releaseSlot(matrixSlotId) {
    return enqueue(async () => {
      const slot = runtime.get(String(matrixSlotId || ''));
      if (!slot) return null;
      guard.release(slot.matrixSlotId);
      if (slot.healthState === 'QUARANTINED') slot.healthState = 'ACTIVE';
      slot.lastError = '';
      await openLane(slot);
      await persistAll();
      publish();
      return snapshotSlot(slot);
    });
  }

  async function probeDescriptor(descriptor, options = {}) {
    const started = Date.now();
    const proxy = await createMixedProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamFor: (target) => connectUpstream(descriptor, target, { timeoutMs: 15000 }),
      log: (message) => log(`[probe] ${message}`),
    });
    try {
      const result = await probeViaProxy({
        host: '127.0.0.1',
        port: proxy.port,
        url: load().settings.probeUrl || 'https://api.ipify.org',
        timeoutMs: 20000,
      });
      const exitIp = String((result && result.exitIp) || '');
      let identity = null;
      if (options.deep) {
        identity = await probeIdentity({
          port: proxy.port,
          timeoutMs: 20000,
          ipv6: options.ipv6 !== false,
        });
      }
      return {
        ok: true,
        exitIp: (identity && identity.exitIp) || exitIp,
        ipv6Prefix64: (identity && identity.ipv6) || '',
        asn: (identity && identity.asn) || '',
        country: (identity && identity.country) || '',
        countryCode: (identity && identity.countryCode) || '',
        latencyMs: Date.now() - started,
        port: proxy.port,
      };
    } finally {
      await proxy.close();
    }
  }

  async function probeNode(nodeId, options = {}) {
    const persist = options.persist !== false;
    const state = load();
    const node = store.findNode(state, nodeId);
    if (!node) {
      throw Object.assign(new Error('节点不存在'), { status: 404, code: 'node_missing' });
    }
    try {
      const descriptor = parseNodeUri(node.uri);
      const result = await probeDescriptor(descriptor, {
        deep: options.deep !== false,
        ipv6: options.ipv6 === true,
      });
      const lastCheck = {
        ok: true,
        exitIp: result.exitIp,
        asn: result.asn || '',
        country: result.country || '',
        countryCode: result.countryCode || '',
        latencyMs: result.latencyMs || 0,
        checkedAt: new Date().toISOString(),
        error: '',
      };
      if (persist) {
        node.lastCheck = lastCheck;
        save(state);
      }
      return Object.assign({ nodeId, ok: true }, result, { lastCheck });
    } catch (error) {
      const lastCheck = {
        ok: false,
        exitIp: '',
        asn: '',
        country: '',
        countryCode: '',
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        error: error.message,
      };
      if (persist) {
        node.lastCheck = lastCheck;
        save(state);
        throw error;
      }
      return { nodeId, ok: false, error: error.message, lastCheck };
    }
  }

  function status() {
    const state = load();
    return {
      running,
      primary: state.settings.primary || '',
      defaultPort: Number(state.settings.defaultPort) || 0,
      slots: [...runtime.values()].map(snapshotSlot).sort((left, right) => {
        return contract.indexForSlotId(left.matrixSlotId) - contract.indexForSlotId(right.matrixSlotId);
      }),
      lanes: lanesNow(),
      nodes: (state.nodes || []).length,
      warp: warp.status(),
      abuse: guard.snapshot(),
      updatedAt: lastUpdatedAt,
    };
  }

  function descriptorForLease(lease) {
    return descriptorFor(load(), lease);
  }

  function reconcile(reason) {
    return enqueue(() => syncOnce(reason));
  }

  function probe() {
    return probeAll({ deep: false });
  }

  function publishNow() {
    return enqueue(async () => {
      const state = load();
      save(state);
      await persistAll();
      return publish(state);
    });
  }

  async function cycle() {
    try {
      await enqueue(() => syncOnce('interval'));
      await probeAll({ deep: false });
    } catch (error) {
      log(`矩阵周期任务失败: ${error.message}`);
    }
  }

  async function start() {
    running = true;
    try {
      await reconcile('start');
      await probeAll({ deep: true });
    } catch (error) {
      log(`矩阵启动失败: ${error.message}`);
    }
    timer = setInterval(() => { void cycle(); }, probeIntervalMs);
    if (timer.unref) timer.unref();
  }

  async function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    for (const slot of runtime.values()) await closeLane(slot);
    await closeDefault();
    await persistAll().catch(() => {});
  }

  return {
    listeners,
    start,
    stop,
    reconcile,
    probe,
    probeAll,
    probeSlot,
    probeSlotDirect,
    probeDescriptor,
    probeNode,
    status,
    publish,
    publishNow,
    descriptorFor,
    descriptorForLease,
    getSlot: (matrixSlotId) => snapshotSlot(runtime.get(String(matrixSlotId || ''))),
    suspendSlot,
    resumeSlot,
    failSlot,
    releaseSlot,
    quarantineSlot,
    guard,
    warp,
    DEFAULT_LANE,
  };
}

module.exports = { createRouterEngine, descriptorFor, DEFAULT_LANE, identityLeaseId };
