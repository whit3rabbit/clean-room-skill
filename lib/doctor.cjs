'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJsonFile } = require('./fs-utils.cjs');
const { configPathForRuntime } = require('./hooks.cjs');
const { resolveRuntimeLayout } = require('./runtime-layout.cjs');

const HOOK_MODES = new Set(['safe', 'strict']);
const RUNTIMES = new Set(['codex', 'claude']);
const MAX_SPAWN_OUTPUT_CHARS = 2000;

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function parseDoctorArgs(argv) {
  const options = {
    runtime: null,
    hookMode: 'safe',
    scope: 'global',
    configDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runtime') {
      i += 1;
      options.runtime = requiredValue(argv, i, '--runtime');
    } else if (arg.startsWith('--runtime=')) {
      options.runtime = arg.slice('--runtime='.length);
    } else if (arg === '--hooks') {
      i += 1;
      options.hookMode = requiredValue(argv, i, '--hooks');
    } else if (arg.startsWith('--hooks=')) {
      options.hookMode = arg.slice('--hooks='.length);
    } else if (arg === '--global') {
      options.scope = 'global';
    } else if (arg === '--local') {
      options.scope = 'local';
    } else if (arg === '--config-dir') {
      i += 1;
      options.configDir = requiredValue(argv, i, '--config-dir');
    } else if (arg.startsWith('--config-dir=')) {
      options.configDir = arg.slice('--config-dir='.length);
    } else {
      throw new Error(`unknown doctor option: ${arg}`);
    }
  }
  if (!RUNTIMES.has(options.runtime)) {
    throw new Error('doctor --runtime must be codex or claude');
  }
  if (!HOOK_MODES.has(options.hookMode)) {
    throw new Error('doctor --hooks must be safe or strict');
  }
  return options;
}

function hasTopLevelHookEvents(value) {
  return Object.keys(value || {}).some((key) =>
    ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'].includes(key)
  );
}

function hookTableFor(value) {
  if (value && typeof value.hooks === 'object' && value.hooks !== null && !Array.isArray(value.hooks)) {
    return value.hooks;
  }
  if (hasTopLevelHookEvents(value)) {
    return value;
  }
  return null;
}

function managedHookEntries(config) {
  const table = hookTableFor(config);
  if (!table) return [];
  const entries = [];
  for (const [event, eventEntries] of Object.entries(table)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const entry of eventEntries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (hook && typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
          entries.push({ event, matcher: entry.matcher, hook });
        }
      }
    }
  }
  return entries;
}

function shellSplit(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) {
    throw new Error('managed hook command has unterminated quoting');
  }
  if (current) parts.push(current);
  return parts;
}

function assertGeneratedCommand(entry, hookMode) {
  const parts = shellSplit(entry.hook.command);
  if (parts.length < 4) {
    throw new Error('managed hook command is incomplete');
  }
  if (!path.isAbsolute(parts[0])) {
    throw new Error('managed hook python path is not absolute');
  }
  if (!path.isAbsolute(parts[1]) || path.basename(parts[1]) !== 'clean-room-hook.py') {
    throw new Error('managed hook wrapper path is not absolute');
  }
  if (!fs.existsSync(parts[1])) {
    throw new Error(`managed hook wrapper does not exist: ${parts[1]}`);
  }
  const modeIndex = parts.indexOf('--mode');
  if (modeIndex === -1 || parts[modeIndex + 1] !== hookMode) {
    throw new Error(`managed hook command does not use --mode ${hookMode}`);
  }
}

function findManagedCommand(entries, event, matcherNeedle) {
  const found = entries.find((entry) =>
    entry.event === event &&
    typeof entry.matcher === 'string' &&
    entry.matcher.includes(matcherNeedle)
  );
  if (!found) {
    throw new Error(`missing managed ${event} hook for ${matcherNeedle}`);
  }
  return found.hook.command;
}

