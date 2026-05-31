'use strict';

const os = require('node:os');
const path = require('node:path');

const { readJsonFile } = require('./fs-utils.cjs');
const { resolveBootstrapScaffold } = require('./bootstrap.cjs');
const { VALID_MODES } = require('./preflight-constants.cjs');
const { parsePreflightArgs, printPreflightHelp } = require('./preflight-cli.cjs');
const {
  applyBootstrapOutputPolicy,
  validateBootstrapOutputPolicy,
} = require('./preflight-bootstrap.cjs');
const { resolveInputPath, resolveOutputPath } = require('./preflight-paths.cjs');
const { buildTemplate } = require('./preflight-template.cjs');
const { validateGoalContract } = require('./preflight-validation.cjs');
const { writePreflightOutput } = require('./preflight-output.cjs');

/**
 * Run the preflight flow from argv.
 * @param {string[]} argv - Command line arguments.
 * @param {object} [context={}] - Environment context containing cwd and homeDir.
 * @returns {object|null} Parsed preflight result containing outputPath and goal, or null if help printed.
 */
function runPreflight(argv, context = {}) {
  const parsed = parsePreflightArgs(argv);
  if (parsed.help) {
    printPreflightHelp();
    return null;
  }
  if (!VALID_MODES.has(parsed.mode)) {
    throw new Error('--mode must be attended or unattended');
  }
  if (parsed.template === Boolean(parsed.input)) {
    throw new Error('specify exactly one of --template or --input');
  }
  if (parsed.bootstrap && parsed.output) {
    throw new Error('--bootstrap conflicts with --output');
  }
  if (!parsed.bootstrap && !parsed.output) {
    throw new Error('specify exactly one of --output or --bootstrap');
  }
  const cwd = context.cwd || process.cwd();
  const homeDir = context.homeDir || os.homedir();
  const bootstrap = parsed.bootstrap ? resolveBootstrapScaffold(parsed.bootstrap, cwd, homeDir) : null;
  const outputPath = bootstrap
    ? path.join(bootstrap.roots.contaminated, 'preflight-goal.json')
    : resolveOutputPath(parsed.output, cwd, homeDir);
  let goal;
  if (parsed.template) {
    goal = buildTemplate(parsed.mode);
    if (bootstrap) {
      applyBootstrapOutputPolicy(goal, bootstrap);
    }
  } else {
    const inputPath = resolveInputPath(parsed.input, cwd, homeDir);
    goal = readJsonFile(inputPath, null);
    if (parsed.mode !== goal?.controller_policy?.mode) {
      throw new Error('--mode must match input controller_policy.mode');
    }
  }

  const errors = validateGoalContract(goal, { requireComplete: Boolean(parsed.input) });
  if (errors.length > 0) {
    throw new Error(`preflight goal is invalid:\n  ${errors.join('\n  ')}`);
  }
  if (bootstrap && parsed.input) {
    const bootstrapErrors = validateBootstrapOutputPolicy(goal, bootstrap, cwd, homeDir);
    if (bootstrapErrors.length > 0) {
      throw new Error(`preflight goal does not match bootstrap scaffold:\n  ${bootstrapErrors.join('\n  ')}`);
    }
  }
  writePreflightOutput(outputPath, goal, parsed);
  return { ...parsed, outputPath, goal };
}

module.exports = {
  buildTemplate,
  parsePreflightArgs,
  runPreflight,
  validateGoalContract,
};
