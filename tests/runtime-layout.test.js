'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  RUNTIMES,
  resolveRuntimeLayout,
} = require('../lib/runtime-layout.cjs');

const GLOBAL_ENV = {
  CODEX_HOME: '/tmp/clean-room/codex',
  CLAUDE_CONFIG_DIR: '/tmp/clean-room/claude',
  ANTIGRAVITY_PLUGIN_DIR: '/tmp/clean-room/antigravity-plugin',
  GEMINI_CONFIG_DIR: '/tmp/clean-room/gemini',
  OPENCODE_CONFIG_DIR: '/tmp/clean-room/opencode',
  KILO_CONFIG_DIR: '/tmp/clean-room/kilo',
  CURSOR_CONFIG_DIR: '/tmp/clean-room/cursor',
  COPILOT_CONFIG_DIR: '/tmp/clean-room/copilot',
  WINDSURF_CONFIG_DIR: '/tmp/clean-room/windsurf',
  AUGMENT_CONFIG_DIR: '/tmp/clean-room/augment',
  TRAE_CONFIG_DIR: '/tmp/clean-room/trae',
  QWEN_CONFIG_DIR: '/tmp/clean-room/qwen',
  HERMES_HOME: '/tmp/clean-room/hermes',
  CODEBUDDY_CONFIG_DIR: '/tmp/clean-room/codebuddy',
};

const EXPECTED_GLOBAL = {
  codex: { root: '/tmp/clean-room/codex', kinds: ['skills:skills', 'agents:agents', 'hooks:hooks/clean-room'], hooks: true },
  claude: { root: '/tmp/clean-room/claude', kinds: ['hooks:hooks/clean-room'], hooks: true },
  antigravity: {
    root: '/tmp/clean-room/antigravity-plugin',
    kinds: ['plugin-manifest:plugin.json', 'skills:skills', 'agents:agents', 'hooks:hooks/clean-room'],
    hooks: false,
  },
  gemini: { root: '/tmp/clean-room/gemini', kinds: ['commands:commands/clean-room', 'hooks:hooks/clean-room'], hooks: false },
  opencode: {
    root: '/tmp/clean-room/opencode',
    kinds: ['skills:skills', 'commands:commands', 'opencode-plugin:plugins/clean-room.ts', 'hooks:hooks/clean-room'],
    hooks: true,
  },
  kilo: { root: '/tmp/clean-room/kilo', kinds: ['commands:command', 'hooks:hooks/clean-room'], hooks: false },
  cursor: { root: '/tmp/clean-room/cursor', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  copilot: { root: '/tmp/clean-room/copilot', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  windsurf: { root: '/tmp/clean-room/windsurf', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  augment: { root: '/tmp/clean-room/augment', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  trae: { root: '/tmp/clean-room/trae', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  qwen: { root: '/tmp/clean-room/qwen', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  hermes: { root: '/tmp/clean-room/hermes', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
  codebuddy: { root: '/tmp/clean-room/codebuddy', kinds: ['skills:skills', 'hooks:hooks/clean-room'], hooks: false },
};

const EXPECTED_LOCAL_ROOTS = {
  codex: '.codex',
  claude: '.claude',
  antigravity: path.join('.agents', 'plugins', 'clean-room'),
  gemini: '.gemini',
  opencode: '.opencode',
  kilo: '.kilo',
  cursor: '.cursor',
  copilot: '.github',
  windsurf: '.windsurf',
  augment: '.augment',
  trae: '.trae',
  qwen: '.qwen',
  hermes: '.hermes',
  codebuddy: '.codebuddy',
};

function kindLabels(layout) {
  return layout.artifacts.map((artifact) => `${artifact.kind}:${artifact.destSubpath}`);
}

describe('runtime layout', () => {
  test('declares every runtime layout global root and artifact surface', () => {
    assert.deepEqual(RUNTIMES, Object.keys(EXPECTED_GLOBAL));
    for (const runtime of RUNTIMES) {
      const layout = resolveRuntimeLayout(runtime, 'global', {
        env: GLOBAL_ENV,
        homeDir: '/Users/tester',
      });
      assert.equal(layout.targetRoot, EXPECTED_GLOBAL[runtime].root, runtime);
      assert.deepEqual(kindLabels(layout), EXPECTED_GLOBAL[runtime].kinds, runtime);
      assert.equal(layout.supportsHookRegistration, EXPECTED_GLOBAL[runtime].hooks, runtime);
    }
  });

  test('declares local runtime roots and Claude local command-wrapper surface', () => {
    const cwd = '/tmp/project';
    for (const runtime of RUNTIMES) {
      const layout = resolveRuntimeLayout(runtime, 'local', { cwd, env: {}, homeDir: '/Users/tester' });
      assert.equal(layout.targetRoot, path.join(cwd, EXPECTED_LOCAL_ROOTS[runtime]), runtime);
    }

    const claude = resolveRuntimeLayout('claude', 'local', { cwd, env: {}, homeDir: '/Users/tester' });
    assert.deepEqual(kindLabels(claude), ['commands:commands/clean-room', 'agents:agents', 'hooks:hooks/clean-room']);
  });

  test('config-dir overrides runtime-specific roots', () => {
    const layout = resolveRuntimeLayout('opencode', 'global', {
      configDir: '~/custom-opencode',
      homeDir: '/Users/tester',
      env: { OPENCODE_CONFIG_DIR: '/tmp/ignored' },
    });
    assert.equal(layout.targetRoot, '/Users/tester/custom-opencode');
  });

  test('Antigravity config root resolves to the clean-room plugin directory', () => {
    const layout = resolveRuntimeLayout('antigravity', 'global', {
      env: { ANTIGRAVITY_CONFIG_DIR: '/tmp/agy-config' },
      homeDir: '/Users/tester',
    });
    assert.equal(layout.targetRoot, '/tmp/agy-config/plugins/clean-room');

    const fallback = resolveRuntimeLayout('antigravity', 'global', {
      env: {},
      homeDir: '/Users/tester',
    });
    assert.equal(fallback.targetRoot, '/Users/tester/.gemini/antigravity-cli/plugins/clean-room');
  });
});
