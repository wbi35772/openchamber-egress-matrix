'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNodeUri } = require('../lib/node-uri');

const UUID = 'b94bf8c2-1111-2222-3333-444455556666';

test('vless over ws+tls keeps uuid, sni and path', () => {
  const d = parseNodeUri(`vless://${UUID}@edge.example:443?type=ws&path=%2Fproxy&host=edge.example&security=tls&sni=edge.example#jp`);
  assert.equal(d.protocol, 'vless');
  assert.equal(d.uuid, UUID);
  assert.equal(d.server, 'edge.example');
  assert.equal(d.port, 443);
  assert.equal(d.tls.enabled, true);
  assert.equal(d.tls.servername, 'edge.example');
  assert.equal(d.ws.path, '/proxy');
  assert.equal(d.ws.host, 'edge.example');
});

test('trojan without tls and custom ws path', () => {
  const d = parseNodeUri('trojan://secret@10.0.0.1:8080?type=ws&path=/ws');
  assert.equal(d.protocol, 'trojan');
  assert.equal(d.password, 'secret');
  assert.equal(d.tls.enabled, false);
  assert.equal(d.ws.path, '/ws');
  assert.equal(d.ws.host, '10.0.0.1');
});

test('socks5 with encoded credentials', () => {
  const d = parseNodeUri('socks5://user:p%40ss@127.0.0.1:1080');
  assert.equal(d.protocol, 'socks');
  assert.equal(d.type, 'tcp');
  assert.equal(d.username, 'user');
  assert.equal(d.password, 'p@ss');
  assert.equal(d.server, '127.0.0.1');
  assert.equal(d.port, 1080);
});

test('rejects reality, vmess and non-ws transports', () => {
  assert.throws(() => parseNodeUri(`vless://${UUID}@h:443?type=ws&security=reality`), /REALITY/);
  assert.throws(() => parseNodeUri('vmess://abc'), /暂不支持 vmess/);
  assert.throws(() => parseNodeUri(`vless://${UUID}@h:443?type=grpc`), /传输/);
  assert.throws(() => parseNodeUri(`vless://not-a-uuid@h:443?type=ws`), /UUID/);
});
