'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonFile } = require('./fs-utils.cjs');

const CLAUDE_AGENT_FILES = Object.freeze([
  'clean-architect.md',
  'clean-implementer-verifier-shell.md',
  'clean-polish-reviewer.md',
  'clean-qa-editor.md',
  'contaminated-handoff-sanitizer.md',
  'contaminated-manager-verifier.md',
  'contaminated-source-analyst.md',
]);

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function localClaudePluginDir() {
  return packageRoot();
}

function defaultClaudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) {
    return path.resolve(expandTilde(env.CLAUDE_CONFIG_DIR));
  }
  return path.join(os.homedir(), '.claude');
}

function expandTilde(value) {
  if (value === '~') return os.homedir();
  if (typeof value === 'string' && value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function claudePluginDirFromInstallManifest(configDir) {
  const manifestPath = path.join(configDir, 'clean-room-install-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = readJsonFile(manifestPath, null);
  const installPath = manifest?.claude_plugin?.install_path;
  return typeof installPath === 'string' && installPath !== '' ? path.resolve(installPath) : null;
}

function claudePluginCandidates(configDir, options = {}) {
  const candidates = [];
  const add = (label, pluginDir) => {
    if (typeof pluginDir !== 'string' || pluginDir === '') return;
    const resolved = path.resolve(pluginDir);
    if (candidates.some((candidate) => candidate.pluginDir === resolved)) return;
    candidates.push({ label, pluginDir: resolved });
  };

  if (options.pluginDir) {
    add('explicit', options.pluginDir);
  }
  if (configDir) {
    add('installed-plugin', claudePluginDirFromInstallManifest(path.resolve(configDir)));
  }
  if (options.includePackageFallback !== false) {
    add('package-plugin', localClaudePluginDir());
  }
  if (configDir) {
    add('local-claude-agents', path.resolve(configDir));
  }
  return candidates;
}

function claudeAgentStatus(configDir, options = {}) {
  const candidates = claudePluginCandidates(configDir, options);
  for (const candidate of candidates) {
    const agentDir = path.join(candidate.pluginDir, 'agents');
    const missing = missingClaudeAgentFiles(candidate.pluginDir);
    if (missing.length === 0) {
      return {
        status: 'ok',
        source: candidate.label,
        pluginDir: candidate.pluginDir,
        agentDir,
        present: CLAUDE_AGENT_FILES.length,
        missing,
      };
    }
  }

  const preferred = candidates[0] || { label: 'none', pluginDir: configDir ? path.resolve(configDir) : null };
  const missing = preferred.pluginDir ? missingClaudeAgentFiles(preferred.pluginDir) : [...CLAUDE_AGENT_FILES];
  return {
    status: 'missing',
    source: preferred.label,
    pluginDir: preferred.pluginDir,
    agentDir: preferred.pluginDir ? path.join(preferred.pluginDir, 'agents') : null,
    present: CLAUDE_AGENT_FILES.length - missing.length,
    missing,
  };
}

function missingClaudeAgentFiles(pluginDir) {
  const agentDir = path.join(pluginDir, 'agents');
  return CLAUDE_AGENT_FILES.filter((name) => {
    const filePath = path.join(agentDir, name);
    try {
      return !fs.statSync(filePath).isFile();
    } catch {
      return true;
    }
  });
}

function assertClaudeAgentsAvailable(configDir, options = {}) {
  const status = claudeAgentStatus(configDir, options);
  if (status.status !== 'ok') {
    const base = status.pluginDir || String(configDir || '<unknown>');
    throw new Error(`Claude role-agent dispatch unavailable: missing ${status.missing.join(', ')} under ${base}`);
  }
  return status;
}

module.exports = {
  CLAUDE_AGENT_FILES,
  assertClaudeAgentsAvailable,
  claudeAgentStatus,
  defaultClaudeConfigDir,
  localClaudePluginDir,
};
