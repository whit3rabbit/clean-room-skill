'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const TASK_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'task-manifest.json');
const PREFLIGHT_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json');
const BEHAVIOR_SPEC_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'minimal-spec-package', 'behavior-spec.json');
const CLEAN_CONTEXT_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'minimal-spec-package', 'clean-run-context.json');
const FOUNDATION_UNIT_ID = 'unit-foundation';
const FOUNDATION_SPEC_ID = 'spec-foundation';
const FOUNDATION_SPEC_FILE = 'foundation-behavior-spec.json';
const BEHAVIOR_UNIT_ID = 'unit-example-flow';
const BEHAVIOR_SPEC_ID = 'spec-example-flow';
const SECOND_UNIT_ID = 'unit-second-flow';
const SECOND_SPEC_ID = 'spec-second-flow';
const SECOND_SPEC_FILE = 'second-behavior-spec.json';
const TEST_TIMEOUT_MS = 30_000;
const RUN_TEST_DEBUG = process.env.CLEAN_ROOM_RUN_TEST_DEBUG === '1';
const RUN_CLI_EXPECTED_COUNT = 87;
const TMP_DIRS = [];
let runCliCounter = 0;
let runCliCompleted = 0;
let runCliDurationMs = 0;

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) {
    return nodeSpawnSync(command, { timeout: TEST_TIMEOUT_MS, ...(args || {}) });
  }
  return nodeSpawnSync(command, args, { timeout: TEST_TIMEOUT_MS, ...(options || {}) });
}

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TMP_DIRS.length > 0) {
    fs.rmSync(TMP_DIRS.pop(), { recursive: true, force: true });
  }
});

function mkdirs(...dirs) {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function debugRunCli(message) {
  if (RUN_TEST_DEBUG) {
    process._rawDebug(`[run.test] ${new Date().toISOString()} ${message}`);
  }
}

function formatDebugDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

function runCliEta() {
  if (runCliCompleted === 0) return `full_progress=0/${RUN_CLI_EXPECTED_COUNT} full_eta=unknown`;
  const averageMs = runCliDurationMs / runCliCompleted;
  const remaining = Math.max(RUN_CLI_EXPECTED_COUNT - runCliCompleted, 0);
  return [
    `full_progress=${runCliCompleted}/${RUN_CLI_EXPECTED_COUNT}`,
    `avg=${formatDebugDuration(averageMs)}`,
    `full_eta=${formatDebugDuration(averageMs * remaining)}`,
  ].join(' ');
}

function truncateDebugOutput(value) {
  const text = String(value || '').trim();
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000)}...`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendSpawnErrorDiagnostics(result, command, args, durationMs) {
  if (!result.error) return result;
  const details = [
    `spawn error: ${result.error.message}`,
    `duration_ms: ${durationMs}`,
    `command: ${[command, ...args].join(' ')}`,
    result.stdout ? `stdout: ${truncateDebugOutput(result.stdout)}` : '',
    result.stderr ? `stderr: ${truncateDebugOutput(result.stderr)}` : '',
  ].filter(Boolean).join('\n');
  result.stderr = result.stderr ? `${result.stderr}\n${details}` : details;
  return result;
}

function runCli(args, cwd = ROOT, env = {}) {
  const index = runCliCounter + 1;
  runCliCounter = index;
  const commandArgs = [INSTALL, ...args];
  const label = `runCli#${index} ${commandArgs.join(' ')}`;
  const startedAt = Date.now();
  debugRunCli(`start ${label} full_progress=${index}/${RUN_CLI_EXPECTED_COUNT}`);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const durationMs = Date.now() - startedAt;
  runCliCompleted += 1;
  runCliDurationMs += durationMs;
  debugRunCli(
    `done ${label} status=${result.status} signal=${result.signal || ''} ` +
    `error=${result.error?.code || ''} duration=${formatDebugDuration(durationMs)} ${runCliEta()}`
  );
  return appendSpawnErrorDiagnostics(result, process.execPath, commandArgs, durationMs);
}

function baseWorkspace(name) {
  const root = tempDir(name);
  const dirs = {
    root,
    source: path.join(root, 'source'),
    contaminated: path.join(root, 'contaminated'),
    clean: path.join(root, 'clean'),
    implementation: path.join(root, 'implementation'),
    allowed: path.join(root, 'allowed'),
  };
  mkdirs(dirs.source, dirs.contaminated, dirs.clean, dirs.implementation, dirs.allowed);

  const manifest = readJson(TASK_FIXTURE);
  manifest.controller_policy = {
    mode: 'unattended',
    max_iterations: 2,
    max_units_per_iteration: 1,
    stop_conditions: [
      'authorization-missing',
      'scope-change',
      'contamination-suspected',
      'schema-validation-failed',
      'leakage-scan-failed',
      'unit-blocked',
      'implementation-complete',
      'coverage-complete',
      'iteration-limit-reached',
      'spec-slice-complete',
      'spec-slice-blocked',
      'spec-delta-required',
      'no-progress-detected',
      'repeated-unit-selection',
      'clean-room-returned',
    ],
  };
  manifest.loop_context = {
    parent_loop_kind: 'spec-development',
    child_loop_kind: 'clean-room',
    parent_loop_ref: 'spec-dev-loop:test',
    spec_slice_ref: 'behavior-spec:unit-example-flow',
    foundation_unit_ref: FOUNDATION_UNIT_ID,
    approved_scope_refs: ['unit-example-flow'],
    acceptance_refs: ['AC-test'],
    public_surface_refs: ['public-contract:test'],
    return_to: 'outer-spec-loop',
    outer_iteration: 1,
    inner_iteration: 0,
    max_inner_iterations: 2,
  };
  manifest.artifact_paths = {
    contaminated_artifacts: dirs.contaminated,
    contaminated_artifact_roots: [dirs.contaminated],
    clean_artifacts: dirs.clean,
    implementation_roots: [dirs.implementation],
    quarantine: path.join(root, 'quarantine'),
  };
  manifest.initialization_snapshot.effective_roots = {
    source_roots: [dirs.source],
    contaminated_artifact_roots: [dirs.contaminated],
    clean_root: dirs.clean,
    implementation_roots: [dirs.implementation],
    quarantine_root: path.join(root, 'quarantine'),
    approved_public_reference_roots: [dirs.allowed],
  };
  const manifestPath = path.join(dirs.contaminated, 'task-manifest.json');
  const preflightPath = path.join(dirs.contaminated, 'preflight-goal.json');
  const preflightGoal = readJson(PREFLIGHT_FIXTURE);
  preflightGoal.controller_policy.mode = 'unattended';
  preflightGoal.controller_policy.unattended_allowed_after_preflight = true;
  preflightGoal.controller_policy.max_iterations = 2;
  writeJson(preflightPath, preflightGoal);
  manifest.preflight_goal_sha256 = fileSha256(preflightPath);
  writeJson(manifestPath, manifest);
  writeCoverage(dirs.contaminated, 'gap');
  writeFoundationCleanArtifacts({ clean: dirs.clean });
  return { ...dirs, manifestPath };
}

function discoveryLead(overrides = {}) {
  return {
    lead_id: 'lead-cli-flags',
    source_ref: 'source-index:batch-cli-flags',
    description: 'Related CLI flag surface was detected but not yet analyzed.',
    priority: 'high',
    status: 'open',
    ...overrides,
  };
}

function coverageEvidenceRefs(unitId, coverageState) {
  if (coverageState !== 'covered') {
    return [];
  }
  return unitId === FOUNDATION_UNIT_ID ? ['evidence-ledger:item-foundation'] : ['evidence-ledger:item-001'];
}

function writeCoverage(contaminated, coverageState, sourceUnitOverrides = {}, options = {}) {
  const foundationCoverageState = options.foundationCoverageState || 'covered';
  const evidenceRefs = coverageState === 'covered' ? ['evidence-ledger:item-001'] : [];
  const sourceUnits = [];
  if (options.includeFoundation !== false) {
    sourceUnits.push({
      unit_id: FOUNDATION_UNIT_ID,
      coverage_state: foundationCoverageState,
      evidence_refs: coverageEvidenceRefs(FOUNDATION_UNIT_ID, foundationCoverageState),
    });
  }
  sourceUnits.push({
    unit_id: BEHAVIOR_UNIT_ID,
    coverage_state: coverageState,
    evidence_refs: evidenceRefs,
    ...sourceUnitOverrides,
  });
  writeJson(path.join(contaminated, 'coverage-ledger.json'), {
    ledger_id: 'coverage-test',
    task_id: 'task-example',
    updated_by_role: 'contaminated-manager-verifier',
    source_units: sourceUnits,
    behavior_spec_refs: [],
    coverage_status: coverageState === 'covered' && foundationCoverageState === 'covered' ? 'complete' : 'partial',
    abstract_delta_tickets: [],
    review_history: [
      {
        reviewer_role: 'contaminated-manager-verifier',
        status: 'test',
        notes: '',
      },
    ],
  });
  if (coverageState === 'covered' || foundationCoverageState === 'covered') {
    writeEvidenceLedger(contaminated);
  }
}

function writeEvidenceLedger(contaminated, entries = null) {
  writeJson(path.join(contaminated, 'evidence-ledger.json'), {
    ledger_id: 'evidence-test',
    task_id: 'task-example',
    domain: 'contaminated',
    entries: entries || [
      {
        evidence_id: 'item-foundation',
        source_unit_ref: FOUNDATION_UNIT_ID,
        evidence_type: 'source-observation',
        description: 'Neutral test evidence that the foundation unit was source-verified.',
        evidence_location_ref: 'contaminated-only:unit-foundation:item-foundation',
        retained_in_contaminated_domain: true,
      },
      {
        evidence_id: 'item-001',
        source_unit_ref: BEHAVIOR_UNIT_ID,
        evidence_type: 'source-observation',
        description: 'Neutral test evidence that the unit was source-verified.',
        evidence_location_ref: 'contaminated-only:unit-example-flow:item-001',
        retained_in_contaminated_domain: true,
      },
    ],
  });
}

function writeTwoUnitCoverage(workspace, firstState = 'gap', secondState = 'gap') {
  writeJson(path.join(workspace.contaminated, 'coverage-ledger.json'), {
    ledger_id: 'coverage-test',
    task_id: 'task-example',
    updated_by_role: 'contaminated-manager-verifier',
    source_units: [
      {
        unit_id: FOUNDATION_UNIT_ID,
        coverage_state: 'covered',
        evidence_refs: ['evidence-ledger:item-foundation'],
      },
      {
        unit_id: BEHAVIOR_UNIT_ID,
        coverage_state: firstState,
        evidence_refs: firstState === 'covered' ? ['evidence-ledger:item-001'] : [],
      },
      {
        unit_id: SECOND_UNIT_ID,
        coverage_state: secondState,
        evidence_refs: secondState === 'covered' ? ['evidence-ledger:item-002'] : [],
      },
    ],
    behavior_spec_refs: [FOUNDATION_SPEC_ID, BEHAVIOR_SPEC_ID, SECOND_SPEC_ID],
    coverage_status: firstState === 'covered' && secondState === 'covered' ? 'complete' : 'partial',
    abstract_delta_tickets: [],
    review_history: [
      {
        reviewer_role: 'contaminated-manager-verifier',
        status: 'test',
        notes: '',
      },
    ],
  });
  writeEvidenceLedger(workspace.contaminated, [
    {
      evidence_id: 'item-foundation',
      source_unit_ref: FOUNDATION_UNIT_ID,
      evidence_type: 'source-observation',
      description: 'Neutral test evidence that the foundation unit was source-verified.',
      evidence_location_ref: 'contaminated-only:unit-foundation:item-foundation',
      retained_in_contaminated_domain: true,
    },
    {
      evidence_id: 'item-001',
      source_unit_ref: BEHAVIOR_UNIT_ID,
      evidence_type: 'source-observation',
      description: 'Neutral test evidence that the first unit was source-verified.',
      evidence_location_ref: 'contaminated-only:unit-example-flow:item-001',
      retained_in_contaminated_domain: true,
    },
    {
      evidence_id: 'item-002',
      source_unit_ref: SECOND_UNIT_ID,
      evidence_type: 'source-observation',
      description: 'Neutral test evidence that the second unit was source-verified.',
      evidence_location_ref: 'contaminated-only:unit-second-flow:item-002',
      retained_in_contaminated_domain: true,
    },
  ]);
}

