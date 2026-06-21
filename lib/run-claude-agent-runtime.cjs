'use strict';

const path = require('node:path');

const { assertClaudeAgentsAvailable, defaultClaudeConfigDir } = require('./claude-agents.cjs');
const { resolveClaudeExecutable } = require('./install-claude-plugin.cjs');
const {
  MANAGER_PREPARE_PHASE,
  POLISH_PHASE,
  REQUIRED_COVERAGE_PHASE,
  ROLE_BY_PHASE,
} = require('./run-constants.cjs');
const { resolvePath } = require('./run-roots.cjs');

const CLAUDE_PERMISSION_MODE = 'acceptEdits';
const CLAUDE_AGENT_AUTH_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
]);
const CCSILO_SAFE_ENV_NAMES = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
]);
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function copyProcessEnvIfPresent(env, name) {
  if (typeof name === 'string' && ENV_NAME_PATTERN.test(name) && process.env[name]) {
    env[name] = process.env[name];
  }
}

function collectCcsiloCredentialNames(credential) {
  const names = [];
  if (typeof credential?.source === 'string') {
    names.push(credential.source);
  }
  if (Array.isArray(credential?.targets)) {
    for (const target of credential.targets) {
      if (typeof target === 'string') names.push(target);
    }
  }
  return names;
}

function collectClaudeWrapperEnv(options) {
  const env = {};
  for (const name of CLAUDE_AGENT_AUTH_ENV_NAMES) {
    copyProcessEnvIfPresent(env, name);
  }
  const variantEnv = options.ccsiloResolved?.['env'];
  if (variantEnv && typeof variantEnv === 'object') {
    for (const [name, value] of Object.entries(variantEnv)) {
      if (CCSILO_SAFE_ENV_NAMES.includes(name) && typeof value === 'string') {
        env[name] = value;
      }
    }
  }
  for (const name of collectCcsiloCredentialNames(options.ccsiloResolved?.credential)) {
    copyProcessEnvIfPresent(env, name);
  }
  return env;
}

function buildClaudeAgentCommandConfig(options, roots, cwd = process.cwd()) {
  const agentConfigDir = options.agentConfigDir
    ? resolvePath(options.agentConfigDir, cwd)
    : defaultClaudeConfigDir();
  const agentStatus = assertClaudeAgentsAvailable(agentConfigDir);
  const { executable, searchPath } = resolveClaudeExecutable();
  const env = {
    ...collectClaudeWrapperEnv(options),
    CLAUDE_CONFIG_DIR: agentConfigDir,
    PATH: searchPath,
  };
  const pluginArgs = agentStatus.source === 'installed-plugin' || agentStatus.source === 'package-plugin'
    ? ['--plugin-dir', agentStatus.pluginDir]
    : [];

  return {
    configDir: agentConfigDir,
    config: {
      version: 1,
      stages: claudeStages(roots, executable, env, pluginArgs),
    },
  };
}

function claudeStages(roots, executable, env, pluginArgs) {
  const contaminatedCwd = roots.contaminatedRoot;
  const cleanCwd = roots.cleanRoot;
  const implementationCwd = roots.implementationRoots[0] || roots.cleanRoot;
  return [
    claudeStage(MANAGER_PREPARE_PHASE, contaminatedCwd, executable, env, pluginArgs),
    claudeStage('contaminated-analysis', contaminatedCwd, executable, env, pluginArgs),
    claudeStage('sanitize-handoff', contaminatedCwd, executable, env, pluginArgs),
    claudeStage('clean-plan', cleanCwd, executable, env, pluginArgs),
    claudeStage('clean-implement-qc', implementationCwd, executable, env, pluginArgs),
    claudeStage(POLISH_PHASE, implementationCwd, executable, env, pluginArgs),
    claudeStage(REQUIRED_COVERAGE_PHASE, contaminatedCwd, executable, env, pluginArgs),
  ];
}

function claudeStage(phase, cwd, executable, env, pluginArgs) {
  const role = ROLE_BY_PHASE[phase];
  return {
    phase,
    role,
    cwd,
    argv: [
      executable,
      '--print',
      '--input-format',
      'text',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--permission-mode',
      CLAUDE_PERMISSION_MODE,
      '--agent',
      `clean-room:${role}`,
      ...pluginArgs,
    ],
    env,
  };
}

module.exports = {
  buildClaudeAgentCommandConfig,
};
