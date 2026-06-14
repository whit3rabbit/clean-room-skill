'use strict';

const {
  VALID_CONTAINER_PROFILES,
  VALID_DEPENDENCY_INSTALL_POLICIES,
  VALID_EXECUTION_BACKENDS,
  VALID_INTENTS,
  VALID_MODES,
  VALID_NETWORK_POLICIES,
} = require('./preflight-constants.cjs');

const EXPLICIT_USER_ANSWER = 'explicit-user-answer';

/**
 * Assert that a value is an object (not null and not an array), appending errors on failure.
 * @param {any} value - Value to check.
 * @param {string} label - Field label for error message.
 * @param {string[]} errors - Array to push error messages into.
 * @returns {boolean} True if validation passes, otherwise false.
 */
function expectObject(value, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  return true;
}

/**
 * Assert that a value is an array, appending errors on failure.
 * @param {any} value - Value to check.
 * @param {string} label - Field label for error message.
 * @param {string[]} errors - Array to push error messages into.
 * @returns {boolean} True if validation passes, otherwise false.
 */
function expectArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  return true;
}

/**
 * Assert that a value is a string, appending errors on failure.
 * @param {any} value - Value to check.
 * @param {string} label - Field label for error message.
 * @param {string[]} errors - Array to push error messages into.
 * @param {boolean} [allowEmpty=false] - Whether to allow empty string.
 * @returns {boolean} True if validation passes, otherwise false.
 */
function expectString(value, label, errors, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

/**
 * Assert that a value is a boolean, appending errors on failure.
 * @param {any} value - Value to check.
 * @param {string} label - Field label for error message.
 * @param {string[]} errors - Array to push error messages into.
 * @returns {boolean} True if validation passes, otherwise false.
 */
function expectBoolean(value, label, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return false;
  }
  return true;
}

/**
 * Assert that a value is a positive integer, appending errors on failure.
 * @param {any} value - Value to check.
 * @param {string} label - Field label for error message.
 * @param {string[]} errors - Array to push error messages into.
 * @returns {boolean} True if validation passes, otherwise false.
 */
