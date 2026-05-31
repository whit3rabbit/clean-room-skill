'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { withDirectoryLock } = require('./dir-lock.cjs');
const {
  readJsonFile,
  writeJsonFile,
} = require('./fs-utils.cjs');
const {
  CLEAN_RUN_CONTEXT_NAME,
  MAX_LEDGER_ITERATIONS,
  POLISH_REPORT_NAME,
  RUN_LOCK_NAME,
  RUN_LOCK_POLL_MS,
  RUN_LOCK_WAIT_MS,
  TERMINAL_RESULTS,
} = require('./run-constants.cjs');
const {
  behaviorSpecOpenQuestionTickets,
  cleanCompletionArtifactPath,
  cleanContextArtifactPath,
  cleanContextBehaviorSpecPaths,
  readCleanCompletionArtifact,
  readCleanRunContext,
  readOptionalJson,
  skeletonAreaMap,
  validatePathsOwnedByAreas,
} = require('./run-clean-artifacts.cjs');
const {
  approvedUnitIds,
  coverageMap,
  validateFoundationCoverageGate,
} = require('./run-coverage.cjs');

function abstractTickets(...sources) {
  const tickets = [];
  for (const source of sources) {
    for (const ticket of source?.abstract_delta_tickets || []) {
      if (ticket && typeof ticket === 'object' && typeof ticket.summary === 'string') {
        tickets.push(sanitizeTicket(ticket));
      }
    }
  }
  return tickets;
}

function sanitizeTicket(ticket) {
  const clean = { summary: ticket.summary };
  for (const key of ['ticket_id', 'kind', 'requested_clean_change', 'status']) {
    if (typeof ticket[key] === 'string') {
      clean[key] = ticket[key];
    }
  }
  return clean;
}

function architectureDeltaTicket(summary) {
  return {
    ticket_id: 'delta-architecture-drift',
    kind: 'implementation-gap',
    summary,
    requested_clean_change: 'Revise skeleton-manifest.json and implementation-plan.json, then rerun clean implementation inside owned architecture areas.',
    status: 'open',
  };
}

function validateImplementationReportArchitecture(report, plan, skeleton) {
  const areas = skeletonAreaMap(skeleton);
  const workItems = new Map();
  for (const workItem of plan?.work_items || []) {
    if (workItem && typeof workItem.work_item_id === 'string') {
      workItems.set(workItem.work_item_id, workItem);
    }
  }

  for (const changedPath of report?.changed_paths || []) {
    const workItemIds = changedPath?.work_item_ids || [];
    if (!Array.isArray(workItemIds) || workItemIds.length === 0) {
      throw new Error('implementation-report changed path has no planned work item');
    }
    const areaRefs = new Set();
    for (const workItemId of workItemIds) {
      const workItem = workItems.get(workItemId);
      if (!workItem) {
        throw new Error('implementation-report changed path references an unknown work item');
      }
      for (const areaRef of workItem.architecture_area_refs || []) {
        areaRefs.add(areaRef);
      }
    }
    validatePathsOwnedByAreas([changedPath.path], [...areaRefs], areas, 'implementation-report changed path');
  }
}

function implementationReportArchitectureTickets(roots, observedChangedPaths = null) {
  const { artifact: report } = readCleanCompletionArtifact(roots, 'implementation_report', 'implementation-report.json', 'clean-run-context implementation_report');
  if (!report || !Array.isArray(report.changed_paths)) {
    return [];
  }
  if (report.changed_paths.length > 0) {
    const context = readCleanRunContext(roots);
    const skeletonPath = context
      ? cleanContextArtifactPath(context, roots, 'skeleton_manifest', 'clean-run-context skeleton_manifest')
      : path.join(roots.cleanRoot, 'skeleton-manifest.json');
    const planPath = cleanCompletionArtifactPath(roots, 'implementation_plan', 'implementation-plan.json', 'clean-run-context implementation_plan');
    if (!skeletonPath || !planPath || !fs.existsSync(skeletonPath) || !fs.existsSync(planPath)) {
      return [architectureDeltaTicket('Implementation report changed paths cannot be reconciled because the clean architecture map or implementation plan is missing.')];
    }
    try {
      validateImplementationReportArchitecture(
        report,
        readJsonFile(planPath, null),
        readJsonFile(skeletonPath, null)
      );
    } catch {
      return [architectureDeltaTicket('Implementation report changed paths do not map to planned work items and owned architecture areas.')];
    }
  }
  if (Array.isArray(observedChangedPaths)) {
    const normalizedReported = [...new Set(report.changed_paths.map((entry) => entry?.path).filter((value) => typeof value === 'string' && value.trim() !== ''))].sort();
    const normalizedObserved = [...new Set(observedChangedPaths.filter((value) => typeof value === 'string' && value.trim() !== ''))].sort();
    if (normalizedReported.length !== normalizedObserved.length || normalizedReported.some((value, index) => value !== normalizedObserved[index])) {
      return [architectureDeltaTicket('Implementation report changed paths did not match observed implementation-root file changes. Re-run clean implementation with accurate changed_paths.')];
    }
  }
  return [];
}

