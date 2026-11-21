'use strict';

const { test, describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const STATE_DIR = path.join(os.tmpdir(), `oc-matrix-test-${process.pid}-${Date.now()}`);
process.env.OPENCHAMBER_MATRIX_STATE_DIR = STATE_DIR;
process.env.EGRESS_MATRIX_DATA_DIR = path.join(STATE_DIR, 'data');

const http = require('node:http');

const contract = require('../core/contract');
const sub2port = require('../core/sub2port');
const storeLock = require('../core/store-lock');
const matrixStore = require('../core/matrix-store');
const ledger = require('../core/subnet-taint-ledger');
const abuse = require('../core/abuse-guard');
const { createWarpPool, endpointList } = require('../core/warp-pool');
const rotation = require('../core/rotation-coordinator');
const ws = require('../lib/ws');
const { createMixedProxy, readRoutingPlane } = require('../lib/local-proxy');
const leaseBatch = require('../lib/lease-batch');
const store = require('../lib/store');
const ports = require('../lib/ports');

after(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

function leaseRecord(index, patch = {}) {
  return Object.assign({
    matrixSlotId: contract.slotIdForIndex(index),
    egressPort: contract.egressPortForIndex(index),
    routingPlane: 'ELASTIC_DATA',
    healthState: 'ACTIVE',
    egressFingerprint: contract.emptyFingerprint(`lease-${index}`),
    leaseId: `lease-${index}`,
  }, patch);
}

function fakeTunnel() {
  return {
    write: () => true,
    onData: () => {},
    onClose: () => {},
    onDrain: () => {},
    close: () => {},
    pause: () => {},
    resume: () => {},
  };
}

describe('contract', () => {
  it('maps slot ids and ports deterministically', () => {
    assert.equal(contract.slotIdForIndex(1), 'slot-001');
    assert.equal(contract.slotIdForIndex(250), 'slot-250');
    assert.equal(contract.egressPortForSlotId('slot-001'), 24001);
    assert.equal(contract.egressPortForSlotId('slot-042'), 24042);
    assert.equal(contract.egressPortForSlotId('slot-250'), 24250);
    assert.equal(contract.matrixSlotIdForPort(24001), 'slot-001');
    assert.equal(contract.matrixSlotIdForPort(24250), 'slot-250');
    assert.equal(contract.matrixSlotIdForPort(24000), '');
    assert.equal(contract.isMatrixPort(25001), false);
    assert.throws(() => contract.slotIdForIndex(0), /矩阵槽位索引/);
    assert.throws(() => contract.slotIdForIndex(251), /矩阵槽位索引/);
  });

  it('normalizes routing planes and health states', () => {
    assert.equal(contract.normalizeRoutingPlane('strict_control'), 'STRICT_CONTROL');
    assert.equal(contract.normalizeRoutingPlane('bogus'), 'ELASTIC_DATA');
    assert.equal(contract.normalizeRoutingPlane('bogus', 'STRICT_CONTROL'), 'STRICT_CONTROL');
    assert.equal(contract.normalizeHealthState('warp_overflow'), 'WARP_OVERFLOW');
    assert.equal(contract.normalizeHealthState('nope'), 'ACTIVE');
  });

  it('normalizes /64 prefixes', () => {
    assert.equal(contract.normalizePrefix64('2001:DB8:AA::/64'), '2001:db8:aa:0::/64');
    assert.equal(contract.normalizePrefix64('[2001:db8:bb:1::]/64'), '2001:db8:bb:1::/64');
    assert.equal(contract.normalizePrefix64('nope'), '');
    assert.equal(contract.normalizePrefix64(''), '');
  });

  it('matches control-plane hosts with subdomain semantics', () => {
    assert.equal(contract.isControlPlaneHost('api.cloudflare.com'), true);
    assert.equal(contract.isControlPlaneHost('API.CloudFlare.Com.'), true);
    assert.equal(contract.isControlPlaneHost('evilcloudflare.com'), false);
    assert.equal(contract.isControlPlaneHost('api.cloudflare.com.evil.io'), false);
    assert.equal(contract.isControlPlaneHost('anything.test', ['test']), true);
  });

  it('validates lease records against the contract', () => {
    const good = leaseRecord(1);
    assert.deepEqual(contract.validateLeaseRecord(good), []);

    const wrongPort = contract.validateLeaseRecord(Object.assign({}, good, { egressPort: 24002 }));
    assert.equal(wrongPort.some((item) => item.includes('egressPort')), true);

    const wrongEnum = contract.validateLeaseRecord(Object.assign({}, good, {
      routingPlane: 'DIRECT',
      healthState: 'UP',
    }));
    assert.equal(wrongEnum.some((item) => item.includes('routingPlane')), true);
    assert.equal(wrongEnum.some((item) => item.includes('healthState')), true);

    const messyPrefix = contract.validateLeaseRecord(Object.assign({}, good, {
      egressFingerprint: Object.assign(contract.emptyFingerprint('x'), { ipv6Prefix64: '2001:DB8::' }),
    }));
    assert.equal(messyPrefix.some((item) => item.includes('ipv6Prefix64')), true);
  });
});

describe('sub2port', () => {
  it('collects used indexes and finds the next free slot', () => {
    const used = sub2port.usedIndexesFrom([
      { matrixSlotId: 'slot-002' },
      {},
      { matrixSlotId: 'slot-999' },
    ]);
    assert.deepEqual([...used], [2]);
    assert.equal(sub2port.nextFreeIndex(new Set([1, 2, 3])), 4);
    assert.equal(sub2port.reserve(new Set([1]), 'slot-001'), 2);
    assert.equal(sub2port.reserve(new Set([1]), 'slot-003'), 3);
    assert.equal(sub2port.reserve(new Set([3]), 'slot-003'), 1);
    assert.equal(sub2port.countFree([{ matrixSlotId: 'slot-001' }]), 249);
    assert.deepEqual(sub2port.mappingForIndex(7), { matrixSlotId: 'slot-007', egressPort: 24007 });
  });

  it('rejects exhaustion and port mismatches', () => {
    const full = new Set();
    for (let index = 1; index <= 250; index += 1) full.add(index);
    assert.throws(() => sub2port.nextFreeIndex(full), (error) => error.code === 'slots_exhausted');
    assert.equal(sub2port.assertMapping('slot-010', 24010), true);
    assert.throws(() => sub2port.assertMapping('slot-010', 24011), (error) => error.code === 'invalid_egress_port');
    assert.throws(() => sub2port.assertMapping('slot-999', 24999), (error) => error.code === 'invalid_slot_id');
  });
});

describe('store-lock', () => {
  it('round-trips atomic JSON and falls back on missing files', async () => {
    const file = path.join(STATE_DIR, 'lock-test.json');
    await storeLock.writeJsonAtomic(file, { ok: true });
    assert.deepEqual(await storeLock.readJson(file), { ok: true });
    assert.deepEqual(await storeLock.readJson(path.join(STATE_DIR, 'nope.json'), { fallback: 1 }), { fallback: 1 });
  });

  it('serializes concurrent mutations', async () => {
    const file = path.join(STATE_DIR, 'counter.json');
    await storeLock.writeJsonAtomic(file, { count: 0 });
    await Promise.all([
      storeLock.mutateJson(file, { count: 0 }, (data) => { data.count += 1; }),
      storeLock.mutateJson(file, { count: 0 }, (data) => { data.count += 1; }),
      storeLock.mutateJson(file, { count: 0 }, (data) => { data.count += 1; }),
    ]);
    const final = await storeLock.readJson(file);
    assert.equal(final.count, 3);
    assert.equal(Number.isInteger(final.updatedAt), true);
  });

  it('retries transient sharing violations on rename', async (t) => {
    const fsp = require('node:fs/promises');
    const original = fsp.rename;
    let calls = 0;
    t.mock.method(fsp, 'rename', async (...args) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
      return original(...args);
    });

    const file = path.join(STATE_DIR, 'retry-rename.json');
    await storeLock.writeJsonAtomic(file, { ok: 'retried' });
    assert.equal(calls, 3);
    assert.deepEqual(await storeLock.readJson(file), { ok: 'retried' });
  });

  it('gives up after five backoffs and removes the temp file', async (t) => {
    const fsp = require('node:fs/promises');
    let calls = 0;
    t.mock.method(fsp, 'rename', async () => {
      calls += 1;
      throw Object.assign(new Error('still locked'), { code: 'EPERM' });
    });

    const file = path.join(STATE_DIR, 'locked-rename.json');
    await assert.rejects(() => storeLock.writeJsonAtomic(file, { ok: false }), /still locked/);
    assert.equal(calls, 6);
    assert.equal(fs.existsSync(file), false);
    const leftovers = fs.readdirSync(STATE_DIR).filter((name) => name.startsWith('locked-rename.json.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('does not retry non-sharing rename errors', async (t) => {
    const fsp = require('node:fs/promises');
    let calls = 0;
    t.mock.method(fsp, 'rename', async () => {
      calls += 1;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });

    const file = path.join(STATE_DIR, 'no-space.json');
    await assert.rejects(() => storeLock.writeJsonAtomic(file, { ok: false }), /disk full/);
    assert.equal(calls, 1);
  });
});

describe('matrix-store', () => {
  it('writes only contract-valid leases', async () => {
    const result = await matrixStore.replaceLeases([
      leaseRecord(1, { routingPlane: 'STRICT_CONTROL' }),
      leaseRecord(2, { egressPort: 24999 }),
    ]);
    assert.equal(result.written, 1);
    assert.equal(result.rejected.length, 1);
    const leases = await matrixStore.listLeases();
    assert.equal(leases.length, 1);
    assert.equal(leases[0].matrixSlotId, 'slot-001');
  });

  it('patches fingerprints and removes leases', async () => {
    const patched = await matrixStore.patchLease('slot-001', {
      healthState: 'COOLDOWN',
      egressFingerprint: { exitIp: '198.51.100.9' },
    });
    assert.equal(patched.healthState, 'COOLDOWN');
    assert.equal(patched.egressFingerprint.exitIp, '198.51.100.9');
    assert.equal(patched.egressFingerprint.leaseId, 'lease-1');
    assert.equal(await matrixStore.patchLease('slot-250', {}), null);

    const removed = await matrixStore.removeLease('slot-001');
    assert.equal(removed.removed, 1);
    assert.equal((await matrixStore.listLeases()).length, 0);
  });

  it('registers, updates and removes callbacks', async () => {
    await assert.rejects(
      matrixStore.registerCallback({ url: 'ftp://nope' }),
      (error) => error.code === 'invalid_callback_url',
    );

    const first = await matrixStore.registerCallback({
      clientId: 'openchamber-cloudflare',
      url: 'http://127.0.0.1:19999/rotation',
      events: ['pre_rotation_freeze'],
    });
    assert.equal(first.id.startsWith('cb_'), true);
    assert.deepEqual(first.events, ['PRE_ROTATION_FREEZE']);

    const again = await matrixStore.registerCallback({
      clientId: 'openchamber-cloudflare',
      url: 'http://127.0.0.1:19999/rotation',
      events: ['POST_ROTATION_RESUME'],
    });
    assert.equal(again.id, first.id);
    assert.deepEqual(again.events, ['POST_ROTATION_RESUME']);

    const list = await matrixStore.listCallbacks();
    assert.equal(list.length, 1);
    const removed = await matrixStore.removeCallback(first.id);
    assert.equal(removed.removed, 1);
    assert.equal((await matrixStore.listCallbacks()).length, 0);
  });

  it('appends events and returns the newest window', async () => {
    fs.rmSync(matrixStore.EVENTS_FILE, { force: true });
    await matrixStore.appendEvent('PRE_ROTATION_FREEZE', { matrixSlotId: 'slot-001' });
    await matrixStore.appendEvent('POST_ROTATION_RESUME', { matrixSlotId: 'slot-001' });
    await matrixStore.appendEvent('ROTATION_FAILED', { matrixSlotId: 'slot-002' });
    const events = await matrixStore.listEvents(2);
    assert.deepEqual(events.map((item) => item.type), ['POST_ROTATION_RESUME', 'ROTATION_FAILED']);
    assert.equal(events[1].matrixSlotId, 'slot-002');
  });
});

describe('subnet-taint-ledger', () => {
  it('moves /64 and exit-IP ownership to the latest slot', async () => {
    fs.rmSync(matrixStore.LEDGER_FILE, { force: true });
    const first = await ledger.claim({
      prefix64: '2001:db8:100::/64',
      exitIp: '203.0.113.10',
      matrixSlotId: 'slot-010',
      leaseId: 'l1',
    });
    assert.equal(first.changed, true);
    assert.equal(first.entries.length, 2);

    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.prefixes['2001:db8:100:0::/64'].matrixSlotId, 'slot-010');

    await ledger.claim({ prefix64: '2001:db8:100::/64', matrixSlotId: 'slot-011', leaseId: 'l2' });
    await ledger.claim({ exitIp: '203.0.113.10', matrixSlotId: 'slot-011', leaseId: 'l2' });

    const moved = await ledger.snapshot();
    assert.equal(moved.prefixes['2001:db8:100:0::/64'].matrixSlotId, 'slot-011');
    assert.equal(moved.exitIps['203.0.113.10'].matrixSlotId, 'slot-011');
  });

  it('allows a previous owner to reclaim and never reports taint', async () => {
    const before = await ledger.snapshot();
    const again = await ledger.claim({
      prefix64: '2001:db8:100::/64',
      matrixSlotId: 'slot-010',
      leaseId: 'l3',
    });
    assert.equal(again.changed, true);
    const entry = again.entries.find((item) => item.prefix64);
    assert.equal(entry.firstSeenAt, before.prefixes['2001:db8:100:0::/64'].firstSeenAt);
    assert.equal(entry.leaseId, 'l3');

    const main = await ledger.snapshot();
    assert.equal(ledger.isTainted(main, { prefix64: '2001:db8:100::/64', matrixSlotId: 'slot-012' }), false);
    assert.equal(ledger.isTainted(main, { prefix64: '2001:db8:100::/64', matrixSlotId: 'slot-010' }), false);
  });

  it('rejects invalid claims and empty identities', async () => {
    await assert.rejects(ledger.claim({}), (error) => error.code === 'invalid_claim');
    await assert.rejects(
      ledger.claim({ matrixSlotId: 'slot-001', prefix64: 'definitely-not-ipv6' }),
      (error) => error.code === 'invalid_prefix64',
    );
    const empty = await ledger.claim({ matrixSlotId: 'slot-001' });
    assert.deepEqual(empty, { changed: false, prefix64: '', exitIp: '', entries: [] });
  });
});

describe('abuse-guard', () => {
  it('classifies hosts', () => {
    assert.equal(abuse.classifyHost('169.254.169.254').kind, 'metadata');
    assert.equal(abuse.classifyHost('metadata.google.internal').kind, 'metadata');
    assert.equal(abuse.classifyHost('127.0.0.1').kind, 'private');
    assert.equal(abuse.classifyHost('10.1.2.3').kind, 'private');
    assert.equal(abuse.classifyHost('172.20.0.1').kind, 'private');
    assert.equal(abuse.classifyHost('192.168.0.10').kind, 'private');
    assert.equal(abuse.classifyHost('100.64.0.1').kind, 'private');
    assert.equal(abuse.classifyHost('::1').kind, 'private');
    assert.equal(abuse.classifyHost('fd00::1').kind, 'private');
    assert.equal(abuse.classifyHost('::ffff:127.0.0.1').kind, 'private');
    assert.equal(abuse.classifyHost('1.1.1.1').kind, 'public');
    assert.equal(abuse.classifyHost('example.com').kind, 'public');
    assert.equal(abuse.classifyHost('').kind, 'invalid');
  });

  it('hard-blocks metadata, private networks and bad targets', () => {
    const guard = abuse.createAbuseGuard();
    const metadata = guard.evaluate('slot-001', { host: '169.254.169.254', port: 80 });
    assert.equal(metadata.allow, false);
    assert.equal(metadata.code, 'metadata_endpoint_blocked');
    assert.equal(metadata.quarantine, true);

    const loopback = guard.evaluate('slot-001', { host: '127.0.0.1', port: 443 });
    assert.equal(loopback.allow, false);
    assert.equal(loopback.code, 'private_network_blocked');

    const badPort = guard.evaluate('slot-001', { host: '1.1.1.1', port: 0 });
    assert.equal(badPort.allow, false);
    assert.equal(badPort.code, 'invalid_target');

    assert.equal(guard.evaluate('slot-001', { host: '1.1.1.1', port: 443 }).allow, true);
  });

  it('quarantines a slot after repeated high-risk port probes', () => {
    const guard = abuse.createAbuseGuard({ scanThreshold: 3, scanWindowMs: 60000, lockMs: 30000 });
    const target = { host: '203.0.113.50', port: 3389 };
    assert.equal(guard.evaluate('slot-002', target).allow, true);
    assert.equal(guard.evaluate('slot-002', target).allow, true);
    const third = guard.evaluate('slot-002', target);
    assert.equal(third.allow, false);
    assert.equal(third.code, 'abuse_scan_detected');
    assert.equal(third.quarantine, true);
    assert.equal(third.lockUntil > Date.now(), true);

    const locked = guard.evaluate('slot-002', { host: '1.1.1.1', port: 443 });
    assert.equal(locked.allow, false);
    assert.equal(locked.code, 'abuse_scan_locked');

    const snapshot = guard.snapshot();
    assert.equal(snapshot['slot-002'].lockUntil > Date.now(), true);

    guard.release('slot-002');
    assert.equal(guard.evaluate('slot-002', { host: '1.1.1.1', port: 443 }).allow, true);
  });
});

describe('warp-pool', () => {
  it('parses endpoint lists', () => {
    assert.deepEqual(
      endpointList('socks5://127.0.0.1:1\nsocks5://127.0.0.1:2, socks5://127.0.0.1:3'),
      ['socks5://127.0.0.1:1', 'socks5://127.0.0.1:2', 'socks5://127.0.0.1:3'],
    );
  });

  it('reports endpoint health and requires enablement', async () => {
    const disabled = createWarpPool({ getConfig: () => ({ enabled: false, endpoints: [] }) });
    assert.equal(disabled.available(), false);
    await assert.rejects(disabled.connect({ host: '1.1.1.1', port: 443 }), (error) => error.code === 'warp_unavailable');

    const pool = createWarpPool({
      getConfig: () => ({
        enabled: true,
        endpoints: ['socks5://127.0.0.1:1080', 'ftp://invalid.example:21'],
      }),
    });
    const status = pool.status();
    assert.equal(status.enabled, true);
    assert.equal(status.total, 2);
    assert.equal(status.healthy, 1);
    assert.equal(status.available, true);
    assert.equal(status.endpoints[0].host, '127.0.0.1');
    assert.equal(status.endpoints[0].port, 1080);
    assert.equal(status.endpoints[0].protocol, 'socks');
    assert.equal(status.endpoints[1].healthy, false);
    assert.equal(Boolean(status.endpoints[1].lastError), true);

    pool.markFailure('socks5://127.0.0.1:1080');
    const cooled = pool.status();
    assert.equal(cooled.endpoints[0].healthy, false);
    assert.equal(cooled.endpoints[0].cooldownUntil > Date.now(), true);
    assert.equal(cooled.available, false);
  });
});

describe('rotation-coordinator', () => {
  function stubEngine(slot, state) {
    const calls = [];
    let current = Object.assign({}, slot, { healthState: state || 'ACTIVE' });
    return {
      calls,
      getSlot: (id) => (id === current.matrixSlotId ? current : null),
      suspendSlot: async (id, healthState) => {
        calls.push(['suspend', healthState]);
        current = Object.assign({}, current, { healthState });
        return current;
      },
      failSlot: async (id, reason) => {
        calls.push(['fail', reason]);
        current = Object.assign({}, current, { healthState: 'COOLDOWN', lastError: reason });
        return current;
      },
      resumeSlot: async (id, patch) => {
        calls.push(['resume', patch]);
        current = Object.assign({}, current, patch, { healthState: 'ACTIVE' });
        return current;
      },
    };
  }

  it('freezes, claims and resumes in order', async () => {
    fs.rmSync(matrixStore.EVENTS_FILE, { force: true });
    fs.rmSync(matrixStore.CALLBACKS_FILE, { force: true });
    const slot = { matrixSlotId: 'slot-020', leaseId: 'lease-r1', egressFingerprint: contract.emptyFingerprint('lease-r1') };
    const engine = stubEngine(slot);
    const coordinator = rotation.createRotationCoordinator({ engine, log: () => {} });

    const updated = await coordinator.rotate('slot-020', async () => ({
      descriptor: { server: 'edge.example', port: 443 },
      egressFingerprint: {
        exitIp: '198.51.100.7',
        ipv6Prefix64: '2001:db8:200::/64',
        leaseId: 'lease-r1',
      },
    }), { reason: 'test' });

    assert.equal(updated.healthState, 'ACTIVE');
    assert.deepEqual(engine.calls.map((item) => item[0]), ['suspend', 'resume']);

    const events = (await matrixStore.listEvents(20)).filter((item) => item.matrixSlotId === 'slot-020');
    assert.deepEqual(events.map((item) => item.type), ['PRE_ROTATION_FREEZE', 'POST_ROTATION_RESUME']);

    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.prefixes['2001:db8:200:0::/64'].matrixSlotId, 'slot-020');
    assert.equal(snapshot.exitIps['198.51.100.7'].matrixSlotId, 'slot-020');
  });

  it('keeps the slot closed when the swap fails', async () => {
    fs.rmSync(matrixStore.EVENTS_FILE, { force: true });
    const slot = { matrixSlotId: 'slot-021', leaseId: 'lease-r2', egressFingerprint: contract.emptyFingerprint('lease-r2') };
    const engine = stubEngine(slot);
    const coordinator = rotation.createRotationCoordinator({ engine, log: () => {} });

    await assert.rejects(
      coordinator.rotate('slot-021', async () => { throw new Error('swap exploded'); }, { reason: 'test' }),
      /swap exploded/,
    );
    assert.deepEqual(engine.calls.map((item) => item[0]), ['suspend', 'fail']);
    const events = (await matrixStore.listEvents(20)).filter((item) => item.matrixSlotId === 'slot-021');
    assert.deepEqual(events.map((item) => item.type), ['PRE_ROTATION_FREEZE', 'ROTATION_FAILED']);
  });

  it('refuses a rotation without a verified exit identity', async () => {
    fs.rmSync(matrixStore.EVENTS_FILE, { force: true });
    const slot = { matrixSlotId: 'slot-023', leaseId: 'lease-r4', egressFingerprint: contract.emptyFingerprint('lease-r4') };
    const engine = stubEngine(slot);
    const coordinator = rotation.createRotationCoordinator({ engine, log: () => {} });

    await assert.rejects(
      coordinator.rotate('slot-023', async () => ({ descriptor: {}, egressFingerprint: { exitIp: '' } })),
      (error) => error.code === 'rotation_identity_invalid',
    );
    assert.deepEqual(engine.calls.map((item) => item[0]), ['suspend', 'fail']);
    const firstEvents = (await matrixStore.listEvents(20)).filter((item) => item.matrixSlotId === 'slot-023');
    assert.deepEqual(firstEvents.map((item) => item.type), ['PRE_ROTATION_FREEZE', 'ROTATION_FAILED']);

    await assert.rejects(
      coordinator.rotate('slot-023', async () => ({
        descriptor: {},
        egressFingerprint: { exitIp: '203.0.113.9', ipv6Prefix64: 'not-a-prefix' },
      })),
      (error) => error.code === 'rotation_identity_invalid',
    );
    assert.equal(engine.getSlot('slot-023').healthState, 'COOLDOWN');
  });

  it('refuses quarantined slots', async () => {
    const slot = { matrixSlotId: 'slot-022', leaseId: 'lease-r3', egressFingerprint: contract.emptyFingerprint('lease-r3') };
    const engine = stubEngine(slot, 'QUARANTINED');
    const coordinator = rotation.createRotationCoordinator({ engine, log: () => {} });
    await assert.rejects(
      coordinator.rotate('slot-022', async () => ({})),
      (error) => error.code === 'slot_quarantined',
    );
  });
});

describe('local-proxy routing plane', () => {
  it('reads X-OC-Routing-Plane from request heads', () => {
    const lines = [
      'CONNECT api.cloudflare.com:443 HTTP/1.1',
      'Host: api.cloudflare.com:443',
      'X-OC-Routing-Plane: strict_control',
    ];
    assert.equal(readRoutingPlane(lines), 'STRICT_CONTROL');
    assert.equal(readRoutingPlane(['GET / HTTP/1.1', 'X-OC-Routing-Plane: ELASTIC_DATA']), 'ELASTIC_DATA');
    assert.equal(readRoutingPlane(['GET / HTTP/1.1', 'X-OC-Routing-Plane: DIRECT']), '');
    assert.equal(readRoutingPlane(['GET / HTTP/1.1']), '');
  });

  it('passes the plane into upstreamFor for CONNECT', async () => {
    let seen = null;
    const proxy = await createMixedProxy({
      port: 0,
      log: () => {},
      upstreamFor: async (target, meta) => {
        seen = { target, meta };
        return fakeTunnel();
      },
    });
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
          socket.write('CONNECT api.cloudflare.com:443 HTTP/1.1\r\nHost: api.cloudflare.com:443\r\nX-OC-Routing-Plane: STRICT_CONTROL\r\n\r\n');
        });
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('latin1');
          if (buffer.includes('\r\n\r\n')) {
            socket.destroy();
            resolve();
          }
        });
        socket.on('error', reject);
        socket.on('close', resolve);
      });
    } finally {
      await proxy.close();
    }
    assert.equal(seen.meta.routingPlane, 'STRICT_CONTROL');
    assert.equal(seen.target.host, 'api.cloudflare.com');
    assert.equal(seen.target.port, 443);
  });
});

