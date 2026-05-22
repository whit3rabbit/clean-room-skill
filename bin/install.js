#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const { runInit } = require('../lib/bootstrap.cjs');
const { withDirectoryLock } = require('../lib/dir-lock.cjs');
const { runDoctor } = require('../lib/doctor.cjs');
const { assertManagedPath, fileHash } = require('../lib/fs-utils.cjs');
const { parsePreflightArgs, runPreflight } = require('../lib/preflight.cjs');
const { parseRunArgs, runCleanRoom } = require('../lib/run.cjs');
const {
  buildHookEntries,
  configPathForRuntime,
  hasManagedHookEntries,
  mergeHookEntries,
  removeHookEntries,
} = require('../lib/hooks.cjs');
const {
  RUNTIMES,
  RUNTIME_FLAGS,
  resolveRuntimeLayout,
} = require('../lib/runtime-layout.cjs');
const { buildDesiredFiles, packageVersion } = require('../lib/install-artifacts.cjs');
const {
  applyInstall,
  applyUninstall,
  manifestHash,
  planInstall,
  planUninstall,
  readManifest,
  writeInstallManifest,
} = require('../lib/install-plan.cjs');

const HOOK_MODES = new Set(['safe', 'copy-only', 'strict']);
const INSTALL_LOCK_NAME = '.clean-room-install.lock';
const INSTALL_LOCK_WAIT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_LOCK_WAIT_MS', 30_000);
const INSTALL_LOCK_POLL_MS = 100;
const PYTHON_PROBE_TIMEOUT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_PYTHON_TIMEOUT_MS', 10_000);
const CLAUDE_PLUGIN_TIMEOUT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_CLAUDE_PLUGIN_TIMEOUT_MS', 120_000);
const CLAUDE_PLUGIN_MARKETPLACE_NAME = 'clean-room-skill';
const CLAUDE_PLUGIN_NAME = 'clean-room';
const CLAUDE_PLUGIN_ID = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_PLUGIN_MARKETPLACE_NAME}`;
const CLAUDE_PLUGIN_SOURCE_URL = 'https://github.com/whit3rabbit/clean-room-skill.git';
const CLAUDE_PLUGIN_SCOPE = 'user';

function envPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : fallback;
}

async function withTargetInstallLock(targetRoot, dryRun, fn) {
  if (dryRun) {
    return fn();
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const lockPath = assertManagedPath(targetRoot, INSTALL_LOCK_NAME);
  return withDirectoryLock({
    lockPath,
    waitMs: INSTALL_LOCK_WAIT_MS,
    pollMs: INSTALL_LOCK_POLL_MS,
    label: 'install lock',
  }, fn);
}

function parseArgs(argv) {
  const options = {
    runtimes: [],
    scope: null,
    dryRun: false,
    yes: false,
    uninstall: false,
    operation: null,
    hookMode: 'safe',
    hookModeSpecified: false,
    configDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (RUNTIME_FLAGS[arg]) options.runtimes.push(RUNTIME_FLAGS[arg]);
    else if (arg === '--all') options.runtimes = [...RUNTIMES];
    else if (arg === '--global') options.scope = setExclusive(options.scope, 'global', '--global');
    else if (arg === '--local') options.scope = setExclusive(options.scope, 'local', '--local');
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--no-hooks') {
      options.hookMode = 'copy-only';
      options.hookModeSpecified = true;
    } else if (arg === '--config-dir') {
      i += 1;
      if (i >= argv.length) throw new Error('--config-dir requires a path');
      options.configDir = argv[i];
    } else if (arg.startsWith('--config-dir=')) {
      options.configDir = arg.slice('--config-dir='.length);
    } else if (arg === '--hooks') {
      i += 1;
      if (i >= argv.length) throw new Error('--hooks requires safe, copy-only, or strict');
      options.hookMode = argv[i];
      options.hookModeSpecified = true;
    } else if (arg.startsWith('--hooks=')) {
      options.hookMode = arg.slice('--hooks='.length);
      options.hookModeSpecified = true;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  options.runtimes = [...new Set(options.runtimes)];
  if (!HOOK_MODES.has(options.hookMode)) {
    throw new Error('--hooks must be one of safe, copy-only, or strict');
  }
  if (options.configDir && options.runtimes.length > 1) {
    throw new Error('--config-dir can only be used with one runtime');
  }
  return options;
}

function setExclusive(current, next, flag) {
  if (current && current !== next) {
    throw new Error(`${flag} conflicts with --${current}`);
  }
  return next;
}

function printHelp() {
  console.log(`Usage: clean-room-skill [runtime] [scope] [options]
       clean-room-skill init [options]
       clean-room-skill status [runtime] [scope] [options]
       clean-room-skill update [runtime] [scope] [options]
       clean-room-skill preflight [options]
       clean-room-skill run [options]

Commands:
  init                Create clean-room bootstrap folders and repo guidance
  status              Report installed runtime version, drift, and hook state
  update              Update installed runtime files without onboarding
  preflight           Create or validate a preflight goal contract
  doctor              Smoke test generated Codex or Claude hook registration
  run                 Execute the bounded inner clean-room controller loop

Runtime:
  --codex              Install for Codex
  --claude             Install for Claude Code
  --antigravity        Install for Antigravity
  --gemini             Install for Gemini CLI
  --opencode           Install for OpenCode
  --kilo               Install for Kilo
  --cursor             Install for Cursor
  --copilot            Install for GitHub Copilot
  --windsurf           Install for Windsurf
  --augment            Install for Augment
  --trae               Install for Trae
  --qwen               Install for Qwen Code
  --hermes             Install for Hermes Agent
  --codebuddy          Install for CodeBuddy
  --all                Install for all known runtime layouts

Scope:
  --global             Install to the runtime user config
  --local              Install to the current project config

Options:
  --hooks=<mode>       safe, copy-only, or strict (default: safe)
  --no-hooks           Alias for --hooks=copy-only
  --config-dir <path>  Override the target root for one runtime
  --dry-run            Print actions without writing files
  --yes                Non-interactive mode; unknown conflicts still abort
  --uninstall          Remove manifest-managed files and clean-room hook entries

