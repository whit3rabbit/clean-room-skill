'use strict';

const {
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
} = require('./fs-utils.cjs');

/**
 * Write preflight goal object to file or dry-run print it.
 * @param {string} outputPath - Target file path.
 * @param {object} goal - Preflight goal object.
 * @param {object} options - Write options (force, dryRun).
 */
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

module.exports = {
  writePreflightOutput,
};