describe('lease batch planning', () => {
  const sub = { id: 'sub_1', name: 'Airport A', keyPrefix: 'airport' };
  const checked = (id, name, countryCode) => ({
    id,
    name,
    subscriptionId: sub.id,
    lastCheck: { ok: true, exitIp: '203.0.113.7', countryCode, latencyMs: 120 },
  });

  it('parses slot and port start values', () => {
    assert.equal(leaseBatch.parseStartPort(''), 0);
    assert.equal(leaseBatch.parseStartPort('slot-010'), 24010);
    assert.equal(leaseBatch.parseStartPort('SLOT 7'), 24007);
    assert.equal(leaseBatch.parseStartPort('24010'), 24010);
    assert.throws(() => leaseBatch.parseStartPort('slot-999'), (error) => error.code === 'invalid_start_slot');
    assert.throws(() => leaseBatch.parseStartPort('70000'), (error) => error.code === 'invalid_start_port');
  });

  it('keeps only probed nodes and skips already leased ones', () => {
    const state = {
      leases: [{ id: 'lease_1', key: 'airport/old', nodeId: 'n_old' }],
      nodes: [
        checked('n_old', 'old', 'US'),
        checked('n_ok', 'US-01', 'us'),
        { id: 'n_new', name: 'US-02', subscriptionId: sub.id, lastCheck: null },
        { id: 'n_fail', name: 'US-03', subscriptionId: sub.id, lastCheck: { ok: false, exitIp: '', error: 'timeout' } },
        { id: 'n_other', name: 'other', subscriptionId: 'sub_2', lastCheck: { ok: true, exitIp: '198.51.100.9' } },
      ],
    };
    const plan = leaseBatch.planLeases(state, sub, { onlyPassed: true });
    assert.equal(plan.specs.length, 1);
    assert.equal(plan.specs[0].nodeId, 'n_ok');
    assert.equal(plan.specs[0].country, 'US');
    assert.equal(plan.specs[0].key, 'airport/us-01');
    assert.equal(plan.skipped, 2);

    const loose = leaseBatch.planLeases(state, sub, {});
    assert.equal(loose.specs.length, 3);
    assert.equal(loose.skipped, 0);
  });

  it('gives duplicate names unique keys and honours a fixed country', () => {
    const state = {
      leases: [],
      nodes: [
        checked('a', 'Tokyo', 'JP'),
        checked('b', 'Tokyo', 'JP'),
        checked('c', 'Tokyo', 'JP'),
      ],
    };
    const plan = leaseBatch.planLeases(state, sub, { onlyPassed: true, country: 'th' });
    assert.deepEqual(plan.specs.map((spec) => spec.key), [
      'airport/tokyo',
      'airport/tokyo-2',
      'airport/tokyo-3',
    ]);
    assert.deepEqual(plan.specs.map((spec) => spec.country), ['TH', 'TH', 'TH']);
  });

  it('keeps nodes whose exit IP appeared behind another matrix slot', () => {
    const state = {
      leases: [],
      nodes: [
        checked('n_tainted', 'tainted', 'TH'),
        checked('n_clean', 'clean', 'TH'),
      ],
    };
    state.nodes[0].lastCheck.exitIp = '198.18.10.10';
    state.nodes[1].lastCheck.exitIp = '198.18.10.11';
    const snapshot = {
      prefixes: {},
      exitIps: { '198.18.10.10': { matrixSlotId: 'slot-099' } },
    };
    const plan = leaseBatch.planLeases(state, sub, {
      onlyPassed: true,
      ledgerSnapshot: snapshot,
      matrixSlotId: 'slot-050',
    });
    assert.equal(plan.specs.length, 2);
    assert.deepEqual(plan.specs.map((spec) => spec.nodeId), ['n_tainted', 'n_clean']);
    assert.equal(plan.tainted, 0);
  });
});

