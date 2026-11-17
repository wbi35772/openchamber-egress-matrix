'use strict';

/*
 * Mixed local proxy: SOCKS5 + HTTP CONNECT on one loopback port.
 *
 * Every connection runs the same three steps before any byte reaches an
 * upstream:
 *   A. optional abuse guard (loopback / RFC1918 / metadata / scan lockout)
 *   B. routing-plane detection (X-OC-Routing-Plane, Proxy-Authorization,
 *      control-plane domain/SNI)
 *   C. fail-closed transport: STRICT_CONTROL errors surface as
 *      503 EGRESS_STRICT_CONTROL_BLOCKED and never fall back to WARP.
 *
 * The upstream is decided by the injected `upstreamFor(target, meta)` function,
 * which returns a tunnel object:
 *   { write(buf), onData(fn), onClose(fn), onDrain(fn), close(), pause(), resume() }
 */

const net = require('node:net');

const contract = require('../core/contract');

const MAX_HEAD = 64 * 1024;

function reasonFor(status) {
  return status === 503 ? 'Service Unavailable'
    : status === 403 ? 'Forbidden'
      : status === 429 ? 'Too Many Requests'
        : status === 400 ? 'Bad Request'
          : 'Bad Gateway';
}

function errorCode(error, fallback) {
  const code = String((error && error.code) || fallback || 'upstream_failed');
  if (code === 'strict_control_failclosed') return 'EGRESS_STRICT_CONTROL_BLOCKED';
  if (code === 'egress_blocked' || code === 'abuse_blocked') return 'EGRESS_ABUSE_BLOCKED';
  return code.toUpperCase();
}

function statusFor(error) {
  if (Number.isInteger(error && error.status)) return error.status;
  if (!error || !error.code) return 502;
  if (error.code === 'strict_control_failclosed') return 503;
  if (error.code === 'slot_quarantined' || error.code === 'slot_rotating' || error.code === 'slot_cooling'
    || error.code === 'private_network_blocked' || error.code === 'metadata_endpoint_blocked'
    || error.code === 'abuse_scan_locked' || error.code === 'invalid_target') return 403;
  return 502;
}

