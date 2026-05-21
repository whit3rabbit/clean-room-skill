'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  assertManagedPath,
  atomicWriteFile,
  fileHash,
  readJsonFile,
  removeEmptyParents,
  sha256Bytes,
  writeJsonFile,
} = require('./fs-utils.cjs');
const { packageVersion } = require('./install-artifacts.cjs');

const MANIFEST_NAME = 'clean-room-install-manifest.json';
const PATCHES_DIR_NAME = 'clean-room-patches';

function readManifest(targetRoot) {
  const manifestPath = assertManagedPath(targetRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath, null);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  return manifest;
}

function manifestHash(manifest, relPath) {
  const entry = manifest?.files?.[relPath];
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.sha256 === 'string') return entry.sha256;
  return null;
}

function observeManagedFile(targetRoot, relPath) {
  const fullPath = assertManagedPath(targetRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return { exists: false, sha256: null };
  }
  return { exists: true, sha256: fileHash(fullPath) };
}

function sameObservation(left, right) {
  return left?.exists === right?.exists && left?.sha256 === right?.sha256;
}

function planInstall(targetRoot, desired, manifest) {
  const unknownConflicts = [];
  const writes = [];
  const removals = [];
  const backups = [];
  const observed = {};

  for (const [relPath, bytes] of desired) {
    const desiredHash = sha256Bytes(bytes);
    const knownHash = manifestHash(manifest, relPath);
    const current = observeManagedFile(targetRoot, relPath);
    observed[relPath] = current;
    if (current.exists) {
      const currentHash = current.sha256;
      if (knownHash && currentHash !== knownHash) {
        backups.push(relPath);
      } else if (!knownHash && currentHash !== desiredHash) {
        unknownConflicts.push(relPath);
      }
    }
    writes.push(relPath);
  }

  for (const relPath of Object.keys(manifest?.files || {})) {
    if (desired.has(relPath)) continue;
    const current = observeManagedFile(targetRoot, relPath);
    observed[relPath] = current;
    if (!current.exists) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && current.sha256 !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }

  return { unknownConflicts, writes, removals, backups, observed };
}

function backupFile(targetRoot, relPath, backupRelRoot) {
  const source = assertManagedPath(targetRoot, relPath);
  const destRel = `${backupRelRoot}/${relPath}`;
  const dest = assertManagedPath(targetRoot, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createBackupWriter(targetRoot, dryRun) {
  let backupRoot = null;
  let backupRelRoot = null;
  return {
    backup(relPath) {
      if (dryRun) return null;
      if (!backupRoot) {
        backupRelRoot = `${PATCHES_DIR_NAME}/${timestampForPath()}`;
        backupRoot = assertManagedPath(targetRoot, backupRelRoot);
      }
      backupFile(targetRoot, relPath, backupRelRoot);
      return backupRoot;
    },
    get root() {
      return backupRoot;
    },
  };
}

function applyInstall(targetRoot, desired, manifest, plan, options) {
  const backupWriter = createBackupWriter(targetRoot, options.dryRun);
  if (options.dryRun) return null;
  fs.mkdirSync(targetRoot, { recursive: true });

  const plannedBackups = new Set([...plan.backups, ...plan.unknownConflicts]);
  const backedUp = new Set();

  function backupIfNeededBeforeMutation(relPath) {
    const current = observeManagedFile(targetRoot, relPath);
    if (!current.exists) return current;

    const observed = plan.observed?.[relPath] || { exists: false, sha256: null };
    const changedSincePlanning = !sameObservation(observed, current);
    if ((plannedBackups.has(relPath) || changedSincePlanning) && !backedUp.has(relPath)) {
      backupWriter.backup(relPath);
      backedUp.add(relPath);
    }
    return current;
  }

  for (const relPath of plan.removals) {
    const fullPath = assertManagedPath(targetRoot, relPath);
    const current = backupIfNeededBeforeMutation(relPath);
    if (current.exists) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }

  for (const [relPath, bytes] of desired) {
    const fullPath = assertManagedPath(targetRoot, relPath);
    backupIfNeededBeforeMutation(relPath);
    atomicWriteFile(fullPath, bytes);
  }

  const nextManifest = {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    runtime: manifest?.runtime || null,
    scope: manifest?.scope || null,
    hooks_mode: options.hookMode,
    phase: 'complete',
    installed_at: new Date().toISOString(),
    files: {},
  };
  for (const [relPath, bytes] of desired) {
    nextManifest.files[relPath] = { sha256: sha256Bytes(bytes) };
  }
  return { backupRoot: backupWriter.root, manifest: nextManifest };
}

function writeInstallManifest(targetRoot, manifest, runtime, scope, hookMode, dryRun, extraState = {}) {
  if (dryRun) return;
  const next = {
    ...manifest,
    runtime,
    scope,
    hooks_mode: hookMode,
    ...extraState,
  };
  writeJsonFile(assertManagedPath(targetRoot, MANIFEST_NAME), next);
}

function planUninstall(targetRoot, manifest, desired = new Map()) {
  const files = Object.keys(manifest?.files || {});
  const managed = new Set(files);
  const backups = [];
  const removals = [];
  const untracked = [];
  const observed = {};
  for (const relPath of files) {
    const current = observeManagedFile(targetRoot, relPath);
    observed[relPath] = current;
    if (!current.exists) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && current.sha256 !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }
  for (const relPath of desired.keys()) {
    if (managed.has(relPath)) continue;
    const fullPath = assertManagedPath(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      untracked.push(relPath);
    }
  }
  return { backups, removals, untracked, observed };
}

function applyUninstall(targetRoot, plan, dryRun) {
  if (dryRun) return null;
  const backupWriter = createBackupWriter(targetRoot, false);
  const plannedBackups = new Set(plan.backups);
  const backedUp = new Set();

  function backupIfNeededBeforeRemoval(relPath) {
    const current = observeManagedFile(targetRoot, relPath);
    if (!current.exists) return current;

    const observed = plan.observed?.[relPath] || { exists: false, sha256: null };
    const changedSincePlanning = !sameObservation(observed, current);
    if ((plannedBackups.has(relPath) || changedSincePlanning) && !backedUp.has(relPath)) {
      backupWriter.backup(relPath);
      backedUp.add(relPath);
    }
    return current;
  }

  for (const relPath of plan.removals) {
    const fullPath = assertManagedPath(targetRoot, relPath);
    const current = backupIfNeededBeforeRemoval(relPath);
    if (current.exists) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }
  fs.rmSync(assertManagedPath(targetRoot, MANIFEST_NAME), { force: true });
  removeEmptyParents(targetRoot, path.dirname(targetRoot));
  return { backupRoot: backupWriter.root };
}

module.exports = {
  applyInstall,
  applyUninstall,
  MANIFEST_NAME,
  manifestHash,
  planInstall,
  planUninstall,
  readManifest,
  writeInstallManifest,
};
