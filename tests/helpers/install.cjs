'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach } = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const HOOK = path.join(ROOT, 'hooks', 'clean-room-hook.py');
const TMP_DIRS = [];

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TMP_DIRS.length > 0) {
    fs.rmSync(TMP_DIRS.pop(), { recursive: true, force: true });
  }
});

function runInstall(args, env = {}, cwd = ROOT) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hookTable(value) {
  return value.hooks && typeof value.hooks === 'object' ? value.hooks : value;
}

function managedHooks(value) {
  const table = hookTable(value);
  const hooks = [];
  for (const entries of Object.values(table)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
          hooks.push(hook);
        }
      }
    }
  }
  return hooks;
}

function managedHookCount(value) {
  return managedHooks(value).length;
}

function assertManagedHookDetails(value) {
  const hooks = managedHooks(value);
  assert.equal(hooks.length, 4);
  for (const hook of hooks) {
    assert.equal(hook.type, 'command');
    assert.equal(hook.timeout, 10);
    assert.equal(hook.statusMessage, 'Checking clean-room guardrails');
  }
}

function postWriteHookCommand(value) {
  const entries = hookTable(value).PostToolUse || [];
  for (const entry of entries) {
    if (typeof entry.matcher !== 'string' || !entry.matcher.includes('Write')) continue;
    for (const hook of entry.hooks || []) {
      if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
        return hook.command;
      }
    }
  }
  return null;
}

module.exports = {
  assertManagedHookDetails,
  HOOK,
  hookTable,
  managedHookCount,
  postWriteHookCommand,
  readJson,
  ROOT,
  runInstall,
  tempDir,
};
