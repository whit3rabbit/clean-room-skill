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

function pathIsInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function realpathForExistingAncestor(rootPath, fullPath) {
  let current = path.dirname(fullPath);
  while (current !== rootPath && current.startsWith(rootPath + path.sep)) {
    if (fs.existsSync(current)) {
      return fs.realpathSync(current);
    }
    current = path.dirname(current);
  }
  return fs.existsSync(rootPath) ? fs.realpathSync(rootPath) : rootPath;
}

function assertManagedPath(root, relPath) {
  const normalized = normalizeRelativePath(relPath);
  if (!normalized) {
    throw new Error(`invalid relative path: ${relPath}`);
  }
  const rootPath = path.resolve(root);
  const rootStat = lstatIfExists(rootPath);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`managed install root must not be a symlink: ${rootPath}`);
  }
  const fullPath = resolveInside(rootPath, normalized);
  const rootRealPath = fs.existsSync(rootPath) ? fs.realpathSync(rootPath) : rootPath;
  const parts = normalized.split('/');
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatIfExists(current);
    if (!stat) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`managed install path must not contain symlinks: ${normalized}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`managed install parent is not a directory: ${normalized}`);
    }
  }

  const parentRealPath = realpathForExistingAncestor(rootPath, fullPath);
  if (!pathIsInside(parentRealPath, rootRealPath)) {
    throw new Error(`managed install path escapes real install root: ${normalized}`);
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

function atomicWriteFileNoOverwrite(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const tmpPath = `${filePath}.tmp-${suffix}`;
  try {
    fs.writeFileSync(tmpPath, data, options);
    fs.linkSync(tmpPath, filePath);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const conflict = new Error(`file already exists: ${filePath}`);
      conflict.code = 'EEXIST';
      throw conflict;
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
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
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 64;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 10000;
  const files = [];
  const stack = [{ dir: root, relBase: '', depth: 0 }];

  while (stack.length > 0) {
    const { dir, relBase, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`could not read directory ${dir}: ${err.message}`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignoreNames.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          throw new Error(`listFiles exceeded max depth ${maxDepth}: ${relPath}`);
        }
        stack.push({ dir: fullPath, relBase: relPath, depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push(relPath);
        if (files.length > maxFiles) {
          throw new Error(`listFiles exceeded max files ${maxFiles} under ${root}`);
        }
      }
    }
  }
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
  assertManagedPath,
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
  fileHash,
  listFiles,
  normalizeRelativePath,
  readJsonFile,
  removeEmptyParents,
  resolveInside,
  sha256Bytes,
  writeJsonFile,
};
