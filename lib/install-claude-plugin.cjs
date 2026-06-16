'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { packageVersion } = require('./install-artifacts.cjs');

const CLAUDE_PLUGIN_TIMEOUT_MS = envPositiveInteger('CLEAN_ROOM_INSTALL_CLAUDE_PLUGIN_TIMEOUT_MS', 120_000);
const CLAUDE_EXECUTABLE_ENV = 'CLEAN_ROOM_CLAUDE_EXECUTABLE';
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

function pathIsUnder(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function currentWorkingRoots() {
  const cwd = path.resolve(process.cwd());
  const roots = [cwd];
  try {
    const real = fs.realpathSync.native(cwd);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    // Keep the resolved cwd as the policy root if realpath is unavailable.
  }
  return roots;
}

function pathIsUnderAny(candidate, roots) {
  return roots.some((root) => pathIsUnder(candidate, root));
}

function pathContainsNodeModulesBin(candidate) {
  const parts = path.resolve(candidate).split(path.sep);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'node_modules' && parts[i + 1] === '.bin') return true;
  }
  return false;
}

function unsafeClaudeExecutableReason(filePath, label) {
  if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return `${label} must be an absolute path`;
  }
  const resolved = path.resolve(filePath);
  const cwdRoots = currentWorkingRoots();
  if (pathIsUnderAny(resolved, cwdRoots)) {
    return `${label} must not be under the current working directory`;
  }
  if (pathContainsNodeModulesBin(resolved)) {
    return `${label} must not be under node_modules/.bin`;
  }
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    return `${label} must resolve to an executable file`;
  }
  if (pathIsUnderAny(real, cwdRoots)) {
    return `${label} target must not be under the current working directory`;
  }
  if (pathContainsNodeModulesBin(real)) {
    return `${label} target must not be under node_modules/.bin`;
  }
  try {
    const stat = fs.statSync(real);
    fs.accessSync(real, fs.constants.X_OK);
    if (!stat.isFile()) {
      return `${label} must be an executable regular file`;
    }
  } catch {
    return `${label} must be an executable regular file`;
  }
  return null;
}

function assertClaudeExecutable(filePath, label) {
  const reason = unsafeClaudeExecutableReason(filePath, label);
  if (reason) throw new Error(reason);
  return path.resolve(filePath);
}

function sanitizedPathEntriesForClaude(value) {
  const entries = String(value || '').split(path.delimiter).filter(Boolean);
  const cwdRoots = currentWorkingRoots();
  const seen = new Set();
  return entries.filter((entry) => {
    if (!path.isAbsolute(entry)) return false;
    const normalized = path.resolve(entry);
    if (pathIsUnderAny(normalized, cwdRoots)) return false;
    try {
      if (pathIsUnderAny(fs.realpathSync.native(normalized), cwdRoots)) return false;
    } catch {
      // Nonexistent PATH entries cannot provide claude; leave candidate validation to fail later.
    }
    if (pathContainsNodeModulesBin(normalized)) return false;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function sanitizePathForClaude(value) {
  return sanitizedPathEntriesForClaude(value).join(path.delimiter);
}

function resolveClaudeExecutable() {
  const configuredExecutable = process.env[CLAUDE_EXECUTABLE_ENV];
  const searchPath = sanitizePathForClaude(process.env.PATH);
  if (configuredExecutable) {
    return {
      executable: assertClaudeExecutable(configuredExecutable, CLAUDE_EXECUTABLE_ENV),
      searchPath,
    };
  }

  const entries = sanitizedPathEntriesForClaude(process.env.PATH);
  if (entries.length === 0) {
    throw new Error(`Claude plugin command requires ${CLAUDE_EXECUTABLE_ENV} or a non-empty sanitized PATH`);
  }

  const candidates = [];
  const seenCandidates = new Set();
  for (const entry of entries) {
    const candidate = path.join(entry, 'claude');
    if (unsafeClaudeExecutableReason(candidate, 'Claude executable')) continue;
    const resolved = path.resolve(candidate);
    let realCandidate;
    try {
      realCandidate = fs.realpathSync.native(resolved);
    } catch {
      continue;
    }
    if (seenCandidates.has(realCandidate)) continue;
    seenCandidates.add(realCandidate);
    candidates.push(resolved);
  }

  if (candidates.length === 1) {
    return { executable: candidates[0], searchPath };
  }
  if (candidates.length > 1) {
    throw new Error(`Claude plugin command found multiple claude executables on sanitized PATH; set ${CLAUDE_EXECUTABLE_ENV} to the intended absolute executable`);
  }
  throw new Error(`Claude plugin command requires ${CLAUDE_EXECUTABLE_ENV} or a claude executable on sanitized PATH`);
}

function claudePluginEnv(layout, searchPath) {
  return {
    ...process.env,
    PATH: searchPath,
    CLAUDE_CONFIG_DIR: layout.targetRoot,
  };
}

function claudeCommandLabel(command, args) {
  return [command, ...args].join(' ');
}

function claudePluginCommandFailure(command, args, result) {
  const parts = [`Claude plugin command failed: ${claudeCommandLabel(command, args)}`];
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

function isClaudeMarketplaceAdd(args) {
  return args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add';
}

function isRetryableClaudeMarketplaceAddFailure(args, result) {
  if (!isClaudeMarketplaceAdd(args)) return false;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const transientFailure = /git-submodule died of signal|RPC failed|early EOF|unable to access/i.test(output);
  const cloneFailure = /Failed to clone marketplace repository/i.test(output);
  const missingRef = /Remote branch .* not found/i.test(output);
  return transientFailure || (cloneFailure && !missingRef);
}

function runClaudePluginCommand(layout, args, options = {}) {
  const { executable: claudeExecutable, searchPath } = resolveClaudeExecutable();
  const attempts = Math.max(1, Number(options.attempts || 1));
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawnSync(claudeExecutable, args, {
      encoding: 'utf8',
      env: claudePluginEnv(layout, searchPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_PLUGIN_TIMEOUT_MS,
    });
    result.command = claudeExecutable;
    if (!result.error && result.status === 0) break;
    if (attempt < attempts && isRetryableClaudeMarketplaceAddFailure(args, result)) continue;
    throw new Error(claudePluginCommandFailure(claudeExecutable, args, result));
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
      `Claude plugin command returned invalid JSON: ${claudeCommandLabel(result.command || 'claude', args)}; ` +
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
  ], { attempts: 2 });

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

module.exports = {
  CLAUDE_EXECUTABLE_ENV,
  CLAUDE_PLUGIN_ID,
  CLAUDE_PLUGIN_MARKETPLACE_NAME,
  CLAUDE_PLUGIN_NAME,
  CLAUDE_PLUGIN_SCOPE,
  CLAUDE_PLUGIN_SOURCE_URL,
  assertClaudeExecutable,
  claudePluginSource,
  ensureClaudeGlobalPlugin,
  pathContainsNodeModulesBin,
  removeClaudeGlobalPlugin,
  resolveClaudeExecutable,
  sanitizedPathEntriesForClaude,
  sanitizePathForClaude,
  unsafeClaudeExecutableReason,
  usesClaudeGlobalPlugin,
};
