'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonFile } = require('./fs-utils.cjs');
const {
  LEDGER_NAME,
  POLISH_PHASE,
  REQUIRED_COVERAGE_PHASE,
  RESULT_NAME,
} = require('./run-constants.cjs');
const { printRunHelp } = require('./run-cli.cjs');
const {
  readOptionalJson,
  validateCleanRunContextReferences,
} = require('./run-clean-artifacts.cjs');
const {
  selectUnit,
  validateCoverageLedgerIntegrity,
  validateFoundationCoverageGate,
} = require('./run-coverage.cjs');
const {
  validateArtifacts,
  validateTaskManifestSchema,
} = require('./run-hooks.cjs');
const {
  effectiveIterationCap,
  validateTaskManifestForRun,
} = require('./run-manifest.cjs');
const {
  artifactSnapshot,
  changedImplementationPaths,
  changedSnapshotPaths,
  semanticProgressSnapshot,
  snapshotsEqual,
  validateImplementationArtifactPlacement,
} = require('./run-progress.cjs');
const {
  defaultSchemaDir,
  resolvePath,
  resolveRoots,
  validateTaskManifestLocation,
  verifyPreflightGoal,
} = require('./run-roots.cjs');
const {
  buildResult,
  completeResultOrSpecDelta,
  inferTerminalResult,
  iterationLimitResult,
  loadLedger,
  noProgressResult,
  stageFailureResult,
  withRunLock,
  writeLedger,
  writeResult,
} = require('./run-results.cjs');
const {
  prepareStageSessionContext,
  runStage,
  strictContextManagement,
  validateCommandConfig,
} = require('./run-stages.cjs');

function previousIteration(ledger) {
  return ledger.iterations[ledger.iterations.length - 1] || null;
}

function repeatedUnitSelection(previous, selectedUnit) {
  return previous?.unit_id === selectedUnit.unit_id && previous?.stop_reason === 'no-progress-detected';
}

