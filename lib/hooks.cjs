'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonFile, writeJsonFile } = require('./fs-utils.cjs');

const HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']);

const CLEAN_ROOM_HOOKS = [
  {
    event: 'PreToolUse',
    matcher: 'Bash|Shell',
    checks: ['require-clean-room-env.py', 'deny-clean-room-shell.py'],
  },
  {
    event: 'PreToolUse',
    matcher: 'Read|Glob|Grep',
    checks: ['require-clean-room-env.py', 'deny-clean-source-read.py'],
  },
  {
    event: 'PreToolUse',
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    checks: ['require-clean-room-env.py', 'deny-contaminated-clean-write.py'],
  },
  {
    event: 'PostToolUse',
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    checks: [
      'require-clean-room-env.py',
      'check-artifact-leakage.py',
      'validate-json-schema.py',
      'validate-handoff-package.py',
    ],
  },
];

function shellQuote(value) {
  const text = String(value);
  if (text === '') {
    return "''";
  }
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function buildHookCommand({ pythonPath, wrapperPath, mode, checks }) {
  const parts = [
    shellQuote(pythonPath),
    shellQuote(wrapperPath),
    '--mode',
    mode,
  ];
  for (const check of checks) {
    parts.push('--check', check);
  }
  return parts.join(' ');
}

function buildHookEntries({ pythonPath, wrapperPath, mode }) {
  return CLEAN_ROOM_HOOKS.map((entry) => ({
    event: entry.event,
    matcher: entry.matcher,
    hook: {
      type: 'command',
      command: buildHookCommand({
        pythonPath,
        wrapperPath,
        mode,
        checks: entry.checks,
      }),
      timeout: 10,
      statusMessage: 'Checking clean-room guardrails',
    },
  }));
}

function isManagedHook(hook) {
  return !!(
    hook &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    hook.command.includes('clean-room-hook.py')
  );
}

function hasTopLevelHookEvents(value) {
  return Object.keys(value || {}).some((key) => HOOK_EVENTS.has(key));
}

function hookTableFor(value) {
  if (value && typeof value.hooks === 'object' && value.hooks !== null && !Array.isArray(value.hooks)) {
    return value.hooks;
  }
  if (hasTopLevelHookEvents(value)) {
    return value;
  }
  return null;
}

function ensureHookTable(value) {
  const table = hookTableFor(value);
  if (table) {
    return table;
  }
  value.hooks = {};
  return value.hooks;
}

function removeManagedHookEntriesFromTable(table) {
  let changed = false;
  for (const event of Object.keys(table)) {
    if (!Array.isArray(table[event])) {
      continue;
    }
    const nextEntries = [];
    for (const entry of table[event]) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        nextEntries.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter((hook) => !isManagedHook(hook));
      if (hooks.length !== entry.hooks.length) {
        changed = true;
      }
      if (hooks.length > 0) {
        nextEntries.push({ ...entry, hooks });
      } else {
        changed = true;
      }
    }
    if (nextEntries.length > 0) {
      table[event] = nextEntries;
    } else {
      delete table[event];
    }
  }
  return changed;
}

function mergedHookConfig(configPath, entries) {
  const original = readJsonFile(configPath, {});
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  const next = structuredClone(original);
  const table = ensureHookTable(next);
  removeManagedHookEntriesFromTable(table);
  for (const entry of entries) {
    if (!Array.isArray(table[entry.event])) {
      table[entry.event] = [];
    }
    table[entry.event].push({
      matcher: entry.matcher,
      hooks: [entry.hook],
    });
  }
  return next;
}

function mergeHookEntries(configPath, entries, options = {}) {
  const next = mergedHookConfig(configPath, entries);
  if (!options.dryRun) {
    writeJsonFile(configPath, next);
  }
  return next;
}

function writeHookConfig(configPath, config) {
  writeJsonFile(configPath, config);
}

function removeHookEntries(configPath, options = {}) {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const original = readJsonFile(configPath, {});
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  const next = structuredClone(original);
  const table = hookTableFor(next);
  if (!table) {
    return original;
  }
  const changed = removeManagedHookEntriesFromTable(table);
  if (changed && !options.dryRun) {
    writeJsonFile(configPath, next);
  }
  return changed ? next : original;
}

function renderPackageHooksJson(mode) {
  const hooks = {};
  for (const entry of CLEAN_ROOM_HOOKS) {
    if (!Array.isArray(hooks[entry.event])) {
      hooks[entry.event] = [];
    }
    hooks[entry.event].push({
      matcher: entry.matcher,
      hooks: [
        {
          type: 'command',
          command: [
            'python3',
            'hooks/clean-room-hook.py',
            '--mode',
            mode,
            ...entry.checks.flatMap((check) => ['--check', check]),
          ].join(' '),
        },
      ],
    });
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function configPathForRuntime(runtime, targetRoot) {
  if (runtime === 'codex') {
    return path.join(targetRoot, 'hooks.json');
  }
  if (runtime === 'claude') {
    return path.join(targetRoot, 'settings.json');
  }
  return null;
}

module.exports = {
  buildHookEntries,
  configPathForRuntime,
  renderPackageHooksJson,
  removeHookEntries,
  mergeHookEntries,
  shellQuote,
  writeHookConfig,
};
