'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  atomicWriteFile,
  fileHash,
  readJsonFile,
  removeEmptyParents,
  resolveInside,
  sha256Bytes,
  writeJsonFile,
} = require('./fs-utils.cjs');
const { packageVersion } = require('./install-artifacts.cjs');

const MANIFEST_NAME = 'clean-room-install-manifest.json';
const PATCHES_DIR_NAME = 'clean-room-patches';

function readManifest(targetRoot) {
  const manifestPath = path.join(targetRoot, MANIFEST_NAME);
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

function planInstall(targetRoot, desired, manifest) {
  const unknownConflicts = [];
  const writes = [];
  const removals = [];
  const backups = [];

  for (const [relPath, bytes] of desired) {
    const fullPath = resolveInside(targetRoot, relPath);
    const desiredHash = sha256Bytes(bytes);
    const knownHash = manifestHash(manifest, relPath);
    if (fs.existsSync(fullPath)) {
      const currentHash = fileHash(fullPath);
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
    const fullPath = resolveInside(targetRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && fileHash(fullPath) !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }

  return { unknownConflicts, writes, removals, backups };
}

function backupFile(targetRoot, relPath, backupRoot) {
  const source = resolveInside(targetRoot, relPath);
  const dest = resolveInside(backupRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createBackupWriter(targetRoot, dryRun) {
  let backupRoot = null;
  return {
    backup(relPath) {
      if (dryRun) return null;
      if (!backupRoot) {
        backupRoot = path.join(targetRoot, PATCHES_DIR_NAME, timestampForPath());
      }
      backupFile(targetRoot, relPath, backupRoot);
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

  const backedUp = new Set();
  for (const relPath of [...plan.backups, ...plan.unknownConflicts]) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath) && !backedUp.has(relPath)) {
      backupWriter.backup(relPath);
      backedUp.add(relPath);
    }
  }

  for (const relPath of plan.removals) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }

  for (const [relPath, bytes] of desired) {
    const fullPath = resolveInside(targetRoot, relPath);
    atomicWriteFile(fullPath, bytes);
  }

  const nextManifest = {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    runtime: manifest?.runtime || null,
    scope: manifest?.scope || null,
    hooks_mode: options.hookMode,
    installed_at: new Date().toISOString(),
    files: {},
  };
  for (const [relPath, bytes] of desired) {
    nextManifest.files[relPath] = { sha256: sha256Bytes(bytes) };
  }
  return { backupRoot: backupWriter.root, manifest: nextManifest };
}

function writeInstallManifest(targetRoot, manifest, runtime, scope, hookMode, dryRun) {
  if (dryRun) return;
  const next = {
    ...manifest,
    runtime,
    scope,
    hooks_mode: hookMode,
  };
  writeJsonFile(path.join(targetRoot, MANIFEST_NAME), next);
}

function planUninstall(targetRoot, manifest, desired = new Map()) {
  const files = Object.keys(manifest?.files || {});
  const managed = new Set(files);
  const backups = [];
  const removals = [];
  const untracked = [];
  for (const relPath of files) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && fileHash(fullPath) !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }
  for (const relPath of desired.keys()) {
    if (managed.has(relPath)) continue;
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      untracked.push(relPath);
    }
  }
  return { backups, removals, untracked };
}

function applyUninstall(targetRoot, plan, dryRun) {
  if (dryRun) return null;
  const backupWriter = createBackupWriter(targetRoot, false);
  for (const relPath of plan.backups) {
    backupWriter.backup(relPath);
  }
  for (const relPath of plan.removals) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }
  fs.rmSync(path.join(targetRoot, MANIFEST_NAME), { force: true });
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
