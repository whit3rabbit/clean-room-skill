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

describe('clean-room shell hook policy', () => {
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

  test('shell policy allows only Agent 3 in implementation roots when explicitly enabled', () => {
    const root = tempDir('clean-room-agent3-shell');
    const env = policyEnv(root, 'clean-qa-editor');
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const runnerCommand = `python3 ${shellQuote(AGENT3_RUNNER)} --command-index 0`;

    let result = runHook('deny-clean-room-shell.py', { tool_name: 'Shell', tool_input: { cwd: implementation } }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_ALLOW_AGENT3_SHELL=1 is required/);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: clean, command: runnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside implementation roots/);

    result = runHook('deny-clean-room-shell.py', { tool_name: 'Shell', tool_input: { cwd: implementation } }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must invoke the verification runner/);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: runnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: runnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ROLE: 'clean-architect',
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /denied shell tool use/);
  });

  test('shell policy rejects Agent 3 raw command bypass payloads', () => {
    const root = tempDir('clean-room-agent3-shell-bypass');
    const env = {
      ...policyEnv(root, 'clean-qa-editor'),
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    };
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    const sourceFile = path.join(source, 'secret.txt');
    fs.writeFileSync(sourceFile, 'secret\n');
    const runner = shellQuote(AGENT3_RUNNER);
    const deniedCommands = [
      `cat ${shellQuote(sourceFile)}`,
      `cp ${shellQuote(sourceFile)} .`,
      `grep -R secret ${shellQuote(source)}`,
      'python3 -c "open(\'/source/file\')"',
      'node -e "require(\'fs\').readFileSync(\'/source/file\')"',
      'bash -c "cat /source/file"',
      `curl file://${sourceFile}`,
      `cat $SOURCE/file`,
      `python3 ${runner} --command-index 0 | cat`,
      `python3 ${runner} --command-index 0 > out.txt`,
      `python3 ${runner} --plan ${shellQuote(path.join(source, 'implementation-plan.json'))} --command-index 0`,
      `python3 ${runner} --plan ${shellQuote(path.join(contaminated, 'implementation-plan.json'))} --command-index 0`,
    ];

    for (const command of deniedCommands) {
      const result = runHook('deny-clean-room-shell.py', {
        tool_name: 'Shell',
        tool_input: { cwd: implementation, command },
      }, env);
      assert.notEqual(result.status, 0, command);
      assert.match(result.stderr, /denied shell tool use/, command);
    }
  });

  test('Agent 3 verification runner allows only bounded argv commands', (t) => {
    const root = tempDir('clean-room-agent3-runner');
    const env = {
      ...policyEnv(root, 'clean-qa-editor'),
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    };
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    fs.writeFileSync(path.join(implementation, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "process.exit(0)"',
      },
    }));
    let plan = writeImplementationPlan(clean, ['npm', 'test']);
    let result = spawnSync('python3', [AGENT3_RUNNER, '--plan', plan, '--command-index', '0'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const sourceFile = path.join(source, 'secret.txt');
    fs.writeFileSync(sourceFile, 'secret\n');
    const deniedCommands = [
      ['cat', sourceFile],
      ['grep', '-R', 'secret', source],
      ['python3', '-c', `open(${JSON.stringify(sourceFile)}).read()`],
      ['node', '-e', `require('fs').readFileSync(${JSON.stringify(sourceFile)})`],
      ['bash', '-c', `cat ${shellQuote(sourceFile)}`],
      ['curl', `file://${sourceFile}`],
      ['npm', 'test', sourceFile],
      ['npm', 'test', '|', 'cat'],
      ['npm', 'test', '>', 'out.txt'],
      ['npm', 'test', `$(cat ${sourceFile})`],
    ];
    for (const command of deniedCommands) {
      plan = writeImplementationPlan(clean, command);
      result = spawnSync('python3', [AGENT3_RUNNER, '--plan', plan, '--command-index', '0'], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, command.join(' '));
      assert.match(result.stderr, /verification denied/, command.join(' '));
    }

    try {
      fs.symlinkSync(source, path.join(implementation, 'linked-source'), 'dir');
    } catch (err) {
      if (['EACCES', 'EINVAL', 'EPERM'].includes(err?.code)) {
        t.skip(`directory symlink unavailable: ${err.code}`);
        return;
      }
      throw err;
    }
    plan = writeImplementationPlan(clean, ['npm', 'test', './linked-source']);
    result = spawnSync('python3', [AGENT3_RUNNER, '--plan', plan, '--command-index', '0'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /blocked root/);
  });
});
