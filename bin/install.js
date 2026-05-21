#!/usr/bin/env node
'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const {
  buildHookEntries,
  configPathForRuntime,
  mergeHookEntries,
  removeHookEntries,
  writeHookConfig,
} = require('../lib/hooks.cjs');
const {
  RUNTIMES,
  RUNTIME_FLAGS,
  resolveRuntimeLayout,
} = require('../lib/runtime-layout.cjs');
const { buildDesiredFiles } = require('../lib/install-artifacts.cjs');
const {
  applyInstall,
  applyUninstall,
  planInstall,
  planUninstall,
  readManifest,
  writeInstallManifest,
} = require('../lib/install-plan.cjs');

const HOOK_MODES = new Set(['safe', 'copy-only', 'strict']);

function parseArgs(argv) {
  const options = {
    runtimes: [],
    scope: null,
    dryRun: false,
    yes: false,
    uninstall: false,
    hookMode: 'safe',
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
    else if (arg === '--no-hooks') options.hookMode = 'copy-only';
    else if (arg === '--config-dir') {
      i += 1;
      if (i >= argv.length) throw new Error('--config-dir requires a path');
      options.configDir = argv[i];
    } else if (arg.startsWith('--config-dir=')) {
      options.configDir = arg.slice('--config-dir='.length);
    } else if (arg === '--hooks') {
      i += 1;
      if (i >= argv.length) throw new Error('--hooks requires safe, copy-only, or strict');
      options.hookMode = argv[i];
    } else if (arg.startsWith('--hooks=')) {
      options.hookMode = arg.slice('--hooks='.length);
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
`);
}

async function resolveInteractiveOptions(options) {
  if (options.runtimes.length > 0 && options.scope) {
    return options;
  }
  if (!process.stdin.isTTY || options.yes) {
    throw new Error('specify runtime and scope flags when running non-interactively');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (options.runtimes.length === 0) {
      const answer = await rl.question(`Runtime [${RUNTIMES.join('/')}/all]: `);
      const runtime = answer.trim().toLowerCase() || 'codex';
      if (runtime === 'all') options.runtimes = [...RUNTIMES];
      else if (RUNTIMES.includes(runtime)) options.runtimes = [runtime];
      else throw new Error(`unsupported runtime: ${answer}`);
    }
    if (!options.scope) {
      const answer = await rl.question('Scope [global/local]: ');
      const scope = answer.trim().toLowerCase() || 'global';
      if (scope !== 'global' && scope !== 'local') {
        throw new Error(`unsupported scope: ${answer}`);
      }
      options.scope = scope;
    }
    return options;
  } finally {
    rl.close();
  }
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
  for (const runtime of options.runtimes) {
    const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
    if (options.hookMode === 'strict' && !layout.supportsHookRegistration) {
      throw new Error(`--hooks=strict is not supported for ${runtime}; hook registration is verified only for codex and claude`);
    }
  }
}

function prepareHookRegistration(layout, hookMode) {
  if (hookMode === 'copy-only') {
    return { status: 'copy-only' };
  }
  if (!layout.supportsHookRegistration) {
    return { status: 'unsupported' };
  }
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return { status: 'unsupported' };
  const pythonPath = resolvePython3();
  const wrapperPath = path.join(layout.targetRoot, 'hooks', 'clean-room', 'clean-room-hook.py');
  const entries = buildHookEntries({ pythonPath, wrapperPath, mode: hookMode });
  const config = mergeHookEntries(configPath, entries, { dryRun: true });
  return { status: 'registered', configPath, config };
}

async function installRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
  const manifest = readManifest(targetRoot);
  const desired = buildDesiredFiles(layout, options.hookMode);
  const plan = planInstall(targetRoot, desired, manifest);
  const adoptedUnknowns = await confirmUnknownConflicts(plan.unknownConflicts, options);

  console.log(`${options.dryRun ? 'Would install' : 'Installing'} ${runtime} to ${targetRoot}`);
  console.log(`  files: ${plan.writes.length}`);
  if (plan.removals.length) console.log(`  stale managed removals: ${plan.removals.length}`);
  if (plan.backups.length || adoptedUnknowns) {
    console.log(`  backups: ${plan.backups.length + (adoptedUnknowns ? plan.unknownConflicts.length : 0)}`);
  }
  if (options.dryRun && plan.unknownConflicts.length) {
    console.log(`  unknown conflicts: ${plan.unknownConflicts.length}`);
  }

  const hookResult = prepareHookRegistration(layout, options.hookMode);
  const result = applyInstall(targetRoot, desired, manifest, plan, options);
  if (!options.dryRun && hookResult.status === 'registered') {
    writeHookConfig(hookResult.configPath, hookResult.config);
  }
  if (hookResult.status === 'unsupported' && options.hookMode === 'safe') {
    console.log('  hook registration unsupported for this runtime; copied hooks only');
  }
  if (result) {
    writeInstallManifest(targetRoot, result.manifest, runtime, options.scope, options.hookMode, options.dryRun);
    if (result.backupRoot) {
      console.log(`  backed up modified files to ${result.backupRoot}`);
    }
  }
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

function uninstallRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
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

  const result = applyUninstall(targetRoot, plan, options.dryRun);
  if (!options.dryRun) {
    removeHookRegistrations(layout, false);
  }
  if (result?.backupRoot) {
    console.log(`  backed up modified files to ${result.backupRoot}`);
  }
}

async function main() {
  const options = await resolveInteractiveOptions(parseArgs(process.argv.slice(2)));
  if (!options.scope) {
    options.scope = 'global';
  }
  validateRuntimeOptions(options);
  for (const runtime of options.runtimes) {
    if (options.uninstall) {
      uninstallRuntime(runtime, options);
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
  planInstall,
  resolveTargetRoot,
};
