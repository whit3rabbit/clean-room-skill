#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const { runInit } = require('../lib/bootstrap.cjs');
const { runDoctor } = require('../lib/doctor.cjs');
const { assertManagedPath } = require('../lib/fs-utils.cjs');
const { parsePreflightArgs, runPreflight } = require('../lib/preflight.cjs');
const { parseRunArgs, runCleanRoom } = require('../lib/run.cjs');
const {
  buildHookEntries,
  configPathForRuntime,
  mergeHookEntries,
  removeHookEntries,
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
const INSTALL_LOCK_NAME = '.clean-room-install.lock';
const INSTALL_LOCK_WAIT_MS = 30_000;
const INSTALL_LOCK_POLL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTargetInstallLock(targetRoot, dryRun, fn) {
  if (dryRun) {
    return fn();
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const lockPath = assertManagedPath(targetRoot, INSTALL_LOCK_NAME);
  const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;
  let locked = false;

  while (!locked) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(
          path.join(lockPath, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`,
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
      if (Date.now() >= deadline) {
        throw new Error(`install lock is held: ${lockPath}`);
      }
      await sleep(INSTALL_LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

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
       clean-room-skill init [options]
       clean-room-skill preflight [options]
       clean-room-skill run [options]

Commands:
  init                Create clean-room bootstrap folders and repo guidance
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

    console.log(`${options.dryRun ? 'Would install' : 'Installing'} ${runtime} to ${targetRoot}`);
    console.log(`  files: ${plan.writes.length}`);
    if (plan.removals.length) console.log(`  stale managed removals: ${plan.removals.length}`);
    if (plan.backups.length || adoptedUnknowns) {
      console.log(`  backups: ${plan.backups.length + (adoptedUnknowns ? plan.unknownConflicts.length : 0)}`);
    }
    if (options.dryRun && plan.unknownConflicts.length) {
      console.log(`  unknown conflicts: ${plan.unknownConflicts.length}`);
    }

    const hookResult = prepareHookRegistration(layout, options.hookMode, { dryRun: options.dryRun });
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
      console.log('  WARNING: safe hooks are installed but not enforcing until clean-room env vars, CLEAN_ROOM_HOOK_ENFORCE=1, or --hooks=strict are set');
    }
    if (result) {
      try {
        writeInstallManifest(targetRoot, result.manifest, runtime, options.scope, options.hookMode, options.dryRun, {
          phase: 'complete',
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
  const options = await resolveInteractiveOptions(parseArgs(argv));
  if (!options.scope) {
    options.scope = 'global';
  }
  validateRuntimeOptions(options);
  for (const runtime of options.runtimes) {
    if (options.uninstall) {
      await uninstallRuntime(runtime, options);
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
  planInstall,
  parseRunArgs,
  runInit,
  runPreflight,
  runCleanRoom,
  resolveTargetRoot,
};
