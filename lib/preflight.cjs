'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
  readJsonFile,
} = require('./fs-utils.cjs');

const VALID_MODES = new Set(['attended', 'unattended']);
const VALID_INTENTS = new Set([
  'clean-room-reimplementation',
  'behavior-compatible-port',
  'api-compatible-clone',
  'modernization',
  'partial-feature-extraction',
  'test-spec-generation-only',
  'other',
]);

function printPreflightHelp() {
  console.log(`Usage: clean-room-skill preflight (--template | --input <path>) --output <path> [options]

Create or validate a clean-room preflight goal contract.

Options:
  --template             Write an attended draft with blocking open questions
  --input <path>         Validate and normalize/copy a completed preflight goal
  --output <path>        Destination preflight-goal.json
  --mode <mode>          attended or unattended (template supports attended only)
  --dry-run              Print actions without writing files
  --force                Overwrite output if it already exists
  -h, --help             Show this help
`);
}

function parsePreflightArgs(argv) {
  const options = {
    template: false,
    input: null,
    output: null,
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

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function expandTilde(value, homeDir = os.homedir()) {
  if (value === '~') return homeDir;
  if (typeof value === 'string' && value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function resolveOutputPath(value, cwd = process.cwd(), homeDir = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--output requires a path');
  }
  const expanded = expandTilde(value, homeDir);
  return path.resolve(cwd, expanded);
}

function resolveInputPath(value, cwd = process.cwd(), homeDir = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--input requires a path');
  }
  const expanded = expandTilde(value, homeDir);
  return path.resolve(cwd, expanded);
}

function buildTemplate(mode = 'attended') {
  if (mode !== 'attended') {
    throw new Error('preflight --template supports attended mode only');
  }
  return {
    goal_id: 'goal-task-xxxxxxxx',
    created_at: new Date().toISOString(),
    end_goal: {
      intent: 'clean-room-reimplementation',
      success_definition: 'TBD: define the observable result the clean implementation must achieve.',
      destination_kind: 'new-project',
      existing_destination_policy: 'inspect-and-preserve',
    },
    target_stack: {
      language: 'TBD',
      runtime: null,
      framework: null,
      package_manager: null,
      test_framework: null,
    },
    license_policy: {
      source_license_notes: 'unknown',
      destination_license: 'TBD',
      dependency_license_allowlist: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause'],
      dependency_license_blocklist: ['GPL-3.0', 'AGPL-3.0'],
    },
    dependency_policy: {
      allow_new_dependencies: true,
      prefer_stdlib: true,
      require_user_approval_for_native_deps: true,
      blocked_dependencies: [],
    },
    compatibility_policy: {
      mirror_public_behavior: true,
      mirror_public_api_names: true,
      mirror_private_structure: false,
      mirror_comments_or_internal_names: false,
      allowed_exactness: [
        'public API names',
        'CLI flags',
        'serialized outputs',
        'documented protocol behavior',
        'public error codes',
      ],
    },
    feature_policy: {
      preserve_features: [],
      remove_features: [],
      add_features: [],
      non_goals: [],
    },
    code_hygiene_policy: {
      max_lines_per_code_file: 500,
      max_lines_per_test_file: 800,
      max_files_per_iteration: 12,
      split_large_files_by: ['module boundary', 'public type', 'feature area'],
      exceptions: ['generated files', 'fixtures', 'snapshots'],
      forbidden_patterns: ['god file', 'source-shaped layout'],
    },
    output_policy: {
      artifact_base_root: '~/Documents/CleanRoom/<task-id>/',
      implementation_root: '~/Documents/CleanRoom/<task-id>/implementation/',
      assumed_output_directory: 'implementation/',
      write_mode: 'create-or-preserve-existing',
    },
    controller_policy: {
      mode: 'attended',
      unattended_allowed_after_preflight: false,
      max_iterations: 10,
    },
    open_questions: [
      {
        question_id: 'goal-end-state',
        question: 'Define the end goal, target stack, compatibility exactness, dependency policy, license policy, and output root before execution.',
        blocking: true,
        default_assumption: 'Do not start source analysis until this is answered.',
      },
    ],
  };
}

function expectObject(value, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  return true;
}

function expectArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  return true;
}

function expectString(value, label, errors, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function expectBoolean(value, label, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return false;
  }
  return true;
}

function expectPositiveInteger(value, label, errors) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive integer`);
    return false;
  }
  return true;
}

function validateStringArray(root, field, errors) {
  if (!expectArray(root?.[field], field, errors)) return;
  for (const [index, item] of root[field].entries()) {
    expectString(item, `${field}[${index}]`, errors);
  }
}

function validateGoalContract(goal, options = {}) {
  const errors = [];
  if (!expectObject(goal, 'preflight goal', errors)) {
    return errors;
  }

  expectString(goal.goal_id, 'goal_id', errors);
  expectString(goal.created_at, 'created_at', errors);

  if (expectObject(goal.end_goal, 'end_goal', errors)) {
    if (!VALID_INTENTS.has(goal.end_goal.intent)) {
      errors.push('end_goal.intent is not supported');
    }
    expectString(goal.end_goal.success_definition, 'end_goal.success_definition', errors);
    expectString(goal.end_goal.destination_kind, 'end_goal.destination_kind', errors);
    expectString(goal.end_goal.existing_destination_policy, 'end_goal.existing_destination_policy', errors);
  }

  if (expectObject(goal.target_stack, 'target_stack', errors)) {
    expectString(goal.target_stack.language, 'target_stack.language', errors);
    for (const field of ['runtime', 'framework', 'package_manager', 'test_framework']) {
      if (goal.target_stack[field] !== null) {
        expectString(goal.target_stack[field], `target_stack.${field}`, errors);
      }
    }
  }

  if (expectObject(goal.license_policy, 'license_policy', errors)) {
    expectString(goal.license_policy.source_license_notes, 'license_policy.source_license_notes', errors, true);
    expectString(goal.license_policy.destination_license, 'license_policy.destination_license', errors);
    validateStringArray(goal.license_policy, 'dependency_license_allowlist', errors);
    validateStringArray(goal.license_policy, 'dependency_license_blocklist', errors);
  }

  if (expectObject(goal.dependency_policy, 'dependency_policy', errors)) {
    expectBoolean(goal.dependency_policy.allow_new_dependencies, 'dependency_policy.allow_new_dependencies', errors);
    expectBoolean(goal.dependency_policy.prefer_stdlib, 'dependency_policy.prefer_stdlib', errors);
    expectBoolean(
      goal.dependency_policy.require_user_approval_for_native_deps,
      'dependency_policy.require_user_approval_for_native_deps',
      errors
    );
    validateStringArray(goal.dependency_policy, 'blocked_dependencies', errors);
  }

  if (expectObject(goal.compatibility_policy, 'compatibility_policy', errors)) {
    expectBoolean(goal.compatibility_policy.mirror_public_behavior, 'compatibility_policy.mirror_public_behavior', errors);
    expectBoolean(goal.compatibility_policy.mirror_public_api_names, 'compatibility_policy.mirror_public_api_names', errors);
    if (goal.compatibility_policy.mirror_private_structure !== false) {
      errors.push('compatibility_policy.mirror_private_structure must be false');
    }
    if (goal.compatibility_policy.mirror_comments_or_internal_names !== false) {
      errors.push('compatibility_policy.mirror_comments_or_internal_names must be false');
    }
    validateStringArray(goal.compatibility_policy, 'allowed_exactness', errors);
  }

  if (expectObject(goal.feature_policy, 'feature_policy', errors)) {
    for (const field of ['preserve_features', 'remove_features', 'add_features', 'non_goals']) {
      validateStringArray(goal.feature_policy, field, errors);
    }
  }

  validateCodeHygienePolicy(goal.code_hygiene_policy, errors);

  if (expectObject(goal.output_policy, 'output_policy', errors)) {
    expectString(goal.output_policy.artifact_base_root, 'output_policy.artifact_base_root', errors);
    expectString(goal.output_policy.implementation_root, 'output_policy.implementation_root', errors);
    expectString(goal.output_policy.assumed_output_directory, 'output_policy.assumed_output_directory', errors);
    expectString(goal.output_policy.write_mode, 'output_policy.write_mode', errors);
  }

  if (expectObject(goal.controller_policy, 'controller_policy', errors)) {
    if (!VALID_MODES.has(goal.controller_policy.mode)) {
      errors.push('controller_policy.mode must be attended or unattended');
    }
    expectBoolean(
      goal.controller_policy.unattended_allowed_after_preflight,
      'controller_policy.unattended_allowed_after_preflight',
      errors
    );
    expectPositiveInteger(goal.controller_policy.max_iterations, 'controller_policy.max_iterations', errors);
  }

  if (expectArray(goal.open_questions, 'open_questions', errors)) {
    for (const [index, question] of goal.open_questions.entries()) {
      if (!expectObject(question, `open_questions[${index}]`, errors)) continue;
      expectString(question.question_id, `open_questions[${index}].question_id`, errors);
      expectString(question.question, `open_questions[${index}].question`, errors);
      expectBoolean(question.blocking, `open_questions[${index}].blocking`, errors);
    }
  }

  if (goal.controller_policy?.mode === 'unattended') {
    if (goal.controller_policy.unattended_allowed_after_preflight !== true) {
      errors.push('unattended preflight requires unattended_allowed_after_preflight=true');
    }
    if (Array.isArray(goal.open_questions) && goal.open_questions.length > 0) {
      errors.push('unattended preflight requires no open_questions');
    }
  }

  if (options.requireComplete && Array.isArray(goal.open_questions)) {
    const blocking = goal.open_questions.filter((question) => question?.blocking === true);
    if (blocking.length > 0) {
      errors.push('completed preflight input must not contain blocking open_questions');
    }
  }

  return errors;
}

function validateCodeHygienePolicy(policy, errors) {
  if (!expectObject(policy, 'code_hygiene_policy', errors)) return;
  expectPositiveInteger(policy.max_lines_per_code_file, 'code_hygiene_policy.max_lines_per_code_file', errors);
  expectPositiveInteger(policy.max_lines_per_test_file, 'code_hygiene_policy.max_lines_per_test_file', errors);
  expectPositiveInteger(policy.max_files_per_iteration, 'code_hygiene_policy.max_files_per_iteration', errors);
  validateStringArray(policy, 'split_large_files_by', errors);
  validateStringArray(policy, 'exceptions', errors);
  if (policy.forbidden_patterns !== undefined) {
    validateStringArray(policy, 'forbidden_patterns', errors);
  }
}

function writePreflightOutput(outputPath, goal, options) {
  const data = `${JSON.stringify(goal, null, 2)}\n`;
  if (options.dryRun) {
    console.log(`Would write preflight goal: ${outputPath}`);
    return;
  }
  try {
    if (options.force) {
      atomicWriteFile(outputPath, data, 'utf8');
    } else {
      atomicWriteFileNoOverwrite(outputPath, data, 'utf8');
    }
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(`preflight output already exists; use --force to overwrite: ${outputPath}`);
    }
    throw err;
  }
  console.log(`Wrote preflight goal: ${outputPath}`);
}

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
  const cwd = context.cwd || process.cwd();
  const homeDir = context.homeDir || os.homedir();
  const outputPath = resolveOutputPath(parsed.output, cwd, homeDir);
  let goal;
  if (parsed.template) {
    goal = buildTemplate(parsed.mode);
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
  writePreflightOutput(outputPath, goal, parsed);
  return { ...parsed, outputPath, goal };
}

module.exports = {
  buildTemplate,
  parsePreflightArgs,
  runPreflight,
  validateGoalContract,
};
