'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Expand tilde character `~` to home directory.
 * @param {string} value - Path value which may start with `~`.
 * @param {string} [homeDir=os.homedir()] - User home directory.
 * @returns {string} The expanded path.
 */
function expandTilde(value, homeDir = os.homedir()) {
  if (value === '~') return homeDir;
  if (typeof value === 'string' && value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

/**
 * Resolve the destination preflight output path.
 * @param {string} value - Path value.
 * @param {string} [cwd=process.cwd()] - Current working directory.
 * @param {string} [homeDir=os.homedir()] - User home directory.
 * @returns {string} The resolved absolute path.
 */
function resolveOutputPath(value, cwd = process.cwd(), homeDir = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--output requires a path');
  }
  const expanded = expandTilde(value, homeDir);
  return path.resolve(cwd, expanded);
}

/**
 * Resolve the input preflight goal path.
 * @param {string} value - Path value.
 * @param {string} [cwd=process.cwd()] - Current working directory.
 * @param {string} [homeDir=os.homedir()] - User home directory.
 * @returns {string} The resolved absolute path.
 */
function resolveInputPath(value, cwd = process.cwd(), homeDir = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--input requires a path');
  }
  const expanded = expandTilde(value, homeDir);
  return path.resolve(cwd, expanded);
}

/**
 * Resolve a path value within the preflight goal configuration.
 * @param {string|null|undefined} value - Path value to resolve.
 * @param {string} cwd - Current working directory.
 * @param {string} homeDir - User home directory.
 * @returns {string|null} Resolved absolute path or null.
 */
function resolveGoalPath(value, cwd, homeDir) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return path.resolve(cwd, expandTilde(value, homeDir));
}

module.exports = {
  expandTilde,
  resolveGoalPath,
  resolveInputPath,
  resolveOutputPath,
};