Run without runtime and scope flags for interactive install or uninstall.
Interactive runtime selection accepts names, numbers, ranges, all, or installed.
`);
}

function operationForOptions(options) {
  if (options.operation) return options.operation;
  return options.uninstall ? 'uninstall' : 'install';
}

async function resolveInteractiveOptions(options) {
  if (options.runtimes.length > 0 && options.scope) {
    return options;
  }
  if (!process.stdin.isTTY || options.yes) {
    throw new Error('specify runtime and scope flags when running non-interactively');
  }
  return runInstallerTui(options);
}

async function runInstallerTui(options) {
  const React = await import('react');
  const ink = await import('ink');
  const h = React.createElement;

  return new Promise((resolve, reject) => {
    let result = null;
    let error = null;
    let instance = null;

    function complete(nextOptions) {
      result = nextOptions;
    }

    function abort(err) {
      error = err;
    }

    function App() {
      return h(InstallerTui, {
        React,
        ink,
        h,
        initialOptions: options,
        onComplete: complete,
        onAbort: abort,
      });
    }

    instance = ink.render(h(App), {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exitOnCtrlC: false,
    });

    instance.waitUntilExit().then(() => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result || options);
    }, reject);
  });
}

function InstallerTui({ React, ink, h, initialOptions, onComplete, onAbort }) {
  const { Box, Text, useApp, useInput } = ink;
  const { useMemo, useState } = React;
  const { exit } = useApp();
  const initialFlags = useMemo(() => ({
    actionResolved: !!initialOptions.operation ||
      !(initialOptions.runtimes.length === 0 && !initialOptions.uninstall),
    promptedRuntimes: false,
    uninstallConfirmed: true,
  }), [initialOptions]);
  const [draft, setDraft] = useState(() => ({
    ...initialOptions,
    runtimes: [...initialOptions.runtimes],
  }));
  const [flags, setFlags] = useState(initialFlags);
  const [stage, setStage] = useState(() => nextTuiStage(initialOptions, initialFlags));

  function fail(message) {
    onAbort(new Error(message));
    exit();
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      fail('aborted by user');
    }
  });

  function advance(nextDraft, nextFlags = {}) {
    const mergedFlags = { ...flags, ...nextFlags };
    const nextStage = nextTuiStage(nextDraft, mergedFlags);
    setDraft(nextDraft);
    setFlags(mergedFlags);
    if (nextStage === 'complete') {
      onComplete(nextDraft);
      exit();
      return;
    }
    setStage(nextStage);
  }

  const action = operationForOptions(draft);

  return h(Box, { flexDirection: 'column', gap: 1 },
    h(Box, { flexDirection: 'column' },
      h(Text, { bold: true }, 'clean-room-skill installer'),
      h(Text, { dimColor: true }, 'Use arrows or j/k to move. Enter selects. Ctrl+C cancels.')
    ),
    stage === 'action' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Action',
      initialIndex: defaultActionIndex(draft),
      items: [
        { label: 'Update', value: 'update', detail: 'refresh installed runtimes without onboarding' },
        { label: 'Install', value: 'install', detail: 'add or repair runtime files' },
        { label: 'Uninstall', value: 'uninstall', detail: 'remove managed files and generated hooks' },
        { label: 'Status', value: 'status', detail: 'inspect runtime installs without changing files' },
      ],
      onSubmit: (item) => advance({
        ...draft,
        operation: item.value,
        uninstall: item.value === 'uninstall',
      }, {
        actionResolved: true,
        uninstallConfirmed: item.value !== 'uninstall',
      }),
    }),
    stage === 'scope' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Scope',
      items: [
        { label: 'Global', value: 'global', detail: 'runtime user config' },
        { label: 'Local', value: 'local', detail: 'current project config' },
      ],
      onSubmit: (item) => advance({ ...draft, scope: item.value }),
    }),
    stage === 'runtimes' && h(RuntimeMultiSelect, {
      React,
      Box,
      Text,
      useInput,
      h,
      action,
      statuses: runtimeInstallStatuses(draft.scope, draft.configDir),
      onSubmit: (runtimes) => advance({ ...draft, runtimes }, {
        promptedRuntimes: true,
        uninstallConfirmed: operationForOptions(draft) !== 'uninstall',
      }),
    }),
    stage === 'confirm-uninstall' && h(ConfirmUninstall, {
      React,
      Box,
      Text,
      useInput,
      h,
      runtimes: draft.runtimes,
      onSubmit: () => advance(draft, { uninstallConfirmed: true }),
    }),
    stage === 'hooks' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Hook mode',
      items: [
        { label: 'Safe', value: 'safe', detail: 'enforces during clean-room role sessions' },
        { label: 'Copy-only', value: 'copy-only', detail: 'copy scripts without host hook registration' },
        { label: 'Strict', value: 'strict', detail: 'fail closed in dedicated Codex or Claude homes' },
      ],
      onSubmit: (item) => advance({ ...draft, hookMode: item.value, hookModeSpecified: true }),
    })
  );
}

function runtimeInstallStatuses(scope, configDir) {
  return RUNTIMES.map((runtime) => runtimeInstallStatus(runtime, scope, configDir));
}

function defaultActionIndex(options) {
  if (operationForOptions(options) === 'status') return 3;
  if (operationForOptions(options) === 'uninstall') return 2;
  if (runtimeInstallStatuses(options.scope || 'global', options.configDir).some((status) => status.state === 'installed')) {
    return 0;
  }
  return 1;
}

function runtimeInstallStatus(runtime, scope, configDir) {
  const layout = resolveRuntimeLayout(runtime, scope, { configDir });
  const status = {
    runtime,
    targetRoot: layout.targetRoot,
    state: 'not-installed',
    detail: 'not installed',
  };
  try {
    const manifest = readManifest(layout.targetRoot);
    if (manifest) {
      const phase = manifest.phase ? `phase ${manifest.phase}` : 'manifest present';
      const hooksMode = manifest.hooks_mode ? `, hooks ${manifest.hooks_mode}` : '';
      return {
        ...status,
        state: 'installed',
        detail: `${phase}${hooksMode}`,
      };
    }
  } catch (err) {
    return {
      ...status,
      state: 'error',
      detail: err.message,
    };
  }

  if (!layout.supportsHookRegistration) {
    return status;
  }
  const configPath = configPathForRuntime(runtime, layout.targetRoot);
  if (!configPath) {
    return status;
  }
  try {
    if (hasManagedHookEntries(configPath)) {
      return {
        ...status,
        state: 'hooks-only',
        detail: 'managed hooks without install manifest',
      };
    }
  } catch (err) {
    return {
      ...status,
      state: 'error',
      detail: err.message,
    };
  }
  return status;
}

function printRuntimeChoices(statuses) {
  console.log('Runtime choices:');
  statuses.forEach((status, index) => {
    const number = String(index + 1).padStart(2, ' ');
    const runtime = status.runtime.padEnd(12, ' ');
    console.log(`  ${number}. ${runtime} ${status.detail} (${displayPath(status.targetRoot)})`);
  });
}

function defaultRuntimeSelectionLabel(statuses, action) {
  if ((action === 'uninstall' || action === 'update') && defaultRuntimeSelections(statuses, action).length > 0) {
    return 'installed';
  }
  return 'codex';
}

function defaultRuntimeSelections(statuses, action = 'install') {
  if (action === 'uninstall') {
    return statuses.filter((status) => isInstalledStatus(status)).map((status) => status.runtime);
  }
  if (action === 'update') {
    return selectableRuntimeSelections(statuses, action);
  }
  if (action === 'status') {
    return statuses.map((status) => status.runtime);
  }
  return ['codex'];
}

function detectedRuntimeSelections(statuses, action = 'install') {
  if (action === 'update') {
    return selectableRuntimeSelections(statuses, action);
  }
  return statuses.filter((status) => isInstalledStatus(status)).map((status) => status.runtime);
}

function isUpdateTargetStatus(status) {
  return status?.state === 'installed' || status?.state === 'update-available';
}

function isSelectableRuntimeStatus(status, action = 'install') {
  if (action === 'update') {
    return isUpdateTargetStatus(status);
  }
  return true;
}

function selectableRuntimeSelections(statuses, action = 'install') {
  return statuses
    .filter((status) => isSelectableRuntimeStatus(status, action))
    .map((status) => status.runtime);
}

function statusForRuntime(statuses, runtime) {
  return statuses.find((status) => status.runtime === runtime) || {
    runtime,
    state: 'not-installed',
  };
}

function unavailableRuntimeSelectionMessage(status, action) {
  if (action === 'update') {
    return `${status.runtime} is not installed in this scope; choose Install to add it.`;
  }
  return `${status.runtime} cannot be selected for ${action}.`;
}

function emptyRuntimeSelectionMessage(statuses, action) {
  if (action === 'update' && selectableRuntimeSelections(statuses, action).length === 0) {
    return 'No installed runtimes detected for update. Choose Install instead.';
  }
  return 'Select at least one runtime.';
}

function addRuntimeSelection(selected, runtime, statuses, action) {
  const status = statusForRuntime(statuses, runtime);
  if (!isSelectableRuntimeStatus(status, action)) {
    throw new Error(unavailableRuntimeSelectionMessage(status, action));
  }
  selected.push(runtime);
}

function parseRuntimeSelection(answer, statuses, action = 'install') {
  const text = answer.trim().toLowerCase();
  if (text === '') {
    if (action === 'uninstall' || action === 'update') {
      const installed = defaultRuntimeSelections(statuses, action);
      if (installed.length === 0) {
        throw new Error('no installed runtimes detected; select a runtime explicitly');
      }
      return installed;
    }
    return ['codex'];
  }

  const selected = [];
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    if (token === 'all') {
      selected.push(...(action === 'update' ? selectableRuntimeSelections(statuses, action) : RUNTIMES));
      continue;
    }
    if (token === 'installed') {
      selected.push(...detectedRuntimeSelections(statuses, action));
      continue;
    }
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) {
        throw new Error(`invalid runtime range: ${token}`);
      }
      for (let index = start; index <= end; index += 1) {
        addRuntimeSelection(selected, runtimeForSelectionIndex(statuses, index), statuses, action);
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      addRuntimeSelection(selected, runtimeForSelectionIndex(statuses, Number(token)), statuses, action);
      continue;
    }
    if (RUNTIMES.includes(token)) {
      addRuntimeSelection(selected, token, statuses, action);
      continue;
    }
    throw new Error(`unsupported runtime selection: ${token}`);
  }
  const unique = [...new Set(selected)];
  if (unique.length === 0) {
    throw new Error('no runtimes selected');
  }
  return unique;
}

function runtimeForSelectionIndex(statuses, index) {
  if (!Number.isInteger(index) || index < 1 || index > statuses.length) {
    throw new Error(`runtime selection out of range: ${index}`);
  }
  return statuses[index - 1].runtime;
}

function isInstalledStatus(status) {
  return status.state === 'installed' || status.state === 'hooks-only';
}

function nextTuiStage(options, flags) {
  if (!options.scope) {
    return 'scope';
  }
  if (!flags.actionResolved) {
    return 'action';
  }
  if (operationForOptions(options) === 'status') {
    return 'complete';
  }
  if (options.runtimes.length === 0) {
    return 'runtimes';
  }
  if (operationForOptions(options) === 'uninstall' && flags.promptedRuntimes && !flags.uninstallConfirmed) {
    return 'confirm-uninstall';
  }
  if (operationForOptions(options) === 'install' && !options.hookModeSpecified) {
    return 'hooks';
  }
  return 'complete';
}

function SingleChoice({ React, Box, Text, useInput, h, title, items, initialIndex = 0, onSubmit }) {
  const [index, setIndex] = React.useState(initialIndex);
  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setIndex((current) => Math.max(0, current - 1));
    } else if (key.downArrow || input === 'j') {
      setIndex((current) => Math.min(items.length - 1, current + 1));
    } else if (key.home) {
      setIndex(0);
    } else if (key.end) {
      setIndex(items.length - 1);
    } else if (key.return || /[\r\n]/.test(input)) {
      onSubmit(items[index]);
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, title),
    ...items.map((item, itemIndex) => h(Text, {
      key: item.value,
      color: itemIndex === index ? 'cyan' : undefined,
    }, `${itemIndex === index ? '>' : ' '} ${item.label.padEnd(10)} ${item.detail}`))
  );
}

function RuntimeMultiSelect({ React, Box, Text, useInput, h, action, statuses, onSubmit }) {
  const initialSelected = React.useMemo(() => new Set(defaultRuntimeSelections(statuses, action)), [statuses, action]);
  const [index, setIndex] = React.useState(0);
  const [selected, setSelected] = React.useState(initialSelected);
  const [error, setError] = React.useState('');

  function toggle(status) {
    setError('');
    if (!isSelectableRuntimeStatus(status, action)) {
      setError(unavailableRuntimeSelectionMessage(status, action));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(status.runtime)) {
        next.delete(status.runtime);
      } else {
        next.add(status.runtime);
      }
      return next;
    });
  }

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setIndex((current) => Math.max(0, current - 1));
    } else if (key.downArrow || input === 'j') {
      setIndex((current) => Math.min(statuses.length - 1, current + 1));
    } else if (key.home) {
      setIndex(0);
    } else if (key.end) {
      setIndex(statuses.length - 1);
    } else if (input === ' ') {
      toggle(statuses[index]);
    } else if (input === 'a') {
      setError('');
      setSelected(new Set(action === 'update' ? selectableRuntimeSelections(statuses, action) : RUNTIMES));
    } else if (input === 'i') {
      setError('');
      setSelected(new Set(detectedRuntimeSelections(statuses, action)));
    } else if (key.return || /[\r\n]/.test(input)) {
      const runtimes = RUNTIMES.filter((runtime) => selected.has(runtime));
      if (runtimes.length === 0) {
        setError(emptyRuntimeSelectionMessage(statuses, action));
        return;
      }
      onSubmit(runtimes);
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, `Runtimes to ${action}`),
    h(Text, { dimColor: true }, `${action === 'update' ? 'Space toggles installed runtimes. a selects installed runtimes.' : 'Space toggles. a selects all.'} i selects detected installs. Enter continues.`),
    ...statuses.map((status, itemIndex) => {
      const checked = selected.has(status.runtime) ? '[x]' : '[ ]';
      const cursor = itemIndex === index ? '>' : ' ';
      return h(Text, {
        key: status.runtime,
        color: itemIndex === index ? 'cyan' : undefined,
      }, `${cursor} ${checked} ${status.runtime.padEnd(12)} ${status.detail} (${displayPath(status.targetRoot)})`);
    }),
    error ? h(Text, { color: 'red' }, error) : null
  );
}

function ConfirmUninstall({ React, Box, Text, useInput, h, runtimes, onSubmit }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');

  useInput((input, key) => {
    const submit = key.return || /[\r\n]/.test(input);
    if (submit) {
      const printable = input.replace(/[^\x20-\x7E]/g, '');
      const nextText = `${text}${printable}`;
      if (nextText.trim().toLowerCase() === 'uninstall') {
        onSubmit();
        return;
      }
      setError('Type uninstall to continue.');
    } else if (key.backspace || key.delete) {
      setError('');
      setText((current) => current.slice(0, -1));
    } else if (!key.ctrl && input) {
      const printable = input.replace(/[^\x20-\x7E]/g, '');
      if (printable) {
        setError('');
        setText((current) => `${current}${printable}`);
      }
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true, color: 'yellow' }, 'Confirm uninstall'),
    h(Text, null, `Selected runtimes: ${runtimes.join(', ')}`),
    h(Text, { dimColor: true }, 'Only manifest-managed files and generated clean-room hook entries are removed.'),
    h(Text, null, `Type uninstall: ${text}`),
    error ? h(Text, { color: 'red' }, error) : null
  );
}

function displayPath(filePath) {
  const home = process.env.HOME;
  if (home && filePath === home) {
    return '~';
  }
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, filePath)}`;
  }
  return filePath;
}