function expectPositiveInteger(value, label, errors) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive integer`);
    return false;
  }
  return true;
}

/**
 * Validate that an object property is a string array.
 * @param {object} root - Object containing the field.
 * @param {string} field - Field name.
 * @param {string[]} errors - Array to push error messages into.
 */
function validateStringArray(root, field, errors) {
  if (!expectArray(root?.[field], field, errors)) return;
  for (const [index, item] of root[field].entries()) {
    expectString(item, `${field}[${index}]`, errors);
  }
}

function isPlaceholderText(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '' ||
    normalized === 'tbd' ||
    normalized.startsWith('tbd:') ||
    normalized === 'todo' ||
    normalized.startsWith('todo:') ||
    normalized === 'unknown';
}

function validateCompletedGoalFields(goal, errors) {
  if (isPlaceholderText(goal?.end_goal?.success_definition)) {
    errors.push('completed preflight input requires user-confirmed end_goal.success_definition, not a placeholder');
  }
  if (expectObject(goal?.target_stack, 'target_stack', errors)) {
    for (const field of ['language', 'runtime', 'framework', 'package_manager', 'test_framework']) {
      const value = goal.target_stack[field];
      if (value !== null && isPlaceholderText(value)) {
        errors.push(`completed preflight input requires user-confirmed target_stack.${field}, not a placeholder`);
      }
    }
  }
}

function validateIntentConfirmation(goal, errors) {
  if (!expectObject(goal.intent_confirmation, 'intent_confirmation', errors)) return;
  expectString(goal.intent_confirmation.confirmed_at, 'intent_confirmation.confirmed_at', errors);
  for (const field of ['end_goal_source', 'target_stack_source', 'controller_mode_source']) {
    if (goal.intent_confirmation[field] !== EXPLICIT_USER_ANSWER) {
      errors.push(`intent_confirmation.${field} must be "${EXPLICIT_USER_ANSWER}"`);
    }
  }
  expectString(goal.intent_confirmation.user_goal_summary, 'intent_confirmation.user_goal_summary', errors);
  expectString(goal.intent_confirmation.user_target_stack_summary, 'intent_confirmation.user_target_stack_summary', errors);
}

/**
 * Validate a preflight goal contract object.
 * @param {object} goal - Goal contract object to validate.
 * @param {object} [options={}] - Validation options (e.g. requireComplete).
 * @returns {string[]} Array of validation error messages.
 */
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

  if (goal.execution_policy !== undefined) {
    validateExecutionPolicy(goal.execution_policy, errors);
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
    validateCompletedGoalFields(goal, errors);
    if (goal.intent_confirmation === undefined) {
      errors.push('completed preflight input requires intent_confirmation with explicit user-confirmed end goal and target stack');
    } else {
      validateIntentConfirmation(goal, errors);
    }
  } else if (goal.intent_confirmation !== undefined) {
    validateIntentConfirmation(goal, errors);
  }

  if (options.requireUnattended) {
    if (goal.controller_policy?.mode !== 'unattended') {
      errors.push('runner-ready preflight requires controller_policy.mode="unattended"');
    }
    if (!options.requireComplete && goal.intent_confirmation === undefined) {
      errors.push('runner-ready preflight requires intent_confirmation with explicit user-confirmed end goal and target stack');
    }
  }

  return errors;
}

/**
 * Validate the execution policy block of a preflight goal contract.
 * @param {object} policy - Execution policy object.
 * @param {string[]} errors - Array to push error messages into.
 */
function validateExecutionPolicy(policy, errors) {
  if (!expectObject(policy, 'execution_policy', errors)) return;
  if (!VALID_EXECUTION_BACKENDS.has(policy.backend)) {
    errors.push('execution_policy.backend must be host, docker, or podman');
  }
  if (!VALID_CONTAINER_PROFILES.has(policy.preferred_container_profile)) {
    errors.push('execution_policy.preferred_container_profile is not supported');
  }
  if (!VALID_NETWORK_POLICIES.has(policy.network_policy)) {
    errors.push('execution_policy.network_policy must be off, deps-only, or on');
  }
  if (!VALID_DEPENDENCY_INSTALL_POLICIES.has(policy.dependency_install_policy)) {
    errors.push('execution_policy.dependency_install_policy must be offline, locked, or allow-new');
  }
  expectBoolean(policy.allow_native_toolchain, 'execution_policy.allow_native_toolchain', errors);
  if (!expectObject(policy.resource_limits, 'execution_policy.resource_limits', errors)) return;
  expectPositiveInteger(policy.resource_limits.memory_mb, 'execution_policy.resource_limits.memory_mb', errors);
  expectPositiveInteger(policy.resource_limits.timeout_seconds, 'execution_policy.resource_limits.timeout_seconds', errors);
  if (typeof policy.resource_limits.cpus !== 'number' || policy.resource_limits.cpus < 1 || policy.resource_limits.cpus > 16) {
    errors.push('execution_policy.resource_limits.cpus must be a number between 1 and 16');
  }
  if (Number.isInteger(policy.resource_limits.memory_mb) && policy.resource_limits.memory_mb > 65536) {
    errors.push('execution_policy.resource_limits.memory_mb must be at most 65536');
  }
  if (Number.isInteger(policy.resource_limits.timeout_seconds) && policy.resource_limits.timeout_seconds > 600) {
    errors.push('execution_policy.resource_limits.timeout_seconds must be at most 600');
  }
}

/**
 * Validate the code hygiene policy block of a preflight goal contract.
 * @param {object} policy - Code hygiene policy object.
 * @param {string[]} errors - Array to push error messages into.
 */
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

module.exports = {
  validateGoalContract,
};
