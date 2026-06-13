'use strict';

const {
  RUNTIMES,
  RUNTIME_FLAGS,
  resolveRuntimeLayout,
} = require('./runtime-layout.cjs');

const HOOK_MODES = new Set(['safe', 'copy-only', 'strict']);

function parseArgs(argv) {
  const options = {
    runtimes: [],
    scope: null,
    dryRun: false,
    yes: false,
    uninstall: false,
    operation: null,
    hookMode: 'safe',
    hookModeSpecified: false,
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
    else if (arg === '--no-hooks') {
      options.hookMode = 'copy-only';
      options.hookModeSpecified = true;
    } else if (arg === '--config-dir') {
      i += 1;
      if (i >= argv.length) throw new Error('--config-dir requires a path');
      options.configDir = argv[i];
    } else if (arg.startsWith('--config-dir=')) {
      options.configDir = arg.slice('--config-dir='.length);
    } else if (arg === '--hooks') {
      i += 1;
      if (i >= argv.length) throw new Error('--hooks requires safe, copy-only, or strict');
      options.hookMode = argv[i];
      options.hookModeSpecified = true;
    } else if (arg.startsWith('--hooks=')) {
      options.hookMode = arg.slice('--hooks='.length);
      options.hookModeSpecified = true;
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
       clean-room-skill status [runtime] [scope] [options]
       clean-room-skill update [runtime] [scope] [options]
       clean-room-skill preflight [options]
       clean-room-skill run [options]

Commands:
  init                Create clean-room bootstrap folders and repo guidance
  status              Report installed runtime version, drift, and hook state
  update              Update installed runtime files without onboarding
  preflight           Create or validate a preflight goal contract
  doctor              Smoke test generated Codex, Claude, or OpenCode hook registration
  run                 Execute the bounded inner clean-room controller loop

Runtime:
  --codex              Install for Codex
  --claude             Install for Claude Code
  --antigravity        Install for Antigravity
  --gemini             Install for Gemini CLI
  --opencode           Install for OpenCode
  --pi                 Install for Pi
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
  --version            Print the installed clean-room-skill version

Run without runtime and scope flags for interactive install or uninstall.
Interactive runtime selection accepts names, numbers, ranges, all, or installed.
`);
}

function operationForOptions(options) {
  if (options.operation) return options.operation;
  return options.uninstall ? 'uninstall' : 'install';
}

function validateRuntimeOptions(options) {
  if (options.configDir && options.runtimes.length > 1) {
    throw new Error('--config-dir can only be used with one runtime');
  }
  for (const runtime of options.runtimes) {
    const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
    if (options.hookMode === 'strict' && !layout.supportsHookRegistration) {
      throw new Error(`--hooks=strict is not supported for ${runtime}; hook registration is verified only for codex, claude, and opencode`);
    }
  }
}

module.exports = {
  HOOK_MODES,
  operationForOptions,
  parseArgs,
  printHelp,
  setExclusive,
  validateRuntimeOptions,
};