function mkdirs(...dirs) {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function smokeEnv(layout, tmpRoot, role) {
  const source = path.join(tmpRoot, 'source');
  const contaminated = path.join(tmpRoot, 'contaminated');
  const clean = path.join(tmpRoot, 'clean');
  const implementation = path.join(tmpRoot, 'implementation');
  const allowed = path.join(tmpRoot, 'allowed');
  mkdirs(source, contaminated, clean, implementation, allowed);
  return {
    CLEAN_ROOM_ROLE: role,
    CLEAN_ROOM_SOURCE_ROOTS: source,
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated,
    CLEAN_ROOM_CLEAN_ROOTS: clean,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: implementation,
    CLEAN_ROOM_ALLOWED_READ_ROOTS: allowed,
    CLEAN_ROOM_SCHEMA_DIR: path.join(layout.targetRoot, 'skills', 'clean-room', 'assets'),
  };
}

function runHookCommand(command, payload, env, cwd) {
  return spawnSync(command, {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    shell: true,
  });
}

function spawnOutputSnippet(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= MAX_SPAWN_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SPAWN_OUTPUT_CHARS)}...<truncated>`;
}

function describeSpawn(result) {
  return [
    result.error && `error=${result.error.message}`,
    result.signal && `signal=${result.signal}`,
    `status=${result.status}`,
    spawnOutputSnippet(result.stderr) && `stderr=${spawnOutputSnippet(result.stderr)}`,
    spawnOutputSnippet(result.stdout) && `stdout=${spawnOutputSnippet(result.stdout)}`,
  ].filter(Boolean).join('; ');
}

function assertHookFails(command, payload, env, cwd, expected, expectedStderr) {
  const result = runHookCommand(command, payload, env, cwd);
  if (result.status === 0) {
    throw new Error(`${expected} hook unexpectedly passed: ${describeSpawn(result)}`);
  }
  if (expectedStderr && !expectedStderr.test(String(result.stderr || ''))) {
    throw new Error(`${expected} hook failed for an unexpected reason: ${describeSpawn(result)}`);
  }
  return result;
}

function runDoctor(argv) {
  const options = parseDoctorArgs(argv);
  const layout = resolveRuntimeLayout(options.runtime, options.scope, { configDir: options.configDir });
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) {
    throw new Error(`doctor is not supported for ${layout.runtime}`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`hook config does not exist: ${configPath}`);
  }
  const config = readJsonFile(configPath, null);
  const entries = managedHookEntries(config);
  if (entries.length !== 4) {
    throw new Error(`expected 4 managed clean-room hooks, found ${entries.length}`);
  }
  for (const entry of entries) {
    assertGeneratedCommand(entry, options.hookMode);
  }

  const firstCommand = entries[0].hook.command;
  if (options.hookMode === 'safe') {
    const safe = spawnSync(firstCommand, {
      cwd: layout.targetRoot,
      env: {},
      input: '',
      encoding: 'utf8',
      shell: true,
    });
    if (safe.status !== 0) {
      throw new Error(`safe hook did not no-op without clean-room env: ${describeSpawn(safe)}`);
    }
    assertHookFails(
      firstCommand,
      {},
      { CLEAN_ROOM_HOOK_ENFORCE: '1' },
      layout.targetRoot,
      'enforced safe',
      /environment check failed/
    );
  } else {
    assertHookFails(firstCommand, {}, {}, layout.targetRoot, 'strict', /environment check failed/);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-room-doctor-'));
  try {
    const readCommand = findManagedCommand(entries, 'PreToolUse', 'Read');
    const shellCommand = findManagedCommand(entries, 'PreToolUse', 'Bash');
    const writeCommand = findManagedCommand(entries, 'PreToolUse', 'Write');
    const postWriteCommand = findManagedCommand(entries, 'PostToolUse', 'Write');

    const cleanEnv = smokeEnv(layout, tmpRoot, 'clean-architect');
    const qaEnv = { ...smokeEnv(layout, tmpRoot, 'clean-qa-editor'), CLEAN_ROOM_ALLOW_AGENT3_SHELL: '1' };
    const sourceFile = path.join(cleanEnv.CLEAN_ROOM_SOURCE_ROOTS, 'secret.txt');
    const cleanBadJson = path.join(cleanEnv.CLEAN_ROOM_CLEAN_ROOTS, 'behavior-spec.json');
    fs.writeFileSync(sourceFile, 'secret\n');
    fs.writeFileSync(cleanBadJson, '{\n');

    assertHookFails(readCommand, {
      tool_name: 'Read',
      tool_input: { file_path: sourceFile },
    }, cleanEnv, layout.targetRoot, 'read', /source-root/);
    assertHookFails(writeCommand, {
      tool_name: 'Write',
      tool_input: { file_path: sourceFile },
    }, cleanEnv, layout.targetRoot, 'write', /source-root/);
    assertHookFails(shellCommand, {
      tool_name: 'Shell',
      tool_input: { cwd: qaEnv.CLEAN_ROOM_IMPLEMENTATION_ROOTS, command: `cat ${sourceFile}` },
    }, qaEnv, layout.targetRoot, 'shell', /policy denied shell tool use|source-root/);
    assertHookFails(postWriteCommand, {
      tool_name: 'Write',
      tool_input: { file_path: cleanBadJson },
    }, cleanEnv, layout.targetRoot, 'post-write', /JSON parse failed/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`clean-room doctor passed for ${options.runtime}`);
  console.log(`  hooks config: ${configPath}`);
  console.log(`  managed hooks: ${entries.length}`);
  console.log(`  mode: ${options.hookMode}`);
  return { configPath, managedHooks: entries.length };
}

module.exports = {
  describeSpawn,
  parseDoctorArgs,
  runDoctor,
};