function usesClaudeGlobalPlugin(layout) {
  return layout.runtime === 'claude' && layout.scope === 'global';
}

function claudePluginSource() {
  return `${CLAUDE_PLUGIN_SOURCE_URL}#v${packageVersion()}`;
}

function truncateCommandOutput(value) {
  const text = String(value || '').trim();
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000)}...`;
}

function claudePluginEnv(layout) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: layout.targetRoot,
  };
}

function claudeCommandLabel(args) {
  return ['claude', ...args].join(' ');
}

function claudePluginCommandFailure(args, result) {
  const parts = [`Claude plugin command failed: ${claudeCommandLabel(args)}`];
  if (result.error) {
    parts.push(result.error.message);
  }
  if (result.status !== null && result.status !== undefined) {
    parts.push(`status ${result.status}`);
  }
  if (result.signal) {
    parts.push(`signal ${result.signal}`);
  }
  const stdout = truncateCommandOutput(result.stdout);
  const stderr = truncateCommandOutput(result.stderr);
  if (stdout) parts.push(`stdout: ${stdout}`);
  if (stderr) parts.push(`stderr: ${stderr}`);
  return parts.join('; ');
}

function runClaudePluginCommand(layout, args, options = {}) {
  const result = spawnSync('claude', args, {
    encoding: 'utf8',
    env: claudePluginEnv(layout),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLAUDE_PLUGIN_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(claudePluginCommandFailure(args, result));
  }
  if (!options.silent) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function readClaudePluginJson(layout, args) {
  const result = runClaudePluginCommand(layout, args, { silent: true });
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(
      `Claude plugin command returned invalid JSON: ${claudeCommandLabel(args)}; ` +
      `stdout: ${truncateCommandOutput(result.stdout)}; ${err.message}`
    );
  }
}

function claudeMarketplaceExists(layout) {
  return readClaudePluginJson(layout, ['plugin', 'marketplace', 'list', '--json'])
    .some((entry) => entry && entry.name === CLAUDE_PLUGIN_MARKETPLACE_NAME);
}

function claudePluginEntry(layout) {
  return readClaudePluginJson(layout, ['plugin', 'list', '--json'])
    .find((entry) => entry && entry.id === CLAUDE_PLUGIN_ID) || null;
}

function claudePluginExists(layout) {
  return Boolean(claudePluginEntry(layout));
}

function claudePluginMetadata(manifest, state = {}) {
  const previous = manifest?.claude_plugin || {};
  const metadata = {
    plugin_id: CLAUDE_PLUGIN_ID,
    plugin_name: CLAUDE_PLUGIN_NAME,
    marketplace_name: CLAUDE_PLUGIN_MARKETPLACE_NAME,
    source_url: CLAUDE_PLUGIN_SOURCE_URL,
    source: claudePluginSource(),
    scope: CLAUDE_PLUGIN_SCOPE,
    version: packageVersion(),
    marketplace_added_by_installer: previous.marketplace_added_by_installer === true ||
      state.marketplaceAdded === true,
    plugin_installed_by_installer: previous.plugin_installed_by_installer === true ||
      state.pluginInstalled === true,
    recorded_at: new Date().toISOString(),
  };
  if (state.installPath || previous.install_path) {
    metadata.install_path = state.installPath || previous.install_path;
  }
  return metadata;
}

function ensureClaudeGlobalPlugin(layout, manifest, options, action) {
  if (!usesClaudeGlobalPlugin(layout)) return null;

  const source = claudePluginSource();
  if (options.dryRun) {
    const marketplaceVerb = action === 'update' ? 'refresh' : 'add';
    const pluginVerb = action === 'update' ? 'update or install' : 'install';
    console.log(`  Claude plugin marketplace: would ${marketplaceVerb} ${source}`);
    console.log(`  Claude plugin: would ${pluginVerb} ${CLAUDE_PLUGIN_ID}`);
    return claudePluginMetadata(manifest);
  }

  const marketplaceWasPresent = claudeMarketplaceExists(layout);
  console.log(`  Claude plugin marketplace: ${source}`);
  runClaudePluginCommand(layout, [
    'plugin',
    'marketplace',
    'add',
    source,
    '--scope',
    CLAUDE_PLUGIN_SCOPE,
  ]);

  const pluginBefore = claudePluginEntry(layout);
  const pluginWasPresent = Boolean(pluginBefore);
  if (action === 'update' && pluginWasPresent) {
    console.log(`  Claude plugin: updating ${CLAUDE_PLUGIN_ID}`);
    runClaudePluginCommand(layout, ['plugin', 'update', CLAUDE_PLUGIN_ID]);
  } else if (!pluginWasPresent) {
    console.log(`  Claude plugin: installing ${CLAUDE_PLUGIN_ID}`);
    runClaudePluginCommand(layout, [
      'plugin',
      'install',
      CLAUDE_PLUGIN_ID,
      '--scope',
      CLAUDE_PLUGIN_SCOPE,
    ]);
  } else {
    console.log(`  Claude plugin: already installed ${CLAUDE_PLUGIN_ID}`);
  }

  const pluginAfter = claudePluginEntry(layout) || pluginBefore;
  return claudePluginMetadata(manifest, {
    marketplaceAdded: !marketplaceWasPresent,
    pluginInstalled: !pluginWasPresent,
    installPath: pluginAfter?.installPath,
  });
}

function removeClaudeGlobalPlugin(layout, manifest, options) {
  if (!usesClaudeGlobalPlugin(layout)) return;
  const plugin = manifest?.claude_plugin;
  if (!plugin) return;

  if (options.dryRun) {
    if (plugin.plugin_installed_by_installer) {
      console.log(`  Claude plugin: would uninstall ${plugin.plugin_id || CLAUDE_PLUGIN_ID}`);
    }
    if (plugin.marketplace_added_by_installer) {
      console.log(`  Claude plugin marketplace: would remove ${plugin.marketplace_name || CLAUDE_PLUGIN_MARKETPLACE_NAME}`);
    }
    return;
  }

  if (plugin.plugin_installed_by_installer) {
    const pluginId = plugin.plugin_id || CLAUDE_PLUGIN_ID;
    if (claudePluginExists(layout)) {
      console.log(`  Claude plugin: uninstalling ${pluginId}`);
      runClaudePluginCommand(layout, ['plugin', 'uninstall', pluginId]);
    } else {
      console.log(`  Claude plugin: already absent ${pluginId}`);
    }
  }

  if (plugin.marketplace_added_by_installer) {
    const marketplaceName = plugin.marketplace_name || CLAUDE_PLUGIN_MARKETPLACE_NAME;
    if (claudeMarketplaceExists(layout)) {
      console.log(`  Claude plugin marketplace: removing ${marketplaceName}`);
      runClaudePluginCommand(layout, ['plugin', 'marketplace', 'remove', marketplaceName]);
    } else {
      console.log(`  Claude plugin marketplace: already absent ${marketplaceName}`);
    }
  }
}

function collectRuntimeStatus(runtime, scope, configDir) {
  const layout = resolveRuntimeLayout(runtime, scope, { configDir });
  const base = {
    runtime,
    scope,
    targetRoot: layout.targetRoot,
    supportsHookRegistration: layout.supportsHookRegistration,
    state: 'not-installed',
    detail: 'not installed',
    installedVersion: null,
    currentVersion: packageVersion(),
    hooksMode: null,
    phase: null,
    files: 0,
    missing: 0,
    modified: 0,
    stale: 0,
    unknownConflicts: 0,
    hookRegistration: layout.supportsHookRegistration ? 'none' : 'unsupported',
    updateAvailable: false,
    claudePlugin: null,
    issues: [],
  };

  let manifest;
  try {
    manifest = readManifest(layout.targetRoot);
  } catch (err) {
    return {
      ...base,
      state: 'error',
      detail: err.message,
      issues: [err.message],
    };
  }

  const configPath = configPathForRuntime(runtime, layout.targetRoot);
  const hookState = detectHookRegistration(layout, configPath);
  if (!manifest) {
    if (hookState === 'present') {
      return {
        ...base,
        state: 'hooks-only',
        detail: 'managed hooks without install manifest',
        hookRegistration: 'present',
        issues: ['managed hooks exist without an install manifest'],
      };
    }
    return base;
  }

  const hooksMode = manifest.hooks_mode || 'safe';
  let desired;
  let plan;
  let fileStats;
  try {
    desired = buildDesiredFiles(layout, hooksMode);
    plan = planInstall(layout.targetRoot, desired, manifest);
    fileStats = manifestFileStats(layout.targetRoot, manifest);
  } catch (err) {
    return {
      ...base,
      state: 'error',
      detail: err.message,
      installedVersion: manifest.version || null,
      hooksMode,
      phase: manifest.phase || null,
      hookRegistration: hookState,
      issues: [err.message],
    };
  }
  const issues = [];
  if (manifest.phase && manifest.phase !== 'complete') {
    issues.push(`manifest phase is ${manifest.phase}`);
  }
  if (fileStats.missing > 0) {
    issues.push(`${fileStats.missing} managed file(s) missing`);
  }
  if (fileStats.modified > 0) {
    issues.push(`${fileStats.modified} managed file(s) locally modified`);
  }
  if (plan.removals.length > 0) {
    issues.push(`${plan.removals.length} stale managed file(s)`);
  }
  if (plan.unknownConflicts.length > 0) {
    issues.push(`${plan.unknownConflicts.length} unmanaged package-path conflict(s)`);
  }
  if (layout.supportsHookRegistration && hooksMode !== 'copy-only' && hookState !== 'present') {
    issues.push('managed hook registration missing');
  }

  const updateAvailable = manifest.version !== packageVersion() ||
    plan.removals.length > 0 ||
    plan.unknownConflicts.length > 0 ||
    fileStats.missing > 0;

  return {
    ...base,
    state: updateAvailable ? 'update-available' : 'installed',
    detail: updateAvailable ? 'update available' : 'installed',
    installedVersion: manifest.version || null,
    hooksMode,
    phase: manifest.phase || null,
    files: Object.keys(manifest.files || {}).length,
    missing: fileStats.missing,
    modified: fileStats.modified,
    stale: plan.removals.length,
    unknownConflicts: plan.unknownConflicts.length,
    hookRegistration: hookState,
    updateAvailable,
    claudePlugin: manifest.claude_plugin || null,
    issues,
  };
}

function detectHookRegistration(layout, configPath) {
  if (!layout.supportsHookRegistration) {
    return 'unsupported';
  }
  if (!configPath) {
    return 'unsupported';
  }
  try {
    return hasManagedHookEntries(configPath) ? 'present' : 'missing';
  } catch (err) {
    return `error: ${err.message}`;
  }
}

function manifestFileStats(targetRoot, manifest) {
  let missing = 0;
  let modified = 0;
  for (const relPath of Object.keys(manifest?.files || {})) {
    const fullPath = assertManagedPath(targetRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      missing += 1;
      continue;
    }
    const expected = manifestHash(manifest, relPath);
    if (expected && fileHash(fullPath) !== expected) {
      modified += 1;
    }
  }
  return { missing, modified };
}

function printStatusReport(statuses) {
  console.log(`clean-room-skill package version: ${packageVersion()}`);
  for (const status of statuses) {
    console.log(`${status.runtime} (${status.scope}) ${status.state}`);
    console.log(`  target: ${status.targetRoot}`);
    if (status.installedVersion) {
      console.log(`  version: ${status.installedVersion}${status.installedVersion !== status.currentVersion ? ` -> ${status.currentVersion}` : ''}`);
      console.log(`  phase: ${status.phase || 'unknown'}`);
      console.log(`  hooks: ${status.hooksMode || 'unknown'}; registration ${status.hookRegistration}`);
      console.log(`  files: ${status.files}; missing ${status.missing}; modified ${status.modified}; stale ${status.stale}; conflicts ${status.unknownConflicts}`);
      if (status.claudePlugin) {
        console.log(`  plugin: ${status.claudePlugin.plugin_id || CLAUDE_PLUGIN_ID}; marketplace ${status.claudePlugin.marketplace_name || CLAUDE_PLUGIN_MARKETPLACE_NAME}`);
      }
    } else if (status.hookRegistration === 'present') {
      console.log('  hooks: managed hook registration present without install manifest');
    }
    if (status.issues.length > 0) {
      console.log(`  issues: ${status.issues.join('; ')}`);
    }
  }
}

function selectedStatusRuntimes(options) {
  return options.runtimes.length > 0 ? options.runtimes : [...RUNTIMES];
}

function selectedUpdateRuntimes(options) {
  if (options.runtimes.length > 0) {
    return options.runtimes;
  }
  return runtimeInstallStatuses(options.scope, options.configDir)
    .filter((status) => isUpdateTargetStatus(status))
    .map((status) => status.runtime);
}

function runStatus(options) {
  const runtimes = selectedStatusRuntimes(options);
  const statuses = runtimes.map((runtime) =>
    collectRuntimeStatus(runtime, options.scope, options.configDir)
  );
  printStatusReport(statuses);
  return statuses;
}

function resolveTargetRoot(runtime, scope, configDir) {
  return resolveRuntimeLayout(runtime, scope, { configDir }).targetRoot;
}

async function confirmUnknownConflicts(conflicts, options) {
  if (conflicts.length === 0) return false;
  if (options.dryRun) return false;
  if (options.yes || !process.stdin.isTTY) {
    throw new Error(
      `unknown existing file(s) would be overwritten: ${conflicts.join(', ')}. ` +
      'Run interactively to confirm or remove the conflict.'
    );
  }
  console.log('Unknown existing files would be overwritten:');
  for (const conflict of conflicts) {
    console.log(`  ${conflict}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Overwrite these files? Type yes to continue: ');
    if (answer.trim() !== 'yes') {
      throw new Error('aborted by user');
    }
    return true;
  } finally {
    rl.close();
  }
}

