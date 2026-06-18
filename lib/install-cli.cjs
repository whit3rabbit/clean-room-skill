'use strict';

const { runInit } = require('./bootstrap.cjs');
const { runArtifact } = require('./artifact.cjs');
const { runDoctor } = require('./doctor.cjs');
const { runPreflight } = require('./preflight.cjs');
const { parseRunArgs, runCleanRoom } = require('./run.cjs');
const { packageVersion } = require('./install-artifacts.cjs');
const { applyCcsiloInstallOptions } = require('./ccsilo.cjs');
const { resolveInteractiveOptions } = require('./install-tui.cjs');
const {
  operationForOptions,
  parseArgs,
  validateRuntimeOptions,
} = require('./install-options.cjs');
const {
  installRuntime,
  uninstallRuntime,
  updateRuntime,
} = require('./install-operations.cjs');
const {
  runStatus,
  selectedUpdateRuntimes,
} = require('./install-status.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(packageVersion());
    return;
  }
  if (argv[0] === 'init') {
    runInit(argv.slice(1));
    return;
  }
  if (argv[0] === 'doctor') {
    runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'artifact') {
    runArtifact(argv.slice(1));
    return;
  }
  if (argv[0] === 'preflight') {
    runPreflight(argv.slice(1));
    return;
  }
  if (argv[0] === 'run') {
    await runCleanRoom(parseRunArgs(argv.slice(1)));
    return;
  }
  if (argv[0] === 'status') {
    const options = parseArgs(argv.slice(1));
    options.operation = 'status';
    applyCcsiloInstallOptions(options);
    if (options.configDir && options.runtimes.length === 0) {
      throw new Error('--config-dir can only be used with one runtime');
    }
    if (!options.scope) options.scope = 'global';
    validateRuntimeOptions(options);
    runStatus(options);
    return;
  }
  if (argv[0] === 'update') {
    const options = parseArgs(argv.slice(1));
    options.operation = 'update';
    applyCcsiloInstallOptions(options);
    if (options.configDir && options.runtimes.length === 0) {
      throw new Error('--config-dir can only be used with one runtime');
    }
    if (!options.scope) options.scope = 'global';
    options.runtimes = selectedUpdateRuntimes(options);
    validateRuntimeOptions(options);
    if (options.runtimes.length === 0) {
      console.log(`No installed ${options.scope} runtimes found to update.`);
      return;
    }
    for (const runtime of options.runtimes) {
      await updateRuntime(runtime, options);
    }
    return;
  }
  const parsedOptions = parseArgs(argv);
  applyCcsiloInstallOptions(parsedOptions);
  const options = parsedOptions.ccsilo
    ? parsedOptions
    : await resolveInteractiveOptions(parsedOptions);
  if (!options.scope) {
    options.scope = 'global';
  }
  validateRuntimeOptions(options);
  if (operationForOptions(options) === 'status') {
    runStatus(options);
    return;
  }
  if (operationForOptions(options) === 'update') {
    options.runtimes = selectedUpdateRuntimes(options);
    if (options.runtimes.length === 0) {
      console.log(`No installed ${options.scope} runtimes found to update.`);
      return;
    }
  }
  for (const runtime of options.runtimes) {
    if (operationForOptions(options) === 'uninstall') {
      await uninstallRuntime(runtime, options);
    } else if (operationForOptions(options) === 'update') {
      await updateRuntime(runtime, options);
    } else {
      await installRuntime(runtime, options);
    }
  }
}

module.exports = {
  main,
};