function commandConfig(filePath, stages) {
  writeJson(filePath, { version: 1, stages });
  return filePath;
}

function noOpStage(phase, role, cwd) {
  return {
    phase,
    role,
    cwd,
    argv: [process.execPath, '-e', 'void 0'],
  };
}

function failingStageWithOutput(phase, role, cwd, output) {
  return {
    phase,
    role,
    cwd,
    argv: [
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(output)}); process.exit(1);`,
    ],
  };
}

function coverageStage(cwd, script) {
  return {
    phase: 'contaminated-coverage-verify',
    role: 'contaminated-manager-verifier',
    cwd,
    argv: [process.execPath, script],
  };
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeHookCaptureShim(root, capturePath) {
  const script = path.join(root, 'hook-capture.js');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  script: path.basename(process.argv[2] || ''),
  env: process.env,
  input
}) + '\\n');
`);
  fs.chmodSync(script, 0o755);
  return script;
}

function writeStageEnvCaptureScript(root, capturePath) {
  const script = path.join(root, 'stage-env-capture.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env, null, 2) + '\\n');
`);
  return script;
}

function writeImplementationFileScript(root, relPath, contents) {
  const script = path.join(root, `write-${relPath.replace(/[^A-Za-z0-9]+/g, '-')}.js`);
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const implementation = process.env.CLEAN_ROOM_IMPLEMENTATION_ROOTS.split(path.delimiter)[0];
const target = path.join(implementation, ${JSON.stringify(relPath)});
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, ${JSON.stringify(contents)});
`);
  return script;
}

function writeClaudeAgentCaptureScript(root, capturePath) {
  const script = path.join(root, 'claude');
  fs.writeFileSync(script, `#!${process.execPath}
'use strict';

const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  input,
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLEAN_ROOM_ROLE: process.env.CLEAN_ROOM_ROLE,
    CLEAN_ROOM_CONTROLLER_PHASE: process.env.CLEAN_ROOM_CONTROLLER_PHASE,
    CLEAN_ROOM_SELECTED_UNIT_ID: process.env.CLEAN_ROOM_SELECTED_UNIT_ID,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    SECRET_SHOULD_NOT_LEAK: process.env.SECRET_SHOULD_NOT_LEAK
  }
}) + '\\n');
`);
  fs.chmodSync(script, 0o755);
  return script;
}

