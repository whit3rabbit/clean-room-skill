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

function policyEnv(root) {
  const source = path.join(root, 'source');
  const contaminated = path.join(root, 'contaminated');
  const clean = path.join(root, 'clean');
  const allowed = path.join(root, 'allowed');
  mkdirs(source, contaminated, clean, allowed);
  return {
    CLEAN_ROOM_ROLE: 'clean-architect',
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

  test('post-write schema hook handles supported payload path variants and fails closed on bad payloads', () => {
    const root = tempDir('clean-room-payloads');
    const env = policyEnv(root);
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

  test('read policy resolves relative payload paths against tool cwd', () => {
    const root = tempDir('clean-room-read-cwd');
    const env = policyEnv(root);
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
  });

  test('write policy resolves relative payload paths against tool cwd', () => {
    const root = tempDir('clean-room-write-cwd');
    const env = policyEnv(root);
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
  });

  test('clean-root JSON artifacts must be recognized or explicitly allowlisted', () => {
    const root = tempDir('clean-room-unknown-json');
    const env = policyEnv(root);
    const unknown = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'behavior_specs.json');
    fs.writeFileSync(unknown, JSON.stringify({ note: 'not a canonical artifact' }));

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: unknown } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized clean JSON artifact/);
  });

  test('source-index JSON is rejected under clean roots', () => {
    const root = tempDir('clean-room-source-index-clean');
    const env = policyEnv(root);
    const sourceIndex = copyExample('source-index.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    const result = runHook('validate-json-schema.py', { tool_name: 'Write', tool_input: { file_path: sourceIndex } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source-index\.json is contaminated-only/);
  });

  test('handoff integrity verifies referenced artifact path and sha256', () => {
    const root = tempDir('clean-room-handoff');
    const env = policyEnv(root);
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);
    const handoff = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'handoff-package.json');
    fs.writeFileSync(handoff, JSON.stringify({
      package_id: 'package-test',
      task_id: 'task-test',
      from_domain: 'contaminated',
      to_domain: 'clean',
      created_by_role: 'contaminated-source-analyst',
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
        reviewer_role: 'contaminated-source-analyst',
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
    const env = policyEnv(root);
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
    const env = policyEnv(root);
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'path-field.json');
    fs.writeFileSync(filePath, JSON.stringify({ path: 'specs/com.example.product/spec.md' }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.equal(result.status, 0, result.stderr);
  });
});
