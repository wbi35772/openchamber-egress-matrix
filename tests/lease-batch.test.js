'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseStartPort, planLeases, leaseKeyFor } = require('../lib/lease-batch');

function node(id, name, extra) {
  return Object.assign({
    id,
    name,
    subscriptionId: 'sub_A',
    uri: 'trojan://secret@example.com:443#x',
  }, extra);
}

function passed(countryCode, exitIp) {
  return {
    ok: true,
    exitIp: exitIp || '203.0.113.7',
    country: 'Netherlands',
    countryCode,
    asn: 'AS13335',
    latencyMs: 400,
    checkedAt: '2026-11-16T00:00:00.000Z',
  };
}

test('parseStartPort accepts slot ids, numbers and empty values', () => {
  assert.equal(parseStartPort(undefined), 0);
  assert.equal(parseStartPort(''), 0);
  assert.equal(parseStartPort('slot-010'), 24010);
  assert.equal(parseStartPort('slot_250'), 24250);
  assert.equal(parseStartPort(24111), 24111);
  assert.equal(parseStartPort('24001'), 24001);
});

test('parseStartPort rejects out-of-range slot ids and ports', () => {
  assert.throws(() => parseStartPort('slot-251'), (error) => error.code === 'invalid_start_slot');
  assert.throws(() => parseStartPort('slot-000'), (error) => error.code === 'invalid_start_slot');
  assert.throws(() => parseStartPort('70000'), (error) => error.code === 'invalid_start_port');
  assert.throws(() => parseStartPort('abc'), (error) => error.code === 'invalid_start_port');
});

test('planLeases onlyPassed keeps probed nodes and counts skipped ones', () => {
  const state = {
    nodes: [
      node('n1', 'NL 01', { lastCheck: passed('NL', '104.28.1.1') }),
      node('n2', 'US 01', { lastCheck: { ok: false, error: 'timeout' } }),
      node('n3', 'HK 01', { lastCheck: { ok: true, exitIp: '' } }),
      node('n4', 'JP 01'),
      node('n5', 'SG 01', { lastCheck: passed('SG', '203.0.113.8') }),
      node('x1', 'other sub', { subscriptionId: 'sub_B', lastCheck: passed('DE', '203.0.113.9') }),
    ],
    leases: [{ key: 'sub/sub-a/sg-01', nodeId: 'n5' }],
  };
  const plan = planLeases(state, { id: 'sub_A', name: 'Sub A' }, { onlyPassed: true });
  assert.equal(plan.specs.length, 1);
  assert.equal(plan.skipped, 3);
  assert.deepEqual(plan.specs[0], {
    nodeId: 'n1',
    key: 'sub/sub-a/nl-01',
    country: 'NL',
    exitIp: '104.28.1.1',
    checkedAt: '2026-11-16T00:00:00.000Z',
  });
});

test('planLeases without onlyPassed leases every unleased node and honors country override', () => {
  const state = {
    nodes: [
      node('n1', 'NL 01', { lastCheck: passed('NL') }),
      node('n2', 'US 01'),
    ],
    leases: [],
  };
  const plan = planLeases(state, { id: 'sub_A', name: 'Sub A' }, { country: 'jp', onlyPassed: false });
  assert.equal(plan.specs.length, 2);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.specs.map((spec) => spec.country), ['JP', 'JP']);
  assert.deepEqual(plan.specs.map((spec) => spec.exitIp), ['203.0.113.7', '']);
});

test('leaseKeyFor dedupes repeated names inside one batch and against existing leases', () => {
  const taken = new Set(['sub/sub-a/hk-01']);
  const first = leaseKeyFor({ leases: [] }, 'sub/sub-a', { name: 'HK 01' }, taken);
  const second = leaseKeyFor({ leases: [] }, 'sub/sub-a', { name: 'HK 01' }, taken);
  assert.equal(first, 'sub/sub-a/hk-01-2');
  assert.equal(second, 'sub/sub-a/hk-01-3');
  assert.equal(leaseKeyFor({ leases: [] }, 'sub/sub-a', { name: 'TW 02' }, taken), 'sub/sub-a/tw-02');
});