function resolvePython3() {
  const result = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PYTHON_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error('python3 is required to install clean-room hooks');
  }
  const pythonPath = String(result.stdout || '').trim();
  if (!path.isAbsolute(pythonPath)) {
    throw new Error('python3 did not resolve to an absolute executable path');
  }
  return pythonPath;
}

function validateRuntimeOptions(options) {
  if (options.configDir && options.runtimes.length > 1) {
    throw new Error('--config-dir can only be used with one runtime');
  }
  for (const runtime of options.runtimes) {
    const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
    if (options.hookMode === 'strict' && !layout.supportsHookRegistration) {
      throw new Error(`--hooks=strict is not supported for ${runtime}; hook registration is verified only for codex and claude`);
    }
  }
}

function prepareHookRegistration(layout, hookMode, options = {}) {
  if (hookMode === 'copy-only') {
    return { status: 'copy-only' };
  }
  if (!layout.supportsHookRegistration) {
    return { status: 'unsupported' };
  }
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return { status: 'unsupported' };
  if (options.dryRun) {
    return { status: 'planned', configPath };
  }
  const pythonPath = resolvePython3();
  const wrapperPath = path.join(layout.targetRoot, 'hooks', 'clean-room', 'clean-room-hook.py');
  const entries = buildHookEntries({ pythonPath, wrapperPath, mode: hookMode });
  return { status: 'registered', configPath, entries };
}

