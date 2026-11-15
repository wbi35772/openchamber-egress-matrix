'use strict';

/*
 * Upstream tunnel: proxy node -> WebSocket -> protocol handshake -> byte pipe.
 *
 * The returned tunnel is deliberately small so the local proxy and tests do not
 * need to know which protocol produced it:
 *   { write(buf), onData(fn), onClose(fn), close(), pause(), resume() }
 */

const net = require('node:net');
const ws = require('./ws');

const HIGH_WATER = 1024 * 1024;

function encodePort(port) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(port, 0);
  return buffer;
}

function addressKind(host) {
  if (net.isIPv4(host)) return 'ipv4';
  if (net.isIPv6(host)) return 'ipv6';
  return 'domain';
}

function encodeTarget(host, port, atyp) {
  const kind = addressKind(host);
  let header;
  let address;
  if (kind === 'ipv4') {
    header = Buffer.from([atyp.ipv4]);
    address = Buffer.from(host.split('.').map((part) => Number(part) & 0xff));
  } else if (kind === 'ipv6') {
    header = Buffer.from([atyp.ipv6]);
    address = ipv6ToBuffer(host);
  } else {
    header = Buffer.from([atyp.domain]);
    address = Buffer.from(host, 'utf8');
    const length = Buffer.alloc(1);
    length.writeUInt8(address.length, 0);
    header = Buffer.concat([header, length]);
  }
  return { header, address, port: encodePort(port) };
}

function ipv6ToBuffer(host) {
  const buffer = Buffer.alloc(16);
  const [head, tail] = host.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const groups = tail !== undefined
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  groups.forEach((group, index) => buffer.writeUInt16BE(parseInt(group, 16) || 0, index * 2));
  return buffer;
}

function encodeVlessRequest(descriptor, target) {
  const uuid = Buffer.from(descriptor.uuid.replace(/-/g, ''), 'hex');
  if (uuid.length !== 16) throw new Error('VLESS UUID 无效');
  const { header, address, port } = encodeTarget(target.host, target.port, { ipv4: 1, domain: 2, ipv6: 3 });
  return Buffer.concat([
    Buffer.from([0x00]),
    uuid,
    Buffer.from([0x00, 0x01]),
    port,
    header,
    address,
  ]);
}

function encodeTrojanRequest(descriptor, target) {
  const crypto = require('node:crypto');
  const password = crypto.createHash('sha224').update(String(descriptor.password), 'utf8').digest('hex');
  const { header, address, port } = encodeTarget(target.host, target.port, { ipv4: 1, domain: 3, ipv6: 4 });
  return Buffer.concat([
    Buffer.from(`${password}\r\n\x01`, 'latin1'),
    header,
    address,
    port,
    Buffer.from('\r\n', 'latin1'),
  ]);
}

function createVlessResponseDecoder() {
  let state = 'version';
  let buffer = Buffer.alloc(0);
  let addonLength = 0;
  return function decode(chunk) {
    if (state === 'done') return chunk;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    if (state === 'version') {
      if (buffer.length < 2) return Buffer.alloc(0);
      addonLength = buffer[1];
      state = 'addons';
    }
    if (state === 'addons') {
      const header = 2 + addonLength;
      if (buffer.length < header) return Buffer.alloc(0);
      const rest = buffer.subarray(header);
      buffer = Buffer.alloc(0);
      state = 'done';
      return Buffer.from(rest);
    }
    return chunk;
  };
}

function createTunnel(socket, options = {}) {
  const dataHandlers = new Set();
  const closeHandlers = new Set();
  const decoder = options.decode || ((chunk) => chunk);
  let closed = false;

  function emitData(chunk) {
    if (!chunk || !chunk.length) return;
    const decoded = decoder(chunk);
    if (!decoded || !decoded.length) return;
    for (const handler of dataHandlers) handler(decoded);
  }

  function finish(reason) {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try { handler(reason); } catch { /* ignore */ }
    }
  }

  socket.on('message', (message) => emitData(message.data));
  socket.on('close', (info) => finish(info));
  socket.on('error', (error) => finish(error));

  return {
    get closed() {
      return closed;
    },
    write(buffer) {
      if (closed) return false;
      socket.send(buffer);
      const pending = socket.socket ? socket.socket.writableLength : 0;
      return pending < HIGH_WATER;
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onDrain(handler) {
      if (!socket.socket || typeof socket.socket.on !== 'function') return () => {};
      socket.socket.on('drain', handler);
      return () => socket.socket.removeListener('drain', handler);
    },
    close() {
      if (closed) return;
      try { socket.close(1000, 'done'); } catch { /* ignore */ }
      finish('local-close');
    },
    pause() {
      if (socket.socket && typeof socket.socket.pause === 'function') socket.socket.pause();
    },
    resume() {
      if (socket.socket && typeof socket.socket.resume === 'function') socket.socket.resume();
    },
  };
}

