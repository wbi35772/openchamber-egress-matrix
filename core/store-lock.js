'use strict';

/*
 * Cross-process atomic JSON access for the shared matrix-state directory.
 *
 * Writers take an exclusive `*.lock` file (O_EXCL), write a temp file and
 * rename it over the target. Readers never see a partially written file.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_STALE_MS = 30000;
const DEFAULT_RETRY_MS = 25;

/*
 * Windows and WSL2 hand out transient sharing violations (EPERM/EBUSY/EACCES)
 * when another process holds a handle to the target for a few milliseconds.
 * Retrying the rename with a short backoff removes those cross-process races
 * without ever deleting a valid target file first.
 */
const RENAME_RETRY_DELAYS_MS = [15, 30, 60, 120, 240];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function lockIsStale(lockFile, staleMs) {
  let stat;
  try {
    stat = await fsp.stat(lockFile);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs > staleMs) return true;
  try {
    const raw = await fsp.readFile(lockFile, 'utf8');
    const holder = JSON.parse(raw);
    return holder && holder.pid ? !pidAlive(Number(holder.pid)) : false;
  } catch {
    return false;
  }
}

async function acquireLock(file, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const staleMs = Number(options.staleMs) || DEFAULT_STALE_MS;
  const retryMs = Number(options.retryMs) || DEFAULT_RETRY_MS;
  const lockFile = `${file}.lock`;
  const startedAt = Date.now();

  await fsp.mkdir(path.dirname(file), { recursive: true });

  for (;;) {
    let handle;
    try {
      handle = await fsp.open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      await handle.close();
      let released = false;
      return async function release() {
        if (released) return;
        released = true;
        try {
          const raw = await fsp.readFile(lockFile, 'utf8');
          const holder = JSON.parse(raw);
          if (holder.pid !== process.pid) return;
        } catch {
          /* already gone */
        }
        await fsp.unlink(lockFile).catch(() => {});
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      if (await lockIsStale(lockFile, staleMs)) {
        await fsp.unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw Object.assign(new Error(`状态文件锁超时: ${path.basename(lockFile)}`), {
          code: 'store_lock_timeout',
        });
      }
      await delay(retryMs + Math.floor(Math.random() * retryMs));
    }
  }
}

async function withFileLock(file, task, options = {}) {
  const release = await acquireLock(file, options);
  try {
    return await task();
  } finally {
    await release();
  }
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return clone(fallback);
    throw error;
  }
}

async function renameWithRetry(temp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, file);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fsp.writeFile(temp, body, 'utf8');
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function mutateJson(file, fallback, mutator, options = {}) {
  return withFileLock(file, async () => {
    const current = await readJson(file, fallback);
    const data = current && typeof current === 'object' ? current : clone(fallback);
    const result = await mutator(data);
    data.updatedAt = Date.now();
    await writeJsonAtomic(file, data);
    return result === undefined ? data : result;
  }, options);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_MS,
  RENAME_RETRY_DELAYS_MS,
  acquireLock,
  withFileLock,
  readJson,
  writeJsonAtomic,
  mutateJson,
};