function qcArchitectureTickets(qc) {
  if (qc?.architecture_status === 'drift') {
    return [architectureDeltaTicket('QC reported clean architecture drift.')];
  }
  if (qc?.architecture_status === 'blocked') {
    return [architectureDeltaTicket('QC blocked completion on clean architecture alignment.')];
  }
  return [];
}

function completionQualityTickets(qc) {
  const tickets = [];
  if (!qc) {
    return tickets;
  }
  if (qc.coverage_status && qc.coverage_status !== 'complete') {
    tickets.push({
      ticket_id: 'delta-qc-coverage',
      kind: 'implementation-gap',
      summary: `QC coverage_status is ${qc.coverage_status}, not complete.`,
      requested_clean_change: 'Resolve QC coverage gaps before marking the spec slice complete.',
      status: 'open',
    });
  }
  if (qc.final_status && qc.final_status !== 'passed') {
    tickets.push({
      ticket_id: 'delta-qc-final-status',
      kind: 'implementation-gap',
      summary: `QC final_status is ${qc.final_status}, not passed.`,
      requested_clean_change: 'Resolve QC findings before marking the spec slice complete.',
      status: 'open',
    });
  }
  return tickets;
}

function architectureDeltaTickets(roots, qc, observedChangedPaths = null) {
  return [
    ...qcArchitectureTickets(qc),
    ...implementationReportArchitectureTickets(roots, observedChangedPaths),
  ];
}

function polishDeltaTicket(summary) {
  return {
    ticket_id: 'delta-polish-review',
    kind: 'implementation-gap',
    summary,
    requested_clean_change: 'Resolve the final clean polish review finding, update polish-report.json, rerun verification, and create the constrained implementation-root commit.',
    status: 'open',
  };
}

function polishReviewTickets(polish, polishRequired) {
  if (!polish) {
    return polishRequired
      ? [polishDeltaTicket('The configured clean polish review stage did not produce polish-report.json.')]
      : [];
  }
  const tickets = [];
  if (polish.final_status === 'failed') {
    tickets.push(polishDeltaTicket('Final clean polish review failed.'));
  } else if (polish.final_status === 'blocked') {
    tickets.push(polishDeltaTicket('Final clean polish review blocked completion.'));
  } else if (polish.final_status === 'passed-with-gaps') {
    tickets.push(polishDeltaTicket('Final clean polish review passed with unresolved gaps.'));
  }
  return tickets;
}

function polishBlocksCompletion(polish, polishRequired) {
  if (!polish) return polishRequired;
  return polish.final_status !== 'passed';
}

function validateTerminalCompletionArtifacts(roots) {
  const context = readCleanRunContext(roots);
  if (!context) {
    throw new Error(`completion requires ${CLEAN_RUN_CONTEXT_NAME} under CLEAN_ROOM_CLEAN_ROOTS`);
  }
  const specPaths = cleanContextBehaviorSpecPaths(context, roots);
  if (specPaths.length === 0) {
    throw new Error('completion requires at least one clean behavior spec in clean-run-context.json');
  }
  for (const specPath of specPaths) {
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      throw new Error(`completion requires clean behavior spec: ${specPath}`);
    }
    readJsonFile(specPath, null);
  }
  for (const [key, artifactName] of [
    ['implementation_plan', 'implementation-plan.json'],
    ['implementation_report', 'implementation-report.json'],
    ['qc_report', 'qc-report.json'],
  ]) {
    const artifactPath = cleanCompletionArtifactPath(roots, key, artifactName, `clean-run-context ${key}`);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      throw new Error(`completion requires terminal clean artifact under CLEAN_ROOM_CLEAN_ROOTS: ${artifactName}`);
    }
    readJsonFile(artifactPath, null);
  }
}