function hookRegistrationFailureState(hookResult, err) {
  return {
    hook_registration: {
      status: 'failed',
      config_path: hookResult.configPath,
      error: err.message,
      recorded_at: new Date().toISOString(),
    },
  };
}

function partialInstallMessage(targetRoot, state, cause) {
  const causeMessage = cause && cause.message ? cause.message : String(cause);
  const parts = [
    `partial install state for ${targetRoot}`,
    state.files,
    state.hooks,
    state.manifest,
    state.recovery,
  ].filter(Boolean);
  return `${parts.join('; ')}. Cause: ${causeMessage}`;
}

async function installRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
  await withTargetInstallLock(targetRoot, options.dryRun, async () => {
    const manifest = readManifest(targetRoot);
    const desired = buildDesiredFiles(layout, options.hookMode);
    const plan = planInstall(targetRoot, desired, manifest);
    const adoptedUnknowns = await confirmUnknownConflicts(plan.unknownConflicts, options);

    const verb = options.operation === 'update' ? 'update' : 'install';
    console.log(`${options.dryRun ? `Would ${verb}` : activeVerb(verb)} ${runtime} to ${targetRoot}`);
    console.log(`  files: ${plan.writes.length}`);
    if (plan.removals.length) console.log(`  stale managed removals: ${plan.removals.length}`);
    if (plan.backups.length || adoptedUnknowns) {
      console.log(`  backups: ${plan.backups.length + (adoptedUnknowns ? plan.unknownConflicts.length : 0)}`);
    }
    if (options.dryRun && plan.unknownConflicts.length) {
      console.log(`  unknown conflicts: ${plan.unknownConflicts.length}`);
    }

    const hookResult = prepareHookRegistration(layout, options.hookMode, { dryRun: options.dryRun });
    const pluginState = ensureClaudeGlobalPlugin(layout, manifest, options, verb);
    const installState = pluginState ? { claude_plugin: pluginState } : {};
    // Install order is files, installing manifest, hook config, then complete manifest.
    // The installing manifest gives repair/uninstall a durable handle if hook config write fails.
    let result;
    try {
      result = applyInstall(targetRoot, desired, manifest, plan, options);
    } catch (err) {
      throw new Error(partialInstallMessage(targetRoot, {
        files: 'managed files may be partially written',
        hooks: 'hook config was not updated',
        manifest: 'install manifest was not written',
        recovery: 're-run the same install command after fixing the filesystem error',
      }, err));
    }
    if (result) {
      try {
        writeInstallManifest(targetRoot, result.manifest, runtime, options.scope, options.hookMode, options.dryRun, {
          phase: 'installing',
          ...installState,
        });
      } catch (err) {
        throw new Error(partialInstallMessage(targetRoot, {
          files: 'managed files were written',
          hooks: 'hook config was not updated',
          manifest: 'install manifest was not written',
          recovery: 're-run the same install command to repair manifest tracking before uninstalling',
        }, err));
      }
    }

    let hookConfigWritten = false;
    if (!options.dryRun && hookResult.status === 'registered') {
      try {
        mergeHookEntries(hookResult.configPath, hookResult.entries);
        hookConfigWritten = true;
      } catch (err) {
        let manifestStatus = 'install manifest records phase installing';
        if (result) {
          try {
            writeInstallManifest(
              targetRoot,
              result.manifest,
              runtime,
              options.scope,
                options.hookMode,
                false,
                {
                  phase: 'installing',
                  ...installState,
                  ...hookRegistrationFailureState(hookResult, err),
                }
              );
            manifestStatus = 'install manifest records the failed hook registration';
          } catch {
            manifestStatus = 'install manifest could not record the failed hook registration';
          }
        }
        throw new Error(partialInstallMessage(targetRoot, {
          files: 'managed files were written',
          hooks: 'hook config write failed',
          manifest: manifestStatus,
          recovery: 're-run the same install command to repair hook registration',
        }, err));
      }
    }
    if (hookResult.status === 'unsupported' && options.hookMode === 'safe') {
      console.log('  hook registration unsupported for this runtime; copied hooks only');
    }
    if (hookResult.status === 'planned') {
      console.log(`  hook registration: would update ${hookResult.configPath}`);
      console.log('  hook registration: python3 required when applying the install');
    }
    if (options.hookMode === 'safe') {
      console.log('  WARNING: safe hooks are installed; clean-room init/onboarding must set role environment variables before enforcement starts');
    }
    if (result) {
      try {
        writeInstallManifest(targetRoot, result.manifest, runtime, options.scope, options.hookMode, options.dryRun, {
          phase: 'complete',
          ...installState,
        });
      } catch (err) {
        throw new Error(partialInstallMessage(targetRoot, {
          files: 'managed files were written',
          hooks: hookConfigWritten ? 'hook config was updated' : 'hook config was not updated',
          manifest: hookConfigWritten ? 'install manifest was not completed' : 'install manifest was not written',
          recovery: 're-run the same install command to repair manifest tracking before uninstalling',
        }, err));
      }
      if (result.backupRoot) {
        console.log(`  backed up modified files to ${result.backupRoot}`);
      }
    }
  });
}

