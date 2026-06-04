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

describe('clean-room leakage hook policy', () => {
  test('leakage scanner reports unreadable artifacts without traceback', () => {
    const root = tempDir('clean-room-leakage-fs-error');
    const env = policyEnv(root, 'clean-architect');
    const behavior = copyExample('behavior-spec.json', env.CLEAN_ROOM_CLEAN_ROOTS);

    fs.chmodSync(behavior, 0o000);
    try {
      const result = runHook('check-artifact-leakage.py', {
        tool_name: 'Write',
        tool_input: { file_path: behavior },
      }, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /artifact could not read/);
      assert.doesNotMatch(result.stderr, /Traceback/);
    } finally {
      fs.chmodSync(behavior, 0o600);
    }
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

  test('leakage scanner catches source-derived hyphenated destination names without a denylist', () => {
    const root = tempDir('clean-room-leakage-source-name');
    const env = policyEnv(root, 'clean-architect');
    const sourceRoot = path.join(root, 'claude-code-build2');
    fs.mkdirSync(sourceRoot);
    env.CLEAN_ROOM_SOURCE_ROOTS = sourceRoot;
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'skeleton-manifest.json');
    fs.writeFileSync(filePath, JSON.stringify({
      description: 'Architecture map for the claude-code workspace.',
      workspace_layout: {
        members: [
          { crate_name: 'claude-code-types' },
        ],
      },
    }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source_derived_name/);
  });

  test('leakage scanner normalizes underscores and spaces in source codebase names', () => {
    const cases = [
      {
        sourceName: 'zk_cli',
        leakedName: 'zk_cli_types',
      },
      {
        sourceName: 'zk cli',
        leakedName: 'zk cli types',
      },
      {
        sourceName: 'zk cli',
        leakedName: 'zk_cli_types',
      },
    ];

    for (const item of cases) {
      const root = tempDir(`clean-room-leakage-${item.sourceName.replaceAll(/[\s_]+/g, '-')}`);
      const env = policyEnv(root, 'clean-architect');
      const sourceRoot = path.join(root, item.sourceName);
      fs.mkdirSync(sourceRoot);
      env.CLEAN_ROOM_SOURCE_ROOTS = sourceRoot;
      const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'skeleton-manifest.json');
      fs.writeFileSync(filePath, JSON.stringify({
        description: `Architecture map for ${item.leakedName}.`,
        workspace_layout: {
          members: [
            { crate_name: item.leakedName },
          ],
        },
      }));

      const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
      assert.notEqual(result.status, 0, item.sourceName);
      assert.match(result.stderr, /source_derived_name/, item.sourceName);
    }
  });

  test('leakage scanner allows source-named public compatibility values listed in public_surface', () => {
    const root = tempDir('clean-room-leakage-public-surface');
    const env = policyEnv(root, 'clean-architect');
    const sourceRoot = path.join(root, 'claude-code-build2');
    fs.mkdirSync(sourceRoot);
    env.CLEAN_ROOM_SOURCE_ROOTS = sourceRoot;
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'behavior-spec.json');
    fs.writeFileSync(filePath, JSON.stringify({
      categories: [
        {
          public_surface: [
            {
              name: 'CLAUDE_CONFIG_DIR',
              kind: 'environment-variable',
              visibility: 'public',
              compatibility_reason: 'Documented config-directory override.',
            },
            {
              name: 'claude-code-20250219',
              kind: 'protocol-header',
              visibility: 'protocol',
              compatibility_reason: 'Protocol compatibility header value.',
            },
          ],
          behavioral_requirements: [
            {
              description: 'Honor CLAUDE_CONFIG_DIR and send claude-code-20250219 exactly.',
            },
          ],
        },
      ],
    }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('leakage scanner checks implementation package manifests for source-derived names', () => {
    const root = tempDir('clean-room-leakage-implementation-metadata');
    const env = policyEnv(root, 'clean-qa-editor');
    const sourceRoot = path.join(root, 'claude-code-build2');
    fs.mkdirSync(sourceRoot);
    env.CLEAN_ROOM_SOURCE_ROOTS = sourceRoot;
    const filePath = path.join(env.CLEAN_ROOM_IMPLEMENTATION_ROOTS, 'Cargo.toml');
    fs.writeFileSync(filePath, [
      '[package]',
      'name = "agent-cli-config"',
      'description = "Configuration wrapper for claude-code"',
      '',
      '[dependencies]',
      'claude-code-types = { path = "../types" }',
      '',
    ].join('\n'));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source_derived_name/);
  });

  test('leakage scanner keeps path fields denylist-only to avoid path-shaped false positives', () => {
    const root = tempDir('clean-room-leakage-negative');
    const env = policyEnv(root, 'clean-architect');
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'path-field.json');
    fs.writeFileSync(filePath, JSON.stringify({
      path: 'specs/com.example.product/spec.md',
      owned_path_prefixes: ['test/example-flow.test.js'],
      include_paths: ['src/example-flow.js', 'test/example-flow.test.js'],
    }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('leakage scanner ignores low-confidence prose identifiers', () => {
    const root = tempDir('clean-room-leakage-prose');
    const env = policyEnv(root, 'clean-architect');
    const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, 'prose-identifiers.json');
    fs.writeFileSync(filePath, JSON.stringify({
      findings: [
        {
          summary: 'Run validate() and check() before publishing.',
        },
      ],
      notes: 'Use docs.example.com for public docs and set conservative logging defaults in config.',
    }));

    const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
    assert.equal(result.status, 0, result.stderr);
  });

  test('leakage scanner still catches reverse DNS packages and scoped calls', () => {
    const root = tempDir('clean-room-leakage-scoped');
    const env = policyEnv(root, 'clean-architect');
    const cases = [
      {
        name: 'reverse-dns',
        data: { summary: 'Keep com.example.product compatible with the public contract.' },
        message: /package_or_module_identifier|source_like_scoped_identifier/,
      },
      {
        name: 'lowercase-private-module',
        data: { summary: 'Coordinate with private.module.secret before publishing.' },
        message: /package_or_module_identifier|source_like_scoped_identifier/,
      },
      {
        name: 'scoped-call',
        data: { summary: 'Call private.module.name.doThing() after setup.' },
        message: /source_like_call|source_like_scoped_identifier/,
      },
    ];

    for (const item of cases) {
      const filePath = path.join(env.CLEAN_ROOM_CLEAN_ROOTS, `${item.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(item.data));
      const result = runHook('check-artifact-leakage.py', { tool_name: 'Write', tool_input: { file_path: filePath } }, env);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.message, item.name);
    }
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