function validateCoveredSliceCanComplete(manifest, roots, coverageLedger) {
  validateFoundationCoverageGate(manifest, coverageLedger);
  const coverage = coverageMap(coverageLedger);
  let hasCoveredUnit = false;
  for (const unitId of approvedUnitIds(manifest)) {
    const coverageStateValue = coverage.get(unitId);
    if (coverageStateValue === 'covered') {
      hasCoveredUnit = true;
    } else if (coverageStateValue !== 'out-of-scope') {
      throw new Error(`spec slice cannot complete with coverage_state ${coverageStateValue || 'missing'} for unit: ${unitId}`);
    }
  }
  if (hasCoveredUnit) {
    validateTerminalCompletionArtifacts(roots);
  }
}

function inferTerminalResult(manifest, roots, selectedUnit, options = {}) {
  const { artifact: report } = readCleanCompletionArtifact(roots, 'implementation_report', 'implementation-report.json', 'clean-run-context implementation_report');
  const { artifact: qc } = readCleanCompletionArtifact(roots, 'qc_report', 'qc-report.json', 'clean-run-context qc_report');
  const polish = readOptionalJson(path.join(roots.cleanRoot, POLISH_REPORT_NAME));
  const coverage = readOptionalJson(path.join(roots.contaminatedRoot, 'coverage-ledger.json'));
  const state = coverageMap(coverage).get(selectedUnit.unit_id);
  const polishRequired = options.polishRequired === true;
  const tickets = abstractTickets(
    report,
    qc,
    polish,
    coverage,
    { abstract_delta_tickets: behaviorSpecOpenQuestionTickets(roots) },
    { abstract_delta_tickets: architectureDeltaTickets(roots, qc, options.observedChangedPaths || null) },
    { abstract_delta_tickets: completionQualityTickets(qc) },
    { abstract_delta_tickets: polishReviewTickets(polish, polishRequired) }
  );

  if (
    report?.final_status === 'quarantined' ||
    qc?.final_status === 'quarantined' ||
    polish?.final_status === 'quarantined' ||
    qc?.leakage_status === 'failed'
  ) {
    return buildResult(manifest, 'contamination-suspected', coverageState(state, qc), report, qc, tickets, polish);
  }
  if (tickets.some((ticket) => ticket.status !== 'resolved')) {
    return buildResult(manifest, 'spec-delta-required', coverageState(state, qc), report, qc, tickets, polish);
  }
  if (report?.final_status === 'blocked' || qc?.final_status === 'blocked' || polish?.final_status === 'blocked' || selectedUnit.status === 'blocked') {
    return buildResult(manifest, 'spec-slice-blocked', coverageState(state, qc), report, qc, tickets, polish);
  }
  if (polishBlocksCompletion(polish, polishRequired)) {
    return null;
  }
  if (state === 'covered' || (qc?.coverage_status === 'complete' && qc?.final_status === 'passed')) {
    validateTerminalCompletionArtifacts(roots);
    return buildResult(manifest, 'spec-slice-complete', 'complete', report, qc, tickets, polish);
  }
  return null;
}

function completeResultOrSpecDelta(manifest, roots, coverageLedger, coverageStateValue = 'complete') {
  validateCoveredSliceCanComplete(manifest, roots, coverageLedger);
  const { artifact: report } = readCleanCompletionArtifact(roots, 'implementation_report', 'implementation-report.json', 'clean-run-context implementation_report');
  const { artifact: qc } = readCleanCompletionArtifact(roots, 'qc_report', 'qc-report.json', 'clean-run-context qc_report');
  const polish = readOptionalJson(path.join(roots.cleanRoot, POLISH_REPORT_NAME));
  const tickets = abstractTickets(
    report,
    qc,
    polish,
    coverageLedger,
    { abstract_delta_tickets: behaviorSpecOpenQuestionTickets(roots) },
    { abstract_delta_tickets: architectureDeltaTickets(roots, qc) },
    { abstract_delta_tickets: completionQualityTickets(qc) }
  );
  if (tickets.some((ticket) => ticket.status !== 'resolved')) {
    return buildResult(manifest, 'spec-delta-required', coverageStateValue, null, null, tickets);
  }
  return buildResult(manifest, 'spec-slice-complete', coverageStateValue, null, null, []);
}

