'use strict';

/*
 * Generic proxy node URI -> upstream descriptor.
 *
 * Supported: vless://, trojan:// over WebSocket (+TLS), and socks5:// / socks://
 * (optional username/password). Platform-free: no hosts, keys or aliases.
 */

class NodeUriError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NodeUriError';
    this.code = code || 'invalid_node_uri';
  }
}

function fail(code, message) {
  return new NodeUriError(message, code);
}

function decode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function parseBool(value) {
  const text = String(value || '').toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED = new Set(['vless', 'trojan', 'socks', 'socks5', 'socks5h']);

function parseNodeUri(raw) {
  const text = String(raw || '').trim();
  if (!text) throw fail('node_uri_empty', '节点 URI 为空');

  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(text);
  if (!scheme) throw fail('node_uri_invalid', '节点 URI 缺少协议前缀，例如 vless:// 或 socks5://');

  const protocol = scheme[1].toLowerCase();
  if (!SUPPORTED.has(protocol)) {
    throw fail('unsupported_protocol', `暂不支持 ${protocol} 节点，目前支持 vless://、trojan://、socks5://`);
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail('node_uri_invalid', '节点 URI 无法解析');
  }

  const server = url.hostname;
  if (!server) throw fail('node_uri_invalid', '节点 URI 缺少服务器地址');

  const username = decode(url.username);
  const password = decode(url.password);
  const tag = decode(url.hash.replace(/^#/, ''));
  const socks = protocol.startsWith('socks');

  const port = Number(url.port || (socks ? 1080 : 443));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw fail('node_uri_invalid', '节点端口无效');
  }

  if (socks) {
    return {
      protocol: 'socks',
      type: 'tcp',
      tag: tag || `socks-${server}-${port}`,
      server,
      port,
      username,
      password,
      tls: { enabled: false, servername: '', insecure: false, alpn: [] },
      ws: null,
    };
  }

  const query = url.searchParams;
  const type = String(query.get('type') || query.get('transport') || 'tcp').toLowerCase();
  if (type !== 'ws' && type !== 'websocket') {
    throw fail('unsupported_transport', `暂不支持 ${type} 传输，目前只支持 WebSocket`);
  }

  const security = String(query.get('security') || '').toLowerCase();
  if (security === 'reality') {
    throw fail('unsupported_reality', '暂不支持 REALITY，需要 uTLS 指纹，后续版本处理');
  }
  const tlsEnabled = security === 'tls' || security === 'xtls' || parseBool(query.get('tls'));

  const sni = String(query.get('sni') || query.get('servername') || query.get('server_name') || '');
  const wsHost = String(query.get('host') || '');
  const wsPath = String(query.get('path') || '/');
  const insecure = parseBool(query.get('allowinsecure') || query.get('allowInsecure') || query.get('insecure'));

  const descriptor = {
    protocol,
    type: 'ws',
    tag: tag || `${protocol}-${server}-${port}`,
    server,
    port,
    tls: {
      enabled: tlsEnabled,
      servername: sni || (tlsEnabled ? server : ''),
      insecure,
      alpn: splitList(query.get('alpn')),
    },
    ws: {
      path: wsPath.startsWith('/') ? wsPath : `/${wsPath}`,
      host: wsHost || sni || server,
    },
  };

  if (protocol === 'vless') {
    if (!UUID_RE.test(username)) throw fail('invalid_vless_uuid', 'VLESS 节点缺少有效的 UUID');
    descriptor.uuid = username.toLowerCase();
  } else {
    if (!username) throw fail('invalid_trojan_password', 'Trojan 节点缺少密码');
    descriptor.password = username;
  }

  return descriptor;
}

function publicNode(descriptor) {
  if (!descriptor) return null;
  return {
    protocol: descriptor.protocol,
    type: descriptor.type,
    tag: descriptor.tag,
    server: descriptor.server,
    port: descriptor.port,
    tls: Boolean(descriptor.tls && descriptor.tls.enabled),
    wsPath: descriptor.ws ? descriptor.ws.path : '',
    host: descriptor.ws ? descriptor.ws.host : '',
  };
}

module.exports = {
  NodeUriError,
  parseNodeUri,
  publicNode,
};
