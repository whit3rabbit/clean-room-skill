'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const {
  AGENT3_RUNNER,
  AGENT4_RUNNER,
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

const TEST_TIMEOUT_MS = 30_000;

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) {
    return nodeSpawnSync(command, { timeout: TEST_TIMEOUT_MS, ...(args || {}) });
  }
  return nodeSpawnSync(command, args, { timeout: TEST_TIMEOUT_MS, ...(options || {}) });
}

function writeFakeContainerBackend(binDir, name, argvPath) {
  const toolPath = path.join(binDir, name);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(toolPath, [
    '#!/bin/sh',
    `: > ${shellQuote(argvPath)}`,
    'for arg in "$@"; do',
    `  printf '%s\\n' "$arg" >> ${shellQuote(argvPath)}`,
    'done',
    'printf fake-container-ok\\n',
    '',
  ].join('\n'));
  fs.chmodSync(toolPath, 0o755);
  return toolPath;
}

function writePolishReport(cleanRoot, overrides = {}) {
  const reportPath = path.join(cleanRoot, 'polish-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    report_id: 'polish-test',
    task_id: 'task-test',
    spec_slice_ref: 'behavior-spec:test',
    unit_id: 'unit-test',
    reviewer_role: 'clean-polish-reviewer',
    reviewed_at: '2024-01-01T00:00:00Z',
    reviewed_artifacts: ['implementation-report.json', 'qc-report.json'],
    changed_paths: [
      {
        path: 'AGENTS.md',
        kind: 'repo-hygiene',
        action: 'created',
        reason: 'Record clean commands.',
      },
    ],
    verification_results: [
      {
        command: ['npm', 'test'],
        cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
        status: 'not-run',
        output_summary: '',
      },
    ],
    findings: [],
    git: {
      repository_status: 'initialized',
      commit_required: true,
      commit_status: 'committed',
      include_paths: ['AGENTS.md'],
      commit_message: 'Complete clean-room spec slice behavior-spec:test',
      commit_hash: '0123456789abcdef0123456789abcdef01234567',
      status_summary: '',
    },
    residual_risks: [],
    abstract_delta_tickets: [],
    final_status: 'passed',
    ...overrides,
  }, null, 2));
  return reportPath;
}

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
    const dockerRunnerCommand = `${runnerCommand} --backend docker`;

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
      tool_input: { cwd: implementation, command: dockerRunnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: `${runnerCommand} --backend remote` },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--backend must be host, docker, or podman/);

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

  test('shell policy allows only Agent 4 polish runner in implementation roots', () => {
    const root = tempDir('clean-room-agent4-shell');
    const env = policyEnv(root, 'clean-polish-reviewer');
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const report = writePolishReport(clean);
    const runnerCommand = `python3 ${shellQuote(AGENT4_RUNNER)} --report ${shellQuote(report)} --status`;

    let result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: runnerCommand },
    }, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLEAN_ROOM_ALLOW_AGENT4_SHELL=1 is required/);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: clean, command: runnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside implementation roots/);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: runnerCommand },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    });
    assert.equal(result.status, 0, result.stderr);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: 'git push origin main' },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /may only invoke the polish runner/);

    result = runHook('deny-clean-room-shell.py', {
      tool_name: 'Shell',
      tool_input: { cwd: implementation, command: `${runnerCommand} | cat` },
    }, {
      ...env,
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shell syntax is not allowed/);
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

  test('Agent 4 polish runner initializes git and commits only listed paths', () => {
    const root = tempDir('clean-room-agent4-runner');
    const env = {
      ...policyEnv(root, 'clean-polish-reviewer'),
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    };
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    fs.writeFileSync(path.join(implementation, 'AGENTS.md'), '# Commands\n\n- npm test\n');
    fs.writeFileSync(path.join(implementation, 'UNLISTED.md'), 'leave dirty\n');
    const report = writePolishReport(clean);

    const result = spawnSync('python3', [AGENT4_RUNNER, '--report', report, '--commit'], {
      cwd: implementation,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commit.commit_status, 'committed');
    assert.match(output.commit.commit_hash, /^[0-9a-f]{40}$/);

    const subject = spawnSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: implementation,
      encoding: 'utf8',
    });
    assert.equal(subject.stdout.trim(), 'Complete clean-room spec slice behavior-spec:test');
    const status = spawnSync('git', ['status', '--short'], {
      cwd: implementation,
      encoding: 'utf8',
    });
    assert.match(status.stdout, /\?\? UNLISTED\.md/);
    assert.doesNotMatch(status.stdout, /AGENTS\.md/);
  });

  test('Agent 4 polish runner disables repository git hooks when committing', () => {
    const root = tempDir('clean-room-agent4-runner-hooks');
    const env = {
      ...policyEnv(root, 'clean-polish-reviewer'),
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    };
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    fs.writeFileSync(path.join(implementation, 'AGENTS.md'), '# Commands\n\n- npm test\n');
    fs.writeFileSync(path.join(implementation, 'UNLISTED.md'), 'leave dirty\n');
    const init = spawnSync('git', ['init'], {
      cwd: implementation,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stderr);
    const marker = path.join(implementation, 'prepare-hook-ran');
    const hookPath = path.join(implementation, '.git', 'hooks', 'prepare-commit-msg');
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      `printf hook-ran > ${shellQuote(marker)}`,
      'exit 42',
      '',
    ].join('\n'));
    fs.chmodSync(hookPath, 0o755);
    const report = writePolishReport(clean);

    const result = spawnSync('python3', [AGENT4_RUNNER, '--report', report, '--commit'], {
      cwd: implementation,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commit.commit_status, 'committed');
    assert.equal(fs.existsSync(marker), false);

    const tree = spawnSync('git', ['ls-tree', '--name-only', 'HEAD'], {
      cwd: implementation,
      encoding: 'utf8',
    });
    assert.match(tree.stdout, /^AGENTS\.md$/m);
    assert.doesNotMatch(tree.stdout, /UNLISTED\.md/);
    const status = spawnSync('git', ['status', '--short'], {
      cwd: implementation,
      encoding: 'utf8',
    });
    assert.match(status.stdout, /\?\? UNLISTED\.md/);
    assert.doesNotMatch(status.stdout, /AGENTS\.md/);
  });

  test('Agent 4 polish runner rejects paths that escape implementation roots', () => {
    const root = tempDir('clean-room-agent4-runner-paths');
    const env = {
      ...policyEnv(root, 'clean-polish-reviewer'),
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    };
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const report = writePolishReport(clean, {
      changed_paths: [
        {
          path: '../source/secret.txt',
          kind: 'repo-hygiene',
          action: 'updated',
          reason: 'bad path',
        },
      ],
      git: {
        repository_status: 'initialized',
        commit_required: true,
        commit_status: 'failed',
        include_paths: ['../source/secret.txt'],
        commit_message: 'Complete clean-room spec slice behavior-spec:test',
        commit_hash: null,
        status_summary: '',
      },
      final_status: 'blocked',
    });

    const result = spawnSync('python3', [AGENT4_RUNNER, '--report', report, '--commit'], {
      cwd: implementation,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not contain/);
  });

  test('Agent 4 polish runner rejects verification argv paths outside implementation roots', () => {
    const root = tempDir('clean-room-agent4-runner-verification-paths');
    const env = {
      ...policyEnv(root, 'clean-polish-reviewer'),
      CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    };
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const report = writePolishReport(clean, {
      verification_results: [
        {
          command: ['npm', 'test', '../source'],
          cwd: 'CLEAN_ROOM_IMPLEMENTATION_ROOTS[0]',
          status: 'not-run',
          output_summary: '',
        },
      ],
      final_status: 'blocked',
      git: {
        repository_status: 'initialized',
        commit_required: false,
        commit_status: 'not-needed',
        include_paths: [],
        commit_message: '',
        commit_hash: null,
        status_summary: '',
      },
    });

    const result = spawnSync('python3', [AGENT4_RUNNER, '--report', report, '--verify-index', '0'], {
      cwd: implementation,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /blocked root|outside implementation root/);
  });

  test('Agent 3 verification runner builds hardened container argv without blocked mounts', () => {
    const root = tempDir('clean-room-agent3-container-runner');
    const env = {
      ...policyEnv(root, 'clean-qa-editor'),
      CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1',
    };
    const implementation = env.CLEAN_ROOM_IMPLEMENTATION_ROOTS;
    const clean = env.CLEAN_ROOM_CLEAN_ROOTS;
    const source = env.CLEAN_ROOM_SOURCE_ROOTS;
    const contaminated = env.CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS;
    const allowedRefs = env.CLEAN_ROOM_ALLOWED_READ_ROOTS;
    const implementationResolved = fs.realpathSync(implementation);
    const cleanResolved = fs.realpathSync(clean);
    const sourceResolved = fs.realpathSync(source);
    const contaminatedResolved = fs.realpathSync(contaminated);
    const allowedRefsResolved = fs.realpathSync(allowedRefs);
    const schemaResolved = fs.realpathSync(SCHEMA_DIR);
    fs.writeFileSync(path.join(clean, 'clean-run-context.json'), JSON.stringify({
      execution_policy: {
        backend: 'docker',
        preferred_container_profile: 'node22',
        network_policy: 'off',
        dependency_install_policy: 'locked',
        allow_native_toolchain: false,
        resource_limits: {
          cpus: 2,
          memory_mb: 2048,
          timeout_seconds: 120,
        },
      },
    }));
    const plan = writeImplementationPlan(clean, ['npm', 'test'], {
      run_type: 'verify',
      dependency_mode: 'locked',
    });
    const binDir = path.join(root, 'bin');
    const argvPath = path.join(root, 'docker-argv.txt');
    writeFakeContainerBackend(binDir, 'docker', argvPath);

    let result = spawnSync('python3', [AGENT3_RUNNER, '--backend', 'docker', '--plan', plan, '--command-index', '0'], {
      cwd: ROOT,
      env: { ...process.env, ...env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake-container-ok/);

    const args = fs.readFileSync(argvPath, 'utf8').trim().split('\n');
    const argAfter = (flag) => args[args.indexOf(flag) + 1];
    assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
    assert.equal(argAfter('--network'), 'none');
    assert.equal(argAfter('--cap-drop'), 'ALL');
    assert.equal(argAfter('--security-opt'), 'no-new-privileges');
    assert.equal(argAfter('--pids-limit'), '512');
    assert.equal(argAfter('--memory'), '2048m');
    assert.equal(argAfter('--cpus'), '2');
    assert.equal(argAfter('--user'), '1000:1000');
    assert.equal(argAfter('--workdir'), '/work');
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('/tmp:rw,noexec,nosuid,size=512m'));
    assert.ok(args.includes(`${implementationResolved}:/work:rw`));
    assert.ok(args.includes(`${cleanResolved}:/clean:ro`));
    assert.ok(args.includes(`${schemaResolved}:/schemas:ro`));
    assert.ok(args.includes(`${allowedRefsResolved}:/refs/0:ro`));
    assert.ok(args.includes('clean-room-skill/node22:local'));
    assert.deepEqual(args.slice(-2), ['npm', 'test']);

    const serialized = args.join('\n');
    assert.equal(serialized.includes(sourceResolved), false);
    assert.equal(serialized.includes(contaminatedResolved), false);
    assert.equal(serialized.includes('CLEAN_ROOM_SOURCE_ROOTS'), false);
    assert.equal(serialized.includes('CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS'), false);

    const unsafePlan = writeImplementationPlan(clean, ['npm', 'test'], {
      run_type: 'verify',
      container_profile: 'node22',
      network: 'on',
      dependency_mode: 'locked',
    });
    result = spawnSync('python3', [AGENT3_RUNNER, '--backend', 'docker', '--plan', unsafePlan, '--command-index', '0'], {
      cwd: ROOT,
      env: { ...process.env, ...env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /network=off only/);
  });
});
