'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  AGENT3_RUNNER,
  assertNoPrivateLeak,
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
} = require('./helpers/hook-policy.cjs');

describe('clean-room environment hook policy', () => {
  test('environment preflight rejects overlapping clean-room roots', () => {
    const root = tempDir('clean-room-overlap');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    const implementation = path.join(root, 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, path.join(source, 'clean'), contaminated, implementation, allowed);

    const result = spawnSync('python3', [path.join(HOOKS, 'require-clean-room-env.py')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLEAN_ROOM_ROLE: 'clean-architect',
        CLEAN_ROOM_SOURCE_ROOTS: source,
        CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
        CLEAN_ROOM_CLEAN_ROOTS: path.join(source, 'clean'),
        CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
        CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
        CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source roots and clean roots must be separate/);
  });

  test('environment preflight rejects schema directory overlap with role roots', () => {
    const root = tempDir('clean-room-schema-overlap');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    const clean = path.join(root, 'clean');
    const implementation = path.join(root, 'implementation');
    const allowed = path.join(root, 'allowed');
    const schemaDir = path.join(clean, 'schemas');
    mkdirs(source, contaminated, schemaDir, implementation, allowed);

    const result = spawnSync('python3', [path.join(HOOKS, 'require-clean-room-env.py')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLEAN_ROOM_ROLE: 'clean-architect',
        CLEAN_ROOM_SOURCE_ROOTS: source,
        CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
        CLEAN_ROOM_CLEAN_ROOTS: clean,
        CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
        CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
        CLEAN_ROOM_SCHEMA_DIR: schemaDir,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema directory must be separate from clean roots/);
  });

  test('environment preflight rejects clean root named after source project basename without echoing it', () => {
    const root = tempDir('clean-room-path-basename');
    const source = path.join(root, 'projects', 'private-payments-processor');
    const contaminated = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'contaminated');
    const clean = path.join(root, 'Documents', 'CleanRoom', 'private-payments-processor', 'clean');
    const implementation = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'clean-architect',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_CLEAN_ROOTS path appears source-derived/);
    assert.doesNotMatch(result.stderr, /private-payments-processor/);
    assert.doesNotMatch(result.stderr, /payments/);
  });

  test('environment preflight rejects contaminated artifact root containing source name token', () => {
    const root = tempDir('clean-room-path-token');
    const source = path.join(root, 'projects', 'private-payments-processor');
    const contaminated = path.join(root, 'Documents', 'CleanRoom', 'task-payments-artifacts');
    const clean = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'clean');
    const implementation = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'contaminated-manager-verifier',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS path appears source-derived/);
  });

  test('environment preflight allows neutral task id roots', () => {
    const root = tempDir('clean-room-path-neutral');
    const source = path.join(root, 'projects', 'private-payments-processor');
    const contaminated = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'contaminated');
    const clean = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'clean');
    const implementation = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'clean-architect',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.equal(result.status, 0, result.stderr);
  });

  test('environment preflight allows collisions on filtered generic source tokens', () => {
    const root = tempDir('clean-room-path-generic');
    const source = path.join(root, 'projects', 'src-app-test');
    const contaminated = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'src');
    const clean = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'app-test');
    const implementation = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'clean-architect',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.equal(result.status, 0, result.stderr);
  });

  test('environment preflight rejects overlapping implementation roots', () => {
    const root = tempDir('clean-room-implementation-overlap');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    const clean = path.join(root, 'clean');
    const implementation = path.join(clean, 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'clean-qa-editor',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean roots and implementation roots must be separate/);
  });

  test('environment preflight rejects source-derived implementation root names', () => {
    const root = tempDir('clean-room-implementation-source-name');
    const source = path.join(root, 'projects', 'private-payments-processor');
    const contaminated = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'contaminated');
    const clean = path.join(root, 'Documents', 'CleanRoom', 'task-8af2', 'clean');
    const implementation = path.join(root, 'Documents', 'CleanRoom', 'task-payments-implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);

    const result = runEnvCheck({
      CLEAN_ROOM_ROLE: 'clean-qa-editor',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_IMPLEMENTATION_ROOTS path appears source-derived/);
    assert.doesNotMatch(result.stderr, /private-payments-processor/);
    assert.doesNotMatch(result.stderr, /payments/);
  });

  test('hook denial stderr redacts private paths across policy hooks', () => {
    const root = tempDir('clean-room-redaction');
    const source = path.join(root, 'projects', 'private-payments-processor');
    const contaminated = path.join(root, 'evidence', 'private-payments-processor-contaminated');
    const clean = path.join(root, 'CleanRoom', 'task-8af2', 'clean');
    const implementation = path.join(root, 'CleanRoom', 'task-8af2', 'implementation');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, contaminated, clean, implementation, allowed);
    const env = {
      CLEAN_ROOM_ROLE: 'clean-architect',
      CLEAN_ROOM_SOURCE_ROOTS: source,
      CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
      CLEAN_ROOM_CLEAN_ROOTS: clean,
      CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
      CLEAN_ROOM_SCHEMA_DIR: SCHEMA_DIR,
    };
    const sourceFile = path.join(source, 'secret.json');
    fs.writeFileSync(sourceFile, '{\n');
    const sensitiveValues = [source, contaminated, sourceFile];

    const overlapEnv = {
      ...env,
      CLEAN_ROOM_CLEAN_ROOTS: path.join(source, 'clean'),
    };
    mkdirs(overlapEnv.CLEAN_ROOM_CLEAN_ROOTS);
    let result = runEnvCheck(overlapEnv);
    assert.notEqual(result.status, 0);
    assertNoPrivateLeak(result.stderr, sensitiveValues);

    const checks = [
      {
        script: 'deny-clean-source-read.py',
        payload: { tool_name: 'Read', tool_input: { file_path: sourceFile } },
      },
      {
        script: 'deny-contaminated-clean-write.py',
        payload: { tool_name: 'Write', tool_input: { file_path: sourceFile } },
      },
      {
        script: 'validate-json-schema.py',
        payload: { tool_name: 'Write', tool_input: { file_path: sourceFile } },
      },
    ];
    for (const item of checks) {
      result = runHook(item.script, item.payload, env);
      assert.notEqual(result.status, 0, item.script);
      assertNoPrivateLeak(result.stderr, sensitiveValues);
    }

    const handoff = path.join(clean, 'handoff-package.json');
    fs.writeFileSync(handoff, JSON.stringify({
      package_id: 'package-test',
      task_id: 'task-test',
      from_domain: 'contaminated',
      to_domain: 'clean',
      created_by_role: 'contaminated-handoff-sanitizer',
      artifacts: [
        {
          artifact_id: 'spec-test',
          artifact_type: 'behavior-spec',
          path: sourceFile,
          sha256: '0'.repeat(64),
        },
      ],
      excluded_material: ['source_excerpt'],
      leakage_review: {
        status: 'passed',
        reviewer_role: 'contaminated-handoff-sanitizer',
        notes: 'fixture',
      },
    }));
    result = runHook('validate-handoff-package.py', {
      tool_name: 'Write',
      tool_input: { file_path: handoff },
    }, env);
    assert.notEqual(result.status, 0);
    assertNoPrivateLeak(result.stderr, sensitiveValues);

    const behavior = copyExample('behavior-spec.json', clean);
    result = runHook('check-artifact-leakage.py', {
      tool_name: 'Write',
      tool_input: { file_path: behavior },
    }, {
      ...env,
      CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST: path.join(source, 'denylist.txt'),
    });
    assert.notEqual(result.status, 0);
    assertNoPrivateLeak(result.stderr, sensitiveValues);
  });
});
