'use strict';

const { resolveGoalPath } = require('./preflight-paths.cjs');

/**
 * Apply bootstrap output policy values to the preflight goal object.
 * @param {object} goal - Preflight goal object.
 * @param {object} bootstrap - Verified bootstrap metadata and roots.
 */
function applyBootstrapOutputPolicy(goal, bootstrap) {
  goal.output_policy.artifact_base_root = bootstrap.outputRoot;
  goal.output_policy.implementation_root = bootstrap.roots.implementation;
}

/**
 * Validate that the preflight goal output policy matches bootstrap paths.
 * @param {object} goal - Preflight goal object.
 * @param {object} bootstrap - Verified bootstrap metadata and roots.
 * @param {string} cwd - Current working directory.
 * @param {string} homeDir - User home directory.
 * @returns {string[]} Validation error messages.
 */
function validateBootstrapOutputPolicy(goal, bootstrap, cwd, homeDir) {
  const errors = [];
  const artifactBaseRoot = resolveGoalPath(goal?.output_policy?.artifact_base_root, cwd, homeDir);
  const implementationRoot = resolveGoalPath(goal?.output_policy?.implementation_root, cwd, homeDir);
  if (artifactBaseRoot !== bootstrap.outputRoot) {
    errors.push(`output_policy.artifact_base_root must match bootstrap task root: ${bootstrap.outputRoot}`);
  }
  if (implementationRoot !== bootstrap.roots.implementation) {
    errors.push(`output_policy.implementation_root must match bootstrap implementation root: ${bootstrap.roots.implementation}`);
  }
  return errors;
}

module.exports = {
  applyBootstrapOutputPolicy,
  validateBootstrapOutputPolicy,
};
