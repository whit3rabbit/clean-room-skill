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

describe('clean-room source-index policy', () => {
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

  test('source-index records directory traversal errors in skipped_entries', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('permission traversal errors are not reliable as root');
      return;
    }
    const root = tempDir('clean-room-source-index-walk-error');
    const source = path.join(root, 'source');
    const blocked = path.join(source, 'blocked');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(blocked, contaminated);
    fs.writeFileSync(path.join(source, 'example.py'), 'VALUE = 1\n');
    fs.chmodSync(blocked, 0o000);
    const output = path.join(contaminated, 'source-index.json');

    try {
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
    } finally {
      fs.chmodSync(blocked, 0o700);
    }

    const index = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(
      index.skipped_entries.some((entry) =>
        entry.path === 'blocked' &&
        entry.kind === 'directory' &&
        entry.reason.startsWith('walk-error:')
      ),
      true
    );
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

  test('user toolchain path probes require explicit opt-in', () => {
    const root = tempDir('clean-room-user-toolchain-probe');
    const { marker } = writeProbeTool(root, 'ast-grep');
    const script = `
import pathlib
import sys
import os

sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'skills', 'clean-room', 'scripts'))})
import clean_room_tooling

toolchain_root = pathlib.Path(sys.argv[1]).resolve()
marker = pathlib.Path(sys.argv[2])
clean_room_tooling.SYSTEM_PATH_PREFIXES = ()
clean_room_tooling.USER_TOOLCHAIN_PATH_PREFIXES = (toolchain_root,)
os.environ["PATH"] = str(toolchain_root)

status = clean_room_tooling.executable_status("ast-grep", probe_tools=True)
if marker.exists():
    raise SystemExit("user toolchain probe executed without opt-in")
if status["value"]["version"]["status"] != "unknown":
    raise SystemExit(status)

status = clean_room_tooling.executable_status(
    "ast-grep",
    probe_tools=True,
    allow_user_toolchain_probes=True,
)
if not marker.exists():
    raise SystemExit("user toolchain probe did not execute after opt-in")
if status["value"]["version"]["status"] != "observed":
    raise SystemExit(status)
`;

    const result = spawnSync('python3', ['-c', script, root, marker], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });

  test('local npm tool installs require strict SemVer versions', () => {
    let result = spawnSync('python3', [TOOL_MANAGER, '--install-local', 'ast-grep', '--version', 'latest'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exact SemVer/);

    const script = `
import argparse
import sys

sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'skills', 'clean-room', 'scripts'))})
import clean_room_tool_manager

valid = ["1.2.3", "1.2.3-alpha.1", "1.2.3+build.5", "1.2.3-alpha.1+build.5"]
invalid = ["latest", "1", "1.2", "^1.2.3", "~1.2.3", "npm:pkg@1.2.3", "file:../pkg", "workspace:*"]
for value in valid:
    clean_room_tool_manager.exact_version_arg(value)
for value in invalid:
    try:
        clean_room_tool_manager.exact_version_arg(value)
    except argparse.ArgumentTypeError:
        continue
    raise SystemExit(f"accepted invalid version: {value}")
`;
    result = spawnSync('python3', ['-c', script], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });

  test('local npm tool install returns structured JSON for timeout and prefix errors', () => {
    const root = tempDir('clean-room-npm-install-errors');
    const script = `
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'skills', 'clean-room', 'scripts'))})
import clean_room_tool_manager
import clean_room_tooling

root = pathlib.Path(sys.argv[1])
npm = root / "npm"
npm.write_text("#!/bin/sh\\nexit 0\\n")
npm.chmod(0o755)
os.environ["NPM_BIN"] = str(npm)

clean_room_tooling.USER_NPM_PREFIX = root / "prefix"
real_run = clean_room_tooling.subprocess.run

def timeout_run(*args, **kwargs):
    raise subprocess.TimeoutExpired(args[0], kwargs.get("timeout"))

clean_room_tooling.subprocess.run = timeout_run
timeout_result = clean_room_tool_manager.install_npm_tool("ast-grep", "1.2.3")
clean_room_tooling.subprocess.run = real_run

blocked = root / "blocked"
blocked.write_text("not a directory")
clean_room_tooling.USER_NPM_PREFIX = blocked / "npm"
prefix_result = clean_room_tool_manager.install_npm_tool("ast-grep", "1.2.3")

print(json.dumps({"timeout": timeout_result, "prefix": prefix_result}, sort_keys=True))
`;

    const result = spawnSync('python3', ['-c', script, root], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.timeout.command.status, 'error');
    assert.match(data.timeout.command.note, /timed out/);
    assert.equal(data.prefix.command.status, 'error');
    assert.match(data.prefix.command.note, /could not create npm install prefix/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  });

  test('source-index writer fsyncs temp file and parent directory', () => {
    const root = tempDir('clean-room-writer-fsync');
    const output = path.join(root, 'source-index.json');
    const script = `
import pathlib
import sys

sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'skills', 'clean-room', 'scripts'))})
from source_index import writer

calls = []
real_fsync = writer.os.fsync

def fake_fsync(fd):
    calls.append(fd)
    return real_fsync(fd)

writer.os.fsync = fake_fsync
writer.atomic_write_json(pathlib.Path(sys.argv[1]), {"ok": True})
if len(calls) < 2:
    raise SystemExit(f"expected file and directory fsync calls, saw {len(calls)}")
`;
    const result = spawnSync('python3', ['-c', script, output], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).ok, true);
  });

  test('source-index routes oversized single files into segment batches', () => {
    const root = tempDir('clean-room-oversized-file-batch');
    const source = path.join(root, 'source');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(source, contaminated);
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index} ${'x'.repeat(120)}`);
    fs.writeFileSync(path.join(source, 'large.txt'), `${lines.join('\n')}\n`);
    const output = path.join(contaminated, 'source-index.json');

    const result = spawnSync('python3', [
      SOURCE_INDEX,
      '--source-root', source,
      '--output', output,
      '--task-id', 'task-oversized',
      '--max-batch-tokens', '80',
      '--large-file-words', '100000',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      env: { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const index = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.ok(index.file_segments.length > 1);
    assert.equal(index.recommended_batches.length, index.file_segments.length);
    assert.equal(index.recommended_batches.every((batch) => batch.segment_ids.length === 1), true);
    assert.equal(index.recommended_batches.some((batch) => batch.segment_ids.length === 0), false);
    assert.equal(index.recommended_batches.every((batch) => batch.metrics.estimated_tokens <= 80), true);
  });
});