async function runCleanRoom(options, context = {}) {
  if (options.help) {
    printRunHelp();
    return null;
  }
  if (!options.taskManifest) {
    throw new Error('--task-manifest is required');
  }
  if (!options.dryRun && !options.agentCommands) {
    throw new Error('--agent-commands is required unless --dry-run is set');
  }

  const taskManifestPath = resolvePath(options.taskManifest, context.cwd || process.cwd());
  if (!fs.existsSync(taskManifestPath)) {
    throw new Error(`task manifest not found: ${taskManifestPath}`);
  }
  const manifestDir = path.dirname(taskManifestPath);
  const schemaDir = options.schemaDir ? resolvePath(options.schemaDir, context.cwd || process.cwd()) : defaultSchemaDir();
  validateTaskManifestSchema(options.python, taskManifestPath, schemaDir);
  const manifest = readJsonFile(taskManifestPath, null);
  validateTaskManifestForRun(manifest);
  const roots = resolveRoots(manifest, manifestDir, schemaDir);
  validateTaskManifestLocation(taskManifestPath, roots);
  verifyPreflightGoal(manifest, manifestDir, roots);
  const cap = effectiveIterationCap(manifest, options);
  const agentConfigPath = options.agentCommands ? resolvePath(options.agentCommands, context.cwd || process.cwd()) : null;
  const agentConfig = agentConfigPath ? readJsonFile(agentConfigPath, null) : null;
  const configDir = agentConfigPath ? path.dirname(agentConfigPath) : process.cwd();
  if (agentConfig) {
    validateCommandConfig(agentConfig, { roots, configDir, contextManagement: manifest.context_management });
  }

  return withRunLock(roots.contaminatedRoot, options.dryRun, async () => {
    const coverageLedgerPath = path.join(roots.contaminatedRoot, 'coverage-ledger.json');
    validateImplementationArtifactPlacement(roots);
    validateArtifacts(options.python, taskManifestPath, roots);
    validateCleanRunContextReferences(options.python, roots);
    const coverageLedger = readOptionalJson(coverageLedgerPath);
    validateCoverageLedgerIntegrity(manifest, roots, coverageLedger);
    validateFoundationCoverageGate(manifest, coverageLedger);
    const selectedUnit = selectUnit(manifest, coverageLedger);
    if (!selectedUnit) {
      const result = completeResultOrSpecDelta(manifest, roots, coverageLedger);
      if (!options.dryRun) writeResult(path.join(roots.contaminatedRoot, RESULT_NAME), result);
      console.log(`clean-room run: ${result.result}`);
      return result;
    }

    const ledgerPath = path.join(roots.contaminatedRoot, LEDGER_NAME);
    const resultPath = path.join(roots.contaminatedRoot, RESULT_NAME);
    const ledger = loadLedger(ledgerPath, manifest);
    const previous = previousIteration(ledger);
    if (repeatedUnitSelection(previous, selectedUnit)) {
      const result = buildResult(manifest, 'no-progress-detected', 'partial', null, null, [
        {
          kind: 'other',
          summary: 'The same unit was selected again after a no-progress iteration.',
          status: 'open',
        },
      ]);
      if (!options.dryRun) {
        writeResult(resultPath, result);
        ledger.iterations.push({
          iteration: ledger.iterations.length + 1,
          unit_id: selectedUnit.unit_id,
          stop_reason: 'repeated-unit-selection',
          phases: [],
        });
        writeLedger(ledgerPath, ledger);
      }
      console.log('clean-room run: repeated-unit-selection');
      return result;
    }

    if (options.dryRun) {
      console.log(`clean-room run dry-run: selected ${selectedUnit.unit_id}`);
      console.log(`clean-room run dry-run: spec slice ${manifest.loop_context.spec_slice_ref}`);
      console.log(`clean-room run dry-run: iteration cap ${cap}`);
      return {
        selected_unit_id: selectedUnit.unit_id,
        spec_slice_ref: manifest.loop_context.spec_slice_ref,
        iteration_cap: cap,
      };
    }

    let terminalResult = null;
    const polishRequired = agentConfig.stages.some((stage) => stage.phase === POLISH_PHASE);
    const strictContext = strictContextManagement(manifest.context_management);
    for (let offset = 0; offset < cap; offset += 1) {
      const iteration = (manifest.loop_context.inner_iteration || 0) + offset + 1;
      const before = semanticProgressSnapshot(taskManifestPath, roots);
      const phaseResults = [];
      let coveragePhaseRan = false;
      let failedStage = null;

      for (const stage of agentConfig.stages) {
        const beforeStage = artifactSnapshot(taskManifestPath, roots);
        const sessionContext = prepareStageSessionContext(
          options.python,
          stage,
          configDir,
          roots,
          manifest,
          selectedUnit,
          strictContext
        );
        const stageResult = runStage(stage, configDir, roots, manifest, selectedUnit, iteration, sessionContext);
        const afterStage = artifactSnapshot(taskManifestPath, roots);
        phaseResults.push(stageResult);
        validateImplementationArtifactPlacement(roots);
        validateArtifacts(options.python, taskManifestPath, roots, changedSnapshotPaths(beforeStage, afterStage));
        validateCleanRunContextReferences(options.python, roots);
        const stageCoverageLedger = readOptionalJson(coverageLedgerPath);
        validateCoverageLedgerIntegrity(manifest, roots, stageCoverageLedger);
        validateFoundationCoverageGate(manifest, stageCoverageLedger);
        if (stage.phase === REQUIRED_COVERAGE_PHASE && stageResult.status === 'passed') {
          coveragePhaseRan = true;
        }
        if (stageResult.status !== 'passed') {
          failedStage = stageResult;
          break;
        }
      }

      const after = semanticProgressSnapshot(taskManifestPath, roots);
      const progressDetected = !snapshotsEqual(before, after);
      const ledgerEntry = {
        iteration,
        unit_id: selectedUnit.unit_id,
        spec_slice_ref: manifest.loop_context.spec_slice_ref,
        phases: phaseResults,
        progress_detected: progressDetected,
      };

      if (failedStage) {
        terminalResult = stageFailureResult(manifest, failedStage);
        ledgerEntry.stop_reason = 'spec-slice-blocked';
      } else if (!progressDetected) {
        terminalResult = noProgressResult(manifest);
        ledgerEntry.stop_reason = 'no-progress-detected';
      } else if (coveragePhaseRan) {
        terminalResult = inferTerminalResult(manifest, roots, selectedUnit, {
          polishRequired,
          observedChangedPaths: changedImplementationPaths(before, after),
        });
        if (terminalResult) {
          ledgerEntry.stop_reason = terminalResult.result;
        }
      }

      ledger.iterations.push(ledgerEntry);
      writeLedger(ledgerPath, ledger);
      if (terminalResult) {
        break;
      }
    }

    if (!terminalResult) {
      terminalResult = iterationLimitResult(manifest);
    }
    writeResult(resultPath, terminalResult);
    validateImplementationArtifactPlacement(roots);
    validateArtifacts(options.python, taskManifestPath, roots);
    validateCleanRunContextReferences(options.python, roots);
    const finalCoverageLedger = readOptionalJson(coverageLedgerPath);
    validateCoverageLedgerIntegrity(manifest, roots, finalCoverageLedger);
    validateFoundationCoverageGate(manifest, finalCoverageLedger);
    console.log(`clean-room run: ${terminalResult.result}`);
    return terminalResult;
  });
}

module.exports = {
  runCleanRoom,
};
