'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const { withDirectoryLock } = require('./dir-lock.cjs');
const { assertManagedPath, removeEmptyParents } = require('./fs-utils.cjs');
const {
  buildHookEntries,
  configPathForRuntime,
  hasManagedOpenCodePlugin,
  mergeHookEntries,
  pluginPathForRuntime,
  removeHookEntries,
} = require('./hooks.cjs');
const { buildDesiredFiles } = require('./install-artifacts.cjs');
const {
  applyInstall,
  applyUninstall,
  planInstall,
  planUninstall,
  readManifest,
  writeInstallManifest,
} = require('./install-plan.cjs');
const {
  ensureClaudeGlobalPlugin,
  removeClaudeGlobalPlugin,
} = require('./install-claude-plugin.cjs');
const { resolveRuntimeLayout } = require('./runtime-layout.cjs');

const INSTALL_LOCK_NAME = '.clean-room-install.lock';
const INSTALL_LOCK_WAIT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_LOCK_WAIT_MS', 30_000);
const INSTALL_LOCK_POLL_MS = 100;
const PYTHON_PROBE_TIMEOUT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_PYTHON_TIMEOUT_MS', 10_000);

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

function prepareHookRegistration(layout, hookMode, options = {}) {
  if (hookMode === 'copy-only') {
    return { status: 'copy-only' };
  }
  if (!layout.supportsHookRegistration) {
    return { status: 'unsupported' };
  }
  if (layout.hookRegistration === 'local-plugin') {
    const pluginPath = pluginPathForRuntime(layout.runtime, layout.targetRoot);
    if (!pluginPath) return { status: 'unsupported' };
    return {
      status: options.dryRun ? 'planned' : 'local-plugin',
      kind: 'local-plugin',
      pluginPath,
    };
  }
  if (layout.hookRegistration !== 'json-config') {
    return { status: 'unsupported' };
  }
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return { status: 'unsupported' };
  if (options.dryRun) {
    return { status: 'planned', kind: 'json-config', configPath };
  }
  const pythonPath = resolvePython3();
  const wrapperPath = path.join(layout.targetRoot, 'hooks', 'clean-room', 'clean-room-hook.py');
  const entries = buildHookEntries({ pythonPath, wrapperPath, mode: hookMode });
  return { status: 'registered', kind: 'json-config', configPath, entries };
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
    if (hookResult.status === 'planned' && hookResult.kind === 'json-config') {
      console.log(`  hook registration: would update ${hookResult.configPath}`);
      console.log('  hook registration: python3 required when applying the install');
    }
    if (hookResult.status === 'planned' && hookResult.kind === 'local-plugin') {
      console.log(`  hook registration: would install local plugin ${hookResult.pluginPath}`);
    }
    if (hookResult.status === 'local-plugin') {
      hookConfigWritten = true;
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
  if (layout.hookRegistration === 'local-plugin') {
    const pluginPath = pluginPathForRuntime(layout.runtime, layout.targetRoot);
    if (!hasManagedOpenCodePlugin(pluginPath)) return null;
    if (!dryRun) {
      fs.rmSync(assertManagedPath(layout.targetRoot, path.relative(layout.targetRoot, pluginPath)), { force: true });
      removeEmptyParents(path.dirname(pluginPath), layout.targetRoot);
    }
    return { removed: pluginPath };
  }
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

module.exports = {
  activeVerb,
  confirmUnknownConflicts,
  desiredFilesForUninstall,
  hookRegistrationFailureState,
  installRuntime,
  partialInstallMessage,
  prepareHookRegistration,
  removeHookRegistrations,
  resolvePython3,
  uninstallRuntime,
  updateRuntime,
  withTargetInstallLock,
};
