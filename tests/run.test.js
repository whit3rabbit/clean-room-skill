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
const TEST_TIMEOUT_MS = 30_000;
const TMP_DIRS = [];

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

function runCli(args, cwd = ROOT, env = {}) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
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
  fs.copyFileSync(PREFLIGHT_FIXTURE, path.join(dirs.contaminated, 'preflight-goal.json'));
  writeJson(manifestPath, manifest);
  writeCoverage(dirs.contaminated, 'gap');
  return { ...dirs, manifestPath };
}

function writeCoverage(contaminated, coverageState) {
  const evidenceRefs = coverageState === 'covered' ? ['evidence-ledger:item-001'] : [];
  writeJson(path.join(contaminated, 'coverage-ledger.json'), {
    ledger_id: 'coverage-test',
    task_id: 'task-example',
    updated_by_role: 'contaminated-manager-verifier',
    source_units: [
      {
        unit_id: 'unit-example-flow',
        coverage_state: coverageState,
        evidence_refs: evidenceRefs,
      },
    ],
    behavior_spec_refs: [],
    coverage_status: coverageState === 'covered' ? 'complete' : 'partial',
    abstract_delta_tickets: [],
    review_history: [
      {
        reviewer_role: 'contaminated-manager-verifier',
        status: 'test',
        notes: '',
      },
    ],
  });
  if (coverageState === 'covered') {
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
        evidence_id: 'item-001',
        source_unit_ref: 'unit-example-flow',
        evidence_type: 'source-observation',
        description: 'Neutral test evidence that the unit was source-verified.',
        evidence_location_ref: 'contaminated-only:unit-example-flow:item-001',
        retained_in_contaminated_domain: true,
      },
    ],
  });
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
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  script: path.basename(process.argv[2] || ''),
  env: process.env
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
        unit_id: 'unit-example-flow',
        coverage_state: 'covered',
        evidence_refs: ['evidence-ledger:item-001'],
        public_surface_coverage: publicSurfaceCoverageEntries,
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

function writeCleanRunContext(workspace, behaviorSpecs = ['behavior-spec.json']) {
  const context = readJson(CLEAN_CONTEXT_FIXTURE);
  context.clean_artifacts = {
    ...context.clean_artifacts,
    clean_root: './',
    handoff_package: 'handoff-package.json',
    behavior_specs: behaviorSpecs,
    skeleton_manifest: 'skeleton-manifest.json',
    implementation_plan: 'implementation-plan.json',
    implementation_report: 'implementation-report.json',
    qc_report: 'qc-report.json',
  };
  writeJson(path.join(workspace.clean, 'clean-run-context.json'), context);
}

function writeHandoffPackage(workspace, artifactPaths) {
  writeJson(path.join(workspace.clean, 'handoff-package.json'), {
    package_id: 'handoff-test',
    task_id: 'task-example',
    from_domain: 'contaminated',
    to_domain: 'clean',
    created_by_role: 'contaminated-handoff-sanitizer',
    artifacts: artifactPaths.map((artifactPath, index) => ({
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
    unit_id: 'unit-example-flow',
    coverage_state: 'covered',
    evidence_refs: ['evidence-ledger:item-001']
  }],
  behavior_spec_refs: ['spec-example-flow'],
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
  test('dry-run validates nested loop context and selects one unit without writes', () => {
    const workspace = baseWorkspace('clean-room-run-dry');
    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /selected unit-example-flow/);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'controller-run-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(workspace.contaminated, 'clean-room-result.json')), false);
  });

  test('rejects missing preflight goal before run work', () => {
    const workspace = baseWorkspace('clean-room-run-missing-preflight');
    fs.rmSync(path.join(workspace.contaminated, 'preflight-goal.json'));

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal not found/);
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
    assert.match(result.stderr, /coverage-ledger references missing evidence-ledger item/);
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
    assert.ok(captures.length < 27);
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
      assert.equal(item.env.CLEAN_ROOM_ROLE, 'contaminated-manager-verifier');
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
    const script = writeCoveredCoverageScript(workspace.root);
    const config = commandConfig(path.join(workspace.root, 'commands.json'), [
      noOpStage('clean-implement-qc', 'clean-qa-editor', workspace.implementation),
      noOpStage('clean-polish-review', 'clean-polish-reviewer', workspace.implementation),
      coverageStage(workspace.root, script),
    ]);

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--agent-commands', config]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /spec-slice-complete/);
    const runResult = readJson(path.join(workspace.contaminated, 'clean-room-result.json'));
    assert.equal(runResult.result, 'spec-slice-complete');
    assert.equal(runResult.polish_report_ref, 'polish-report.json');
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
