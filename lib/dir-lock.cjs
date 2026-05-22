'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN_STALE_LOCK_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lockOwner() {
  return {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
}

function staleSuffix() {
  return `${new Date().toISOString().replace(/[^0-9]/g, '')}.${process.pid}`;
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processLiveState(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return 'unknown';
  }
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return 'dead';
    }
    return 'unknown';
  }
}

function lockLastActivityMs(lockPath, owner) {
  let lockStat;
  try {
    lockStat = fs.statSync(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const ownerCreated = Date.parse(owner?.created_at || '');
  return Number.isFinite(ownerCreated)
    ? Math.max(lockStat.mtimeMs, ownerCreated)
    : lockStat.mtimeMs;
}

function staleLockDestination(lockPath) {
  return `${lockPath}.stale.${staleSuffix()}`;
}

function recoverStaleLock(lockPath, staleMs) {
  const owner = readOwner(lockPath);
  const lastActivity = lockLastActivityMs(lockPath, owner);
  if (lastActivity === null) {
    return true;
  }
  if (Date.now() - lastActivity < staleMs) {
    return false;
  }
  if (processLiveState(owner?.pid) === 'alive') {
    return false;
  }
  try {
    fs.renameSync(lockPath, staleLockDestination(lockPath));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return true;
    }
    return false;
  }
}

async function withDirectoryLock(options, fn) {
  const {
    lockPath,
    waitMs,
    pollMs,
    label,
  } = options;
  const staleMs = Math.max(waitMs * 2, MIN_STALE_LOCK_MS);
  const deadline = Date.now() + waitMs;
  let locked = false;

  while (!locked) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(
          path.join(lockPath, 'owner.json'),
          `${JSON.stringify(lockOwner(), null, 2)}\n`,
          'utf8'
        );
      } catch (err) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }
      locked = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      if (recoverStaleLock(lockPath, staleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${label} is held: ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

module.exports = {
  MIN_STALE_LOCK_MS,
  processLiveState,
  recoverStaleLock,
  withDirectoryLock,
};
