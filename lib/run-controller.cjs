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
const { buildClaudeAgentCommandConfig } = require('./run-claude-agent-runtime.cjs');
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

function validateRunState(options, taskManifestPath, roots, manifest, coverageLedgerPath) {
  validateImplementationArtifactPlacement(roots);
  validateArtifacts(options.python, taskManifestPath, roots);
  validateCleanRunContextReferences(options.python, roots);
  const coverageLedger = readOptionalJson(coverageLedgerPath);
  validateCoverageLedgerIntegrity(manifest, roots, coverageLedger);
  validateFoundationCoverageGate(manifest, coverageLedger);
  return coverageLedger;
}

function rootListEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertStableRunRoots(initialRoots, currentRoots) {
  if (
    !rootListEqual(initialRoots.sourceRoots, currentRoots.sourceRoots) ||
    initialRoots.contaminatedRoot !== currentRoots.contaminatedRoot ||
    initialRoots.cleanRoot !== currentRoots.cleanRoot ||
    !rootListEqual(initialRoots.implementationRoots, currentRoots.implementationRoots) ||
    !rootListEqual(initialRoots.allowedReadRoots, currentRoots.allowedReadRoots) ||
    initialRoots.schemaDir !== currentRoots.schemaDir
  ) {
    throw new Error('task manifest root drift detected during unattended run');
  }
}

function reloadManifestForIteration(options, taskManifestPath, manifestDir, roots, schemaDir) {
  validateTaskManifestSchema(options.python, taskManifestPath, schemaDir);
  const currentManifest = readJsonFile(taskManifestPath, null);
  validateTaskManifestForRun(currentManifest);
  const currentRoots = resolveRoots(currentManifest, manifestDir, schemaDir);
  assertStableRunRoots(roots, currentRoots);
  validateTaskManifestLocation(taskManifestPath, currentRoots);
  verifyPreflightGoal(currentManifest, manifestDir, currentRoots);
  return currentManifest;
}

function resolveAgentConfig(options, context, roots, manifest, agentConfigPath) {
  if (options.agentCommands && options.agentRuntime) {
    throw new Error('--agent-runtime cannot be used with --agent-commands');
  }
  if (!options.agentCommands && !options.agentRuntime) {
    return { agentConfig: null, configDir: process.cwd() };
  }
  if (options.agentRuntime === 'claude') {
    const builtIn = buildClaudeAgentCommandConfig(options, roots, context.cwd || process.cwd());
    validateCommandConfig(builtIn.config, {
      roots,
      configDir: builtIn.configDir,
      contextManagement: manifest.context_management,
    });
    return { agentConfig: builtIn.config, configDir: builtIn.configDir };
  }
  const agentConfig = readJsonFile(agentConfigPath, null);
  const configDir = path.dirname(agentConfigPath);
  validateCommandConfig(agentConfig, { roots, configDir, contextManagement: manifest.context_management });
  return { agentConfig, configDir };
}

function shouldContinueAfterUnitComplete(manifest, coverageLedger) {
  return Boolean(selectUnit(manifest, coverageLedger));
}