function createSocketReader(socket) {
  let buffer = Buffer.alloc(0);
  let notify = null;
  let failure = null;

  const wake = () => {
    if (!notify) return;
    const resolve = notify;
    notify = null;
    resolve();
  };
  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    wake();
  };
  const onClose = () => {
    failure = failure || new Error('上游连接已关闭');
    wake();
  };
  const onError = (error) => {
    failure = failure || error;
    wake();
  };

  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', onError);

  return {
    async read(pick) {
      for (;;) {
        const result = pick(buffer);
        if (result) {
          buffer = buffer.subarray(result.length);
          return result.value;
        }
        if (failure) throw failure;
        await new Promise((resolve) => { notify = resolve; });
      }
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      const rest = buffer;
      buffer = Buffer.alloc(0);
      return rest;
    },
  };
}

function createSocketTunnel(socket, initial) {
  const dataHandlers = new Set();
  const closeHandlers = new Set();
  let closed = false;

  const emit = (chunk) => {
    if (!chunk || !chunk.length) return;
    for (const handler of dataHandlers) handler(chunk);
  };

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(reason);
  };

  socket.on('data', emit);
  socket.on('close', () => finish('closed'));
  socket.on('error', (error) => finish(error));

  if (initial && initial.length) {
    // Deliver bytes that were already read during the handshake.
    setImmediate(() => emit(initial));
  }

  return {
    get closed() {
      return closed;
    },
    write(chunk) {
      if (closed) return false;
      return socket.write(chunk) || false;
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onDrain(handler) {
      socket.on('drain', handler);
      return () => socket.removeListener('drain', handler);
    },
    close() {
      if (closed) return;
      try { socket.destroy(); } catch { /* ignore */ }
      finish('local-close');
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
  };
}

async function connectSocks5(descriptor, target, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 15000 : options.timeoutMs;
  const socket = net.connect({ host: descriptor.server, port: descriptor.port });
  socket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SOCKS5 连接超时'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const reader = createSocketReader(socket);
  const hasAuth = Boolean(descriptor.username || descriptor.password);

  socket.write(Buffer.from([0x05, 0x01, hasAuth ? 0x02 : 0x00]));
  const method = await reader.read((buffer) => (buffer.length >= 2 ? { length: 2, value: buffer[1] } : null));
  if (method === 0xff) throw new Error('SOCKS5 服务器不接受认证方式');
  if (method === 0x02) {
    const user = Buffer.from(descriptor.username || '', 'utf8');
    const pass = Buffer.from(descriptor.password || '', 'utf8');
    socket.write(Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ]));
    const status = await reader.read((buffer) => (buffer.length >= 2 ? { length: 2, value: buffer[1] } : null));
    if (status !== 0x00) throw new Error('SOCKS5 用户名或密码被拒绝');
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 不支持的认证方式 ${method}`);
  }

  const encoded = encodeTarget(target.host, target.port, { ipv4: 1, domain: 3, ipv6: 4 });
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00]),
    encoded.header,
    encoded.address,
    encoded.port,
  ]));

  const reply = await reader.read((buffer) => {
    if (buffer.length < 4) return null;
    const atyp = buffer[3];
    let need = 0;
    if (atyp === 0x01) need = 4 + 4 + 2;
    else if (atyp === 0x04) need = 4 + 16 + 2;
    else if (atyp === 0x03) {
      if (buffer.length < 5) return null;
      need = 4 + 1 + buffer[4] + 2;
    } else {
      throw new Error('SOCKS5 响应地址类型无效');
    }
    if (buffer.length < need) return null;
    return { length: need, value: Buffer.from(buffer.subarray(0, need)) };
  });

  if (reply[1] !== 0x00) throw new Error(`SOCKS5 连接被拒绝，代码 ${reply[1]}`);

  const rest = reader.detach();
  socket.removeAllListeners('error');
  return createSocketTunnel(socket, rest);
}

async function connectUpstream(descriptor, target, options = {}) {
  if (!descriptor) throw new Error('缺少上游节点');
  if (!target || !target.host || !target.port) throw new Error('缺少目标地址');
  if (descriptor.protocol === 'socks') return connectSocks5(descriptor, target, options);

  const secure = Boolean(descriptor.tls && descriptor.tls.enabled);
  const scheme = secure ? 'wss' : 'ws';
  const url = `${scheme}://${formatHost(descriptor.server)}:${descriptor.port}${descriptor.ws.path}`;
  const headers = { Host: descriptor.ws.host || descriptor.server };

  const socket = await ws.connect(url, {
    headers,
    servername: secure ? (descriptor.tls.servername || descriptor.server) : undefined,
    rejectUnauthorized: !(descriptor.tls && descriptor.tls.insecure),
    timeoutMs: options.timeoutMs === undefined ? 15000 : options.timeoutMs,
    maxPayload: options.maxPayload || 16 * 1024 * 1024,
  });
  socket.resume();

  const request = descriptor.protocol === 'vless'
    ? encodeVlessRequest(descriptor, target)
    : encodeTrojanRequest(descriptor, target);

  socket.send(request, { binary: true });

  return createTunnel(socket, {
    decode: descriptor.protocol === 'vless' ? createVlessResponseDecoder() : undefined,
  });
}

function formatHost(host) {
  return net.isIPv6(host) ? `[${host}]` : host;
}

module.exports = {
  connectUpstream,
  connectSocks5,
  createTunnel,
  createSocketTunnel,
  encodeVlessRequest,
  encodeTrojanRequest,
  createVlessResponseDecoder,
  encodeTarget,
};