function coverageState(sourceState, qc) {
  if (sourceState === 'covered' || qc?.coverage_status === 'complete') return 'complete';
  if (sourceState === 'blocked' || qc?.coverage_status === 'blocked') return 'blocked';
  if (sourceState === 'gap' || qc?.coverage_status === 'partial') return 'partial';
  return 'not-run';
}

function buildResult(manifest, result, coverage_state, implementationReport, qcReport, tickets = [], polishReport = null) {
  void implementationReport;
  void qcReport;
  const output = {
    task_id: manifest.task_id,
    result,
    spec_slice_ref: manifest.loop_context.spec_slice_ref,
    coverage_state,
    terminal_report_ref: manifest.implementation_status?.report_ref || 'implementation-report.json',
    qc_report_ref: 'qc-report.json',
    abstract_delta_tickets: tickets,
    returned_at: new Date().toISOString(),
  };
  if (polishReport) {
    output.polish_report_ref = POLISH_REPORT_NAME;
  }
  return output;
}

function noProgressResult(manifest) {
  return buildResult(manifest, 'no-progress-detected', 'partial', null, null, [
    {
      kind: 'other',
      summary: 'The inner clean-room loop produced no durable artifact changes.',
      status: 'open',
    },
  ]);
}

function iterationLimitResult(manifest) {
  return buildResult(manifest, 'iteration-limit-reached', 'partial', null, null, [
    {
      kind: 'other',
      summary: 'The inner clean-room loop reached its configured iteration limit.',
      status: 'open',
    },
  ]);
}

function stageFailureResult(manifest, stageResult) {
  return buildResult(manifest, 'spec-slice-blocked', 'blocked', null, null, [
    {
      kind: 'other',
      summary: `${stageResult.phase} failed before the selected spec slice reached a terminal clean-room result.`,
      status: 'open',
    },
  ]);
}

function validateResult(result) {
  if (!TERMINAL_RESULTS.has(result.result)) {
    throw new Error(`unsupported clean-room result: ${result.result}`);
  }
}

function writeResult(resultPath, result) {
  validateResult(result);
  writeJsonFile(resultPath, result);
}

function loadLedger(ledgerPath, manifest) {
  const existing = readOptionalJson(ledgerPath);
  if (existing && Array.isArray(existing.iterations)) {
    return existing;
  }
  return {
    ledger_id: 'controller-run-ledger',
    task_id: manifest.task_id,
    updated_at: new Date().toISOString(),
    loop_context: {
      parent_loop_ref: manifest.loop_context.parent_loop_ref,
      spec_slice_ref: manifest.loop_context.spec_slice_ref,
    },
    iterations: [],
  };
}

function writeLedger(ledgerPath, ledger) {
  if (ledger.iterations.length > MAX_LEDGER_ITERATIONS) {
    const pruned = ledger.iterations.length - MAX_LEDGER_ITERATIONS;
    const priorPruned = Number.isInteger(ledger.pruned_iteration_count) && ledger.pruned_iteration_count > 0
      ? ledger.pruned_iteration_count
      : 0;
    ledger.iterations = ledger.iterations.slice(-MAX_LEDGER_ITERATIONS);
    ledger.pruned_iteration_count = priorPruned + pruned;
  }
  ledger.updated_at = new Date().toISOString();
  writeJsonFile(ledgerPath, ledger);
}

async function withRunLock(contaminatedRoot, dryRun, fn) {
  if (dryRun) return fn();
  fs.mkdirSync(contaminatedRoot, { recursive: true });
  const lockPath = path.join(contaminatedRoot, RUN_LOCK_NAME);
  return withDirectoryLock({
    lockPath,
    waitMs: RUN_LOCK_WAIT_MS,
    pollMs: RUN_LOCK_POLL_MS,
    label: 'clean-room run lock',
  }, fn);
}

module.exports = {
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
};
