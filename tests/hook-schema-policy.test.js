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

const REPAIR_HINT = 'Fix or update the JSON artifact to satisfy the reported schema errors, then write it again.';

describe('clean-room schema hook policy', () => {
  test('post-write schema hook handles supported payload path variants and fails closed on bad payloads', () => {
    const root = tempDir('clean-room-payloads');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const behavior = copyExample('behavior-spec.json', clean);
    const report = copyExample('qc-report.json', clean);
    const badJson = path.join(clean, 'bad-json.json');

    const validPayloads = [
      { tool_name: 'Write', tool_input: { file_path: behavior } },
      { tool_name: 'Write', tool_input: { cwd: clean, file_path: 'behavior-spec.json' } },
      { tool_name: 'Edit', tool_input: { path: behavior } },
      { tool_name: 'MultiEdit', path: behavior },
      { tool_name: 'Write', tool_input: { outputs: [{ path: behavior }, { file_path: report }] } },
    ];
    for (const payload of validPayloads) {
      const result = runHook('validate-json-schema.py', payload, env);
      assert.equal(result.status, 0, result.stderr);
    }

    let result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { content: '{}' } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not determine the written path/);
    assert.equal(result.stderr.includes(REPAIR_HINT), false);

    result = runHook('validate-json-schema.py', '{', env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed hook JSON payload/);
    assert.equal(result.stderr.includes(REPAIR_HINT), false);

    fs.writeFileSync(badJson, '{\n');
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: badJson } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON parse failed/);
    assert.ok(result.stderr.includes(REPAIR_HINT));
  });

  test('post-write schema hook reports missing and unreadable artifacts without traceback', () => {
    const root = tempDir('clean-room-schema-fs-errors');
    const env = policyEnv(root, 'clean-architect');
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    const missing = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'missing-behavior-spec.json');

    let result = runHook('validate-json-schema.py', {
      tool_name: 'Write',
      tool_input: { file_path: missing },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not read written file/);
    assert.doesNotMatch(result.stderr, /Traceback/);

    fs.chmodSync(behavior, 0o000);
    try {
      result = runHook('validate-json-schema.py', {
        tool_name: 'Write',
        tool_input: { file_path: behavior },
      }, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /JSON artifact could not read/);
      assert.doesNotMatch(result.stderr, /Traceback/);
    } finally {
      fs.chmodSync(behavior, 0o600);
    }
  });

  test('strict post-write wrapper runs the full JSON artifact chain', () => {
    const root = tempDir('clean-room-post-write-chain');
    const env = policyEnv(root, 'clean-architect');
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHookWrapper([
      'require-clean-room-env.py',
      'check-artifact-leakage.py',
      'validate-json-schema.py',
      'validate-handoff-package.py',
    ], {
      tool_name: 'Write',
      tool_input: { file_path: behavior },
    }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('hook payload reader rejects oversized stdin', () => {
    const root = tempDir('clean-room-large-payload');
    const env = policyEnv(root, 'clean-architect');
    const oversized = 'x'.repeat(10 * 1024 * 1024 + 1);

    const result = runHook('validate-json-schema.py', oversized, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hook payload exceeds 10485760 bytes/);
  });

  test('hook path extraction rejects excessive nesting', () => {
    const root = tempDir('clean-room-deep-payload');
    const env = policyEnv(root, 'clean-architect');
    let nested = { file_path: path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'behavior-spec.json') };
    for (let index = 0; index < 50; index += 1) {
      nested = { outputs: [nested] };
    }

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: nested }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path extraction exceeded depth/);
  });

  test('schema hook applies if then else branches', () => {
    const root = tempDir('clean-room-if-then-else');
    const env = policyEnv(root, 'clean-architect');
    const schemaDir = path.join(root, 'schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(path.join(schemaDir, 'task-manifest.schema.json'), JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['then', 'else'] },
        then_value: { type: 'string' },
        else_value: { type: 'string' },
      },
      if: {
        properties: {
          mode: { const: 'then' },
        },
        required: ['mode'],
      },
      then: {
        required: ['then_value'],
      },
      else: {
        required: ['else_value'],
      },
    }));
    const artifact = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'task-manifest.json');
    const schemaEnv = { ...env, CLEAN_ROOM_SCHEMA_DIR: schemaDir };

    fs.writeFileSync(artifact, JSON.stringify({ mode: 'then', then_value: 'ok' }));
    let result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.equal(result.status, 0, result.stderr);

    fs.writeFileSync(artifact, JSON.stringify({ mode: 'then' }));
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required field 'then_value'/);
    assert.ok(result.stderr.includes(REPAIR_HINT));

    fs.writeFileSync(artifact, JSON.stringify({ mode: 'else' }));
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required field 'else_value'/);
  });

  test('schema hook enforces anyOf and oneOf branches', () => {
    const root = tempDir('clean-room-combinators');
    const env = policyEnv(root, 'clean-architect');
    const schemaDir = path.join(root, 'schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(path.join(schemaDir, 'task-manifest.schema.json'), JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        any_value: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'integer', minimum: 1 },
          ],
        },
        one_value: {
          oneOf: [
            { type: 'integer', minimum: 1 },
            { type: 'number', minimum: 1 },
          ],
        },
      },
    }));
    const artifact = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'task-manifest.json');
    const schemaEnv = { ...env, CLEAN_ROOM_SCHEMA_DIR: schemaDir };

    fs.writeFileSync(artifact, JSON.stringify({ any_value: 'ok', one_value: 1.5 }));
    let result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.equal(result.status, 0, result.stderr);

    fs.writeFileSync(artifact, JSON.stringify({ any_value: false }));
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected at least one matching anyOf schema/);

    fs.writeFileSync(artifact, JSON.stringify({ one_value: 1 }));
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one matching oneOf schema/);
  });

  test('schema hook enforces maxLength', () => {
    const root = tempDir('clean-room-max-length');
    const env = policyEnv(root, 'clean-architect');
    const schemaDir = path.join(root, 'schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(path.join(schemaDir, 'task-manifest.schema.json'), JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', maxLength: 4 },
      },
    }));
    const artifact = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'task-manifest.json');
    const schemaEnv = { ...env, CLEAN_ROOM_SCHEMA_DIR: schemaDir };

    fs.writeFileSync(artifact, JSON.stringify({ name: 'short' }));
    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: artifact } }, schemaEnv);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /longer than maxLength 4/);
  });

  test('source-index JSON is rejected under clean roots', () => {
    const root = tempDir('clean-room-source-index-clean');
    const env = policyEnv(root, 'clean-architect');
    const sourceIndex = copyExample('source-index.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: sourceIndex } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source-index\.json is not a clean-role artifact/);
  });

  test('init-config JSON is rejected under clean roots', () => {
    const root = tempDir('clean-room-init-config-clean');
    const env = policyEnv(root, 'clean-architect');
    const initConfig = copyExample('init-config.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: initConfig } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /init-config\.json is not a clean-role artifact/);
  });

  test('preflight-goal JSON is rejected under clean roots', () => {
    const root = tempDir('clean-room-preflight-goal-clean');
    const env = policyEnv(root, 'clean-architect');
    const preflightGoal = copyExample('preflight-goal.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: preflightGoal } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight-goal\.json is not a clean-role artifact/);
  });

  test('controller-status JSON is rejected under clean roots', () => {
    const root = tempDir('clean-room-controller-status-clean');
    const env = policyEnv(root, 'clean-architect');
    const status = copyExample('controller-status.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: status } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /controller-status\.json is not a clean-role artifact/);
  });

  test('schema hook does not infer task manifest from arbitrary task_id JSON', () => {
    const root = tempDir('clean-room-task-id-fallback');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const arbitrary = path.join(clean, 'notes.json');
    fs.writeFileSync(arbitrary, JSON.stringify({ task_id: 'task-test', notes: 'not a manifest' }));

    let result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: arbitrary } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized clean JSON artifact/);

    const taskManifest = copyExample('task-manifest.json', clean);
    result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: taskManifest } }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('clean-run-context rejects unsafe clean artifact paths', () => {
    const root = tempDir('clean-room-context-paths');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const cases = [
      {
        name: 'absolute-source-path',
        mutate(data) {
          data.clean_artifacts.behavior_specs[0] = path.join(env.CLEAN_ROOM_SOURCE_ROOTS, 'secret.json');
        },
        message: /path must be relative/,
      },
      {
        name: 'home-expansion',
        mutate(data) {
          data.clean_artifacts.handoff_package = '~/handoff-package.json';
        },
        message: /must not use home expansion/,
      },
      {
        name: 'parent-directory',
        mutate(data) {
          data.clean_artifacts.qc_report = '../contaminated/qc-report.json';
        },
        message: /must not contain '\.\.'/,
      },
      {
        name: 'forbidden-artifact',
        mutate(data) {
          data.clean_artifacts.skeleton_manifest = 'nested/init-config.json';
        },
        message: /forbidden clean-run-context artifact path/,
      },
    ];

    for (const item of cases) {
      const context = copyExample('clean-run-context.json', clean);
      const data = JSON.parse(fs.readFileSync(context, 'utf8'));
      item.mutate(data);
      fs.writeFileSync(context, JSON.stringify(data));
      const result = runHook('validate-json-schema.py', {
        tool_name: 'Write',
        tool_input: { file_path: context },
      }, env);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.message, item.name);
    }
  });

  test('clean-run-context rejects paths that resolve into blocked roots', () => {
    const root = tempDir('clean-room-context-root-overlap');
    const env = policyEnv(root, 'clean-architect');
    const context = copyExample('clean-run-context.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', {
      tool_name: 'Write',
      tool_input: { file_path: context },
    }, {
      ...env,
      CLEAN_ROOM_CLEAN_ROOTS: env.CLEAN_ROOM_SOURCE_ROOTS,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resolves into a source or contaminated root/);
  });

  test('clean role-session-brief rejects unsafe artifact paths', () => {
    const root = tempDir('clean-room-brief-paths');
    const env = policyEnv(root, 'clean-architect');
    const brief = copyExample('role-session-brief.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    const data = JSON.parse(fs.readFileSync(brief, 'utf8'));
    data.allowed_artifacts[0].path = '../contaminated/source-index.json';
    fs.writeFileSync(brief, JSON.stringify(data));

    const result = runHook('validate-json-schema.py', {
      tool_name: 'Write',
      tool_input: { file_path: brief },
    }, env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /role-session-brief artifact path must not contain '\.\.'/);
  });

  test('handoff integrity verifies referenced artifact path and sha256', () => {
    const root = tempDir('clean-room-handoff');
    const env = policyEnv(root, 'clean-architect');
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    const handoff = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'handoff-package.json');
    fs.writeFileSync(handoff, JSON.stringify({
      package_id: 'package-test',
      task_id: 'task-test',
      from_domain: 'contaminated',
      to_domain: 'clean',
      created_by_role: 'contaminated-handoff-sanitizer',
      artifacts: [
        {
          artifact_id: 'spec-example-flow',
          artifact_type: 'behavior-spec',
          path: 'behavior-spec.json',
          sha256: sha256(behavior),
        },
      ],
      excluded_material: ['source_excerpt'],
      leakage_review: {
        status: 'passed',
        reviewer_role: 'contaminated-handoff-sanitizer',
        notes: 'fixture',
      },
    }));

    let result = runHook('validate-handoff-package.py', { tool_name: 'Write', tool_input: { file_path: handoff } }, env);
    assert.equal(result.status, 0, result.stderr);

    const packageData = JSON.parse(fs.readFileSync(handoff, 'utf8'));
    packageData.artifacts[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(handoff, JSON.stringify(packageData));
    result = runHook('validate-handoff-package.py', { tool_name: 'Write', tool_input: { file_path: handoff } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256 mismatch/);

    delete packageData.artifacts[0].sha256;
    fs.writeFileSync(handoff, JSON.stringify(packageData));
    result = runHook('validate-handoff-package.py', { tool_name: 'Write', tool_input: { file_path: handoff } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact sha256 must be a 64-character hex string/);

    const taskManifest = copyExample('task-manifest.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    fs.writeFileSync(handoff, JSON.stringify({
      package_id: 'package-test',
      task_id: 'task-test',
      from_domain: 'contaminated',
      to_domain: 'clean',
      created_by_role: 'contaminated-handoff-sanitizer',
      artifacts: [
        {
          artifact_id: 'task-manifest',
          artifact_type: 'task-manifest',
          path: 'task-manifest.json',
          sha256: sha256(taskManifest),
        },
      ],
      excluded_material: ['source_excerpt'],
      leakage_review: {
        status: 'passed',
        reviewer_role: 'contaminated-handoff-sanitizer',
        notes: 'fixture',
      },
    }));
    result = runHook('validate-handoff-package.py', { tool_name: 'Write', tool_input: { file_path: handoff } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task-manifest\.json must not be included/);
  });

  test('handoff integrity reports unreadable referenced artifacts without traceback', () => {
    const root = tempDir('clean-room-handoff-unreadable');
    const env = policyEnv(root, 'clean-architect');
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    const handoff = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'handoff-package.json');
    const digest = sha256(behavior);
    fs.writeFileSync(handoff, JSON.stringify({
      package_id: 'package-test',
      task_id: 'task-test',
      from_domain: 'contaminated',
      to_domain: 'clean',
      created_by_role: 'contaminated-handoff-sanitizer',
      artifacts: [
        {
          artifact_id: 'spec-example-flow',
          artifact_type: 'behavior-spec',
          path: 'behavior-spec.json',
          sha256: digest,
        },
      ],
      excluded_material: ['source_excerpt'],
      leakage_review: {
        status: 'passed',
        reviewer_role: 'contaminated-handoff-sanitizer',
        notes: 'fixture',
      },
    }));

    fs.chmodSync(behavior, 0o000);
    try {
      const result = runHook('validate-handoff-package.py', {
        tool_name: 'Write',
        tool_input: { file_path: handoff },
      }, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /referenced artifact could not be hashed/);
      assert.doesNotMatch(result.stderr, /Traceback/);
    } finally {
      fs.chmodSync(behavior, 0o600);
    }
  });

  test('handoff package schema rejects analyst self-approval', () => {
    const root = tempDir('clean-room-handoff-self-approval');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const handoff = copyExample('handoff-package.json', clean);
    const baseData = JSON.parse(fs.readFileSync(handoff, 'utf8'));
    const cases = [
      {
        name: 'created-by-analyst',
        mutate(data) {
          data.created_by_role = 'contaminated-source-analyst';
        },
      },
      {
        name: 'reviewer-is-analyst',
        mutate(data) {
          data.leakage_review.reviewer_role = 'contaminated-source-analyst';
        },
      },
    ];

    for (const item of cases) {
      const data = JSON.parse(JSON.stringify(baseData));
      item.mutate(data);
      fs.writeFileSync(handoff, JSON.stringify(data));
      const result = runHook('validate-json-schema.py', {
        tool_name: 'Write',
        tool_input: { file_path: handoff },
      }, env);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, /expected const 'contaminated-handoff-sanitizer'/, item.name);
    }
  });

  test('schema hook accepts sanitizer role in manifest, behavior spec, handoff, and incident artifacts', () => {
    const root = tempDir('clean-room-sanitizer-schema');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const artifacts = [
      copyExample('task-manifest.json', clean),
      copyExample('clean-run-context.json', clean),
      copyExample('behavior-spec.json', clean),
      copyExample('handoff-package.json', clean),
      copyExample('contamination-incident.json', clean),
    ];

    const incidentPath = path.join(clean, 'contamination-incident.json');
    const incident = JSON.parse(fs.readFileSync(incidentPath, 'utf8'));
    incident.reported_by_role = 'contaminated-handoff-sanitizer';
    fs.writeFileSync(incidentPath, JSON.stringify(incident));

    for (const artifact of artifacts) {
      const result = runHook('validate-json-schema.py', {
        tool_name: 'Write',
        tool_input: { file_path: artifact },
      }, env);
      assert.equal(result.status, 0, `${artifact}\n${result.stderr}`);
    }
  });
});