function createMixedProxy(options = {}) {
  const host = options.host || '127.0.0.1';
  const upstreamFor = options.upstreamFor;
  const guard = typeof options.guard === 'function' ? options.guard : null;
  const controlDomains = Array.isArray(options.controlDomains) && options.controlDomains.length
    ? options.controlDomains
    : contract.DEFAULT_CONTROL_DOMAINS;
  const log = options.log || (() => {});
  const handshakeTimeoutMs = options.handshakeTimeoutMs || 20000;
  if (typeof upstreamFor !== 'function') throw new Error('createMixedProxy 需要 upstreamFor');

  const sockets = new Set();
  const stats = { connections: 0, active: 0, failed: 0, blocked: 0, bytesUp: 0, bytesDown: 0 };

  function planeMeta(target, lines) {
    const explicit = readRoutingPlane(lines) || readProxyAuthPlane(lines);
    const domainPlane = explicit ? '' : resolvePlaneFor(target.host, [], controlDomains);
    const plane = explicit || domainPlane;
    const meta = {};
    if (plane) meta.routingPlane = plane;
    meta.controlPlane = plane === 'STRICT_CONTROL';
    return meta;
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    stats.connections += 1;
    stats.active += 1;

    let tunnel = null;
    let finished = false;

    const done = () => {
      if (finished) return;
      finished = true;
      stats.active = Math.max(0, stats.active - 1);
      sockets.delete(socket);
      try { socket.destroy(); } catch { /* ignore */ }
    };

    socket.on('error', () => done());
    socket.on('close', () => {
      if (tunnel) tunnel.close();
      done();
    });

    async function checkGuard(target, meta) {
      meta.guardChecked = Boolean(guard);
      if (!guard) return;
      const verdict = await guard(target, meta);
      if (verdict && verdict.allow === false) {
        throw Object.assign(new Error(verdict.reason || verdict.code || '出口滥用防护已阻断'), {
          code: verdict.code || 'abuse_blocked',
          status: verdict.status || 403,
          lockUntil: verdict.lockUntil || 0,
        });
      }
    }

    function connect(target, meta) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error('上游握手超时'), { code: 'upstream_timeout', status: 504 }));
        }, handshakeTimeoutMs);
        if (timer.unref) timer.unref();

        Promise.resolve()
          .then(() => checkGuard(target, meta))
          .then(() => upstreamFor(target, meta || {}))
          .then((created) => {
            if (settled) {
              created.close();
              return;
            }
            settled = true;
            clearTimeout(timer);
            if (finished) {
              created.close();
              reject(Object.assign(new Error('本地连接已关闭'), { code: 'socket_closed' }));
              return;
            }
            tunnel = created;
            created.onData((chunk) => {
              stats.bytesDown += chunk.length;
              if (!socket.write(chunk)) created.pause();
            });
            created.onClose(() => {
              if (!socket.destroyed) socket.end();
            });
            created.onDrain(() => socket.resume());
            resolve(created);
          })
          .catch((error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          });
      });
    }

    function startPipe(initial) {
      if (!tunnel) return;
      socket.on('data', (chunk) => {
        stats.bytesUp += chunk.length;
        if (!tunnel.write(chunk)) socket.pause();
      });
      if (initial && initial.length) {
        stats.bytesUp += initial.length;
        tunnel.write(initial);
      }
      socket.resume();
    }

    function failHttp(error) {
      const status = statusFor(error);
      const code = errorCode(error, status === 503 ? 'strict_control_failclosed' : 'upstream_failed');
      if (socket.destroyed) return;
      const body = JSON.stringify({ ok: false, error: { code, message: error && error.message ? error.message : code } });
      socket.end([
        `HTTP/1.1 ${status} ${reasonFor(status)}`,
        'Connection: close',
        'Content-Type: application/json; charset=utf-8',
        `X-OC-Error: ${code}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n'), 'latin1');
    }

    socket.once('data', (first) => {
      if (first.length && first[0] === 0x05) handleSocks(first);
      else handleHttp(first);
    });

    function handleSocks(first) {
      let buffer = first;
      let stage = 'greeting';

      const reply = (code) => {
        if (socket.destroyed) return;
        socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (code !== 0x00) socket.destroy();
      };

      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const methods = buffer[1];
          if (buffer.length < 2 + methods) return;
          const offered = buffer.subarray(2, 2 + methods);
          buffer = buffer.subarray(2 + methods);
          if (!offered.includes(0x00)) {
            socket.write(Buffer.from([0x05, 0xff]));
            socket.destroy();
            return;
          }
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
        if (stage !== 'request') return;
        if (buffer.length < 4) return;
        const parsed = readSocksAddress(buffer, buffer[3]);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.length);
        if (parsed.command !== 0x01) {
          reply(0x07);
          return;
        }
        stage = 'connecting';
        socket.removeListener('data', onData);
        socket.pause();
        const target = { host: parsed.host, port: parsed.port };
        const meta = planeMeta(target, []);
        connect(target, meta)
          .then(() => {
            reply(0x00);
            startPipe(buffer);
          })
          .catch((error) => {
            if (statusFor(error) === 403) {
              stats.blocked += 1;
              log(`socks ${parsed.host}:${parsed.port} 阻断: ${error.code || error.message}`);
              reply(0x02);
              return;
            }
            stats.failed += 1;
            log(`socks ${parsed.host}:${parsed.port} 失败: ${error.message}`);
            reply(0x01);
          });
      };

      socket.on('data', onData);
      onData(Buffer.alloc(0));
    }

    function handleHttp(first) {
      let buffer = first;
      const tryHead = () => {
        if (buffer.length > MAX_HEAD) {
          socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
          return;
        }
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', onData);
        socket.pause();
        const head = buffer.subarray(0, end + 4).toString('latin1');
        const rest = buffer.subarray(end + 4);
        onHead(head, rest);
      };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        tryHead();
      };
      socket.on('data', onData);
      tryHead();
    }

    function onHead(head, rest) {
      const lines = head.split('\r\n');
      const match = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(lines[0] || '');
      if (!match) {
        stats.failed += 1;
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const method = match[1].toUpperCase();
      const target = match[2];

      if (method === 'CONNECT') {
        const parsed = parseHostPort(target, 443);
        if (!parsed) {
          stats.failed += 1;
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          return;
        }
        const meta = planeMeta(parsed, lines);
        connect(parsed, meta)
          .then(() => {
            socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: egress-matrix\r\n\r\n', 'latin1');
            startPipe(rest);
          })
          .catch((error) => {
            if (statusFor(error) === 403) stats.blocked += 1;
            else stats.failed += 1;
            log(`http connect ${parsed.host}:${parsed.port} 失败 ${errorCode(error, 'upstream_failed')}: ${error.message}`);
            failHttp(error);
          });
        return;
      }

      let url;
      try {
        url = new URL(target);
      } catch {
        stats.failed += 1;
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        stats.failed += 1;
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }

      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const origin = `${url.pathname || '/'}${url.search || ''}`;
      const headers = stripInternalHeaders(lines.slice(1))
        .filter(Boolean)
        .filter((line) => !/^connection:/i.test(line));
      headers.push('Connection: close');
      const rewritten = `${method} ${origin} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`;
      const meta = planeMeta({ host: url.hostname, port }, lines);

      connect({ host: url.hostname, port }, meta)
        .then(() => {
          const payload = Buffer.concat([Buffer.from(rewritten, 'latin1'), rest]);
          startPipe(payload);
        })
        .catch((error) => {
          if (statusFor(error) === 403) stats.blocked += 1;
          else stats.failed += 1;
          log(`http ${url.hostname}:${port} 失败 ${errorCode(error, 'upstream_failed')}: ${error.message}`);
          failHttp(error);
        });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(portOf(options.port), host, () => {
      resolve({
        host,
        port: server.address().port,
        stats,
        close() {
          for (const socket of sockets) {
            try { socket.destroy(); } catch { /* ignore */ }
          }
          sockets.clear();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function readSocksAddress(buffer, atyp) {
  let offset = 4;
  let hostText;
  if (atyp === 0x01) {
    if (buffer.length < offset + 4 + 2) return null;
    hostText = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
    offset += 4;
  } else if (atyp === 0x03) {
    if (buffer.length < offset + 1) return null;
    const size = buffer[offset];
    if (buffer.length < offset + 1 + size + 2) return null;
    hostText = buffer.subarray(offset + 1, offset + 1 + size).toString('utf8');
    offset += 1 + size;
  } else if (atyp === 0x04) {
    if (buffer.length < offset + 16 + 2) return null;
    const parts = [];
    for (let index = 0; index < 8; index += 1) parts.push(buffer.readUInt16BE(offset + index * 2).toString(16));
    hostText = parts.join(':');
    offset += 16;
  } else {
    return { command: buffer[1], host: '', port: 0, length: buffer.length };
  }
  const port = buffer.readUInt16BE(offset);
  return { command: buffer[1], host: hostText, port, length: offset + 2 };
}

function headerValue(lines, name) {
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== name) continue;
    return { present: true, value: line.slice(at + 1).trim() };
  }
  return { present: false, value: '' };
}

/*
 * Internal routing headers are consumed locally. `Proxy-Authorization` must
 * never reach the exit node: lib/upstream.js writes the node's own credentials
 * and an inherited value would trigger an upstream 407.
 */
const INTERNAL_FORWARD_HEADERS = new Set([
  'proxy-authorization',
  'proxy-connection',
  'x-oc-routing-plane',
]);

function stripInternalHeaders(lines) {
  return lines.filter((line) => {
    const at = line.indexOf(':');
    if (at < 0) return true;
    return !INTERNAL_FORWARD_HEADERS.has(line.slice(0, at).trim().toLowerCase());
  });
}

function normalizePlane(value) {
  const text = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (text === 'STRICT_CONTROL' || text === 'STRICT' || text === 'CONTROL') return 'STRICT_CONTROL';
  if (text === 'ELASTIC_DATA' || text === 'ELASTIC' || text === 'DATA') return 'ELASTIC_DATA';
  return '';
}

function readRoutingPlane(lines) {
  const header = headerValue(lines, 'x-oc-routing-plane');
  return header.present ? normalizePlane(header.value) : '';
}

/*
 * `Proxy-Authorization: Plane STRICT_CONTROL`, `Bearer plane=STRICT_CONTROL`
 * or `slot-042:STRICT_CONTROL` lets a local app pick a plane without inventing
 * another header. Basic credentials are decoded before matching.
 */
function readProxyAuthPlane(lines) {
  const header = headerValue(lines, 'proxy-authorization');
  if (!header.present) return '';
  let text = header.value;
  const basic = /^basic\s+(\S+)$/i.exec(text);
  if (basic) {
    try {
      text = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      text = header.value;
    }
  }
  text = text.replace(/^bearer\s+/i, '').replace(/^plane\s+/i, '');
  const direct = normalizePlane(text);
  if (direct) return direct;
  const slot = /(?:^|[;,\s])slot-[^:;\s]+:\s*(?:plane\s*[=:]\s*)?([A-Za-z_-]+)/i.exec(text);
  if (slot) {
    const plane = normalizePlane(slot[1]);
    if (plane) return plane;
  }
  const match = /(?:^|[;,\s])plane\s*[=:]\s*([A-Za-z_-]+)/i.exec(text);
  return match ? normalizePlane(match[1]) : '';
}

function resolvePlaneFor(host, lines, controlDomains) {
  const explicit = readRoutingPlane(lines) || readProxyAuthPlane(lines);
  if (explicit) return explicit;
  const domains = Array.isArray(controlDomains) && controlDomains.length
    ? controlDomains
    : contract.DEFAULT_CONTROL_DOMAINS;
  return contract.isControlPlaneHost(host, domains) ? 'STRICT_CONTROL' : '';
}

function parseHostPort(value, fallbackPort) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    const host = text.slice(1, end);
    const port = Number(text.slice(end + 1).replace(/^:/, '') || fallbackPort);
    return host && Number.isInteger(port) ? { host, port } : null;
  }
  const at = text.lastIndexOf(':');
  if (at < 0) return { host: text, port: fallbackPort };
  const host = text.slice(0, at);
  const port = Number(text.slice(at + 1) || fallbackPort);
  if (!host || !Number.isInteger(port)) return null;
  return { host, port };
}

function portOf(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 ? port : 0;
}

module.exports = {
  createMixedProxy,
  readSocksAddress,
  parseHostPort,
  readRoutingPlane,
  readProxyAuthPlane,
  resolvePlaneFor,
  stripInternalHeaders,
};
