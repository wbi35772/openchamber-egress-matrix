'use strict';

/*
 * Egress identity probe.
 *
 * Speaks plain HTTP through an existing local mixed proxy so no TLS stack or
 * proxy agent is needed. Used only for fingerprint enrichment (exit IP, ASN,
 * IPv6 /64); health probes stay on the lighter HTTPS path.
 */

const http = require('node:http');

function getViaProxy(proxyPort, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(Object.assign(new Error(`探测地址非法: ${url}`), { code: 'invalid_probe_url' }));
      return;
    }
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: {
        host: target.host,
        accept: 'application/json, text/plain, */*',
        connection: 'close',
        'user-agent': 'openchamber-egress-matrix/0.3',
      },
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('身份探测超时'), { code: 'probe_timeout' }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function probeAsn(proxyPort, timeoutMs) {
  const response = await getViaProxy(
    proxyPort,
    'http://ip-api.com/json/?fields=status,query,as,asname,country,countryCode',
    timeoutMs,
  );
  if (response.status !== 200) throw new Error(`ip-api HTTP ${response.status}`);
  const parsed = JSON.parse(response.body);
  if (parsed.status && parsed.status !== 'success') throw new Error(`ip-api ${parsed.status}`);
  return {
    exitIp: String(parsed.query || ''),
    asn: String(parsed.as || parsed.asname || ''),
    country: String(parsed.country || ''),
    countryCode: String(parsed.countryCode || '').toUpperCase(),
  };
}

async function probeIpv6(proxyPort, timeoutMs) {
  const response = await getViaProxy(proxyPort, 'http://v6.ident.me', timeoutMs);
  if (response.status !== 200) throw new Error(`ident.me HTTP ${response.status}`);
  return String(response.body || '').trim();
}

async function probeIdentity(options = {}) {
  const port = Number(options.port);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const identity = {
    exitIp: '',
    asn: '',
    country: '',
    countryCode: '',
    ipv6: '',
    asnError: '',
    ipv6Error: '',
  };

  try {
    const asn = await probeAsn(port, timeoutMs);
    identity.exitIp = asn.exitIp;
    identity.asn = asn.asn;
    identity.country = asn.country;
    identity.countryCode = asn.countryCode;
  } catch (error) {
    identity.asnError = error.message;
  }

  if (!identity.exitIp) {
    try {
      const response = await getViaProxy(port, 'http://api.ipify.org', timeoutMs);
      if (response.status === 200) identity.exitIp = String(response.body || '').trim();
    } catch (error) {
      identity.asnError = identity.asnError || error.message;
    }
  }

  if (options.ipv6 === false) {
    identity.ipv6Error = 'skipped';
    return identity;
  }

  try {
    identity.ipv6 = await probeIpv6(port, Math.min(timeoutMs, 8000));
  } catch (error) {
    identity.ipv6Error = error.message;
  }

  return identity;
}

module.exports = { getViaProxy, probeIdentity };
