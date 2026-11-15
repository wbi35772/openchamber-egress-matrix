'use strict';

/*
 * Rotation coordinator.
 *
 * A rotation is the only moment when an egress identity may change for a
 * matrix slot. The sequence is intentionally serialized per slot:
 *
 *   1. mark ROTATING and stop accepting new connections on the slot
 *   2. fire PRE_ROTATION_FREEZE to registered clients (200 ms budget)
 *   3. swap the upstream, verify the new exit fingerprint
 *   4. claim the new /64 and exit IP in the taint ledger
 *   5. reopen the listener, mark ACTIVE, fire POST_ROTATION_RESUME
 *
 * Any failure keeps the slot closed (COOLDOWN), never falls back to direct.
 */

const matrixStore = require('./matrix-store');
const ledger = require('./subnet-taint-ledger');
const { normalizeFingerprint } = require('./contract');

const FREEZE_TIMEOUT_MS = 200;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} 超时`), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dispatchEvent(event, payload, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : FREEZE_TIMEOUT_MS;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let callbacks = [];
  try {
    callbacks = await matrixStore.listCallbacks();
  } catch (error) {
    log(`读取旋转回调失败: ${error.message}`);
    return [];
  }
  const targets = callbacks.filter((callback) => {
    return Array.isArray(callback.events) && callback.events.includes(event);
  });
  if (!targets.length) return [];

  return Promise.all(targets.map(async (callback) => {
    const startedAt = Date.now();
    try {
      const response = await withTimeout(fetch(callback.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-oc-event': event,
          'x-oc-client': callback.clientId || '',
        },
        body: JSON.stringify(Object.assign({ event, dispatchedAt: Date.now() }, payload)),
      }), timeoutMs, `回调 ${callback.clientId || callback.id}`);
      return {
        clientId: callback.clientId,
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      log(`旋转回调 ${callback.clientId || callback.id} 失败: ${error.message}`);
      return {
        clientId: callback.clientId,
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        error: error.message,
      };
    }
  }));
}

function createRotationCoordinator(options = {}) {
  const engine = options.engine;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const running = new Map();

  async function emit(event, payload) {
    const results = await dispatchEvent(event, payload, { log });
    await matrixStore.appendEvent(event, Object.assign({ delivery: results }, payload)).catch((error) => {
      log(`记录旋转事件失败: ${error.message}`);
    });
    return results;
  }

  async function rotate(matrixSlotId, apply, meta = {}) {
    const slotId = String(matrixSlotId || '');
    if (running.has(slotId)) {
      throw Object.assign(new Error(`槽位 ${slotId} 正在旋转`), { code: 'rotation_in_progress', status: 409 });
    }
    const slot = engine.getSlot(slotId);
    if (!slot) {
      throw Object.assign(new Error(`槽位 ${slotId} 不存在`), { code: 'slot_missing', status: 404 });
    }
    if (slot.healthState === 'ROTATING') {
      throw Object.assign(new Error(`槽位 ${slotId} 正在旋转`), { code: 'rotation_in_progress', status: 409 });
    }
    if (slot.healthState === 'QUARANTINED') {
      throw Object.assign(new Error(`槽位 ${slotId} 处于隔离状态，先解除隔离`), {
        code: 'slot_quarantined',
        status: 409,
      });
    }

    running.set(slotId, { startedAt: Date.now(), reason: String(meta.reason || 'manual') });
    try {
      await engine.suspendSlot(slotId, 'ROTATING');
      await emit('PRE_ROTATION_FREEZE', {
        matrixSlotId: slotId,
        deadlineMs: FREEZE_TIMEOUT_MS,
        reason: meta.reason || 'manual',
      });

      let applied;
      try {
        applied = await apply({ slot, matrixSlotId: slotId });
      } catch (error) {
        await engine.failSlot(slotId, error.message || String(error));
        await emit('ROTATION_FAILED', { matrixSlotId: slotId, reason: error.message || String(error) });
        throw error;
      }

      const fingerprint = normalizeFingerprint(applied && applied.egressFingerprint, slot.leaseId || '');
      const rawPrefix = String((applied && applied.egressFingerprint && applied.egressFingerprint.ipv6Prefix64) || '').trim();
      const identityProblem = rawPrefix && !fingerprint.ipv6Prefix64
        ? '换血校验失败：新 /64 前缀非法'
        : (!fingerprint.exitIp ? '换血校验失败：新上游未返回出口 IP' : '');
      if (identityProblem) {
        await engine.failSlot(slotId, identityProblem);
        await emit('ROTATION_FAILED', { matrixSlotId: slotId, reason: identityProblem });
        throw Object.assign(new Error(identityProblem), { code: 'rotation_identity_invalid', status: 502 });
      }
      try {
        await ledger.claim({
          prefix64: fingerprint.ipv6Prefix64,
          exitIp: fingerprint.exitIp,
          matrixSlotId: slotId,
          leaseId: fingerprint.leaseId,
        });
      } catch (error) {
        await engine.failSlot(slotId, error.message || String(error));
        await emit('ROTATION_FAILED', { matrixSlotId: slotId, reason: error.message || String(error) });
        throw error;
      }

      const updated = await engine.resumeSlot(slotId, {
        descriptor: applied && applied.descriptor,
        egressFingerprint: fingerprint,
      });
      await emit('POST_ROTATION_RESUME', {
        matrixSlotId: slotId,
        leaseId: updated.leaseId,
        egressFingerprint: updated.egressFingerprint,
      });
      return updated;
    } finally {
      running.delete(slotId);
    }
  }

  return { rotate, emit, dispatchEvent };
}

module.exports = {
  FREEZE_TIMEOUT_MS,
  dispatchEvent,
  createRotationCoordinator,
};
