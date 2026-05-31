'use strict';

/**
 * Print the help/usage message for the clean-room-skill preflight command.
 */
function printPreflightHelp() {
  console.log(`Usage: clean-room-skill preflight (--template | --input <path>) (--output <path> | --bootstrap <path>) [options]

Create or validate a clean-room preflight goal contract.

Options:
  --template             Write an attended draft with blocking open questions
  --input <path>         Validate and normalize/copy a completed preflight goal
  --output <path>        Destination preflight-goal.json
  --bootstrap <path>     Generated task root or clean-room-bootstrap.json
  --mode <mode>          attended or unattended (template supports attended only)
  --dry-run              Print actions without writing files
  --force                Overwrite output if it already exists
  -h, --help             Show this help
`);
}

/**
 * Parse command line arguments for the preflight command.
 * @param {string[]} argv - The command line arguments.
 * @returns {object} The parsed options.
 */
function parsePreflightArgs(argv) {
  const options = {
    template: false,
    input: null,
    output: null,
    bootstrap: null,
    mode: 'attended',
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--template') {
      options.template = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--input') {
      index += 1;
      options.input = requiredValue(argv, index, '--input');
    } else if (arg.startsWith('--input=')) {
      options.input = arg.slice('--input='.length);
    } else if (arg === '--output') {
      index += 1;
      options.output = requiredValue(argv, index, '--output');
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else if (arg === '--bootstrap') {
      index += 1;
      options.bootstrap = requiredValue(argv, index, '--bootstrap');
    } else if (arg.startsWith('--bootstrap=')) {
      options.bootstrap = arg.slice('--bootstrap='.length);
    } else if (arg === '--mode') {
      index += 1;
      options.mode = requiredValue(argv, index, '--mode');
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else {
      throw new Error(`unknown preflight option: ${arg}`);
    }
  }

  return options;
}

/**
 * Get a required argument value or throw an error.
 * @param {string[]} argv - The command line arguments.
 * @param {number} index - The index of the argument.
 * @param {string} flag - The name of the flag.
 * @returns {string} The flag's value.
 */
function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

module.exports = {
  parsePreflightArgs,
  printPreflightHelp,
};
