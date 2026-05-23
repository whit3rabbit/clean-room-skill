'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'hooks');
const CLEAN_EXAMPLES = path.join(ROOT, 'skills', 'clean-room', 'examples', 'minimal-spec-package');
const CONTAMINATED_EXAMPLES = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side');
const SCHEMA_DIR = path.join(ROOT, 'skills', 'clean-room', 'assets');
const SOURCE_INDEX = path.join(ROOT, 'skills', 'clean-room', 'scripts', 'build_source_index.py');
const TOOL_MANAGER = path.join(ROOT, 'skills', 'clean-room', 'scripts', 'clean_room_tool_manager.py');
const AGENT3_RUNNER = path.join(HOOKS, 'agent3-verification-runner.py');
const AGENT4_RUNNER = path.join(HOOKS, 'agent4-polish-runner.py');
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

function policyEnv(root, role) {
  assert.equal(typeof role, 'string');
  const source = path.join(root, 'source');
  const contaminated = path.join(root, 'contaminated');
  const clean = path.join(root, 'clean');
  const implementation = path.join(root, 'implementation');
  const allowed = path.join(root, 'allowed');
  mkdirs(source, contaminated, clean, implementation, allowed);
  return {
    CLEAN_ROOM_ROLE: role,
    CLEAN_ROOM_SOURCE_ROOTS: source,
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
    CLEAN_ROOM_CLEAN_ROOTS: clean,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
    CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
    CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
  };
}

function runHook(script, payload, env) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync('python3', [path.join(HOOKS, script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

function runEnvCheck(env) {
  return spawnSync('python3', [path.join(HOOKS, 'require-clean-room-env.py')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runHookWrapper(checks, payload, env) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync('python3', [
    path.join(HOOKS, 'clean-room-hook.py'),
    '--mode',
    'strict',
    ...checks.flatMap((check) => ['--check', check]),
  ], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

function copyExample(name, targetDir) {
  const target = path.join(targetDir, name);
  for (const sourceDir of [CLEAN_EXAMPLES, CONTAMINATED_EXAMPLES]) {
    const source = path.join(sourceDir, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      return target;
    }
  }
  throw new Error(`missing example fixture: ${name}`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoPrivateLeak(stderr, values) {
  for (const value of values) {
    assert.doesNotMatch(stderr, new RegExp(escapeRegex(value)));
  }
  assert.doesNotMatch(stderr, /private-payments-processor/);
  assert.doesNotMatch(stderr, /payments/);
  assert.doesNotMatch(stderr, /processor/);
}

function writeProbeTool(dir, name) {
  const toolPath = path.join(dir, name);
  const marker = path.join(dir, `${name}.ran`);
  fs.writeFileSync(toolPath, `#!/bin/sh\nprintf probe > ${shellQuote(marker)}\necho ${name} 1.0\n`);
  fs.chmodSync(toolPath, 0o755);
  return { toolPath, marker };
}

function writeImplementationPlan(cleanRoot, command, commandExtra = {}) {
  const planPath = path.join(cleanRoot, 'implementation-plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    plan_id: 'plan-test',
    task_id: 'task-test',
    planner_role: 'clean-architect',
    created_at: '2024-01-01T00:00:00Z',
    target_profile: 'speckit-feature-folder',
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
        work_item_id: 'work-test',
        status: 'planned',
        summary: 'Test verification work item.',
        spec_ids: ['spec-test'],
        architecture_area_refs: ['area-test'],
        implementation_root_ref: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        target_paths: ['src/test.js'],
        test_paths: ['test/test.js'],
        acceptance_criteria: ['Test command runs.'],
      },
    ],
    planned_refactors: [],
    verification_strategy: [
      {
        command,
        cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        purpose: 'test',
        ...commandExtra,
      },
    ],
    implementation_forbidden_material: ['source_excerpt'],
    open_decisions: [],
  }));
  return planPath;
}

module.exports = {
  AGENT3_RUNNER,
  AGENT4_RUNNER,
  assertNoPrivateLeak,
  CLEAN_EXAMPLES,
  CONTAMINATED_EXAMPLES,
  copyExample,
  HOOKS,
  mkdirs,
  policyEnv,
  ROOT,
  runEnvCheck,
  runHook,
  runHookWrapper,
  SCHEMA_DIR,
  sha256,
  shellQuote,
  SOURCE_INDEX,
  tempDir,
  TOOL_MANAGER,
  writeImplementationPlan,
  writeProbeTool,
};
