'use strict';

const fs = require('node:fs');

const { claudeAgentStatus } = require('./claude-agents.cjs');
const { assertManagedPath, fileHash } = require('./fs-utils.cjs');
const {
  configPathForRuntime,
  hasManagedHookEntries,
  hasManagedOpenCodePlugin,
  pluginPathForRuntime,
} = require('./hooks.cjs');
const { buildDesiredFiles, packageVersion } = require('./install-artifacts.cjs');
const {
  manifestHash,
  planInstall,
  readManifest,
} = require('./install-plan.cjs');
const {
  CLAUDE_PLUGIN_ID,
  CLAUDE_PLUGIN_MARKETPLACE_NAME,
  claudeActivePluginStatus,
} = require('./install-claude-plugin.cjs');
const { isUpdateTargetStatus } = require('./install-runtime-selection.cjs');
const {
  RUNTIMES,
  resolveRuntimeLayout,
} = require('./runtime-layout.cjs');

function runtimeInstallStatuses(scope, configDir) {
  return RUNTIMES.map((runtime) => runtimeInstallStatus(runtime, scope, configDir));
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
  const hookState = detectHookRegistration(layout, configPathForRuntime(runtime, layout.targetRoot));
  if (hookState === 'present') {
    return {
      ...status,
      state: 'hooks-only',
      detail: 'managed hooks without install manifest',
    };
  }
  if (hookState.startsWith('error: ')) {
    return {
      ...status,
      state: 'error',
      detail: hookState.slice('error: '.length),
    };
  }
  return status;
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
    claudeActivePlugin: null,
    claudeAgents: null,
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
  const claudeAgents = runtime === 'claude'
    ? claudeAgentStatus(layout.targetRoot, { includePackageFallback: false })
    : null;
  const claudeActivePlugin = runtime === 'claude'
    ? claudeActivePluginStatus(layout.targetRoot, manifest)
    : null;
  if (claudeActivePlugin && !claudeActivePlugin.ok) {
    issues.push(...claudeActivePlugin.issues);
  }
  if (claudeAgents && claudeAgents.status !== 'ok') {
    issues.push(`Claude role-agent dispatch unavailable: missing ${claudeAgents.missing.join(', ')}`);
  }

  const updateAvailable = Boolean(manifest.version !== packageVersion() ||
    plan.removals.length > 0 ||
    plan.unknownConflicts.length > 0 ||
    fileStats.missing > 0 ||
    (claudeActivePlugin && !claudeActivePlugin.ok) ||
    (claudeAgents && claudeAgents.status !== 'ok'));

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
    claudeActivePlugin,
    claudeAgents,
    issues,
  };
}

function detectHookRegistration(layout, configPath) {
  if (!layout.supportsHookRegistration) {
    return 'unsupported';
  }
  if (layout.hookRegistration === 'local-plugin') {
    try {
      return hasManagedOpenCodePlugin(pluginPathForRuntime(layout.runtime, layout.targetRoot)) ? 'present' : 'missing';
    } catch (err) {
      return `error: ${err.message}`;
    }
  }
  if (layout.hookRegistration !== 'json-config' || !configPath) {
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
      if (status.claudeActivePlugin?.entry) {
        console.log(`  active plugin: ${status.claudeActivePlugin.entry.version || '<unknown>'}; path ${status.claudeActivePlugin.entry.installPath || '<unknown>'}`);
      }
      if (status.claudeAgents) {
        console.log(`  plugin agents: ${status.claudeAgents.status}; present ${status.claudeAgents.present}; missing ${status.claudeAgents.missing.length}`);
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

module.exports = {
  collectRuntimeStatus,
  detectHookRegistration,
  manifestFileStats,
  printStatusReport,
  resolveTargetRoot,
  runStatus,
  runtimeInstallStatus,
  runtimeInstallStatuses,
  selectedStatusRuntimes,
  selectedUpdateRuntimes,
};
