'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks');
const EXAMPLES = path.join(ROOT, 'skills', 'clean-room', 'examples', 'minimal-spec-package');
const SCHEMA_DIR = path.join(ROOT, 'skills', 'clean-room', 'assets');
const SOURCE_INDEX = path.join(ROOT, 'skills', 'clean-room', 'scripts', 'build_source_index.py');
const TOOL_MANAGER = path.join(ROOT, 'skills', 'clean-room', 'scripts', 'clean_room_tool_manager.py');
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

function policyEnv(root, role) {
  assert.equal(typeof role, 'string');
  const source = path.join(root, 'source');
  const contaminated = path.join(root, 'contaminated');
  const clean = path.join(root, 'clean');
  const allowed = path.join(root, 'allowed');
  mkdirs(source, contaminated, clean, allowed);
  return {
    CLEAN_ROOM_ROLE: role,
    CLEAN_ROOM_SOURCE_ROOTS: source,
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
    CLEAN_ROOM_CLEAN_ROOTS: clean,
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

function copyExample(name, targetDir) {
  const target = path.join(targetDir, name);
  fs.copyFileSync(path.join(EXAMPLES, name), target);
  return target;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeProbeTool(dir, name) {
  const toolPath = path.join(dir, name);
  const marker = path.join(dir, `${name}.ran`);
  fs.writeFileSync(toolPath, `#!/bin/sh\nprintf probe > ${shellQuote(marker)}\necho ${name} 1.0\n`);
  fs.chmodSync(toolPath, 0o755);
  return { toolPath, marker };
}

describe('clean-room hook policy', () => {
  test('environment preflight rejects overlapping clean-room roots', () => {
    const root = tempDir('clean-room-overlap');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    const allowed = path.join(root, 'allowed');
    mkdirs(source, path.join(source, 'clean'), contaminated, allowed);

    const result = spawnSync('python3', [path.join(HOOKS, 'require-clean-room-env.py')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLEAN_ROOM_ROLE: 'clean-architect',
        CLEAN_ROOM_SOURCE_ROOTS: source,
        CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
        CLEAN_ROOM_CLEAN_ROOTS: path.join(source, 'clean'),
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
    const allowed = path.join(root, 'allowed');
    const schemaDir = path.join(clean, 'schemas');
    mkdirs(source, contaminated, schemaDir, allowed);

    const result = spawnSync('python3', [path.join(HOOKS, 'require-clean-room-env.py')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLEAN_ROOM_ROLE: 'clean-architect',
        CLEAN_ROOM_SOURCE_ROOTS: source,
        CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
        CLEAN_ROOM_CLEAN_ROOTS: clean,
        CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
        CLEAN_ROOM_SCHEMA_DIR: schemaDir,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema directory must be separate from clean roots/);
  });

  test('shell policy directly blocks clean-room role sessions', () => {
    const root = tempDir('clean-room-shell-deny');
    const env = policyEnv(root, 'clean-architect');

    const result = runHook('deny-clean-room-shell.py', {}, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /denied shell tool use/);

    const sanitizerResult = runHook('deny-clean-room-shell.py', {}, {
      ...env,
      CLEAN_ROOM_ROLE: 'contaminated-handoff-sanitizer',
    });
    assert.notEqual(sanitizerResult.status, 0);
    assert.match(sanitizerResult.stderr, /denied shell tool use/);
  });

  test('post-write schema hook handles supported payload path variants and fails closed on bad payloads', () => {
    const root = tempDir('clean-room-payloads');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const behavior = copyExample('behavior-spec.json', clean);
    const report = copyExample('qc-report.json', clean);

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

    result = runHook('validate-json-schema.py', '{', env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed hook JSON payload/);
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

  test('read policy resolves relative payload paths against tool cwd', () => {
    const root = tempDir('clean-room-read-cwd');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    copyExample('qc-report.json', clean);
    fs.writeFileSync(path.join(source, 'secret.py'), 'VALUE = 1\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { cwd: clean, file_path: 'qc-report.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { cwd: clean, file_path: '../source/secret.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Glob',
      tool_input: { cwd: clean, glob: '../source/*.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Glob',
      tool_input: { cwd: clean, pattern: '*.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { cwd: clean },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read with no resolved path/);
  });

  test('clean roles may read schema roots but not source or contaminated roots', () => {
    const root = tempDir('clean-room-schema-read');
    const env = policyEnv(root, 'clean-qa-editor');
    const schema = path.join(SCHEMA_DIR, 'behavior-spec.schema.json');
    const sourceFile = path.join(env.CLEAN_ROOM_SOURCE_ROOTS, 'secret.py');
    const contaminatedFile = path.join(env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS, 'coverage-ledger.json');
    fs.writeFileSync(sourceFile, 'VALUE = 1\n');
    fs.writeFileSync(contaminatedFile, '{}\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: schema },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: sourceFile },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: contaminatedFile },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed roots/);
  });

  test('source-denied sanitizer can read staged artifacts but not source, clean, or source-index files', () => {
    const root = tempDir('clean-room-sanitizer-read');
    const env = policyEnv(root, 'contaminated-handoff-sanitizer');
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    const allowed = env.CLEAN_ROOM_ALLOWED_READ_ROOTS;
    fs.writeFileSync(path.join(contaminated, 'behavior-spec.json'), '{}');
    fs.writeFileSync(path.join(contaminated, 'source-index.json'), '{}');
    fs.writeFileSync(path.join(source, 'secret.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(clean, 'handoff-package.json'), '{}');
    fs.writeFileSync(path.join(allowed, 'public.md'), '# Public reference\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { cwd: contaminated, file_path: 'behavior-spec.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(SCHEMA_DIR, 'behavior-spec.schema.json') },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(allowed, 'public.md') },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(source, 'secret.py') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(clean, 'handoff-package.json') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading clean path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(contaminated, 'source-index.json') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source-index artifact/);
  });

  test('write policy resolves relative payload paths against tool cwd', () => {
    const root = tempDir('clean-room-write-cwd');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    fs.writeFileSync(path.join(source, 'secret.py'), 'VALUE = 1\n');

    let result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: clean, file_path: 'qc-report.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: clean },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /write with no resolved path/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: clean, file_path: '../source/secret.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing source path/);

    const contaminatedEnv = { ...env, CLEAN_ROOM_ROLE: 'contaminated-source-analyst' };
    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: contaminated, file_path: 'source-index.json' },
    }, contaminatedEnv);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: contaminated, file_path: '../clean/qc-report.json' },
    }, contaminatedEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing clean path/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'NotebookEdit',
      tool_input: { content: 'no file path in this payload' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /write with no resolved path/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'FutureWriteTool',
      tool_input: { content: 'no file path in this payload' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /write with no resolved path/);
  });

  test('sanitizer writes only under contaminated artifact roots', () => {
    const root = tempDir('clean-room-sanitizer-write');
    const env = policyEnv(root, 'contaminated-handoff-sanitizer');
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;

    let result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: contaminated, file_path: 'sanitized-behavior-spec.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: contaminated, file_path: '../clean/handoff-package.json' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing clean path/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(clean, 'handoff-package.json') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing clean path/);
  });

  test('clean-root JSON artifacts must be recognized or explicitly allowlisted', () => {
    const root = tempDir('clean-room-unknown-json');
    const env = policyEnv(root, 'clean-architect');
    const unknown = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'behavior_specs.json');
    fs.writeFileSync(unknown, JSON.stringify({ note: 'not a canonical artifact' }));

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: unknown } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized clean JSON artifact/);
  });

  test('auxiliary JSON allowlist entries must stay under clean roots', () => {
    const root = tempDir('clean-room-aux-allowlist');
    const env = policyEnv(root, 'clean-architect');
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ note: 'outside clean root' }));

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: outside } }, {
      ...env,
      CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST: outside,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST path is outside CLEAN_ROOM_CLEAN_ROOTS/);
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

  test('source-index builder refuses output outside contaminated artifact roots', () => {
    const root = tempDir('clean-room-source-index-output');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    const outside = path.join(root, 'clean', 'source-index.json');
    mkdirs(source, contaminated, path.dirname(outside));
    fs.writeFileSync(path.join(source, 'example.py'), 'VALUE = 1\n');

    const result = spawnSync('python3', [
      SOURCE_INDEX,
      '--source-root', source,
      '--output', outside,
      '--task-id', 'task-test',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      env: { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--output must be under a contaminated artifact root/);
    assert.equal(fs.existsSync(outside), false);
  });

  test('source-index builder rejects overlapping roots and output under source roots', () => {
    const root = tempDir('clean-room-source-index-overlap');
    const source = path.join(root, 'source');
    const nested = path.join(source, 'nested');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(nested, contaminated);
    fs.writeFileSync(path.join(source, 'example.py'), 'VALUE = 1\n');

    const cases = [
      {
        name: 'source-under-contaminated',
        sourceRoots: [path.join(contaminated, 'source')],
        contaminatedRoot: contaminated,
        output: path.join(contaminated, 'source-index.json'),
        message: /source roots and contaminated artifact roots must be separate/,
      },
      {
        name: 'contaminated-under-source',
        sourceRoots: [source],
        contaminatedRoot: path.join(source, 'contaminated'),
        output: path.join(source, 'contaminated', 'source-index.json'),
        message: /--output must not be under a source root/,
      },
      {
        name: 'nested-source-roots',
        sourceRoots: [source, nested],
        contaminatedRoot: contaminated,
        output: path.join(contaminated, 'source-index.json'),
        message: /source roots must not overlap/,
      },
      {
        name: 'output-under-source',
        sourceRoots: [source],
        contaminatedRoot: source,
        output: path.join(source, 'source-index.json'),
        message: /--output must not be under a source root/,
      },
    ];

    for (const item of cases) {
      for (const sourceRoot of item.sourceRoots) {
        mkdirs(sourceRoot);
      }
      mkdirs(item.contaminatedRoot);
      const args = [
        SOURCE_INDEX,
        '--output', item.output,
        '--contaminated-artifact-root', item.contaminatedRoot,
        '--task-id', `task-${item.name}`,
        '--skip-tool-detection',
      ];
      for (const sourceRoot of item.sourceRoots) {
        args.push('--source-root', sourceRoot);
      }
      const result = spawnSync('python3', args, {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.message, item.name);
      assert.equal(fs.existsSync(item.output), false, item.name);
    }
  });

  test('source-index resolves package-relative Python imports to the package base', () => {
    const root = tempDir('clean-room-python-relative-import');
    const source = path.join(root, 'source');
    const packageDir = path.join(source, 'pkg');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(packageDir, contaminated);
    fs.writeFileSync(path.join(packageDir, '__init__.py'), '');
    fs.writeFileSync(path.join(packageDir, 'foo.py'), '');
    fs.writeFileSync(path.join(packageDir, 'bar.py'), '');
    fs.writeFileSync(path.join(packageDir, 'main.py'), 'from . import foo, bar\n');
    const output = path.join(contaminated, 'source-index.json');

    const result = spawnSync('python3', [
      SOURCE_INDEX,
      '--source-root', source,
      '--output', output,
      '--task-id', 'task-test',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      env: { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(fs.readFileSync(output, 'utf8'));
    const files = new Map(index.files.map((file) => [file.file_id, file.path]));
    const relationship = index.relationships.find((item) => item.specifier === '.');
    assert.equal(files.get(relationship.to_file_id), 'pkg/__init__.py');
  });

  test('source-index C# scanner ignores local constructor calls', () => {
    const root = tempDir('clean-room-csharp-scanner');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(source, contaminated);
    fs.writeFileSync(path.join(source, 'Example.cs'), [
      'class Example {',
      '  void Helper() {',
      '    new Foo();',
      '  }',
      '  public void RealMethod() {',
      '  }',
      '}',
      '',
    ].join('\n'));
    const output = path.join(contaminated, 'source-index.json');

    const result = spawnSync('python3', [
      SOURCE_INDEX,
      '--source-root', source,
      '--output', output,
      '--task-id', 'task-test',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      env: { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(fs.readFileSync(output, 'utf8'));
    const names = index.files.flatMap((file) => file.exports.map((item) => item.name));
    assert.equal(names.includes('RealMethod'), true);
    assert.equal(names.includes('Foo'), false);
  });

  test('tool status and source-index dependency reports do not execute tools by default', () => {
    const root = tempDir('clean-room-tool-probe');
    const { toolPath, marker } = writeProbeTool(root, 'ast-grep');
    const env = { ...process.env, AST_GREP_BIN: toolPath };

    let result = spawnSync('python3', [TOOL_MANAGER, '--status'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.match(result.stdout, /stat-only/);
    assert.match(result.stdout, /not probed/);

    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(source, contaminated);
    fs.writeFileSync(path.join(source, 'example.py'), 'VALUE = 1\n');
    result = spawnSync('python3', [
      SOURCE_INDEX,
      '--source-root', source,
      '--output', path.join(contaminated, 'source-index.json'),
      '--task-id', 'task-test',
    ], {
      cwd: ROOT,
      env: { ...env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
  });

  test('leakage scanner catches private denylist terms in path-like and free-text fields', () => {
    const root = tempDir('clean-room-leakage-keys');
    const env = policyEnv(root, 'clean-architect');
    const denylist = path.join(root, 'private-identifiers.txt');
    fs.writeFileSync(denylist, 'private.module.secret\n');

    const cases = [
      { name: 'artifact-paths', data: { artifact_paths: { clean_artifacts: 'private.module.secret/specs' } } },
      { name: 'native-artifacts', data: { format_selection: { native_artifacts: ['private.module.secret/spec.md'] } } },
      { name: 'expected-artifacts', data: { expected_artifacts: ['private.module.secret/spec.md'] } },
      { name: 'open-questions', data: { open_questions: ['Does private.module.secret retry after failure?'] } },
      { name: 'qc-findings', data: { findings: [{ summary: 'private.module.secret leaked into the report' }] } },
    ];

    for (const item of cases) {
      const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, `${item.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(item.data));
      const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, {
        ...env,
        CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST: denylist,
      });
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, /private_identifier_denylist/);
    }
  });

  test('leakage scanner keeps path fields denylist-only to avoid path-shaped false positives', () => {
    const root = tempDir('clean-room-leakage-negative');
    const env = policyEnv(root, 'clean-architect');
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'path-field.json');
    fs.writeFileSync(filePath, JSON.stringify({ path: 'specs/com.example.product/spec.md' }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('sanitizer staged artifacts are leakage-scanned while analyst drafts are not', () => {
    const root = tempDir('clean-room-sanitizer-leakage');
    const env = policyEnv(root, 'contaminated-handoff-sanitizer');
    const filePath = path.join(env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS, 'behavior-spec.json');
    fs.writeFileSync(filePath, JSON.stringify({
      summary: 'Call private.module.name.doThing() after setup.',
    }));

    let result = runHook('check-artifact-leakage.py', {
      tool_name: 'Write',
      tool_input: { file_path: filePath },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package_or_module_identifier|source_like_call|source_like_scoped_identifier/);

    result = runHook('check-artifact-leakage.py', {
      tool_name: 'Write',
      tool_input: { file_path: filePath },
    }, {
      ...env,
      CLEAN_ROOM_ROLE: 'contaminated-source-analyst',
    });
    assert.equal(result.status, 0, result.stderr);
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

  test('leakage scanner uses only the leaf key for denylist-only string classification', () => {
    const root = tempDir('clean-room-leakage-leaf-key');
    const env = policyEnv(root, 'clean-architect');
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'nested-artifact-summary.json');
    fs.writeFileSync(filePath, JSON.stringify({
      artifacts: [
        {
          summary: 'Call private.module.name.doThing() after setup.',
        },
      ],
    }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package_or_module_identifier|source_like_call|source_like_scoped_identifier/);
  });
});
