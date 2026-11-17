'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const DEFAULT_WS_PATH = '/api/v1/egress/ws';

function encodeFrame(opcode, payload, options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload === undefined ? '' : String(payload), 'utf8');
  const fin = options.fin !== false;
  const mask = options.mask !== false;
  const head = [];
  head.push((fin ? 0x80 : 0) | (opcode & 0x0f));
  const maskBit = mask ? 0x80 : 0;
  if (data.length < 126) {
    head.push(maskBit | data.length);
  } else if (data.length < 65536) {
    head.push(maskBit | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    head.push(maskBit | 127, ...length);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      const frame = this.next();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  next() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      const big = this.buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(big);
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (this.buffer.length < offset + length) return null;
    let payload = this.buffer.subarray(offset, offset + length);
    if (masked) {
      const key = this.buffer.subarray(maskOffset, maskOffset + 4);
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ key[i % 4];
      payload = copy;
    } else {
      payload = Buffer.from(payload);
    }
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

class WsConn extends EventEmitter {
  constructor(socket, head, options = {}) {
    super();
    this.socket = socket;
    this.head = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parser = new FrameParser();
    this.maxPayload = options.maxPayload || 16 * 1024 * 1024;
    this.maskOutgoing = options.maskOutgoing !== false;
    this.started = false;
    this.closed = false;
    this.closeSent = false;
    this.lastActivity = Date.now();
    this.fragmentOpcode = 0;
    this.fragmentChunks = [];
    this.fragmentSize = 0;
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', (error) => this._fail(error));
  }

  get isOpen() {
    return !this.closed && this.socket && !this.socket.destroyed;
  }

  resume() {
    if (this.started || this.closed) return this;
    this.started = true;
    this.socket.on('data', (chunk) => this._feed(chunk));
    if (this.head.length) this._feed(this.head);
    this.head = Buffer.alloc(0);
    return this;
  }

  send(data, options = {}) {
    if (!this.isOpen) throw new Error('WebSocket is closed');
    const binary = options.binary !== false;
    const opcode = binary ? OP_BINARY : OP_TEXT;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.socket.write(encodeFrame(opcode, payload, { mask: this.maskOutgoing }));
  }

  sendText(text) {
    this.send(text, { binary: false });
  }

  ping(payload) {
    if (!this.isOpen) return;
    this.socket.write(encodeFrame(OP_PING, payload || Buffer.alloc(0), { mask: this.maskOutgoing }));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (this.isOpen) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      try { this.socket.write(encodeFrame(OP_CLOSE, body, { mask: this.maskOutgoing })); } catch { /* ignore */ }
      this.closeSent = true;
    }
    this._finish(code, reason);
    try { this.socket.end(); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 1000);
    if (timer.unref) timer.unref();
  }

  _feed(chunk) {
    if (this.closed) return;
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this._fail(error);
      return;
    }
    for (const frame of frames) this._handleFrame(frame);
  }

  _handleFrame(frame) {
    this.lastActivity = Date.now();
    if (frame.payload.length > this.maxPayload) {
      this._fail(new Error('WebSocket frame exceeds the payload limit'));
      return;
    }
    if (frame.opcode === OP_CLOSE) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
      if (!this.closeSent && this.isOpen) {
        try { this.socket.write(encodeFrame(OP_CLOSE, frame.payload, { mask: this.maskOutgoing })); } catch { /* ignore */ }
        this.closeSent = true;
      }
      this._finish(code, reason);
      try { this.socket.end(); } catch { /* ignore */ }
      return;
    }
    if (frame.opcode === OP_PING) {
      if (this.isOpen) {
        try { this.socket.write(encodeFrame(OP_PONG, frame.payload, { mask: this.maskOutgoing })); } catch { /* ignore */ }
      }
      this.emit('ping', frame.payload);
      return;
    }
    if (frame.opcode === OP_PONG) {
      this.emit('pong', frame.payload);
      return;
    }
    if (frame.opcode === OP_TEXT || frame.opcode === OP_BINARY) {
      if (this.fragmentOpcode) {
        this._fail(new Error('Unexpected new data frame during fragmentation'));
        return;
      }
      if (frame.fin) {
        this.emit('message', { data: frame.payload, binary: frame.opcode === OP_BINARY });
        return;
      }
      this.fragmentOpcode = frame.opcode;
      this.fragmentChunks = [frame.payload];
      this.fragmentSize = frame.payload.length;
      return;
    }
    if (frame.opcode === OP_CONT) {
      if (!this.fragmentOpcode) {
        this._fail(new Error('Unexpected continuation frame'));
        return;
      }
      this.fragmentChunks.push(frame.payload);
      this.fragmentSize += frame.payload.length;
      if (this.fragmentSize > this.maxPayload) {
        this._fail(new Error('WebSocket message exceeds the payload limit'));
        return;
      }
      if (frame.fin) {
        const data = Buffer.concat(this.fragmentChunks);
        const binary = this.fragmentOpcode === OP_BINARY;
        this.fragmentOpcode = 0;
        this.fragmentChunks = [];
        this.fragmentSize = 0;
        this.emit('message', { data, binary });
      }
      return;
    }
    this._fail(new Error(`Unsupported WebSocket opcode: ${frame.opcode}`));
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
  }

  _fail(error) {
    if (this.closed) return;
    if (this.listenerCount('error')) this.emit('error', error);
    this._finish(1006, error.message || 'WebSocket error');
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

function connect(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    const transport = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const headers = Object.assign({}, options.headers || {}, {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    });
    if (options.subprotocols && !headers['Sec-WebSocket-Protocol']) {
      headers['Sec-WebSocket-Protocol'] = options.subprotocols;
    }
    const timeoutMs = options.timeoutMs === undefined ? 15000 : options.timeoutMs;
    let settled = false;
    const request = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: 'GET',
      headers,
      servername: secure ? (options.servername || url.hostname) : undefined,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      ...(options.agent ? { agent: options.agent } : {}),
    });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`));
    }, timeoutMs) : null;

    request.on('upgrade', (response, socket, head) => {
      const head2 = head;
      if (settled) { try { socket.destroy(); } catch { /* ignore */ } return; }
      if (response.statusCode !== 101) {
        settled = true;
        if (timer) clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
        return;
      }
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const accept = response.headers['sec-websocket-accept'];
      if (options.verifyAccept !== false && accept !== expected) {
        settled = true;
        if (timer) clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new WsConn(socket, head2, { maxPayload: options.maxPayload }));
    });

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (size < 65536) chunks.push(chunk);
        size += chunk.length;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        const error = new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}${body ? `: ${body.slice(0, 400)}` : ''}`);
        error.status = response.statusCode;
        error.body = body;
        reject(error);
      });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    request.end();
  });
}