function writeCcsiloVariant(root, name, wrapperPath, overrides = {}) {
  const variantRoot = path.join(root, 'Library', 'Application Support', 'ccsilo', 'variants', name);
  const configDir = overrides.configDir || path.join(variantRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  writeJson(path.join(variantRoot, 'variant.json'), {
    schemaVersion: 1,
    id: name,
    paths: {
      root: variantRoot,
      configDir,
      wrapper: wrapperPath,
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_MODEL: 'openrouter/owl-alpha',
      ...(overrides.env || {}),
    },
    credential: {
      mode: 'env',
      source: 'OPENROUTER_API_KEY',
      targets: ['ANTHROPIC_AUTH_TOKEN'],
      ...(overrides.credential || {}),
    },
  });
  return { variantRoot, configDir, wrapper: wrapperPath };
}

function enableStrictContext(workspace, budgets = {}) {
  const manifest = readJson(workspace.manifestPath);
  manifest.context_management = {
    mode: 'role-session-briefs',
    enforcement: 'strict',
    fresh_context_required: true,
    budgets: {
      max_prompt_chars: 1200,
      max_brief_chars: 4000,
      max_artifact_refs: 8,
      max_referenced_artifact_bytes: 20000,
      ...budgets,
    },
  };
  writeJson(workspace.manifestPath, manifest);
}

function writeRoleSessionBrief(workspace, filePath, role, phase, overrides = {}) {
  writeJson(filePath, {
    brief_id: `brief-${phase}`,
    task_id: 'task-example',
    created_at: '2024-01-01T00:00:00Z',
    role,
    phase,
    unit_id: 'unit-example-flow',
    spec_slice_ref: 'behavior-spec:unit-example-flow',
    fresh_context_required: true,
    compact_status: 'Run the configured test stage from durable artifacts.',
    next_action: 'Execute the configured stage and write only permitted artifacts.',
    allowed_artifacts: [],
    forbidden_inputs: [
      'prior chat history',
      'source-index.json',
      'task-manifest.json',
    ],
    blockers: [],
    ...overrides,
  });
  return filePath;
}

function writeDeltaScript(root) {
  const script = path.join(root, 'write-delta.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const clean = process.env.CLEAN_ROOM_CLEAN_ROOTS.split(path.delimiter)[0];
fs.writeFileSync(path.join(clean, 'qc-report.json'), JSON.stringify({
  report_id: 'qc-delta',
  reviewer_role: 'contaminated-manager-verifier',
  reviewed_at: '2024-01-01T00:00:00Z',
  reviewed_artifacts: ['implementation-report.json'],
  artifact_hashes: [],
  schema_validator_version: 'test',
  schema_status: 'passed',
  leakage_status: 'passed',
  leakage_scan_summary: 'No blocked markers in test.',
  architecture_status: 'aligned',
  architecture_findings: [],
  coverage_status: 'partial',
  required_rerun: true,
  contamination_incidents: [],
  findings: [],
  abstract_delta_tickets: [{
    ticket_id: 'delta-001',
    summary: 'The spec does not define timeout behavior.',
    requested_clean_change: 'Define timeout behavior.',
    status: 'open'
  }],
  final_status: 'passed-with-gaps'
}, null, 2) + '\\n');
`);
  return script;
}

function writeQcReport(clean, reviewedAt) {
  writeJson(path.join(clean, 'qc-report.json'), {
    report_id: 'qc-timestamp',
    reviewer_role: 'clean-qa-editor',
    reviewed_at: reviewedAt,
    reviewed_artifacts: ['implementation-report.json'],
    artifact_hashes: [],
    schema_validator_version: 'test',
    schema_status: 'passed',
    leakage_status: 'passed',
    leakage_scan_summary: 'No blocked markers in test.',
    architecture_status: 'aligned',
    architecture_findings: [],
    coverage_status: 'partial',
    required_rerun: true,
    contamination_incidents: [],
    findings: [],
    abstract_delta_tickets: [],
    final_status: 'passed-with-gaps',
  });
}

function validBehaviorSpec(overrides = {}) {
  return {
    ...readJson(BEHAVIOR_SPEC_FIXTURE),
    ...overrides,
  };
}

function validFoundationBehaviorSpec(overrides = {}) {
  return validBehaviorSpec({
    spec_id: FOUNDATION_SPEC_ID,
    unit_id: FOUNDATION_UNIT_ID,
    source_unit_refs: [FOUNDATION_UNIT_ID],
    evidence_refs: ['evidence-ledger:item-foundation'],
    summary: 'Foundation unit captures target stack, package boundaries, and dependency constraints.',
    observable_surface: [
      {
        claim_id: 'foundation-surface',
        claim: 'The destination foundation is identified before behavior implementation starts.',
        evidence_refs: ['evidence-ledger:item-foundation'],
        evidence_status: 'observed',
        confidence: 'high',
      },
    ],
    observable_behaviors: [
      {
        claim_id: 'foundation-behavior',
        claim: 'Foundation facts are represented as public compatibility and destination constraints, not copied dependency lists.',
        evidence_refs: ['evidence-ledger:item-foundation'],
        evidence_status: 'observed',
        confidence: 'high',
      },
    ],
    test_scenarios: [
      {
        scenario_id: 'test-foundation-captured',
        scenario: 'Review the sanitized foundation spec before behavior planning.',
        expected_result: 'The clean planner has target stack, package boundary, test entrypoint, and dependency-policy constraints.',
        coverage: [],
      },
    ],
    ...overrides,
  });
}

function validSecondBehaviorSpec(overrides = {}) {
  return validBehaviorSpec({
    spec_id: SECOND_SPEC_ID,
    unit_id: SECOND_UNIT_ID,
    source_unit_refs: [SECOND_UNIT_ID],
    evidence_refs: ['evidence-ledger:item-002'],
    summary: 'Second behavior unit captures another observable flow.',
    observable_surface: [
      {
        claim_id: 'second-surface',
        claim: 'The second behavior exposes a distinct user-visible flow.',
        evidence_refs: ['evidence-ledger:item-002'],
        evidence_status: 'observed',
        confidence: 'high',
      },
    ],
    observable_behaviors: [
      {
        claim_id: 'second-behavior',
        claim: 'The second flow completes using clean implementation behavior.',
        evidence_refs: ['evidence-ledger:item-002'],
        evidence_status: 'observed',
        confidence: 'high',
      },
    ],
    test_scenarios: [
      {
        scenario_id: 'test-second-flow',
        scenario: 'Run the second clean behavior flow.',
        expected_result: 'The second clean flow completes.',
        coverage: [],
      },
    ],
    ...overrides,
  });
}

function addSecondApprovedUnit(workspace) {
  const manifest = readJson(workspace.manifestPath);
  manifest.controller_policy.max_iterations = 4;
  manifest.loop_context.max_inner_iterations = 4;
  manifest.loop_context.approved_scope_refs = [BEHAVIOR_UNIT_ID, SECOND_UNIT_ID];
  manifest.units.push({
    unit_id: SECOND_UNIT_ID,
    unit_kind: 'behavior',
    description: 'Second observable flow.',
    status: 'pending',
    source_index_refs: ['source-index:batch-0001'],
    notes: 'Second neutral unit id.',
  });
  writeJson(workspace.manifestPath, manifest);
  writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
  writeJson(path.join(workspace.clean, SECOND_SPEC_FILE), validSecondBehaviorSpec());
  writeCleanRunContext(workspace, ['behavior-spec.json', SECOND_SPEC_FILE]);
  writeArchitectureArtifacts(workspace);
  writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json', SECOND_SPEC_FILE]);
  writeCompleteCleanReports(workspace);
  writeTwoUnitCoverage(workspace, 'gap', 'gap');
}

function writeFoundationCleanArtifacts(workspace) {
  writeJson(path.join(workspace.clean, FOUNDATION_SPEC_FILE), validFoundationBehaviorSpec());
  writeSkeletonManifest(workspace, {
    areas: [
      {
        area_id: 'area-foundation',
        purpose: 'Own destination foundation constraints and build/test boundaries.',
        owned_path_prefixes: ['src/', 'test/', 'package.json'],
        responsibilities: ['Record foundation constraints before behavior implementation.'],
        forbidden_responsibilities: ['Do not mirror source dependencies without public compatibility or policy basis.'],
        allowed_area_dependencies: [],
        spec_ids: [FOUNDATION_SPEC_ID],
        public_contract_refs: [],
        target_constraints: ['Foundation must be established before behavior slices run.'],
        dependency_constraints: ['Dependencies follow preflight policy and destination evidence.'],
        test_obligations: ['test-foundation-captured'],
        open_decisions: [],
      },
    ],
    test_mapping: [
      {
        test_id: 'test-foundation-captured',
        spec_ids: [FOUNDATION_SPEC_ID],
        scenario_refs: ['test-foundation-captured'],
      },
    ],
    test_obligations: ['test-foundation-captured'],
  });
  writeCleanRunContext(workspace, [FOUNDATION_SPEC_FILE]);
  writeHandoffPackage(workspace, ['clean-run-context.json', FOUNDATION_SPEC_FILE]);
}

function publicSurfaceRef(name, kind = 'command', specId = 'spec-example-flow') {
  return `public_surface:${specId}:${kind}:${name}`;
}

function publicCommandItem(name) {
  return {
    name,
    kind: 'command',
    visibility: 'user-required',
    compatibility_reason: `${name} is part of the required user-visible command surface.`,
  };
}

function publicSurfaceCoverage(ref, status = 'covered') {
  return {
    ref,
    status,
    evidence_refs: status === 'covered' ? ['evidence-ledger:item-001'] : [],
    work_item_refs: ['wi-test'],
    verification_refs: ['verification:npm-test'],
  };
}

function writeCoveredCoverageWithPublicSurface(workspace, publicSurfaceCoverageEntries) {
  writeJson(path.join(workspace.contaminated, 'coverage-ledger.json'), {
    ledger_id: 'coverage-test',
    task_id: 'task-example',
    updated_by_role: 'contaminated-manager-verifier',
    source_units: [
      {
        unit_id: FOUNDATION_UNIT_ID,
        coverage_state: 'covered',
        evidence_refs: ['evidence-ledger:item-foundation'],
      },
      {
        unit_id: BEHAVIOR_UNIT_ID,
        coverage_state: 'covered',
        evidence_refs: ['evidence-ledger:item-001'],
        public_surface_coverage: publicSurfaceCoverageEntries,
      },
    ],
    behavior_spec_refs: [FOUNDATION_SPEC_ID, BEHAVIOR_SPEC_ID],
    coverage_status: 'complete',
    abstract_delta_tickets: [],
    review_history: [
      {
        reviewer_role: 'contaminated-manager-verifier',
        status: 'test',
        notes: '',
      },
    ],
  });
  writeEvidenceLedger(workspace.contaminated);
}

function writePublicCommandCompletionArtifacts(workspace, options = {}) {
  const commandNames = options.commandNames || ['/alpha'];
  const publicRefs = commandNames.map((name) => publicSurfaceRef(name));
  const scenarioCoverage = options.scenarioCoverage || publicRefs;
  writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec({
    public_surface: commandNames.map((name) => publicCommandItem(name)),
    test_scenarios: [
      {
        scenario_id: 'test-public-command-surface',
        scenario: 'Invoke required public slash commands.',
        expected_result: 'Each command produces its documented user-visible behavior.',
        coverage: scenarioCoverage,
      },
    ],
  }));
  writeCleanRunContext(workspace);
  writeArchitectureArtifacts(workspace, {
    work_items: [
      {
        work_item_id: 'wi-test',
        status: 'planned',
        summary: 'Implement required public command surface.',
        spec_ids: ['spec-example-flow'],
        architecture_area_refs: ['area-example-flow'],
        public_contract_refs: options.planRefs || publicRefs,
        implementation_root_ref: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        target_paths: ['src/example-flow.js'],
        test_paths: ['test/example-flow.test.js'],
        acceptance_criteria: ['Required public commands are implemented and tested.'],
      },
    ],
  }, {
    public_contracts: commandNames.map((name) => ({
      contract_id: publicSurfaceRef(name),
      source_spec_id: 'spec-example-flow',
      name,
      kind: 'command',
      visibility: 'user-required',
      compatibility_reason: `${name} is part of the required user-visible command surface.`,
    })),
    areas: [
      {
        area_id: 'area-example-flow',
        purpose: 'Own the example public command flow and tests.',
        owned_path_prefixes: ['src/', 'test/'],
        responsibilities: ['Implement and test required public commands.'],
        forbidden_responsibilities: ['Do not own unrelated destination behavior.'],
        allowed_area_dependencies: [],
        spec_ids: ['spec-example-flow'],
        public_contract_refs: publicRefs,
        target_constraints: [],
        dependency_constraints: [],
        test_obligations: ['test-public-command-surface'],
        open_decisions: [],
      },
    ],
  });
  writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
  writeCompleteCleanReports(workspace);
  if (options.completedWorkItems) {
    const reportPath = path.join(workspace.clean, 'implementation-report.json');
    const report = readJson(reportPath);
    report.completed_work_items = options.completedWorkItems;
    writeJson(reportPath, report);
  }
  return publicRefs;
}

function writeSkeletonManifest(workspace, overrides = {}) {
  writeJson(path.join(workspace.clean, 'skeleton-manifest.json'), {
    manifest_id: 'skeleton-test',
    target_language: 'unspecified',
    area_id_naming_policy: 'Use neutral clean architecture area ids.',
    architecture_summary: 'Test architecture map owns one clean feature area.',
    target_constraints: [],
    areas: [
      {
        area_id: 'area-example-flow',
        purpose: 'Own the example flow behavior and tests.',
        owned_path_prefixes: [
          'src/',
          'test/',
        ],
        responsibilities: [
          'Implement and test the example flow.',
        ],
        forbidden_responsibilities: [
          'Do not own unrelated destination behavior.',
        ],
        allowed_area_dependencies: [],
        spec_ids: ['spec-example-flow'],
        public_contract_refs: [],
        target_constraints: [],
        dependency_constraints: [],
        test_obligations: ['test-001'],
        open_decisions: [],
      },
    ],
    public_contracts: [],
    dependency_constraints: [],
    implementation_forbidden_material: [
      'source_excerpt',
      'raw_diff',
      'private_identifier',
      'source_shaped_pseudocode',
    ],
    test_mapping: [
      {
        test_id: 'test-001',
        spec_ids: ['spec-example-flow'],
        scenario_refs: ['test-001'],
      },
    ],
    test_obligations: ['test-001'],
    refactor_triggers: [
      'Split the area before adding unrelated destination behavior.',
    ],
    open_decisions: [],
    ...overrides,
  });
}

function writeImplementationPlan(workspace, overrides = {}) {
  writeJson(path.join(workspace.clean, 'implementation-plan.json'), {
    plan_id: 'implementation-plan-test',
    task_id: 'task-example',
    created_at: '2024-01-01T00:00:00Z',
    planner_role: 'clean-architect',
    implementation_root_refs: ['CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]'],
    source_artifacts: ['behavior-spec.json', 'skeleton-manifest.json'],
    architecture_manifest_ref: 'skeleton-manifest.json',
    foundation_summary: 'Test clean implementation foundation.',
    code_hygiene_policy: {
      max_lines_per_code_file: 500,
      max_lines_per_test_file: 800,
      max_files_per_iteration: 12,
      split_large_files_by: ['module boundary', 'public type', 'feature area'],
      exceptions: [],
    },
    work_items: [
      {
        work_item_id: 'wi-test',
        status: 'planned',
        summary: 'Implement the example flow.',
        spec_ids: ['spec-example-flow'],
        architecture_area_refs: ['area-example-flow'],
        implementation_root_ref: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        target_paths: ['src/example-flow.js'],
        test_paths: ['test/example-flow.test.js'],
        acceptance_criteria: ['Example flow is implemented and tested.'],
      },
    ],
    planned_refactors: [],
    verification_strategy: [
      {
        command: ['npm', 'test'],
        cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        purpose: 'Run destination tests.',
      },
    ],
    implementation_forbidden_material: [
      'source_excerpt',
      'raw_diff',
      'private_identifier',
      'source_shaped_pseudocode',
    ],
    open_decisions: [],
    ...overrides,
  });
}

function writeArchitectureArtifacts(workspace, planOverrides = {}, skeletonOverrides = {}) {
  writeSkeletonManifest(workspace, skeletonOverrides);
  writeImplementationPlan(workspace, planOverrides);
}

function withFoundationSpec(workspace, behaviorSpecs) {
  const specs = [...behaviorSpecs];
  if (fs.existsSync(path.join(workspace.clean, FOUNDATION_SPEC_FILE)) && !specs.includes(FOUNDATION_SPEC_FILE)) {
    specs.unshift(FOUNDATION_SPEC_FILE);
  }
  return specs;
}

function writeCleanRunContext(workspace, behaviorSpecs = ['behavior-spec.json']) {
  const context = readJson(CLEAN_CONTEXT_FIXTURE);
  context.clean_artifacts = {
    ...context.clean_artifacts,
    clean_root: './',
    handoff_package: 'handoff-package.json',
    behavior_specs: withFoundationSpec(workspace, behaviorSpecs),
    skeleton_manifest: 'skeleton-manifest.json',
    implementation_plan: 'implementation-plan.json',
    implementation_report: 'implementation-report.json',
    qc_report: 'qc-report.json',
  };
  writeJson(path.join(workspace.clean, 'clean-run-context.json'), context);
}

function writeHandoffPackage(workspace, artifactPaths) {
  const paths = [...artifactPaths];
  if (
    paths.includes('clean-run-context.json') &&
    fs.existsSync(path.join(workspace.clean, FOUNDATION_SPEC_FILE)) &&
    !paths.includes(FOUNDATION_SPEC_FILE)
  ) {
    paths.splice(paths.indexOf('clean-run-context.json') + 1, 0, FOUNDATION_SPEC_FILE);
  }
  writeJson(path.join(workspace.clean, 'handoff-package.json'), {
    package_id: 'handoff-test',
    task_id: 'task-example',
    from_domain: 'contaminated',
    to_domain: 'clean',
    created_by_role: 'contaminated-handoff-sanitizer',
    artifacts: paths.map((artifactPath, index) => ({
      artifact_id: `artifact-${index + 1}`,
      artifact_type: path.basename(artifactPath) === 'clean-run-context.json' ? 'clean-run-context' : 'behavior-spec',
      path: artifactPath,
      sha256: fileSha256(path.join(workspace.clean, artifactPath)),
    })),
    excluded_material: [],
    leakage_review: {
      status: 'passed',
      reviewer_role: 'contaminated-handoff-sanitizer',
      notes: 'Test handoff package contains schema-shaped clean artifacts.',
    },
  });
}

function writeCompleteCleanReports(workspace) {
  writeJson(path.join(workspace.clean, 'implementation-report.json'), {
    report_id: 'implementation-report-complete',
    task_id: 'task-example',
    plan_ref: 'implementation-plan.json',
    implementer_role: 'clean-qa-editor',
    updated_at: '2024-01-01T00:00:00Z',
    implementation_status: 'complete',
    agent0_reporting: {
      report_state: 'terminal-report',
      terminal_report_target: 'agent_0',
      interim_updates_allowed: false,
    },
    completed_work_items: ['wi-test'],
    blocked_work_items: [],
    changed_paths: [],
    verification_results: [
      {
        command: ['npm', 'test'],
        cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        status: 'passed',
        output_summary: 'Test verification passed.',
      },
    ],
    findings: [],
    abstract_delta_tickets: [],
    final_status: 'complete',
  });
  writeJson(path.join(workspace.clean, 'qc-report.json'), {
    report_id: 'qc-complete',
    reviewer_role: 'clean-qa-editor',
    reviewed_at: '2024-01-01T00:00:00Z',
    reviewed_artifacts: ['implementation-report.json', 'behavior-spec.json'],
    artifact_hashes: [],
    schema_validator_version: 'test',
    schema_status: 'passed',
    leakage_status: 'passed',
    leakage_scan_summary: 'No blocked markers in test.',
    architecture_status: 'aligned',
    architecture_findings: [],
    coverage_status: 'complete',
    required_rerun: false,
    contamination_incidents: [],
    findings: [],
    abstract_delta_tickets: [],
    final_status: 'passed',
  });
}

function writePolishReport(workspace, overrides = {}) {
  writeJson(path.join(workspace.clean, 'polish-report.json'), {
    report_id: 'polish-complete',
    task_id: 'task-example',
    spec_slice_ref: 'behavior-spec:unit-example-flow',
    unit_id: 'unit-example-flow',
    reviewer_role: 'clean-polish-reviewer',
    reviewed_at: '2024-01-01T00:00:00Z',
    reviewed_artifacts: ['implementation-report.json', 'qc-report.json'],
    changed_paths: [
      {
        path: 'AGENTS.md',
        kind: 'repo-hygiene',
        action: 'created',
        reason: 'Record commands and gotchas.',
      },
    ],
    verification_results: [
      {
        command: ['npm', 'test'],
        cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        status: 'passed',
        output_summary: 'Polish verification passed.',
      },
    ],
    findings: [],
    git: {
      repository_status: 'initialized',
      commit_required: true,
      commit_status: 'committed',
      include_paths: ['AGENTS.md'],
      commit_message: 'Complete clean-room spec slice behavior-spec:unit-example-flow',
      commit_hash: '0123456789abcdef0123456789abcdef01234567',
      status_summary: 'Committed listed paths only.',
    },
    residual_risks: [],
    abstract_delta_tickets: [],
    final_status: 'passed',
    ...overrides,
  });
}

function writeCoveredCoverageScript(root) {
  const script = path.join(root, 'write-covered-coverage.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const contaminated = process.env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS.split(path.delimiter)[0];
fs.writeFileSync(path.join(contaminated, 'evidence-ledger.json'), JSON.stringify({
  ledger_id: 'evidence-test',
  task_id: 'task-example',
  domain: 'contaminated',
  entries: [{
    evidence_id: 'item-foundation',
    source_unit_ref: 'unit-foundation',
    evidence_type: 'source-observation',
    description: 'Neutral test evidence that the foundation unit was source-verified.',
    evidence_location_ref: 'contaminated-only:unit-foundation:item-foundation',
    retained_in_contaminated_domain: true
  }, {
    evidence_id: 'item-001',
    source_unit_ref: 'unit-example-flow',
    evidence_type: 'source-observation',
    description: 'Neutral test evidence that the unit was source-verified.',
    evidence_location_ref: 'contaminated-only:unit-example-flow:item-001',
    retained_in_contaminated_domain: true
  }]
}, null, 2) + '\\n');
fs.writeFileSync(path.join(contaminated, 'coverage-ledger.json'), JSON.stringify({
  ledger_id: 'coverage-test',
  task_id: 'task-example',
  updated_by_role: 'contaminated-manager-verifier',
  source_units: [{
    unit_id: 'unit-foundation',
    coverage_state: 'covered',
    evidence_refs: ['evidence-ledger:item-foundation']
  }, {
    unit_id: 'unit-example-flow',
    coverage_state: 'covered',
    evidence_refs: ['evidence-ledger:item-001']
  }],
  behavior_spec_refs: ['spec-foundation', 'spec-example-flow'],
  coverage_status: 'complete',
  abstract_delta_tickets: [],
  review_history: [{
    reviewer_role: 'contaminated-manager-verifier',
    status: 'test',
    notes: ''
  }]
}, null, 2) + '\\n');
`);
  return script;
}

function writeSelectedUnitCoveredScript(root) {
  const script = path.join(root, 'write-selected-unit-covered.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const contaminated = process.env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS.split(path.delimiter)[0];
const selected = process.env.CLEAN_ROOM_SELECTED_UNIT_ID;
const coveragePath = path.join(contaminated, 'coverage-ledger.json');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
for (const unit of coverage.source_units || []) {
  if (unit.unit_id === selected) {
    unit.coverage_state = 'covered';
    unit.evidence_refs = [selected === 'unit-second-flow' ? 'evidence-ledger:item-002' : 'evidence-ledger:item-001'];
  }
}
coverage.coverage_status = coverage.source_units
  .every((unit) => unit.coverage_state === 'covered' || unit.coverage_state === 'out-of-scope')
  ? 'complete'
  : 'partial';
fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\\n');
`);
  return script;
}

function writeTimestampOnlyQcScript(root) {
  const script = path.join(root, 'timestamp-only-qc.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const clean = process.env.CLEAN_ROOM_CLEAN_ROOTS.split(path.delimiter)[0];
const qcPath = path.join(clean, 'qc-report.json');
const qc = JSON.parse(fs.readFileSync(qcPath, 'utf8'));
qc.reviewed_at = '2025-01-01T00:00:00Z';
fs.writeFileSync(qcPath, JSON.stringify(qc, null, 2) + '\\n');
`);
  return script;
}

function writeImplementationChangeScript(root) {
  const script = path.join(root, 'write-implementation.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const implementation = process.env.CLEAN_ROOM_IMPLEMENTATION_ROOTS.split(path.delimiter)[0];
fs.writeFileSync(path.join(implementation, 'generated.txt'), 'implemented\\n');
`);
  return script;
}

function writeImplementationTargetJsonScript(root) {
  const script = path.join(root, 'write-implementation-target-json.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const implementation = process.env.CLEAN_ROOM_IMPLEMENTATION_ROOTS.split(path.delimiter)[0];
fs.mkdirSync(path.join(implementation, 'target'), { recursive: true });
fs.writeFileSync(path.join(implementation, 'target', 'build-metadata.json'), '{"fresh":true}\\n');
`);
  return script;
}

function writeControllerStatusScript(root) {
  const script = path.join(root, 'write-controller-status.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const contaminated = process.env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS.split(path.delimiter)[0];
fs.writeFileSync(path.join(contaminated, 'controller-status.json'), JSON.stringify({
  status_id: 'status-test',
  task_id: 'task-example',
  updated_at: '2024-01-01T00:00:00Z',
  updated_by_role: 'contaminated-manager-verifier',
  current_gate: 'contaminated-coverage-verify',
  selected_unit_id: 'unit-example-flow',
  spec_slice_ref: 'behavior-spec:unit-example-flow',
  coverage_state: 'partial',
  implementation_state: 'not-started',
  qc_state: 'not-run',
  blockers: [],
  latest_artifact_refs: [],
  next_safe_action: 'Create the next role-session brief.'
}, null, 2) + '\\n');
`);
  return script;
}

function writeLock(lockPath, pid, createdAt) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    pid,
    created_at: createdAt.toISOString(),
  }, null, 2)}\n`);
  fs.utimesSync(lockPath, createdAt, createdAt);
}

describe('clean-room run command', () => {
  test('dry-run selects the foundation unit when it is approved and not covered', () => {
    const workspace = baseWorkspace('clean-room-run-foundation-first');
    const manifest = readJson(workspace.manifestPath);
    manifest.loop_context.spec_slice_ref = 'behavior-spec:unit-foundation';
    manifest.loop_context.approved_scope_refs = [FOUNDATION_UNIT_ID];
    writeJson(workspace.manifestPath, manifest);
    writeCoverage(workspace.contaminated, 'gap', {}, { foundationCoverageState: 'gap' });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /selected unit-foundation/);
  });

  test('dry-run validates nested loop context and selects one unit without writes', () => {
    const workspace = baseWorkspace('clean-room-run-dry');
    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /selected unit-example-flow/);
    assert.match(result.stdout, /schema dir:/);
    assert.match(result.stdout, /bundled generated CLI schemas/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'clean-room-result.json')), false);
  });

  test('rejects invalid schema-dir with bundled schema guidance', () => {
    const workspace = baseWorkspace('clean-room-run-invalid-schema-dir');
    const schemaDir = path.join(workspace.root, 'clean', 'schemas');

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--dry-run',
      '--schema-dir',
      schemaDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema directory not found/);
    assert.match(result.stderr, /Omit --schema-dir to use bundled schemas/);
    assert.match(result.stderr, /skills\/clean-room\/assets/);
  });

  test('rejects behavior slices before foundation coverage is complete', () => {
    const workspace = baseWorkspace('clean-room-run-behavior-before-foundation');
    writeCoverage(workspace.contaminated, 'gap', {}, { foundationCoverageState: 'gap' });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foundation unit must be covered before approving non-foundation unit/);
  });

  test('rejects behavior completion before foundation coverage is complete', () => {
    const workspace = baseWorkspace('clean-room-run-complete-before-foundation');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    writeCoverage(workspace.contaminated, 'covered', {}, { foundationCoverageState: 'gap' });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foundation unit must be covered before approving non-foundation unit/);
  });

  test('rejects unknown foundation unit refs', () => {
    const workspace = baseWorkspace('clean-room-run-unknown-foundation-ref');
    const manifest = readJson(workspace.manifestPath);
    manifest.loop_context.foundation_unit_ref = 'unit-missing';
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foundation_unit_ref does not match any task-manifest unit/);
  });

  test('rejects foundation refs that point at behavior units', () => {
    const workspace = baseWorkspace('clean-room-run-mismatched-foundation-ref');
    const manifest = readJson(workspace.manifestPath);
    manifest.loop_context.foundation_unit_ref = BEHAVIOR_UNIT_ID;
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /foundation_unit_ref must reference the foundation unit/);
  });

  test('rejects missing preflight goal before run work', () => {
    const workspace = baseWorkspace('clean-room-run-missing-preflight');
    fs.rmSync(path.join(workspace.contaminated, 'preflight-goal.json'));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal not found/);
    assert.match(result.stderr, new RegExp(escapeRegExp(path.join(workspace.contaminated, 'preflight-goal.json'))));
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects unattended preflight goals without explicit intent confirmation', () => {
    const workspace = baseWorkspace('clean-room-run-preflight-no-confirmation');
    const preflightPath = path.join(workspace.contaminated, 'preflight-goal.json');
    const preflightGoal = readJson(preflightPath);
    delete preflightGoal.intent_confirmation;
    writeJson(preflightPath, preflightGoal);
    const manifest = readJson(workspace.manifestPath);
    manifest.preflight_goal_sha256 = fileSha256(preflightPath);
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal is not runner-ready/);
    assert.match(result.stderr, /intent_confirmation/);
    assert.match(result.stderr, /explicit user-confirmed end goal and target stack/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects preflight goals whose controller mode mismatches the task manifest', () => {
    const workspace = baseWorkspace('clean-room-run-preflight-mode-mismatch');
    const preflightPath = path.join(workspace.contaminated, 'preflight-goal.json');
    const preflightGoal = readJson(preflightPath);
    preflightGoal.controller_policy.mode = 'attended';
    preflightGoal.controller_policy.unattended_allowed_after_preflight = false;
    writeJson(preflightPath, preflightGoal);
    const manifest = readJson(workspace.manifestPath);
    manifest.preflight_goal_sha256 = fileSha256(preflightPath);
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal is not runner-ready/);
    assert.match(result.stderr, /controller_policy\.mode must match task-manifest controller_policy\.mode/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('missing root-level manifest suggests contaminated manifest path', () => {
    const workspace = baseWorkspace('clean-room-run-root-manifest-hint');
    const rootManifest = path.join(workspace.root, 'task-manifest.json');

    const result = runCli(['run', '--task-manifest', rootManifest, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected task manifest layout: <task-root>\/contaminated\/task-manifest\.json/);
    assert.match(result.stderr, new RegExp(escapeRegExp(path.join(workspace.contaminated, 'task-manifest.json'))));
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('requires task manifest under contaminated artifact root', () => {
    const workspace = baseWorkspace('clean-room-run-manifest-placement');
    const outsideManifest = path.join(workspace.root, 'task-manifest.json');
    fs.copyFileSync(workspace.manifestPath, outsideManifest);

    const result = runCli(['run', '--task-manifest', outsideManifest, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task manifest must be under contaminated artifact root/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects conflicting root-level and contaminated task manifests', () => {
    const workspace = baseWorkspace('clean-room-run-manifest-drift');
    const rootManifest = path.join(workspace.root, 'task-manifest.json');
    const manifest = readJson(workspace.manifestPath);
    manifest.preflight_goal_sha256 = '0'.repeat(64);
    writeJson(rootManifest, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root-level task-manifest\.json conflicts with contaminated artifact manifest/);
    assert.match(result.stderr, new RegExp(escapeRegExp(rootManifest)));
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects clean-room report JSON under implementation roots', () => {
    const workspace = baseWorkspace('clean-room-run-implementation-artifact-placement');
    writeJson(path.join(workspace.implementation, 'implementation-report-unit-001.json'), {
      report_id: 'misplaced-report',
    });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-room artifacts must not be under implementation roots/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects coverage ledger entries for missing manifest units', () => {
    const workspace = baseWorkspace('clean-room-run-coverage-unknown-unit');
    writeJson(path.join(workspace.contaminated, 'coverage-ledger.json'), {
      ledger_id: 'coverage-test',
      task_id: 'task-example',
      updated_by_role: 'contaminated-manager-verifier',
      source_units: [
        {
          unit_id: 'unit-missing',
          coverage_state: 'gap',
          evidence_refs: [],
        },
      ],
      behavior_spec_refs: [],
      coverage_status: 'partial',
      abstract_delta_tickets: [],
      review_history: [
        {
          reviewer_role: 'contaminated-manager-verifier',
          status: 'test',
          notes: '',
        },
      ],
    });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /coverage-ledger references unknown task-manifest unit/);
  });

  test('rejects covered coverage ledger entries with missing evidence items', () => {
    const workspace = baseWorkspace('clean-room-run-coverage-missing-evidence');
    writeJson(path.join(workspace.contaminated, 'coverage-ledger.json'), {
      ledger_id: 'coverage-test',
      task_id: 'task-example',
      updated_by_role: 'contaminated-manager-verifier',
      source_units: [
        {
          unit_id: 'unit-example-flow',
          coverage_state: 'covered',
          evidence_refs: ['evidence-ledger:item-missing'],
        },
      ],
      behavior_spec_refs: ['spec-example-flow'],
      coverage_status: 'complete',
      abstract_delta_tickets: [],
      review_history: [
        {
          reviewer_role: 'contaminated-manager-verifier',
          status: 'test',
          notes: '',
        },
      ],
    });
    writeEvidenceLedger(workspace.contaminated);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /coverage-ledger references missing evidence-ledger item in canonical evidence-ledger\.json/);
  });

  test('rejects coverage evidence refs when canonical evidence ledger is missing', () => {
    const workspace = baseWorkspace('clean-room-run-coverage-missing-evidence-ledger');
    writeCoverage(workspace.contaminated, 'covered');
    fs.rmSync(path.join(workspace.contaminated, 'evidence-ledger.json'));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical evidence-ledger\.json is missing/);
    assert.match(result.stderr, /do not use per-unit evidence-ledger filenames/);
  });

  test('rejects path-like evidence source_unit_ref with redacted actionable guidance', () => {
    const workspace = baseWorkspace('clean-room-run-coverage-path-like-evidence-unit');
    writeCoverage(workspace.contaminated, 'covered');
    writeEvidenceLedger(workspace.contaminated, [
      {
        evidence_id: 'item-foundation',
        source_unit_ref: FOUNDATION_UNIT_ID,
        evidence_type: 'source-observation',
        description: 'Neutral test evidence that the foundation unit was source-verified.',
        evidence_location_ref: 'contaminated-only:unit-foundation:item-foundation',
        retained_in_contaminated_domain: true,
      },
      {
        evidence_id: 'item-001',
        source_unit_ref: 'types/ids.ts',
        evidence_type: 'source-observation',
        description: 'Neutral test evidence that the unit was source-verified.',
        evidence_location_ref: 'source-index:batch-0001:types/ids.ts',
        retained_in_contaminated_domain: true,
      },
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence source_unit_ref was rejected; value not shown/);
    assert.doesNotMatch(result.stderr, /types\/ids\.ts/);
    assert.match(result.stderr, /coverage unit_id=unit-example-flow/);
    assert.match(result.stderr, /source_unit_ref must be the task-manifest unit id or accepted unit alias/);
    assert.match(result.stderr, /source paths belong in evidence_location_ref or source_index_refs\/visual_index_refs/);
  });

  test('rejects covered coverage ledger entries with unresolved coverage gaps', () => {
    const workspace = baseWorkspace('clean-room-run-covered-coverage-gap');
    writeJson(path.join(workspace.contaminated, 'coverage-ledger.json'), {
      ledger_id: 'coverage-test',
      task_id: 'task-example',
      updated_by_role: 'contaminated-manager-verifier',
      source_units: [
        {
          unit_id: 'unit-example-flow',
          coverage_state: 'covered',
          evidence_refs: ['evidence-ledger:item-001'],
        },
      ],
      behavior_spec_refs: ['spec-example-flow'],
      coverage_status: 'complete',
      abstract_delta_tickets: [
        {
          ticket_id: 'coverage-gap-001',
          unit_id: 'unit-example-flow',
          summary: 'TUI behavior remains unverified.',
          status: 'open',
        },
      ],
      review_history: [
        {
          reviewer_role: 'contaminated-manager-verifier',
          status: 'test',
          notes: '',
        },
      ],
    });
    writeEvidenceLedger(workspace.contaminated);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /covered coverage-ledger unit has unresolved coverage gaps/);
  });

  test('rejects covered coverage ledger entries with unresolved high-priority discovery leads', () => {
    const workspace = baseWorkspace('clean-room-run-covered-discovery-lead');
    writeCoverage(workspace.contaminated, 'covered', {
      discovery_leads: [discoveryLead()],
    });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /covered coverage-ledger unit has unresolved high-priority discovery_leads/);
  });

  test('allows covered coverage ledger entries with resolved high-priority discovery leads', () => {
    const workspace = baseWorkspace('clean-room-run-resolved-discovery-lead');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    writeCoverage(workspace.contaminated, 'covered', {
      discovery_leads: [discoveryLead({ status: 'resolved' })],
    });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
  });

  test('does not reject noncovered units solely for unresolved high-priority discovery leads', () => {
    let workspace = baseWorkspace('clean-room-run-gap-discovery-lead');
    writeCoverage(workspace.contaminated, 'gap', {
      discovery_leads: [discoveryLead()],
    });

    let result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /selected unit-example-flow/);

    workspace = baseWorkspace('clean-room-run-blocked-discovery-lead');
    writeCoverage(workspace.contaminated, 'blocked', {
      discovery_leads: [discoveryLead()],
    });

    result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /coverage_state blocked/);
    assert.doesNotMatch(result.stderr, /discovery_leads/);
  });

  test('rejects covered public surface missing behavior spec test coverage', () => {
    const workspace = baseWorkspace('clean-room-run-public-surface-missing-test-coverage');
    const refs = writePublicCommandCompletionArtifacts(workspace, {
      commandNames: ['/alpha'],
      scenarioCoverage: [],
    });
    writeCoveredCoverageWithPublicSurface(workspace, refs.map((ref) => publicSurfaceCoverage(ref)));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public_surface obligation missing from behavior spec test coverage/);
  });

  test('rejects covered public surface missing implementation plan mapping', () => {
    const workspace = baseWorkspace('clean-room-run-public-surface-missing-plan-ref');
    const refs = writePublicCommandCompletionArtifacts(workspace, {
      commandNames: ['/alpha'],
      planRefs: [],
    });
    writeCoveredCoverageWithPublicSurface(workspace, refs.map((ref) => publicSurfaceCoverage(ref)));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public_surface obligation missing from implementation plan/);
  });

  test('rejects covered public surface with incomplete mapped work item', () => {
    const workspace = baseWorkspace('clean-room-run-public-surface-incomplete-work-item');
    const refs = writePublicCommandCompletionArtifacts(workspace, {
      commandNames: ['/alpha'],
      completedWorkItems: [],
    });
    writeCoveredCoverageWithPublicSurface(workspace, refs.map((ref) => publicSurfaceCoverage(ref)));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public_surface obligation work item is not complete/);
  });

  test('rejects covered unit with uncovered public surface coverage entry', () => {
    const workspace = baseWorkspace('clean-room-run-public-surface-gap-coverage');
    const refs = writePublicCommandCompletionArtifacts(workspace, {
      commandNames: ['/alpha'],
    });
    writeCoveredCoverageWithPublicSurface(workspace, [publicSurfaceCoverage(refs[0], 'gap')]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /coverage-ledger public_surface_coverage is not covered/);
  });

  test('completes covered public surface when spec, plan, report, and ledger all map obligations', () => {
    const workspace = baseWorkspace('clean-room-run-public-surface-complete');
    const refs = writePublicCommandCompletionArtifacts(workspace, {
      commandNames: ['/alpha', '/beta'],
    });
    writeCoveredCoverageWithPublicSurface(workspace, refs.map((ref) => publicSurfaceCoverage(ref)));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
  });

  test('rejects noncanonical manual task manifests before completion claims', () => {
    const root = tempDir('clean-room-run-noncanonical-manual-manifest');
    const manifestPath = path.join(root, 'task-manifest.json');
    writeJson(manifestPath, {
      manifest_id: 'manual-result',
      status: 'complete',
      units_completed: ['unit-example-flow'],
    });

    const result = runCli(['run', '--task-manifest', manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required field 'task_id'/);
  });

  test('rejects completed slices without terminal clean artifacts', () => {
    const workspace = baseWorkspace('clean-room-run-complete-missing-terminal-artifacts');
    writeCoverage(workspace.contaminated, 'covered');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /completion requires terminal clean artifact/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'clean-room-result.json')), false);
  });

  test('rejects mismatched preflight goal hash', () => {
    const workspace = baseWorkspace('clean-room-run-preflight-hash');
    fs.writeFileSync(path.join(workspace.contaminated, 'preflight-goal.json'), '{"goal_id":"changed"}\n');

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal sha256 mismatch/);
  });

  test('rejects preflight goal symlink outside contaminated root', () => {
    const workspace = baseWorkspace('clean-room-run-preflight-symlink');
    const outside = path.join(workspace.root, 'outside-preflight.json');
    const preflightPath = path.join(workspace.contaminated, 'preflight-goal.json');
    fs.writeFileSync(outside, '{"goal_id":"outside"}\n');
    fs.rmSync(preflightPath);
    fs.symlinkSync(outside, preflightPath);
    const manifest = readJson(workspace.manifestPath);
    manifest.preflight_goal_sha256 = fileSha256(outside);
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal must resolve under contaminated artifact root/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('rejects attended manifests and missing loop context', () => {
    const workspace = baseWorkspace('clean-room-run-invalid-manifest');
    const manifest = readJson(workspace.manifestPath);
    manifest.controller_policy.mode = 'attended';
    writeJson(workspace.manifestPath, manifest);

    let result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires controller_policy\.mode/);

    manifest.controller_policy.mode = 'unattended';
    delete manifest.loop_context;
    writeJson(workspace.manifestPath, manifest);
    result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires task-manifest loop_context/);
  });

  test('run rejects overlapping source and contaminated roots', () => {
    const workspace = baseWorkspace('clean-room-run-overlap-source-contaminated');
    const manifest = readJson(workspace.manifestPath);
    manifest.artifact_paths.contaminated_artifacts = workspace.source;
    manifest.artifact_paths.contaminated_artifact_roots = [workspace.source];
    manifest.initialization_snapshot.effective_roots.contaminated_artifact_roots = [workspace.source];
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source roots and contaminated artifact roots must be separate/);
    assert.equal(fs.existsSync(path.join(workspace.source, '.clean-room-run.lock')), false);
    assert.equal(fs.existsSync(path.join(workspace.source, 'controller-run-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(workspace.source, 'clean-room-result.json')), false);
  });

  test('rejects max-iterations above the manifest cap', () => {
    const workspace = baseWorkspace('clean-room-run-cap');
    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--max-iterations',
      '3',
      '--dry-run',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /may only lower/);
  });

  test('rejects command configs without contaminated coverage verification', () => {
    const workspace = baseWorkspace('clean-room-run-agent3-alone');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.root),
    ]);
    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must include contaminated-coverage-verify/);
  });

  test('accepts legacy command configs without clean polish review', () => {
    const workspace = baseWorkspace('clean-room-run-agent4-legacy');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

    assert.equal(result.status, 0, result.stderr);
  });

  test('rejects combining built-in agent runtime with custom commands', () => {
    const workspace = baseWorkspace('clean-room-run-agent-runtime-conflict');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-commands',
      config,
      '--agent-runtime',
      'claude',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be used with --agent-commands/);
  });

  test('built-in Claude agent runtime invokes plugin role agents', () => {
    const workspace = baseWorkspace('clean-room-run-claude-agent-runtime');
    const capturePath = path.join(workspace.root, 'claude-calls.jsonl');
    const claude = writeClaudeAgentCaptureScript(workspace.root, capturePath);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-runtime',
      'claude',
      '--agent-config-dir',
      workspace.root,
      '--once',
    ], ROOT, {
      CLEAN_ROOM_CLAUDE_EXECUTABLE: claude,
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readJsonLines(capturePath);
    assert.deepEqual(calls.map((call) => call.env.CLEAN_ROOM_CONTROLLER_PHASE), [
      'contaminated-manager-prepare',
      'contaminated-analysis',
      'sanitize-handoff',
      'clean-plan',
      'clean-implement-qc',
      'clean-polish-review',
      'contaminated-coverage-verify',
    ]);
    assert.ok(calls.every((call) => call.args.includes('--no-session-persistence')));
    assert.ok(calls.every((call) => call.args.includes('--plugin-dir')));
    assert.ok(calls.some((call) => call.args.includes('clean-room:contaminated-manager-verifier')));
    assert.ok(calls.some((call) => call.input.includes('Do not use prior chat history as state.')));
    assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, workspace.root);
  });

  test('built-in Claude agent runtime preserves wrapper auth env only', () => {
    const workspace = baseWorkspace('clean-room-run-claude-wrapper-env');
    const capturePath = path.join(workspace.root, 'claude-calls.jsonl');
    const claude = writeClaudeAgentCaptureScript(workspace.root, capturePath);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-runtime',
      'claude',
      '--agent-config-dir',
      workspace.root,
      '--once',
    ], ROOT, {
      CLEAN_ROOM_CLAUDE_EXECUTABLE: claude,
      OPENROUTER_API_KEY: 'or-test-key',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-test-token',
      ANTHROPIC_API_KEY: 'anthropic-api-key',
      SECRET_SHOULD_NOT_LEAK: 'do-not-copy',
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readJsonLines(capturePath);
    assert.equal(calls[0].env.OPENROUTER_API_KEY, 'or-test-key');
    assert.equal(calls[0].env.ANTHROPIC_AUTH_TOKEN, 'anthropic-test-token');
    assert.equal(calls[0].env.ANTHROPIC_API_KEY, 'anthropic-api-key');
    assert.equal(calls[0].env.SECRET_SHOULD_NOT_LEAK, undefined);
  });

  test('built-in Claude agent runtime accepts ccsilo shortcut', () => {
    const root = tempDir('clean-room-run-ccsilo');
    const workspace = baseWorkspace('clean-room-run-ccsilo-workspace');
    const capturePath = path.join(workspace.root, 'claude-calls.jsonl');
    const wrapper = writeClaudeAgentCaptureScript(workspace.root, capturePath);
    const variant = writeCcsiloVariant(root, 'openrouter', wrapper);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-runtime',
      'claude',
      '--ccsilo',
      'openrouter',
      '--once',
    ], ROOT, {
      HOME: root,
      OPENROUTER_API_KEY: 'or-test-key',
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readJsonLines(capturePath);
    assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, variant.configDir);
    assert.equal(calls[0].env.OPENROUTER_API_KEY, 'or-test-key');
    assert.equal(calls[0].env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.equal(calls[0].env.ANTHROPIC_MODEL, 'openrouter/owl-alpha');
  });

  test('validates clean polish review stage order', () => {
    const workspace = baseWorkspace('clean-room-run-agent4-order');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
      noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-polish-review must run after clean-implement-qc/);
  });

  test('validates task manifest schema before deriving roots', () => {
    const workspace = baseWorkspace('clean-room-run-manifest-schema-first');
    const manifest = readJson(workspace.manifestPath);
    manifest.artifact_paths.implementation_roots = workspace.implementation;
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema check failed/);
  });

  test('rejects phase cwd and source-root argv boundaries', () => {
    const workspace = baseWorkspace('clean-room-run-command-boundaries');
    let config = commandConfig(path.join(workspace.root, 'commands-bad-cwd.json'), [
      noOpStage('clean-plan', 'clean-architect', workspace.source),
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    let result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cwd must not be under source roots/);

    const sourceTool = path.join(workspace.source, 'tool.js');
    fs.writeFileSync(sourceTool, 'process.exit(0)\n');
    config = commandConfig(path.join(workspace.root, 'commands-bad-argv.json'), [
      {
        phase: 'clean-plan',
        role: 'clean-architect',
        cwd: workspace.clean,
        argv: [sourceTool],
      },
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /argv\[0\] must not resolve under source roots/);
  });

  test('inner loop cannot select units outside approved scope refs', () => {
    const workspace = baseWorkspace('clean-room-run-scope');
    const manifest = readJson(workspace.manifestPath);
    manifest.loop_context.approved_scope_refs = ['unit:not-approved'];
    writeJson(workspace.manifestPath, manifest);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match any task-manifest unit/);
  });

  test('no-progress detection stops before max iterations', () => {
    const workspace = baseWorkspace('clean-room-run-no-progress');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.root),
    ]);
    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no-progress-detected/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'no-progress-detected');
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations.length, 1);
    assert.equal(ledger.iterations[0].stop_reason, 'no-progress-detected');
  });

  test('classified stage failures produce sanitized diagnostics', () => {
    const cases = [
      {
        name: 'auth',
        output: 'Not logged in · Please run /login\n',
        expected: /Claude auth is unavailable for the configured agent harness/,
        required: [/--ccsilo \[variant\]/, /Never write ANTHROPIC_AUTH_TOKEN or API keys/],
        forbidden: /Run \/login/,
      },
      {
        name: 'rate-limit',
        output: '429 {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"openrouter/owl-alpha is temporarily rate-limited upstream. Please retry shortly."}}}\n',
        expected: /Claude provider returned 429/,
      },
      {
        name: 'malformed-200',
        output: 'API Error: API returned an empty or malformed response (HTTP 200), check for a proxy or gateway intercepting the request\n',
        expected: /Claude provider returned an empty or malformed HTTP 200 response/,
      },
      {
        name: 'openrouter-missing-key',
        output: '/Users/example/.local/bin/openrouter: line 98: OPENROUTER_API_KEY: Set OPENROUTER_API_KEY for variant openrouter\n',
        expected: /OpenRouter wrapper credentials are unavailable/,
        required: [/--ccsilo \[variant\]/, /never write ANTHROPIC_AUTH_TOKEN or API keys/],
        forbidden: /sk-or-v1-/,
      },
    ];

    for (const item of cases) {
      const workspace = baseWorkspace(`clean-room-run-classified-${item.name}`);
      const config = commandConfig(path.join(workspace.root, 'commands.json'), [
        failingStageWithOutput(
          'contaminated-manager-prepare',
          'contaminated-manager-verifier',
          workspace.contaminated,
          item.output
        ),
        noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
      ]);

      const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /contaminated-manager-prepare failed:/);
      assert.match(result.stdout, item.expected);
      if (item.required) {
        for (const required of item.required) assert.match(result.stdout, required);
      }
      if (item.forbidden) assert.doesNotMatch(result.stdout, item.forbidden);
      const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
      assert.equal(runResult.result, 'spec-slice-blocked');
      assert.match(runResult.abstract_delta_tickets[0].summary, item.expected);
      if (item.required) {
        for (const required of item.required) {
          assert.match(runResult.abstract_delta_tickets[0].summary, required);
        }
      }
      if (item.forbidden) assert.doesNotMatch(runResult.abstract_delta_tickets[0].summary, item.forbidden);
    }
  });

  test('continues across approved units until coverage is complete', () => {
    const workspace = baseWorkspace('clean-room-run-multiple-units');
    addSecondApprovedUnit(workspace);
    const hookShim = writeHookCaptureShim(workspace.root, path.join(workspace.root, 'hook-env.jsonl'));
    const script = writeSelectedUnitCoveredScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.contaminated, script),
    ]);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-commands',
      config,
      '--python',
      hookShim,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations.length, 2);
    assert.deepEqual(ledger.iterations.map((entry) => entry.unit_id), [BEHAVIOR_UNIT_ID, SECOND_UNIT_ID]);
    assert.equal(ledger.iterations[0].stop_reason, 'unit-complete');
    assert.equal(ledger.iterations[1].stop_reason, 'spec-slice-complete');
  });

  test('once caps a multi-unit unattended run after one selected unit', () => {
    const workspace = baseWorkspace('clean-room-run-multiple-units-once');
    addSecondApprovedUnit(workspace);
    const hookShim = writeHookCaptureShim(workspace.root, path.join(workspace.root, 'hook-env.jsonl'));
    const script = writeSelectedUnitCoveredScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.contaminated, script),
    ]);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-commands',
      config,
      '--once',
      '--python',
      hookShim,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /iteration-limit-reached/);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations.length, 1);
    assert.equal(ledger.iterations[0].unit_id, BEHAVIOR_UNIT_ID);
    assert.equal(ledger.iterations[0].stop_reason, 'unit-complete');
    const coverage = readJson(path.join(workspace.contaminated, 'coverage-ledger.json'));
    assert.equal(coverage.source_units.find((unit) => unit.unit_id === SECOND_UNIT_ID).coverage_state, 'gap');
  });

  test('run lock recovers stale locks and preserves fresh locks', () => {
    const staleWorkspace = baseWorkspace('clean-room-run-stale-lock');
    const staleLock = path.join(staleWorkspace.contaminated, '.clean-room-run.lock');
    writeLock(staleLock, 2147483647, new Date(Date.now() - 120_000));
    let config = commandConfig(path.join(staleWorkspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', staleWorkspace.root),
    ]);

    let result = runCli(['run', '--task-manifest', staleWorkspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readdirSync(staleWorkspace.contaminated).some((name) => name.startsWith('.clean-room-run.lock.stale.')),
      true
    );

    const freshWorkspace = baseWorkspace('clean-room-run-fresh-lock');
    const freshLock = path.join(freshWorkspace.contaminated, '.clean-room-run.lock');
    writeLock(freshLock, process.pid, new Date());
    config = commandConfig(path.join(freshWorkspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', freshWorkspace.root),
    ]);

    result = runCli([
      'run',
      '--task-manifest',
      freshWorkspace.manifestPath,
      '--agent-commands',
      config,
    ], ROOT, {
      CLEAN_ROOM_RUN_LOCK_WAIT_MS: '50',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-room run lock is held/);
    assert.equal(fs.existsSync(freshLock), true);
  });

  test('implementation lock recovers stale locks and preserves fresh locks', () => {
    const staleWorkspace = baseWorkspace('clean-room-run-impl-stale-lock');
    const staleLock = path.join(staleWorkspace.implementation, '.clean-room-implementation.lock');
    writeLock(staleLock, 2147483647, new Date(Date.now() - 120_000));
    let config = commandConfig(path.join(staleWorkspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', staleWorkspace.root),
    ]);

    let result = runCli(['run', '--task-manifest', staleWorkspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readdirSync(staleWorkspace.implementation).some((name) => name.startsWith('.clean-room-implementation.lock.stale.')),
      true
    );
    assert.equal(fs.existsSync(staleLock), false);

    const freshWorkspace = baseWorkspace('clean-room-run-impl-fresh-lock');
    const freshLock = path.join(freshWorkspace.implementation, '.clean-room-implementation.lock');
    writeLock(freshLock, process.pid, new Date());
    config = commandConfig(path.join(freshWorkspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', freshWorkspace.root),
    ]);

    result = runCli([
      'run',
      '--task-manifest',
      freshWorkspace.manifestPath,
      '--agent-commands',
      config,
    ], ROOT, {
      CLEAN_ROOM_IMPLEMENTATION_LOCK_WAIT_MS: '50',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-room implementation lock is held/);
    assert.equal(fs.existsSync(freshLock), true);
    // Implementation locks acquire before the contaminated run lock, so a
    // held implementation lock must leave no run lock behind.
    assert.equal(fs.existsSync(path.join(freshWorkspace.contaminated, '.clean-room-run.lock')), false);
  });

  test('timestamp-only artifact changes do not count as progress', () => {
    const workspace = baseWorkspace('clean-room-run-timestamp-only');
    writeQcReport(workspace.clean, '2024-01-01T00:00:00Z');
    const script = writeTimestampOnlyQcScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.contaminated, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].progress_detected, false);
    assert.equal(ledger.iterations[0].stop_reason, 'no-progress-detected');
  });

  test('implementation-root changes count as progress', () => {
    const workspace = baseWorkspace('clean-room-run-implementation-progress');
    const script = writeImplementationChangeScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].progress_detected, true);
    assert.equal(fs.readFileSync(path.join(workspace.implementation, 'generated.txt'), 'utf8'), 'implemented\n');
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'iteration-limit-reached');
  });

  test('implementation target JSON does not count as semantic progress', () => {
    const workspace = baseWorkspace('clean-room-run-target-json-ignored');
    const script = writeImplementationTargetJsonScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].progress_detected, false);
    assert.equal(ledger.iterations[0].stop_reason, 'no-progress-detected');
    assert.equal(fs.existsSync(path.join(workspace.implementation, 'target', 'build-metadata.json')), true);
  });

  test('between stages validates only changed artifacts', () => {
    const workspace = baseWorkspace('clean-room-run-touched-validation');
    const capturePath = path.join(workspace.root, 'hook-env.jsonl');
    const hookShim = writeHookCaptureShim(workspace.root, capturePath);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-analysis', 'contaminated-source-analyst', workspace.root),
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.root),
    ]);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-commands',
      config,
      '--python',
      hookShim,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const captures = readJsonLines(capturePath);
    const coverageSchemaChecks = captures.filter((item) => {
      return item.script === 'validate-json-schema.py' && item.input.includes('coverage-ledger.json');
    });
    assert.equal(coverageSchemaChecks.length, 3);
  });

  test('passes only allowlisted parent and hook-only env to validation hooks', () => {
    const workspace = baseWorkspace('clean-room-run-hook-env');
    const capturePath = path.join(workspace.root, 'hook-env.jsonl');
    const hookShim = writeHookCaptureShim(workspace.root, capturePath);
    const denylistPath = path.join(workspace.root, 'private-identifiers.txt');
    fs.writeFileSync(denylistPath, '# empty test denylist\n');

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--dry-run',
      '--python',
      hookShim,
    ], ROOT, {
      CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST: path.join(workspace.clean, 'auxiliary.json'),
      CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST: denylistPath,
      SECRET_TOKEN: 'must-not-leak',
    });

    assert.equal(result.status, 0, result.stderr);
    const captures = readJsonLines(capturePath).filter((item) => item.env.CLEAN_ROOM_ROLE);
    assert.ok(captures.length > 0);
    for (const item of captures) {
      assert.equal(item.env.SECRET_TOKEN, undefined);
      assert.equal(item.env.CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST, path.join(workspace.clean, 'auxiliary.json'));
      assert.equal(item.env.CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST, denylistPath);
      assert.ok(['contaminated-manager-verifier', 'clean-architect'].includes(item.env.CLEAN_ROOM_ROLE));
      assert.equal(item.env.CLEAN_ROOM_CLEAN_ROOTS, workspace.clean);
    }
  });

  test('stage env excludes parent secrets and hook-only variables while preserving adapter env', () => {
    const workspace = baseWorkspace('clean-room-run-stage-env');
    const capturePath = path.join(workspace.root, 'stage-env.json');
    const stageScript = writeStageEnvCaptureScript(workspace.root, capturePath);
    const denylistPath = path.join(workspace.root, 'private-identifiers.txt');
    fs.writeFileSync(denylistPath, '# empty test denylist\n');
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...coverageStage(workspace.root, stageScript),
        env: {
          ADAPTER_VISIBLE: 'yes',
        },
      },
    ]);

    const result = runCli([
      'run',
      '--task-manifest',
      workspace.manifestPath,
      '--agent-commands',
      config,
    ], ROOT, {
      CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST: path.join(workspace.clean, 'auxiliary.json'),
      CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST: denylistPath,
      SECRET_TOKEN: 'must-not-leak',
    });

    assert.equal(result.status, 0, result.stderr);
    const env = readJson(capturePath);
    assert.equal(env.ADAPTER_VISIBLE, 'yes');
    assert.equal(env.SECRET_TOKEN, undefined);
    assert.equal(env.CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST, undefined);
    assert.equal(env.CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST, undefined);
    assert.equal(env.CLEAN_ROOM_ROLE, 'contaminated-manager-verifier');
    assert.equal(env.CLEAN_ROOM_SELECTED_UNIT_ID, 'unit-example-flow');
  });

  test('strict context management requires fresh role-session briefs', () => {
    const workspace = baseWorkspace('clean-room-run-strict-context-required');
    enableStrictContext(workspace);
    let config = commandConfig(path.join(workspace.root, 'commands-missing-context.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
    ]);

    let result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must provide context/);

    config = commandConfig(path.join(workspace.root, 'commands-missing-brief.json'), [
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: path.join(workspace.contaminated, 'missing-role-session-brief.json'),
        },
      },
    ]);

    result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /role-session brief not found/);
  });

  test('strict context management rejects mismatched and over-budget briefs', () => {
    const workspace = baseWorkspace('clean-room-run-strict-context-invalid');
    enableStrictContext(workspace, { max_brief_chars: 2000 });
    const briefPath = writeRoleSessionBrief(
      workspace,
      path.join(workspace.contaminated, 'role-session-brief.json'),
      'clean-architect',
      'contaminated-coverage-verify'
    );
    let config = commandConfig(path.join(workspace.root, 'commands-wrong-role.json'), [
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: briefPath,
        },
      },
    ]);

    let result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /brief role does not match/);

    enableStrictContext(workspace, { max_brief_chars: 80 });
    writeRoleSessionBrief(
      workspace,
      briefPath,
      'contaminated-manager-verifier',
      'contaminated-coverage-verify'
    );
    config = commandConfig(path.join(workspace.root, 'commands-over-budget.json'), [
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: briefPath,
        },
      },
    ]);

    result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds max_brief_chars/);
  });

  test('strict context management rejects brief paths outside role artifact roots', () => {
    const workspace = baseWorkspace('clean-room-run-strict-context-brief-root');
    enableStrictContext(workspace);
    const briefPath = writeRoleSessionBrief(
      workspace,
      path.join(workspace.root, 'role-session-brief.json'),
      'contaminated-manager-verifier',
      'contaminated-coverage-verify'
    );
    const config = commandConfig(path.join(workspace.root, 'commands-bad-brief-root.json'), [
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: briefPath,
        },
      },
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /context\.brief_path/);
  });

  test('strict context management rejects source-denied briefs with blocked artifacts', () => {
    const workspace = baseWorkspace('clean-room-run-strict-context-source-denied');
    enableStrictContext(workspace);
    const briefPath = writeRoleSessionBrief(
      workspace,
      path.join(workspace.contaminated, 'sanitize-role-session-brief.json'),
      'contaminated-handoff-sanitizer',
      'sanitize-handoff',
      {
        allowed_artifacts: [
          {
            artifact_id: 'source-index',
            artifact_type: 'other',
            path: 'source-index.json',
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      }
    );
    const coverageBriefPath = writeRoleSessionBrief(
      workspace,
      path.join(workspace.contaminated, 'coverage-role-session-brief.json'),
      'contaminated-manager-verifier',
      'contaminated-coverage-verify'
    );
    const config = commandConfig(path.join(workspace.root, 'commands-source-denied.json'), [
      {
        ...noOpStage('sanitize-handoff', 'contaminated-handoff-sanitizer', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: briefPath,
        },
      },
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: coverageBriefPath,
        },
      },
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden for source-denied phase/);
  });

  test('strict context management exports brief env and records brief hashes only', () => {
    const workspace = baseWorkspace('clean-room-run-strict-context-env');
    enableStrictContext(workspace);
    const capturePath = path.join(workspace.root, 'stage-env.json');
    const stageScript = writeStageEnvCaptureScript(workspace.root, capturePath);
    const briefPath = writeRoleSessionBrief(
      workspace,
      path.join(workspace.contaminated, 'role-session-brief.json'),
      'contaminated-manager-verifier',
      'contaminated-coverage-verify'
    );
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...coverageStage(workspace.contaminated, stageScript),
        context: {
          fresh_session: true,
          brief_path: briefPath,
        },
      },
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    const env = readJson(capturePath);
    assert.equal(env.CLEAN_ROOM_SESSION_BRIEF_PATH, briefPath);
    assert.equal(env.CLEAN_ROOM_FRESH_CONTEXT_REQUIRED, '1');
    assert.match(env.CLEAN_ROOM_ROLE_SESSION_ID, /^[0-9a-f-]{36}$/);

    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    const phase = ledger.iterations[0].phases[0];
    assert.equal(phase.session_brief_ref, briefPath);
    assert.equal(phase.session_brief_sha256, fileSha256(briefPath));
    assert.equal(JSON.stringify(phase).includes('Run the configured test stage'), false);
  });

  test('controller-status updates do not count as progress', () => {
    const workspace = baseWorkspace('clean-room-run-status-only');
    const script = writeControllerStatusScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.contaminated, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].progress_detected, false);
    assert.equal(ledger.iterations[0].stop_reason, 'no-progress-detected');
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-status.json')), true);
  });

  test('stale artifact validation aggregates failures and ignores controller-status', () => {
    const workspace = baseWorkspace('clean-room-run-stale-artifacts');
    writeJson(path.join(workspace.clean, 'behavior-spec-stale.json'), {});
    writeJson(path.join(workspace.clean, 'implementation-plan-stale.json'), {});
    writeJson(path.join(workspace.contaminated, 'controller-status.json'), {
      old_controller_shape: true,
    });

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-room artifact validation failed/);
    assert.match(result.stderr, /behavior-spec-stale\.json/);
    assert.match(result.stderr, /implementation-plan-stale\.json/);
    assert.match(result.stderr, /move stale\/legacy JSON out of contaminated and clean artifact roots/);
    assert.doesNotMatch(result.stderr, /controller-status\.json/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
  });

  test('repeated unit selection stops after prior no-progress iteration', () => {
    const workspace = baseWorkspace('clean-room-run-repeated');
    writeJson(path.join(workspace.contaminated, 'controller-run-ledger.json'), {
      ledger_id: 'controller-run-ledger',
      task_id: 'task-example',
      updated_at: '2024-01-01T00:00:00Z',
      loop_context: {
        parent_loop_ref: 'spec-dev-loop:test',
        spec_slice_ref: 'behavior-spec:unit-example-flow',
      },
      iterations: [
        {
          iteration: 1,
          unit_id: 'unit-example-flow',
          stop_reason: 'no-progress-detected',
          phases: [],
        },
      ],
    });
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.root),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /repeated-unit-selection/);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations.at(-1).stop_reason, 'repeated-unit-selection');
  });

  test('controller run ledger keeps the latest 50 entries and records pruned count', () => {
    const workspace = baseWorkspace('clean-room-run-ledger-cap');
    writeJson(path.join(workspace.contaminated, 'controller-run-ledger.json'), {
      ledger_id: 'controller-run-ledger',
      task_id: 'task-example',
      updated_at: '2024-01-01T00:00:00Z',
      loop_context: {
        parent_loop_ref: 'spec-dev-loop:test',
        spec_slice_ref: 'behavior-spec:unit-example-flow',
      },
      iterations: Array.from({ length: 50 }, (_, index) => ({
        iteration: index + 1,
        unit_id: 'unit-example-flow',
        stop_reason: 'spec-delta-required',
        phases: [],
      })),
    });
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.root),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations.length, 50);
    assert.equal(ledger.pruned_iteration_count, 1);
    assert.equal(ledger.iterations[0].iteration, 2);
    assert.equal(ledger.iterations.at(-1).stop_reason, 'no-progress-detected');
  });

  test('spec-delta-required writes clean-room result with abstract deltas only', () => {
    const workspace = baseWorkspace('clean-room-run-delta');
    const script = writeDeltaScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-delta-required/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-delta-required');
    assert.deepEqual(runResult.abstract_delta_tickets, [
      {
        ticket_id: 'delta-001',
        summary: 'The spec does not define timeout behavior.',
        requested_clean_change: 'Define timeout behavior.',
        status: 'open',
      },
      {
        ticket_id: 'delta-qc-coverage',
        kind: 'implementation-gap',
        summary: 'QC coverage_status is partial, not complete.',
        requested_clean_change: 'Resolve QC coverage gaps before marking the spec slice complete.',
        status: 'open',
      },
      {
        ticket_id: 'delta-qc-final-status',
        kind: 'implementation-gap',
        summary: 'QC final_status is passed-with-gaps, not passed.',
        requested_clean_change: 'Resolve QC findings before marking the spec slice complete.',
        status: 'open',
      },
    ]);
    assert.equal(JSON.stringify(runResult).includes('src/'), false);
  });

  test('rejects clean-run-context behavior spec references that do not exist', () => {
    const workspace = baseWorkspace('clean-room-run-missing-context-spec');
    writeCleanRunContext(workspace, ['missing-behavior-spec.json']);
    writeHandoffPackage(workspace, ['clean-run-context.json', FOUNDATION_SPEC_FILE]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /behavior spec does not exist/);
  });

  test('rejects schema-invalid behavior specs referenced by clean-run-context', () => {
    const workspace = baseWorkspace('clean-room-run-invalid-context-spec');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), {
      unit: 'unit-example-flow',
      summary: 'This is not the behavior-spec schema.',
    });
    writeCleanRunContext(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema check failed/);
  });

  test('rejects clean-run-context behavior specs without a skeleton manifest', () => {
    const workspace = baseWorkspace('clean-room-run-missing-skeleton');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    fs.rmSync(path.join(workspace.clean, 'skeleton-manifest.json'));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /skeleton manifest does not exist/);
  });

  test('rejects implementation plans that reference unknown architecture areas', () => {
    const workspace = baseWorkspace('clean-room-run-unknown-area');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace, {
      work_items: [
        {
          work_item_id: 'wi-test',
          status: 'planned',
          summary: 'Implement the example flow.',
          spec_ids: ['spec-example-flow'],
          architecture_area_refs: ['area-missing'],
          implementation_root_ref: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
          target_paths: ['src/example-flow.js'],
          test_paths: ['test/example-flow.test.js'],
          acceptance_criteria: ['Example flow is implemented and tested.'],
        },
      ],
    });
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown architecture area/);
  });

  test('rejects implementation plan paths outside referenced architecture areas', () => {
    const workspace = baseWorkspace('clean-room-run-area-path-drift');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace, {
      work_items: [
        {
          work_item_id: 'wi-test',
          status: 'planned',
          summary: 'Implement the example flow.',
          spec_ids: ['spec-example-flow'],
          architecture_area_refs: ['area-example-flow'],
          implementation_root_ref: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
          target_paths: ['unowned/example-flow.js'],
          test_paths: ['test/example-flow.test.js'],
          acceptance_criteria: ['Example flow is implemented and tested.'],
        },
      ],
    });
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside referenced architecture areas/);
  });

  test('accepts planned refactor paths covered by architecture areas', () => {
    const workspace = baseWorkspace('clean-room-run-covered-refactor');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace, {
      planned_refactors: [
        {
          refactor_id: 'refactor-test',
          kind: 'extract',
          summary: 'Extract a helper inside the existing clean area.',
          architecture_area_refs: ['area-example-flow'],
          existing_paths: ['src/example-flow.js'],
          target_paths: ['src/example-helper.js'],
          test_paths: ['test/example-helper.test.js'],
          rationale: 'Keep related clean behavior inside the owned area.',
        },
      ],
    });
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /selected unit-example-flow/);
  });

  test('rejects handoff packages that omit clean-run-context behavior specs', () => {
    const workspace = baseWorkspace('clean-room-run-handoff-omits-spec');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json']);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not include clean-run-context behavior spec/);
  });

  test('rejects handoff packages with stale behavior spec hashes', () => {
    const workspace = baseWorkspace('clean-room-run-handoff-stale-hash');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    const handoffPath = path.join(workspace.clean, 'handoff-package.json');
    const handoff = readJson(handoffPath);
    handoff.artifacts.find((item) => item.path === 'behavior-spec.json').sha256 =
      '0000000000000000000000000000000000000000000000000000000000000000';
    writeJson(handoffPath, handoff);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256 mismatch/);
  });

  test('architecture drift in terminal reports returns spec delta', () => {
    const workspace = baseWorkspace('clean-room-run-architecture-drift');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const reportPath = path.join(workspace.clean, 'implementation-report.json');
    const report = readJson(reportPath);
    report.changed_paths = [
      {
        path: 'unowned/generated.js',
        kind: 'code',
        work_item_ids: ['wi-test'],
      },
    ];
    writeJson(reportPath, report);
    const script = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-delta-required/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-delta-required');
    assert.deepEqual(runResult.abstract_delta_tickets, [
      {
        ticket_id: 'delta-architecture-drift',
        kind: 'implementation-gap',
        summary: 'Implementation report changed paths do not map to planned work items and owned architecture areas.',
        requested_clean_change: 'Revise skeleton-manifest.json and implementation-plan.json, then rerun clean implementation inside owned architecture areas.',
        status: 'open',
      },
    ]);
  });

  test('unreported implementation changes return spec delta', () => {
    const workspace = baseWorkspace('clean-room-run-unreported-implementation-change');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const implementationScript = writeImplementationChangeScript(workspace.root);
    const coverageScript = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        phase: 'clean-implement-qc',
        role: 'clean-qa-editor',
        cwd: workspace.implementation,
        argv: [process.execPath, implementationScript],
      },
      coverageStage(workspace.root, coverageScript),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-delta-required/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-delta-required');
    assert.deepEqual(runResult.abstract_delta_tickets, [
      {
        ticket_id: 'delta-architecture-drift',
        kind: 'implementation-gap',
        summary: 'Implementation report changed paths did not match observed implementation-root file changes. Re-run clean implementation with accurate changed_paths.',
        requested_clean_change: 'Revise skeleton-manifest.json and implementation-plan.json, then rerun clean implementation inside owned architecture areas.',
        status: 'open',
      },
    ]);
  });

  test('rejects covered behavior specs with unresolved open questions', () => {
    const workspace = baseWorkspace('clean-room-run-open-question-delta');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec({
      open_questions: ['The approved behavior spec still has an unresolved compatibility question.'],
    }));
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const script = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /covered behavior spec has unresolved open_questions/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'clean-room-result.json')), false);
  });

  test('polish report is required for completion when polish stage is configured', () => {
    const workspace = baseWorkspace('clean-room-run-polish-required');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const script = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
      noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-delta-required/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-delta-required');
    assert.equal(runResult.polish_report_ref, undefined);
    assert.equal(runResult.abstract_delta_tickets[0].ticket_id, 'delta-polish-review');
  });

  test('passing polish report allows completion and is returned by reference', () => {
    const workspace = baseWorkspace('clean-room-run-polish-complete');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    writePolishReport(workspace);
    const polishScript = writeImplementationFileScript(workspace.root, 'AGENTS.md', '# Commands\n\n- npm test\n');
    const script = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
      {
        ...noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
        argv: [process.execPath, polishScript],
      },
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-slice-complete');
    assert.equal(runResult.polish_report_ref, 'polish-report.json');
  });

  test('controller finalizes Agent 4 commit before coverage verification', () => {
    const workspace = baseWorkspace('clean-room-run-polish-controller-commit');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const implementationReportPath = path.join(workspace.clean, 'implementation-report.json');
    const implementationReport = readJson(implementationReportPath);
    implementationReport.changed_paths = [
      {
        path: 'src/example-flow.js',
        kind: 'code',
        work_item_ids: ['wi-test'],
      },
    ];
    writeJson(implementationReportPath, implementationReport);
    writePolishReport(workspace, {
      git: {
        repository_status: 'not-initialized',
        commit_required: true,
        commit_status: 'not-run',
        include_paths: ['AGENTS.md', 'src/example-flow.js'],
        commit_message: 'Complete clean-room spec slice behavior-spec:unit-example-flow',
        commit_hash: null,
        status_summary: 'Commit pending controller finalization.',
      },
      final_status: 'blocked',
    });
    const implementationScript = writeImplementationFileScript(
      workspace.root,
      'src/example-flow.js',
      'export function exampleFlow() { return true; }\n'
    );
    const polishScript = writeImplementationFileScript(workspace.root, 'AGENTS.md', '# Commands\n\n- npm test\n');
    const coverageScript = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
        argv: [process.execPath, implementationScript],
      },
      {
        ...noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
        argv: [process.execPath, polishScript],
      },
      coverageStage(workspace.root, coverageScript),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
    const polishReport = readJson(path.join(workspace.clean, 'polish-report.json'));
    assert.equal(polishReport.final_status, 'passed');
    assert.equal(polishReport.git.commit_status, 'committed');
    assert.match(polishReport.git.commit_hash, /^[0-9a-f]{40}$/);
    assert.deepEqual([...polishReport.git.include_paths].sort(), ['AGENTS.md', 'src/example-flow.js']);
    const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: workspace.implementation,
      encoding: 'utf8',
    });
    assert.equal(tree.status, 0, tree.stderr);
    assert.match(tree.stdout, /^AGENTS\.md$/m);
    assert.match(tree.stdout, /^src\/example-flow\.js$/m);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].phases[1].agent4_commit.status, 'committed');
  });

  test('controller blocks Agent 4 commit when implementation paths are omitted', () => {
    const workspace = baseWorkspace('clean-room-run-polish-commit-missing-path');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const implementationReportPath = path.join(workspace.clean, 'implementation-report.json');
    const implementationReport = readJson(implementationReportPath);
    implementationReport.changed_paths = [
      {
        path: 'src/example-flow.js',
        kind: 'code',
        work_item_ids: ['wi-test'],
      },
    ];
    writeJson(implementationReportPath, implementationReport);
    writePolishReport(workspace, {
      git: {
        repository_status: 'not-initialized',
        commit_required: true,
        commit_status: 'not-run',
        include_paths: ['AGENTS.md'],
        commit_message: 'Complete clean-room spec slice behavior-spec:unit-example-flow',
        commit_hash: null,
        status_summary: 'Commit pending controller finalization.',
      },
      final_status: 'blocked',
    });
    const implementationScript = writeImplementationFileScript(
      workspace.root,
      'src/example-flow.js',
      'export function exampleFlow() { return true; }\n'
    );
    const polishScript = writeImplementationFileScript(workspace.root, 'AGENTS.md', '# Commands\n\n- npm test\n');
    const coverageScript = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
        argv: [process.execPath, implementationScript],
      },
      {
        ...noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
        argv: [process.execPath, polishScript],
      },
      coverageStage(workspace.root, coverageScript),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-blocked/);
    assert.equal(fs.existsSync(path.join(workspace.implementation, '.git')), false);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-slice-blocked');
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].phases[1].status, 'failed');
    assert.match(ledger.iterations[0].phases[1].stderr, /missing changed implementation path/);
  });

  test('disabled Agent 4 commit policy completes only when commit is not required', () => {
    const workspace = baseWorkspace('clean-room-run-polish-commit-disabled');
    writeJson(path.join(workspace.clean, 'behavior-spec.json'), validBehaviorSpec());
    writeCleanRunContext(workspace);
    const contextPath = path.join(workspace.clean, 'clean-run-context.json');
    const context = readJson(contextPath);
    context.implementation.polish_commit = {
      agent4_shell_allowed: false,
      cwd_policy: 'implementation-root',
      git_policy: 'disabled',
    };
    writeJson(contextPath, context);
    writeArchitectureArtifacts(workspace);
    writeHandoffPackage(workspace, ['clean-run-context.json', 'behavior-spec.json']);
    writeCompleteCleanReports(workspace);
    const implementationReportPath = path.join(workspace.clean, 'implementation-report.json');
    const implementationReport = readJson(implementationReportPath);
    implementationReport.changed_paths = [
      {
        path: 'src/example-flow.js',
        kind: 'code',
        work_item_ids: ['wi-test'],
      },
    ];
    writeJson(implementationReportPath, implementationReport);
    writePolishReport(workspace, {
      changed_paths: [],
      git: {
        repository_status: 'not-initialized',
        commit_required: false,
        commit_status: 'not-needed',
        include_paths: [],
        commit_message: '',
        commit_hash: null,
        status_summary: 'Agent 4 commit policy is disabled.',
      },
      final_status: 'passed',
    });
    const implementationScript = writeImplementationFileScript(
      workspace.root,
      'src/example-flow.js',
      'export function exampleFlow() { return true; }\n'
    );
    const coverageScript = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
        argv: [process.execPath, implementationScript],
      },
      noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
      coverageStage(workspace.root, coverageScript),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
    assert.equal(fs.existsSync(path.join(workspace.implementation, '.git')), false);
    const polishReport = readJson(path.join(workspace.clean, 'polish-report.json'));
    assert.equal(polishReport.git.commit_status, 'not-needed');
  });

  test('strict context management accepts clean polish review briefs', () => {
    const workspace = baseWorkspace('clean-room-run-polish-strict-context');
    enableStrictContext(workspace);
    const polishBrief = writeRoleSessionBrief(
      workspace,
      path.join(workspace.clean, 'polish-role-session-brief.json'),
      'clean-polish-reviewer',
      'clean-polish-review'
    );
    const coverageBrief = writeRoleSessionBrief(
      workspace,
      path.join(workspace.contaminated, 'coverage-role-session-brief.json'),
      'contaminated-manager-verifier',
      'contaminated-coverage-verify'
    );
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      {
        ...noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
        context: {
          fresh_session: true,
          brief_path: writeRoleSessionBrief(
            workspace,
            path.join(workspace.clean, 'implementation-role-session-brief.json'),
            'clean-qa-editor',
            'clean-implement-qc'
          ),
        },
      },
      {
        ...noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
        context: {
          fresh_session: true,
          brief_path: polishBrief,
        },
      },
      {
        ...noOpStage('contaminated-coverage-verify', 'contaminated-manager-verifier', workspace.contaminated),
        context: {
          fresh_session: true,
          brief_path: coverageBrief,
        },
      },
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config, '--once']);

    assert.equal(result.status, 0, result.stderr);
    const ledger = readJson(path.join(workspace.contaminated, 'controller-run-ledger.json'));
    assert.equal(ledger.iterations[0].phases[1].role, 'clean-polish-reviewer');
    assert.equal(ledger.iterations[0].phases[1].session_brief_ref, polishBrief);
  });
});
