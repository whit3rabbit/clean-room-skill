'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const TASK_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'task-manifest.json');
const PREFLIGHT_FIXTURE = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json');
const TMP_DIRS = [];

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
  writeJson(path.join(contaminated, 'coverage-ledger.json'), {
    ledger_id: 'coverage-test',
    task_id: 'task-example',
    updated_by_role: 'contaminated-manager-verifier',
    source_units: [
      {
        unit_id: 'unit-example-flow',
        coverage_state: coverageState,
        evidence_refs: [],
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

  test('rejects mismatched preflight goal hash', () => {
    const workspace = baseWorkspace('clean-room-run-preflight-hash');
    fs.writeFileSync(path.join(workspace.contaminated, 'preflight-goal.json'), '{"goal_id":"changed"}\n');

    const result = runCli(['run', '--task-manifest', workspace.manifestPath, '--dry-run']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal sha256 mismatch/);
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
    const captures = readJsonLines(capturePath);
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
    ]);
    assert.equal(JSON.stringify(runResult).includes('src/'), false);
  });
});