function eventId() {
  return `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function parseClientMessage(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

/*
 * Loopback WebSocket hub. The panel and sibling extensions connect to
 * /api/v1/egress/ws; the service broadcasts contract events, and rotation
 * freezes wait for an explicit ACK_FREEZE inside a hard time budget.
 */
function createWsHub(options = {}) {
  const path = options.path || DEFAULT_WS_PATH;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const clients = new Map();
  const ackWaiters = new Map();
  let sequence = 0;

  function clientList(filter) {
    const list = [...clients.values()];
    if (!filter) return list;
    return list.filter(filter);
  }

  function handleMessage(client, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ACK_FREEZE' || message.type === 'ACK') {
      ack(client.clientId, String(message.eventId || ''), message.ok !== false);
      return;
    }
    if (message.type === 'PING') {
      try { client.conn.sendText(JSON.stringify({ type: 'PONG', at: Date.now() })); } catch { /* ignore */ }
      return;
    }
    client.lastSeenAt = Date.now();
    client.conn.emit('client-message', message);
  }

  function attach(server) {
    if (!server || typeof server.on !== 'function') throw new Error('createWsHub.attach 需要 http.Server');
    if (server.__ocWsHubAttached) return server.__ocWsHubAttached;
    const onUpgrade = (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      if (url.pathname !== path) {
        try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      const key = String(req.headers['sec-websocket-key'] || '');
      if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
        try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
      ];
      if (req.headers['sec-websocket-protocol']) {
        headers.push(`Sec-WebSocket-Protocol: ${String(req.headers['sec-websocket-protocol']).split(',')[0].trim()}`);
      }
      try {
        socket.write(`${headers.join('\r\n')}\r\n\r\n`);
      } catch {
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      socket.setNoDelay(true);
      const conn = new WsConn(socket, head, { maskOutgoing: false, maxPayload: options.maxPayload });
      const requested = String(url.searchParams.get('clientId') || req.headers['x-oc-client'] || '').trim();
      const clientId = (requested || `client-${++sequence}`).slice(0, 80);
      const client = {
        clientId,
        conn,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        remote: socket.remoteAddress || '',
      };
      clients.set(clientId, client);
      conn.resume();
      conn.on('message', ({ data }) => handleMessage(client, parseClientMessage(data)));
      conn.on('close', () => {
        clients.delete(clientId);
        for (const waiter of ackWaiters.values()) {
          const entry = waiter.waiting.get(clientId);
          if (entry) {
            waiter.waiting.delete(clientId);
            waiter.results.set(clientId, {
              clientId, ok: false, status: 0, latencyMs: Date.now() - entry.sentAt, error: 'client disconnected',
            });
            waiter.check();
          }
        }
        log(`WS 客户端离线 ${clientId}`);
      });
      conn.on('error', (error) => log(`WS 客户端错误 ${clientId}: ${error.message}`));
      log(`WS 客户端上线 ${clientId}`);
    };
    server.on('upgrade', onUpgrade);
    server.__ocWsHubAttached = onUpgrade;
    return onUpgrade;
  }

  function detach(server) {
    const handler = server && server.__ocWsHubAttached;
    if (!handler) return;
    server.removeListener('upgrade', handler);
    delete server.__ocWsHubAttached;
  }

  function envelope(event, payload) {
    const base = {
      type: String(event || 'EVENT'),
      eventId: eventId(),
      at: Date.now(),
    };
    if (payload && typeof payload === 'object') Object.assign(base, payload);
    return base;
  }

  function ack(waitingClientId, id, ok) {
    const waiter = ackWaiters.get(id);
    if (!waiter) return false;
    const entry = waiter.waiting.get(waitingClientId);
    if (!entry) return false;
    waiter.waiting.delete(waitingClientId);
    waiter.results.set(waitingClientId, {
      clientId: waitingClientId,
      ok: Boolean(ok),
      status: ok ? 200 : 503,
      latencyMs: Date.now() - entry.sentAt,
    });
    waiter.check();
    return true;
  }

  function broadcastAwait(event, payload, waitOptions = {}) {
    const message = envelope(event, payload);
    const timeoutMs = Number(waitOptions.timeoutMs) || 0;
    const targets = clientList(waitOptions.filter);
    if (!targets.length) return Promise.resolve({ eventId: message.eventId, clients: 0, results: [] });
    return new Promise((resolve) => {
      let finished = false;
      const waiter = {
        eventId: message.eventId,
        results: new Map(),
        waiting: new Map(),
        timer: null,
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        ackWaiters.delete(message.eventId);
        resolve({
          eventId: message.eventId,
          clients: targets.length,
          results: [...waiter.results.values()],
        });
      };
      waiter.check = () => {
        if (waiter.waiting.size === 0) finish();
      };
      ackWaiters.set(message.eventId, waiter);
      if (timeoutMs > 0) waiter.timer = setTimeout(finish, timeoutMs);
      if (waiter.timer && waiter.timer.unref) waiter.timer.unref();
      for (const client of targets) {
        waiter.results.set(client.clientId, {
          clientId: client.clientId, ok: false, status: 0, latencyMs: 0, error: 'pending',
        });
        waiter.waiting.set(client.clientId, { sentAt: Date.now() });
        try {
          client.conn.sendText(JSON.stringify(message));
        } catch (error) {
          waiter.waiting.delete(client.clientId);
          waiter.results.set(client.clientId, {
            clientId: client.clientId, ok: false, status: 0, latencyMs: 0, error: error.message,
          });
        }
      }
      if (waiter.waiting.size === 0) finish();
    });
  }

  function broadcast(event, payload, broadcastOptions = {}) {
    const message = envelope(event, payload);
    const targets = clientList(broadcastOptions.filter);
    let delivered = 0;
    for (const client of targets) {
      try {
        client.conn.sendText(JSON.stringify(message));
        delivered += 1;
      } catch { /* client vanished */ }
    }
    if (broadcastOptions.timeoutMs > 0) {
      return broadcastAwait(event, payload, broadcastOptions);
    }
    return { eventId: message.eventId, clients: targets.length, delivered };
  }

  function status() {
    return {
      path,
      clients: [...clients.values()].map((client) => ({
        clientId: client.clientId,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
      })),
      pendingAcks: ackWaiters.size,
    };
  }

  function close() {
    for (const waiter of [...ackWaiters.values()]) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    ackWaiters.clear();
    for (const client of [...clients.values()]) {
      try { client.conn.close(1001, 'service stopping'); } catch { /* ignore */ }
    }
    clients.clear();
  }

  return {
    path,
    attach,
    detach,
    broadcast,
    broadcastAwait,
    ack,
    status,
    close,
    get clientCount() { return clients.size; },
  };
}

module.exports = {
  connect,
  encodeFrame,
  FrameParser,
  WsConn,
  createWsHub,
  DEFAULT_WS_PATH,
  OP_CONT,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
};
