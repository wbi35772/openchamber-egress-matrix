'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeSubscription,
  parseSubscriptionText,
  importNodes,
  fetchSubscription,
  syncSubscription,
} = require('../lib/subscriptions');

const UUID = '11111111-1111-4111-8111-111111111111';
const VLESS = `vless://${UUID}@edge.example:443?type=ws&path=%2Fproxy&security=tls#jp-node`;
const TROJAN = 'trojan://secret@10.0.0.1:8443?type=ws&path=/ws#th-node';

function emptyState() {
  return { nodes: [], subscriptions: [] };
}

test('decodeSubscription accepts plain and base64 bodies', () => {
  assert.equal(decodeSubscription('vless://a@b:1?type=ws'), 'vless://a@b:1?type=ws');
  const encoded = Buffer.from(`${VLESS}\n${TROJAN}`).toString('base64');
  const decoded = decodeSubscription(encoded);
  assert.match(decoded, /vless:\/\//);
  assert.match(decoded, /trojan:\/\//);
});

test('parseSubscriptionText skips comments, duplicates and bad lines', () => {
  const body = [
    '# comment',
    VLESS,
    VLESS,
    'vmess://not-supported',
    '',
    TROJAN,
  ].join('\n');
  const parsed = parseSubscriptionText(body);
  assert.deepEqual(parsed.uris, [VLESS, TROJAN]);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].error, /VMESS|不支持|协议/i);
});

test('importNodes names by fragment and keeps subscription link', () => {
  const state = emptyState();
  const subscription = { id: 'sub-1', name: 'pool', keyPrefix: '', autoLease: false };
  const result = importNodes(state, subscription, [VLESS, TROJAN]);
  assert.deepEqual(result, { added: 2, updated: 0, total: 2 });
  assert.equal(state.nodes.length, 2);
  assert.equal(state.nodes[0].name, 'jp-node');
  assert.equal(state.nodes[1].name, 'th-node');
  assert.equal(state.nodes[0].subscriptionId, 'sub-1');
  assert.equal(subscription.nodeCount, 2);
});

test('importNodes updates existing nodes instead of duplicating', () => {
  const state = emptyState();
  const first = { id: 'sub-1', name: 'pool' };
  importNodes(state, first, [VLESS]);
  const second = { id: 'sub-2', name: 'pool-2' };
  const result = importNodes(state, second, [VLESS, TROJAN]);
  assert.deepEqual(result, { added: 1, updated: 1, total: 2 });
  assert.equal(state.nodes.length, 2);
  assert.equal(state.nodes[0].subscriptionId, 'sub-2');
});

test('fetchSubscription rejects HTML pages', async () => {
  await assert.rejects(
    () => fetchSubscription('data:text/html,%3Chtml%3Elogin%3C/html%3E'),
    /HTML/
  );
});

test('syncSubscription reads an encoded list end to end', async () => {
  const body = Buffer.from([VLESS, TROJAN].join('\n')).toString('base64');
  const original = global.fetch;
  global.fetch = async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  try {
    const state = emptyState();
    const subscription = { id: 'sub-9', name: 'remote', lastSyncAt: '', lastError: 'old' };
    const result = await syncSubscription(state, subscription);
    assert.equal(result.added, 2);
    assert.equal(state.nodes.length, 2);
    assert.equal(subscription.lastError, '');
    assert.ok(subscription.lastSyncAt);
  } finally {
    global.fetch = original;
  }
});