function activeVerb(verb) {
  if (verb === 'update') return 'Updating';
  return 'Installing';
}

async function updateRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const manifest = readManifest(layout.targetRoot);
  if (!manifest) {
    console.log(`${options.dryRun ? 'Would skip update' : 'Skipping update'} ${runtime} from ${layout.targetRoot}`);
    console.log('  no install manifest found');
    return;
  }
  const hookMode = options.hookModeSpecified ? options.hookMode : (manifest.hooks_mode || options.hookMode);
  await installRuntime(runtime, {
    ...options,
    operation: 'update',
    hookMode,
    hookModeSpecified: true,
  });
}

function removeHookRegistrations(layout, dryRun) {
  if (!layout.supportsHookRegistration) return null;
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return null;
  return removeHookEntries(configPath, { dryRun });
}

function desiredFilesForUninstall(layout, hookMode) {
  try {
    return buildDesiredFiles(layout, hookMode);
  } catch (err) {
    console.log(`  untracked file scan skipped: ${err.message}`);
    return new Map();
  }
}

async function uninstallRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
  if (!options.dryRun && !fs.existsSync(targetRoot)) {
    console.log(`Uninstalling ${runtime} from ${targetRoot}`);
    console.log('  no install manifest found');
    return;
  }
  await withTargetInstallLock(targetRoot, options.dryRun, async () => {
    const manifest = readManifest(targetRoot);
    console.log(`${options.dryRun ? 'Would uninstall' : 'Uninstalling'} ${runtime} from ${targetRoot}`);
    if (!manifest) {
      console.log('  no install manifest found');
      removeHookRegistrations(layout, options.dryRun);
      return;
    }
    const desired = desiredFilesForUninstall(layout, manifest.hooks_mode || options.hookMode);
    const plan = planUninstall(targetRoot, manifest, desired);
    console.log(`  managed removals: ${plan.removals.length}`);
    if (plan.backups.length) {
      console.log(`  backups: ${plan.backups.length}`);
    }
    if (plan.untracked.length) {
      console.log(`  untracked package-path files left in place: ${plan.untracked.length}`);
    }

    removeClaudeGlobalPlugin(layout, manifest, options);
    const result = applyUninstall(targetRoot, plan, options.dryRun);
    if (!options.dryRun) {
      removeHookRegistrations(layout, false);
    }
    if (result?.backupRoot) {
      console.log(`  backed up modified files to ${result.backupRoot}`);
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') {
    runInit(argv.slice(1));
    return;
  }
  if (argv[0] === 'doctor') {
    runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'preflight') {
    runPreflight(argv.slice(1));
    return;
  }
  if (argv[0] === 'run') {
    await runCleanRoom(parseRunArgs(argv.slice(1)));
    return;
  }
  if (argv[0] === 'status') {
    const options = parseArgs(argv.slice(1));
    options.operation = 'status';
    if (options.configDir && options.runtimes.length === 0) {
      throw new Error('--config-dir can only be used with one runtime');
    }
    if (!options.scope) options.scope = 'global';
    validateRuntimeOptions(options);
    runStatus(options);
    return;
  }
  if (argv[0] === 'update') {
    const options = parseArgs(argv.slice(1));
    options.operation = 'update';
    if (options.configDir && options.runtimes.length === 0) {
      throw new Error('--config-dir can only be used with one runtime');
    }
    if (!options.scope) options.scope = 'global';
    options.runtimes = selectedUpdateRuntimes(options);
    validateRuntimeOptions(options);
    if (options.runtimes.length === 0) {
      console.log(`No installed ${options.scope} runtimes found to update.`);
      return;
    }
    for (const runtime of options.runtimes) {
      await updateRuntime(runtime, options);
    }
    return;
  }
  const options = await resolveInteractiveOptions(parseArgs(argv));
  if (!options.scope) {
    options.scope = 'global';
  }
  validateRuntimeOptions(options);
  if (operationForOptions(options) === 'status') {
    if (options.runtimes.length === 0) options.runtimes = [...RUNTIMES];
    runStatus(options);
    return;
  }
  if (operationForOptions(options) === 'update') {
    options.runtimes = selectedUpdateRuntimes(options);
    if (options.runtimes.length === 0) {
      console.log(`No installed ${options.scope} runtimes found to update.`);
      return;
    }
  }
  for (const runtime of options.runtimes) {
    if (operationForOptions(options) === 'uninstall') {
      await uninstallRuntime(runtime, options);
    } else if (operationForOptions(options) === 'update') {
      await updateRuntime(runtime, options);
    } else {
      await installRuntime(runtime, options);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`clean-room-skill: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDesiredFiles,
  parseArgs,
  parsePreflightArgs,
  parseRuntimeSelection,
  planInstall,
  parseRunArgs,
  runInit,
  runPreflight,
  runCleanRoom,
  runStatus,
  runtimeInstallStatus,
  collectRuntimeStatus,
  resolveTargetRoot,
};
