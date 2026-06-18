'use strict';

const AGENT_RUNTIMES = new Set(['claude']);

function printRunHelp() {
  console.log(`Usage: clean-room-skill run --task-manifest <path> (--agent-commands <path> | --agent-runtime claude) [options]

Run one bounded inner clean-room controller loop for an approved spec slice.

Options:
  --task-manifest <path>   Required task-manifest.json path
  --agent-commands <path>  Role command adapter JSON unless --agent-runtime or --dry-run is set
  --agent-runtime <name>   Built-in role agent runtime; currently supports claude
  --agent-config-dir <path>
                           Runtime config dir for --agent-runtime claude
                           Set CLEAN_ROOM_CLAUDE_EXECUTABLE=/absolute/path/to/claude-wrapper
                           for ccsilo or other wrapper commands such as openrouter
  --max-iterations <n>     Lower the manifest/loop iteration cap
  --once                   Run at most one inner iteration
  --dry-run                Validate and print the selected unit without writing or spawning agents
  --schema-dir <path>      Schema directory override; omit to use bundled schemas
  --python <path>          Python executable for bundled validation hooks (default: python3)
  -h, --help               Show this help
`);
}

function parseRunArgs(argv) {
  const options = {
    taskManifest: null,
    agentCommands: null,
    agentRuntime: null,
    agentConfigDir: null,
    maxIterations: null,
    once: false,
    dryRun: false,
    schemaDir: null,
    python: 'python3',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--task-manifest') {
      index += 1;
      options.taskManifest = requiredValue(argv, index, '--task-manifest');
    } else if (arg.startsWith('--task-manifest=')) {
      options.taskManifest = arg.slice('--task-manifest='.length);
    } else if (arg === '--agent-commands') {
      index += 1;
      options.agentCommands = requiredValue(argv, index, '--agent-commands');
    } else if (arg.startsWith('--agent-commands=')) {
      options.agentCommands = arg.slice('--agent-commands='.length);
    } else if (arg === '--agent-runtime') {
      index += 1;
      options.agentRuntime = parseAgentRuntime(requiredValue(argv, index, '--agent-runtime'));
    } else if (arg.startsWith('--agent-runtime=')) {
      options.agentRuntime = parseAgentRuntime(arg.slice('--agent-runtime='.length));
    } else if (arg === '--agent-config-dir') {
      index += 1;
      options.agentConfigDir = requiredValue(argv, index, '--agent-config-dir');
    } else if (arg.startsWith('--agent-config-dir=')) {
      options.agentConfigDir = arg.slice('--agent-config-dir='.length);
    } else if (arg === '--max-iterations') {
      index += 1;
      options.maxIterations = parsePositiveInteger(requiredValue(argv, index, '--max-iterations'), '--max-iterations');
    } else if (arg.startsWith('--max-iterations=')) {
      options.maxIterations = parsePositiveInteger(arg.slice('--max-iterations='.length), '--max-iterations');
    } else if (arg === '--schema-dir') {
      index += 1;
      options.schemaDir = requiredValue(argv, index, '--schema-dir');
    } else if (arg.startsWith('--schema-dir=')) {
      options.schemaDir = arg.slice('--schema-dir='.length);
    } else if (arg === '--python') {
      index += 1;
      options.python = requiredValue(argv, index, '--python');
    } else if (arg.startsWith('--python=')) {
      options.python = arg.slice('--python='.length);
    } else {
      throw new Error(`unknown run option: ${arg}`);
    }
  }

  return options;
}

function parseAgentRuntime(value) {
  if (!AGENT_RUNTIMES.has(value)) {
    throw new Error('--agent-runtime must be claude');
  }
  return value;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

module.exports = {
  AGENT_RUNTIMES,
  parseRunArgs,
  printRunHelp,
};
