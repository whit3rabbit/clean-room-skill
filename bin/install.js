#!/usr/bin/env node
'use strict';

const { runInit } = require('../lib/bootstrap.cjs');
const { buildDesiredFiles } = require('../lib/install-artifacts.cjs');
const { planInstall } = require('../lib/install-plan.cjs');
const { main } = require('../lib/install-cli.cjs');
const { parseArgs } = require('../lib/install-options.cjs');
const { parseRuntimeSelection } = require('../lib/install-runtime-selection.cjs');
const {
  collectRuntimeStatus,
  resolveTargetRoot,
  runStatus,
  runtimeInstallStatus,
} = require('../lib/install-status.cjs');
const { parsePreflightArgs, runPreflight } = require('../lib/preflight.cjs');
const { parseRunArgs, runCleanRoom } = require('../lib/run.cjs');

if (require.main === module) {
  main().catch((err) => {
    console.error(`clean-room-skill: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDesiredFiles,
  parseArgs,
  parsePreflightArgs,
  parseRuntimeSelection,
  planInstall,
  parseRunArgs,
  runInit,
  runPreflight,
  runCleanRoom,
  runStatus,
  runtimeInstallStatus,
  collectRuntimeStatus,
  resolveTargetRoot,
};
