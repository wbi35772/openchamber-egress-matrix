'use strict';

const net = require('node:net');

function pool(state) {
  const settings = state.settings || {};
  const base = Number(settings.portBase) || 25101;
  const size = Math.max(1, Math.min(1000, Number(settings.portSize) || 100));
  return { base, size, end: base + size };
}

function allocatePort(state, key) {
  state.ports = state.ports || {};
  const { base, size, end } = pool(state);

  const current = Number(state.ports[key]);
  if (Number.isInteger(current) && current >= base && current < end) return current;

  const used = new Set(Object.values(state.ports).map((value) => Number(value)).filter(Number.isInteger));
  const reserved = Number(state.settings && state.settings.defaultPort);
  if (Number.isInteger(reserved)) used.add(reserved);

  for (let index = 0; index < size; index += 1) {
    const port = base + index;
    if (!used.has(port)) {
      state.ports[key] = port;
      return port;
    }
  }
  throw new Error('出口端口池已满，请在设置里扩大端口范围');
}

function releasePort(state, key) {
  if (!state.ports) return;
  delete state.ports[key];
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

module.exports = { allocatePort, releasePort, isPortFree, pool };
