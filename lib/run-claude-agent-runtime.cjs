'use strict';

const path = require('node:path');

const { assertClaudeAgentsAvailable, defaultClaudeConfigDir } = require('./claude-agents.cjs');
const { resolveClaudeExecutable } = require('./install-claude-plugin.cjs');
const {
  MANAGER_PREPARE_PHASE,
  REQUIRED_COVERAGE_PHASE,
  ROLE_BY_PHASE,
} = require('./run-constants.cjs');
const { resolvePath } = require('./run-roots.cjs');

const CLAUDE_PERMISSION_MODE = 'acceptEdits';

function buildClaudeAgentCommandConfig(options, roots, cwd = process.cwd()) {
  const agentConfigDir = options.agentConfigDir
    ? resolvePath(options.agentConfigDir, cwd)
    : defaultClaudeConfigDir();
  const agentStatus = assertClaudeAgentsAvailable(agentConfigDir);
  const { executable, searchPath } = resolveClaudeExecutable();
  const env = {
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
