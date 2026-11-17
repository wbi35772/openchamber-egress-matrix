'use strict';

/*
 * Port compatibility layer.
 *
 * The only port mapping is slot index N -> 24000 + N (core/contract.js).
 * This module must never invent a second port table; it only records the
 * deterministic port against a lease key for legacy callers.
 */

const net = require('node:net');

const contract = require('../core/contract');
const sub2port = require('../core/sub2port');

function pool() {
  return {
    base: contract.EGRESS_PORT_MIN,
    size: contract.SLOT_COUNT,
    end: contract.EGRESS_PORT_MAX + 1,
  };
}

function usedIndexes(state) {
  const used = sub2port.usedIndexesFrom((state && state.leases) || []);
  for (const value of Object.values((state && state.ports) || {})) {
    const index = contract.indexForSlotId(contract.matrixSlotIdForPort(Number(value)));
    if (index) used.add(index);
  }
  return used;
}

function allocatePort(state, key) {
  state.ports = state.ports || {};
  const { base, size } = pool();
  const current = Number(state.ports[key]);
  if (Number.isInteger(current) && current >= base && current < base + size) return current;

  const index = sub2port.nextFreeIndex(usedIndexes(state));
  const port = contract.egressPortForIndex(index);
  state.ports[key] = port;
  return port;
}

function releasePort(state, key) {
  if (!state || !state.ports) return false;
  const owned = Object.prototype.hasOwnProperty.call(state.ports, key);
  delete state.ports[key];
  return owned;
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try {
      server.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

module.exports = { pool, allocatePort, releasePort, isPortFree };
