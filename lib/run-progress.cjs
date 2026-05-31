'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  fileHash,
  listFiles,
  readJsonFile,
  sha256Bytes,
} = require('./fs-utils.cjs');
const {
  CLEAN_ROOM_ARTIFACT_PREFIXES,
  IMPLEMENTATION_IGNORE_NAMES,
  LEDGER_NAME,
  STATUS_NAME,
  VOLATILE_PROGRESS_KEYS,
} = require('./run-constants.cjs');

function jsonFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  return listFiles(root)
    .filter((rel) => rel.endsWith('.json'))
    .filter((rel) => rel !== LEDGER_NAME)
    .filter((rel) => rel !== STATUS_NAME)
    .map((rel) => path.join(root, rel));
}

function isCleanRoomArtifactName(name) {
  if (!name.endsWith('.json')) return false;
  const stem = name.slice(0, -'.json'.length);
  return CLEAN_ROOM_ARTIFACT_PREFIXES.some((prefix) => stem === prefix || stem.startsWith(`${prefix}-`));
}

function misplacedImplementationArtifacts(roots) {
  const misplaced = [];
  for (const root of roots.implementationRoots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const relPath of listFiles(root, { ignoreNames: IMPLEMENTATION_IGNORE_NAMES })) {
      if (isCleanRoomArtifactName(path.basename(relPath))) {
        misplaced.push(path.join(root, relPath));
      }
    }
  }
  return misplaced.sort();
}

function validateImplementationArtifactPlacement(roots) {
  const misplaced = misplacedImplementationArtifacts(roots);
  if (misplaced.length > 0) {
    throw new Error(`clean-room artifacts must not be under implementation roots: ${misplaced[0]}`);
  }
}

function trackedArtifactPaths(manifestPath, roots) {
  const paths = new Set([manifestPath]);
  for (const root of [roots.contaminatedRoot, roots.cleanRoot]) {
    for (const filePath of jsonFiles(root)) {
      paths.add(filePath);
    }
  }
  return [...paths].sort();
}

function artifactSnapshot(manifestPath, roots) {
  const entries = {};
  for (const filePath of trackedArtifactPaths(manifestPath, roots)) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    entries[filePath] = fileHash(filePath);
  }
  return entries;
}

function changedSnapshotPaths(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((filePath) => before[filePath] !== after[filePath])
    .sort();
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_PROGRESS_KEYS.has(key)) {
        continue;
      }
      output[key] = stableValue(value[key]);
    }
    return output;
  }
  return value;
}

function stableHash(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(stableValue(value)), 'utf8'));
}

function semanticArtifactHash(filePath) {
  try {
    return stableHash(readJsonFile(filePath, null));
  } catch {
    return fileHash(filePath);
  }
}

function semanticProgressSnapshot(manifestPath, roots) {
  const entries = {};
  for (const filePath of trackedArtifactPaths(manifestPath, roots)) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    entries[`artifact:${filePath}`] = semanticArtifactHash(filePath);
  }
  roots.implementationRoots.forEach((root, rootIndex) => {
    if (!root || !fs.existsSync(root)) return;
    for (const relPath of listFiles(root, { ignoreNames: IMPLEMENTATION_IGNORE_NAMES })) {
      const filePath = path.join(root, relPath);
      entries[`implementation:${rootIndex}:${relPath}`] = fileHash(filePath);
    }
  });
  return entries;
}

function changedImplementationPaths(beforeSnapshot, afterSnapshot) {
  const before = beforeSnapshot || {};
  const after = afterSnapshot || {};
  const changed = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!key.startsWith('implementation:')) continue;
    if (before[key] === after[key]) continue;
    const parts = key.split(':');
    if (parts.length >= 3) {
      changed.add(parts.slice(2).join(':'));
    }
  }
  return [...changed].sort();
}

function snapshotsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
  }
  return true;
}

module.exports = {
  artifactSnapshot,
  changedImplementationPaths,
  changedSnapshotPaths,
  semanticProgressSnapshot,
  snapshotsEqual,
  trackedArtifactPaths,
  validateImplementationArtifactPlacement,
};
