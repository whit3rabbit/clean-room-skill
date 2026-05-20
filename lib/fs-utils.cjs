'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileHash(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function normalizeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) {
    return null;
  }
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    return null;
  }
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return parts.join('/');
}

function resolveInside(root, relPath) {
  const normalized = normalizeRelativePath(relPath);
  if (!normalized) {
    throw new Error(`invalid relative path: ${relPath}`);
  }
  const rootPath = path.resolve(root);
  const fullPath = path.resolve(rootPath, normalized);
  if (fullPath !== rootPath && !fullPath.startsWith(rootPath + path.sep)) {
    throw new Error(`path escapes install root: ${relPath}`);
  }
  return fullPath;
}

function atomicWriteFile(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const tmpPath = `${filePath}.tmp-${suffix}`;
  try {
    fs.writeFileSync(tmpPath, data, options);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw err;
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
}

function writeJsonFile(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listFiles(root, options = {}) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const ignoreNames = new Set(options.ignoreNames || []);
  const files = [];
  function walk(dir, relBase) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoreNames.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }
  walk(root, '');
  return files.sort();
}

function removeEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current !== stop && current.startsWith(stop + path.sep)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

module.exports = {
  atomicWriteFile,
  fileHash,
  listFiles,
  normalizeRelativePath,
  readJsonFile,
  removeEmptyParents,
  resolveInside,
  sha256Bytes,
  writeJsonFile,
};
