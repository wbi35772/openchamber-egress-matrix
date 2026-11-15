'use strict';

/*
 * Deterministic slot/port mapping. Every matrix slot owns exactly one local
 * mixed inbound port: slot index N -> 24000 + N (24001..24250).
 *
 * No other module is allowed to compute this mapping on its own; call these
 * helpers or use the contract exports.
 */

const {
  SLOT_MIN_INDEX,
  SLOT_MAX_INDEX,
  slotIdForIndex,
  indexForSlotId,
  egressPortForIndex,
  egressPortForSlotId,
} = require('./contract');

function usedIndexesFrom(records) {
  const used = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const index = indexForSlotId(record && record.matrixSlotId);
    if (index) used.add(index);
  }
  return used;
}

function nextFreeIndex(used = new Set()) {
  for (let index = SLOT_MIN_INDEX; index <= SLOT_MAX_INDEX; index += 1) {
    if (!used.has(index)) return index;
  }
  throw Object.assign(new Error('矩阵槽位已耗尽（最多 250 条线路）'), { code: 'slots_exhausted', status: 409 });
}

/*
 * Reserve one slot for an intent. A previously persisted mapping is reused
 * only when it is valid and not owned by another record.
 */
function reserve(used, preferredMatrixSlotId) {
  const set = used instanceof Set ? used : usedIndexesFrom(used);
  const preferred = indexForSlotId(preferredMatrixSlotId);
  if (preferred && !set.has(preferred)) {
    set.add(preferred);
    return preferred;
  }
  const index = nextFreeIndex(set);
  set.add(index);
  return index;
}

function mappingForIndex(index) {
  const matrixSlotId = slotIdForIndex(index);
  return { matrixSlotId, egressPort: egressPortForIndex(index) };
}

function mappingFor(record, used) {
  const index = reserve(used, record && record.matrixSlotId);
  return mappingForIndex(index);
}

function assertMapping(matrixSlotId, egressPort) {
  const expected = egressPortForSlotId(matrixSlotId);
  if (!expected) {
    throw Object.assign(new Error(`非法矩阵槽位 ${matrixSlotId}`), { code: 'invalid_slot_id' });
  }
  if (Number(egressPort) !== expected) {
    throw Object.assign(new Error(`槽位 ${matrixSlotId} 必须使用端口 ${expected}`), { code: 'invalid_egress_port' });
  }
  return true;
}

function sortRecords(records) {
  return [...(Array.isArray(records) ? records : [])].sort((left, right) => {
    return indexForSlotId(left.matrixSlotId) - indexForSlotId(right.matrixSlotId);
  });
}

function countFree(records) {
  return SLOT_MAX_INDEX - SLOT_MIN_INDEX + 1 - usedIndexesFrom(records).size;
}

module.exports = {
  usedIndexesFrom,
  nextFreeIndex,
  reserve,
  mappingForIndex,
  mappingFor,
  assertMapping,
  sortRecords,
  countFree,
};