describe('ws hub freeze handshake', () => {
  it('delivers PRE_ROTATION_FREEZE over WS and waits for ACK_FREEZE', async () => {
    const hub = ws.createWsHub({ log: () => {} });
    const server = http.createServer((req, res) => {
      res.writeHead(404, { connection: 'close' });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    hub.attach(server);
    const port = server.address().port;
    const client = await ws.connect(`ws://127.0.0.1:${port}/api/v1/egress/ws?clientId=test-panel`);
    client.resume();

    const frames = [];
    client.on('message', ({ data }) => {
      let frame = null;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === 'PRE_ROTATION_FREEZE') {
        client.sendText(JSON.stringify({ type: 'ACK_FREEZE', eventId: frame.eventId, ok: true }));
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const slot = { matrixSlotId: 'slot-031', leaseId: 'lease-ws', egressFingerprint: contract.emptyFingerprint('lease-ws') };
    const engine = {
      getSlot: (id) => (id === slot.matrixSlotId ? Object.assign({}, slot, { healthState: 'ACTIVE' }) : null),
      suspendSlot: async () => ({ matrixSlotId: slot.matrixSlotId, healthState: 'ROTATING' }),
      failSlot: async () => ({}),
      resumeSlot: async (id, patch) => ({
        matrixSlotId: id,
        leaseId: 'lease-ws',
        egressFingerprint: patch.egressFingerprint,
        healthState: 'ACTIVE',
      }),
    };
    const coordinator = rotation.createRotationCoordinator({ engine, wsHub: hub, log: () => {} });

    const updated = await coordinator.rotate('slot-031', async () => ({
      descriptor: {},
      egressFingerprint: {
        exitIp: '198.18.20.31',
        ipv6Prefix64: '2001:db8:531::/64',
        leaseId: 'lease-ws',
      },
    }), { reason: 'ws-test' });

    assert.equal(updated.healthState, 'ACTIVE');
    assert.equal(frames.some((frame) => frame.type === 'PRE_ROTATION_FREEZE'), true);
    assert.equal(frames.some((frame) => frame.type === 'POST_ROTATION_RESUME'), true);

    const events = (await matrixStore.listEvents(50))
      .filter((item) => item.matrixSlotId === 'slot-031');
    const pre = events.find((item) => item.type === 'PRE_ROTATION_FREEZE');
    assert.equal(Boolean(pre), true);
    assert.equal(pre.delivery.some((entry) => entry.channel === 'ws' && entry.ok === true), true);
    assert.equal(hub.ack('ghost', 'evt_missing', true), false);
    assert.equal(hub.ack('test-panel', pre.eventId || 'evt_missing', true), false);

    client.close(1000, 'done');
    hub.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('store and ports shim', () => {
  it('round-trips state through the hot cache and mirrors contract leases', async () => {
    const state = store.load();
    state.settings.probeUrl = 'http://127.0.0.1:9/probe';
    state.leases.push({
      id: 'intent-slot-007',
      key: 'sub/slot-007',
      leaseId: 'lease-7',
      matrixSlotId: 'slot-007',
      routingPlane: 'ELASTIC_DATA',
      healthState: 'ACTIVE',
      egressFingerprint: {
        exitIp: '198.18.30.7',
        ipv6Prefix64: '2001:db8:607::/64',
        asn: 'AS607',
        leaseId: 'lease-7',
        updatedAt: '',
      },
    });
    store.save(state);
    await store.flush();

    assert.equal(store.load().settings.probeUrl, 'http://127.0.0.1:9/probe');
    const mirrored = await matrixStore.findLease('slot-007');
    assert.equal(Boolean(mirrored), true);
    assert.equal(mirrored.egressPort, 24007);
    assert.equal(mirrored.routingPlane, 'ELASTIC_DATA');
    assert.equal(mirrored.egressFingerprint.exitIp, '198.18.30.7');

    store.rememberSlot({ matrixSlotId: 'slot-007', healthState: 'ACTIVE', routingPlane: 'ELASTIC_DATA' });
    assert.equal(store.slotLease('slot-007').slot.healthState, 'ACTIVE');
    assert.equal(store.slotsSnapshot().length >= 1, true);
    store.forgetSlot('slot-007');
    assert.equal(store.slotLease('slot-007').slot, null);

    store.invalidate();
    assert.equal(store.load().settings.probeUrl, 'http://127.0.0.1:9/probe');
  });

  it('allocates and releases only deterministic matrix ports', () => {
    const state = { ports: {}, leases: [], settings: {} };
    assert.deepEqual(ports.pool(), { base: 24001, size: 250, end: 24251 });
    const first = ports.allocatePort(state, 'k1');
    assert.equal(first, 24001);
    assert.equal(ports.allocatePort(state, 'k1'), 24001);
    assert.equal(ports.releasePort(state, 'k1'), true);
    assert.equal(ports.releasePort(state, 'k1'), false);
  });
});
