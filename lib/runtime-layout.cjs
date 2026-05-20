'use strict';

const os = require('node:os');
const path = require('node:path');

const RUNTIMES = Object.freeze([
  'codex',
  'claude',
  'antigravity',
  'gemini',
  'opencode',
  'kilo',
  'cursor',
  'copilot',
  'windsurf',
  'augment',
  'trae',
  'qwen',
  'hermes',
  'codebuddy',
]);

const RUNTIME_FLAGS = Object.freeze(Object.fromEntries(RUNTIMES.map((runtime) => [`--${runtime}`, runtime])));

const STANDARD_SKILLS = Object.freeze({ kind: 'skills', source: 'skills', destSubpath: 'skills' });
const HERMES_SKILLS = Object.freeze({ kind: 'skills', source: 'skills', destSubpath: 'skills/clean-room' });
const CODEX_AGENTS = Object.freeze({
  kind: 'agents',
  source: 'examples/codex/.codex/agents',
  destSubpath: 'agents',
});
const CLAUDE_AGENTS = Object.freeze({ kind: 'agents', source: 'agents', destSubpath: 'agents' });
const HOOKS = Object.freeze({ kind: 'hooks', source: 'hooks', destSubpath: 'hooks/clean-room' });

const RUNTIME_DEFS = Object.freeze({
  codex: {
    globalEnv: 'CODEX_HOME',
    globalDefault: ['.codex'],
    localDir: '.codex',
    hooks: true,
    artifacts: [STANDARD_SKILLS, CODEX_AGENTS, HOOKS],
  },
  claude: {
    globalEnv: 'CLAUDE_CONFIG_DIR',
    globalDefault: ['.claude'],
    localDir: '.claude',
    hooks: true,
    artifacts: {
      global: [STANDARD_SKILLS, CLAUDE_AGENTS, HOOKS],
      local: [
        {
          kind: 'commands',
          source: 'skills',
          destSubpath: 'commands/clean-room',
          commandPrefix: '',
        },
        CLAUDE_AGENTS,
        HOOKS,
      ],
    },
  },
  antigravity: {
    globalResolver: resolveAntigravityGlobalRoot,
    localDir: path.join('.agents', 'plugins', 'clean-room'),
    hooks: false,
    artifacts: [
      { kind: 'plugin-manifest', destSubpath: 'plugin.json' },
      STANDARD_SKILLS,
      CLAUDE_AGENTS,
      HOOKS,
    ],
  },
  gemini: {
    globalEnv: 'GEMINI_CONFIG_DIR',
    globalDefault: ['.gemini'],
    localDir: '.gemini',
    hooks: false,
    artifacts: [
      {
        kind: 'commands',
        source: 'skills',
        destSubpath: 'commands/clean-room',
        commandPrefix: '',
      },
      HOOKS,
    ],
  },
  opencode: {
    globalResolver: resolveOpenCodeGlobalRoot,
    localDir: '.opencode',
    hooks: false,
    artifacts: [
      {
        kind: 'commands',
        source: 'skills',
        destSubpath: 'command',
        commandPrefix: 'clean-room-',
      },
      HOOKS,
    ],
  },
  kilo: {
    globalResolver: resolveKiloGlobalRoot,
    localDir: '.kilo',
    hooks: false,
    artifacts: [
      {
        kind: 'commands',
        source: 'skills',
        destSubpath: 'command',
        commandPrefix: 'clean-room-',
      },
      HOOKS,
    ],
  },
  cursor: {
    globalEnv: 'CURSOR_CONFIG_DIR',
    globalDefault: ['.cursor'],
    localDir: '.cursor',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  copilot: {
    globalEnv: 'COPILOT_CONFIG_DIR',
    globalDefault: ['.copilot'],
    localDir: '.github',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  windsurf: {
    globalEnv: 'WINDSURF_CONFIG_DIR',
    globalDefault: ['.codeium', 'windsurf'],
    localDir: '.windsurf',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  augment: {
    globalEnv: 'AUGMENT_CONFIG_DIR',
    globalDefault: ['.augment'],
    localDir: '.augment',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  trae: {
    globalEnv: 'TRAE_CONFIG_DIR',
    globalDefault: ['.trae'],
    localDir: '.trae',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  qwen: {
    globalEnv: 'QWEN_CONFIG_DIR',
    globalDefault: ['.qwen'],
    localDir: '.qwen',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
  hermes: {
    globalEnv: 'HERMES_HOME',
    globalDefault: ['.hermes'],
    localDir: '.hermes',
    hooks: false,
    artifacts: [HERMES_SKILLS, HOOKS],
  },
  codebuddy: {
    globalEnv: 'CODEBUDDY_CONFIG_DIR',
    globalDefault: ['.codebuddy'],
    localDir: '.codebuddy',
    hooks: false,
    artifacts: [STANDARD_SKILLS, HOOKS],
  },
});

function expandTilde(value, homeDir = os.homedir()) {
  if (typeof value !== 'string') return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function resolveDefaultRoot(parts, homeDir) {
  return path.join(homeDir, ...parts);
}

function resolveEnvRoot(envName, env, homeDir) {
  const value = env[envName];
  return value ? path.resolve(expandTilde(value, homeDir)) : null;
}

function resolveOpenCodeGlobalRoot({ env, homeDir }) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(expandTilde(env.OPENCODE_CONFIG_DIR, homeDir));
  if (env.OPENCODE_CONFIG) return path.dirname(path.resolve(expandTilde(env.OPENCODE_CONFIG, homeDir)));
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(expandTilde(env.XDG_CONFIG_HOME, homeDir)), 'opencode');
  return path.join(homeDir, '.config', 'opencode');
}

function resolveKiloGlobalRoot({ env, homeDir }) {
  if (env.KILO_CONFIG_DIR) return path.resolve(expandTilde(env.KILO_CONFIG_DIR, homeDir));
  if (env.KILO_CONFIG) return path.dirname(path.resolve(expandTilde(env.KILO_CONFIG, homeDir)));
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(expandTilde(env.XDG_CONFIG_HOME, homeDir)), 'kilo');
  return path.join(homeDir, '.config', 'kilo');
}

function resolveAntigravityGlobalRoot({ env, homeDir }) {
  if (env.ANTIGRAVITY_PLUGIN_DIR) {
    return path.resolve(expandTilde(env.ANTIGRAVITY_PLUGIN_DIR, homeDir));
  }
  if (env.ANTIGRAVITY_CLI_PLUGIN_DIR) {
    return path.resolve(expandTilde(env.ANTIGRAVITY_CLI_PLUGIN_DIR, homeDir));
  }
  if (env.ANTIGRAVITY_CONFIG_DIR) {
    return path.join(path.resolve(expandTilde(env.ANTIGRAVITY_CONFIG_DIR, homeDir)), 'plugins', 'clean-room');
  }
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'plugins', 'clean-room');
}

function artifactsFor(def, scope) {
  if (Array.isArray(def.artifacts)) return def.artifacts;
  return def.artifacts[scope] || [];
}

function resolveRuntimeLayout(runtime, scope, options = {}) {
  const def = RUNTIME_DEFS[runtime];
  if (!def) {
    throw new Error(`unsupported runtime: ${runtime}`);
  }
  if (scope !== 'global' && scope !== 'local') {
    throw new Error(`unsupported scope: ${scope}`);
  }

  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  let targetRoot;
  if (options.configDir) {
    targetRoot = path.resolve(expandTilde(options.configDir, homeDir));
  } else if (scope === 'local') {
    targetRoot = path.resolve(cwd, def.localDir);
  } else if (def.globalResolver) {
    targetRoot = def.globalResolver({ env, homeDir });
  } else {
    targetRoot = resolveEnvRoot(def.globalEnv, env, homeDir) || resolveDefaultRoot(def.globalDefault, homeDir);
  }

  return {
    runtime,
    scope,
    targetRoot,
    supportsHookRegistration: def.hooks === true,
    artifacts: artifactsFor(def, scope).map((artifact) => ({ ...artifact })),
  };
}

module.exports = {
  RUNTIMES,
  RUNTIME_FLAGS,
  expandTilde,
  resolveRuntimeLayout,
};
