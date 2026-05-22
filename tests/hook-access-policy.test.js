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

describe('clean-room access hook policy', () => {
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
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Glob',
      tool_input: { cwd: clean, glob: '../source/*.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);

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

  test('read policy covers list and notebook tool aliases', () => {
    const root = tempDir('clean-room-read-aliases');
    const env = policyEnv(root, 'clean-architect');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    fs.writeFileSync(path.join(clean, 'notes.ipynb'), '{}\n');
    fs.mkdirSync(path.join(clean, 'images'), { recursive: true });
    fs.writeFileSync(path.join(clean, 'images', 'diagram.png'), 'png\n');
    fs.writeFileSync(path.join(source, 'secret.py'), 'VALUE = 1\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'LS',
      tool_input: { cwd: clean },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'LS',
      tool_input: { cwd: source },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'LSP',
      tool_input: { cwd: clean, filePath: '../source/secret.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'list_dir',
      tool_input: { cwd: clean, path: '../source' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'NotebookRead',
      tool_input: { cwd: clean, notebook_path: 'notes.ipynb' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'NotebookRead',
      tool_input: { cwd: clean },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read with no resolved path/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'view_image',
      tool_input: { cwd: clean, path: 'images/diagram.png' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'view_image',
      tool_input: { cwd: clean, path: '../source/secret.py' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);
  });

  test('read policy fails closed for MCP resource aliases', () => {
    const root = tempDir('clean-room-read-mcp');
    const env = policyEnv(root, 'clean-architect');
    const toolNames = [
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'ListMcpResourceTemplatesTool',
      'list_mcp_resources',
      'list_mcp_resource_templates',
      'read_mcp_resource',
    ];

    for (const toolName of toolNames) {
      const result = runHook('deny-clean-source-read.py', {
        tool_name: toolName,
        tool_input: { server: 'docs', uri: 'file:///tmp/public.md' },
      }, env);
      assert.notEqual(result.status, 0, toolName);
      assert.match(result.stderr, /MCP resource access/);
    }
  });

  test('clean roles may read schema roots but not source or contaminated roots', () => {
    const root = tempDir('clean-room-schema-read');
    const env = policyEnv(root, 'clean-qa-editor');
    const schema = path.join(SCHEMA_DIR, 'behavior-spec.schema.json');
    const implementationFile = path.join(env.CLEAN_ROOM_IMPLEMENTATION_ROOTS, 'clean-foundation.js');
    const sourceFile = path.join(env.CLEAN_ROOM_SOURCE_ROOTS, 'secret.py');
    const contaminatedFile = path.join(env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS, 'coverage-ledger.json');
    fs.writeFileSync(implementationFile, 'export const value = 1;\n');
    fs.writeFileSync(sourceFile, 'VALUE = 1\n');
    fs.writeFileSync(contaminatedFile, '{}\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: schema },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: implementationFile },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: sourceFile },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: contaminatedFile },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed roots/);
  });

  test('source-denied sanitizer can read only explicitly allowed staged artifacts and denied roots stay blocked', () => {
    const root = tempDir('clean-room-sanitizer-read');
    const env = policyEnv(root, 'contaminated-handoff-sanitizer');
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    const assignedArtifact = path.join(contaminated, 'behavior-spec.json');
    const renamedLedger = path.join(contaminated, 'renamed-ledger.json');
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    const allowed = env.CLEAN_ROOM_ALLOWED_READ_ROOTS;
    env.CLEAN_ROOM_ALLOWED_READ_ROOTS = `${allowed}${path.delimiter}${assignedArtifact}`;
    fs.writeFileSync(assignedArtifact, '{}');
    fs.writeFileSync(renamedLedger, '{}');
    fs.writeFileSync(path.join(contaminated, 'source-index.json'), '{}');
    fs.writeFileSync(path.join(source, 'secret.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(clean, 'handoff-package.json'), '{}');
    fs.writeFileSync(path.join(implementation, 'generated.txt'), 'ok\n');
    fs.writeFileSync(path.join(allowed, 'public.md'), '# Public reference\n');

    let result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: assignedArtifact },
    }, policyEnv(root, 'contaminated-handoff-sanitizer'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed roots/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { cwd: contaminated, file_path: 'behavior-spec.json' },
    }, env);
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: renamedLedger },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed roots/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: renamedLedger },
    }, {
      ...env,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: `${allowed}${path.delimiter}${contaminated}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed roots/);

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
    assert.match(result.stderr, /reading source-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(clean, 'handoff-package.json') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading clean-root\[0\]/);

    result = runHook('deny-clean-source-read.py', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(implementation, 'generated.txt') },
    }, {
      ...env,
      CLEAN_ROOM_ALLOWED_READ_ROOTS: `${env.CLEAN_ROOM_ALLOWED_READ_ROOTS}${path.delimiter}${implementation}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reading implementation-root\[0\]/);

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
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
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
    assert.match(result.stderr, /writing source-root\[0\]/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: implementation, file_path: 'src/new-file.js' },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Agent 2 writing implementation-root\[0\]/);

    const agent3Env = { ...env, CLEAN_ROOM_ROLE: 'clean-qa-editor' };
    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: implementation, file_path: 'src/new-file.js' },
    }, agent3Env);
    assert.equal(result.status, 0, result.stderr);

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
    assert.match(result.stderr, /writing clean-root\[0\]/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { cwd: contaminated, file_path: '../implementation/new-file.js' },
    }, contaminatedEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing implementation-root\[0\]/);

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
    assert.match(result.stderr, /writing clean-root\[0\]/);

    result = runHook('deny-contaminated-clean-write.py', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(clean, 'handoff-package.json') },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writing clean-root\[0\]/);
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
});