async function runCleanRoom(options, context = {}) {
  if (options.help) {
    printRunHelp();
    return null;
  }
  if (!options.taskManifest) {
    throw new Error('--task-manifest is required');
  }
  if (!options.dryRun && !options.agentCommands && !options.agentRuntime) {
    throw new Error('--agent-commands or --agent-runtime is required unless --dry-run is set');
  }
  if (options.agentCommands && options.agentRuntime) {
    throw new Error('--agent-runtime cannot be used with --agent-commands');
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
  const { agentConfig, configDir } = options.dryRun
    ? { agentConfig: null, configDir: process.cwd() }
    : resolveAgentConfig(options, context, roots, manifest, agentConfigPath);

  return withRunLock(roots.contaminatedRoot, options.dryRun, async () => {
    const coverageLedgerPath = path.join(roots.contaminatedRoot, 'coverage-ledger.json');
    const coverageLedger = validateRunState(options, taskManifestPath, roots, manifest, coverageLedgerPath);
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
    let resultManifest = manifest;
    const polishRequired = agentConfig.stages.some((stage) => stage.phase === POLISH_PHASE);
    for (let offset = 0; offset < cap; offset += 1) {
      const currentManifest = reloadManifestForIteration(options, taskManifestPath, manifestDir, roots, schemaDir);
      resultManifest = currentManifest;
      const strictContext = strictContextManagement(currentManifest.context_management);
      const currentCoverageLedger = validateRunState(options, taskManifestPath, roots, currentManifest, coverageLedgerPath);
      const selected = selectUnit(currentManifest, currentCoverageLedger);
      if (!selected) {
        terminalResult = completeResultOrSpecDelta(currentManifest, roots, currentCoverageLedger);
        break;
      }
      const previous = previousIteration(ledger);
      if (repeatedUnitSelection(previous, selected)) {
        terminalResult = buildResult(currentManifest, 'no-progress-detected', 'partial', null, null, [
          {
            kind: 'other',
            summary: 'The same unit was selected again after a no-progress iteration.',
            status: 'open',
          },
        ]);
        ledger.iterations.push({
          iteration: ledger.iterations.length + 1,
          unit_id: selected.unit_id,
          stop_reason: 'repeated-unit-selection',
          phases: [],
        });
        writeLedger(ledgerPath, ledger);
        console.log('clean-room run: repeated-unit-selection');
        break;
      }

      const iteration = (currentManifest.loop_context.inner_iteration || 0) + offset + 1;
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
          currentManifest,
          selected,
          strictContext
        );
        const stageResult = runStage(stage, configDir, roots, currentManifest, selected, iteration, sessionContext);
        const afterStage = artifactSnapshot(taskManifestPath, roots);
        phaseResults.push(stageResult);
        validateImplementationArtifactPlacement(roots);
        validateArtifacts(options.python, taskManifestPath, roots, changedSnapshotPaths(beforeStage, afterStage));
        validateCleanRunContextReferences(options.python, roots);
        const stageCoverageLedger = readOptionalJson(coverageLedgerPath);
        validateCoverageLedgerIntegrity(currentManifest, roots, stageCoverageLedger);
        validateFoundationCoverageGate(currentManifest, stageCoverageLedger);
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
        unit_id: selected.unit_id,
        spec_slice_ref: currentManifest.loop_context.spec_slice_ref,
        phases: phaseResults,
        progress_detected: progressDetected,
      };

      if (failedStage) {
        terminalResult = stageFailureResult(currentManifest, failedStage);
        ledgerEntry.stop_reason = 'spec-slice-blocked';
      } else if (!progressDetected) {
        terminalResult = noProgressResult(currentManifest);
        ledgerEntry.stop_reason = 'no-progress-detected';
      } else if (coveragePhaseRan) {
        terminalResult = inferTerminalResult(currentManifest, roots, selected, {
          polishRequired,
          observedChangedPaths: changedImplementationPaths(before, after),
        });
        if (terminalResult) {
          if (terminalResult.result === 'spec-slice-complete') {
            const latestCoverageLedger = readOptionalJson(coverageLedgerPath);
            validateCoverageLedgerIntegrity(currentManifest, roots, latestCoverageLedger);
            validateFoundationCoverageGate(currentManifest, latestCoverageLedger);
            if (shouldContinueAfterUnitComplete(currentManifest, latestCoverageLedger)) {
              ledgerEntry.stop_reason = 'unit-complete';
              terminalResult = null;
            } else {
              ledgerEntry.stop_reason = terminalResult.result;
            }
          } else {
            ledgerEntry.stop_reason = terminalResult.result;
          }
        }
      }

      ledger.iterations.push(ledgerEntry);
      writeLedger(ledgerPath, ledger);
      if (terminalResult) {
        break;
      }
    }

    if (!terminalResult) {
      terminalResult = iterationLimitResult(resultManifest);
    }
    writeResult(resultPath, terminalResult);
    validateImplementationArtifactPlacement(roots);
    validateArtifacts(options.python, taskManifestPath, roots);
    validateCleanRunContextReferences(options.python, roots);
    const finalCoverageLedger = readOptionalJson(coverageLedgerPath);
    validateCoverageLedgerIntegrity(resultManifest, roots, finalCoverageLedger);
    validateFoundationCoverageGate(resultManifest, finalCoverageLedger);
    console.log(`clean-room run: ${terminalResult.result}`);
    return terminalResult;
  });
}

module.exports = {
  runCleanRoom,
};
