'use strict';

/*
 * End-to-end health probe through a local mixed proxy.
 * The probe uses the same CONNECT path a local app would use, so a listener
 * that answers here is proven usable, not merely "running".
 */

const net = require('node:net');
const tls = require('node:tls');

function dechunk(body) {
  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(out);
}

function parseHttp(buffer) {
  const end = buffer.indexOf('\r\n\r\n');
  const head = (end < 0 ? buffer : buffer.subarray(0, end)).toString('latin1');
  const body = end < 0 ? Buffer.alloc(0) : buffer.subarray(end + 4);
  const lines = head.split('\r\n');
  const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
  return { status: status ? Number(status[1]) : 0, headers, body: chunked ? dechunk(body) : body };
}

function probeViaProxy(options) {
  const proxyHost = options.host || '127.0.0.1';
  const proxyPort = options.port;
  const timeoutMs = options.timeoutMs || 15000;
  const url = new URL(options.url || 'https://api.ipify.org');

  return new Promise((resolve, reject) => {
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setNoDelay(true);

    let settled = false;
    const timer = setTimeout(() => finish(new Error('探测超时')), timeoutMs);
    if (timer.unref) timer.unref();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(value);
    }

    let connectBuffer = Buffer.alloc(0);
    const onConnectData = (chunk) => {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const end = connectBuffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onConnectData);
      const parsed = parseHttp(connectBuffer.subarray(0, end + 4));
      if (parsed.status !== 200) {
        finish(new Error(`本地代理 CONNECT 返回 HTTP ${parsed.status}`));
        return;
      }
      const rest = connectBuffer.subarray(end + 4);
      connectBuffer = Buffer.alloc(0);
      startTunnel(rest);
    };

    socket.on('data', onConnectData);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('本地代理提前关闭连接'));
    });

    socket.on('connect', () => {
      const host = net.isIPv6(url.hostname) ? `[${url.hostname}]` : url.hostname;
      socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`, 'latin1');
    });

    function startTunnel(rest) {
      let stream = socket;
      if (url.protocol === 'https:') {
        stream = tls.connect({
          socket,
          servername: url.hostname,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
        });
        stream.on('error', (error) => finish(error));
        stream.once('secureConnect', request);
      } else {
        request();
      }

      function request() {
        const path = `${url.pathname || '/'}${url.search || ''}`;
        stream.write([
          `GET ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          'User-Agent: egress-matrix/0.1',
          'Accept: */*',
          'Connection: close',
          '',
          '',
        ].join('\r\n'), 'latin1');
        if (rest && rest.length) {
          // CONNECT leftovers belong to the tunnel; send them first.
          stream.write(rest);
        }
      }

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        if (size < 1024 * 1024) chunks.push(chunk);
        size += chunk.length;
      });
      stream.once('end', () => {
        const response = parseHttp(Buffer.concat(chunks));
        if (response.status < 200 || response.status >= 400) {
          finish(new Error(`探测目标返回 HTTP ${response.status}`));
          return;
        }
        finish(null, {
          status: response.status,
          body: response.body.toString('utf8').trim(),
          exitIp: response.body.toString('utf8').trim(),
        });
      });
    }
  });
}

module.exports = { probeViaProxy, parseHttp, dechunk };
