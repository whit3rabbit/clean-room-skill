'use strict';

const { DEFAULT_ROLE } = require('./run-constants.cjs');

function printArtifactHelp() {
  console.log(`Usage: clean-room-skill artifact <command> [options]

Create or validate canonical clean-room JSON artifacts.

Commands:
  kinds               List canonical artifact kinds and creation commands
  template            Write a schema-shaped artifact starter
  validate            Validate one or more artifact JSON files

Template:
  clean-room-skill artifact template --kind <kind> --output <path> [--force] [--dry-run]

Validate:
  clean-room-skill artifact validate --path <path> [--path <path> ...] [options]

Options:
  --task-manifest <path>  Derive roots and run full artifact hook validation
  --role <role>           Role used for full hook validation path policy
  --schema-dir <path>     Schema directory override; omit to use bundled schemas
  --python <path>         Python executable for bundled validation hooks (default: python3)
  -h, --help              Show this help
`);
}

function parseArtifactArgs(argv) {
  const options = {
    command: null,
    help: false,
    kind: null,
    output: null,
    paths: [],
    taskManifest: null,
    role: DEFAULT_ROLE,
    roleProvided: false,
    schemaDir: null,
    python: 'python3',
    force: false,
    dryRun: false,
  };

  if (argv.length === 0) {
    options.help = true;
    return options;
  }

  if (argv[0] === '-h' || argv[0] === '--help') {
    options.help = true;
    return options;
  }

  options.command = argv[0];
  if (!['kinds', 'template', 'validate'].includes(options.command)) {
    throw new Error(`unknown artifact command: ${options.command}`);
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--kind') {
      index += 1;
      options.kind = requiredValue(argv, index, '--kind');
    } else if (arg.startsWith('--kind=')) {
      options.kind = arg.slice('--kind='.length);
    } else if (arg === '--output') {
      index += 1;
      options.output = requiredValue(argv, index, '--output');
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else if (arg === '--path') {
      index += 1;
      options.paths.push(requiredValue(argv, index, '--path'));
    } else if (arg.startsWith('--path=')) {
      options.paths.push(arg.slice('--path='.length));
    } else if (arg === '--task-manifest') {
      index += 1;
      options.taskManifest = requiredValue(argv, index, '--task-manifest');
    } else if (arg.startsWith('--task-manifest=')) {
      options.taskManifest = arg.slice('--task-manifest='.length);
    } else if (arg === '--role') {
      index += 1;
      options.role = requiredValue(argv, index, '--role');
      options.roleProvided = true;
    } else if (arg.startsWith('--role=')) {
      options.role = arg.slice('--role='.length);
      options.roleProvided = true;
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
      throw new Error(`unknown artifact option: ${arg}`);
    }
  }

  return options;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

module.exports = {
  parseArtifactArgs,
  printArtifactHelp,
};
