'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  assertManagedHookDetails,
  HOOK,
  hookTable,
  managedHookCount,
  postWriteHookCommand,
  readJson,
  ROOT,
  runInstall,
  tempDir,
} = require('./helpers/install.cjs');

function managedHookCommands(value) {
  const table = hookTable(value);
  const commands = [];
  for (const entries of Object.values(table)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
          commands.push(hook.command);
        }
      }
    }
  }
  return commands;
}

function managedHookMatchers(value, event) {
  return (hookTable(value)[event] || [])
    .filter((entry) =>
      (entry.hooks || []).some((hook) =>
        typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')
      )
    )
    .map((entry) => entry.matcher);
}

function firstManagedHookCommand(configPath) {
  const commands = managedHookCommands(readJson(configPath));
  assert.ok(commands.length > 0);
  return commands[0];
}

function symlinkDirOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (err) {
    if (['EACCES', 'EINVAL', 'EPERM'].includes(err?.code)) {
      t.skip(`directory symlink unavailable: ${err.code}`);
      return false;
    }
    throw err;
  }
}

describe('clean-room-skill installer', () => {
  test('init dry run makes no target changes and prints bootstrap paths', () => {
    const root = tempDir('clean-room-init-dry-run');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--task-id',
      'task-dry',
      '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would create clean-room bootstrap/);
    assert.match(result.stdout, new RegExp(path.join(artifactBase, 'task-dry').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(artifactBase), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
  });

  test('init creates generated task directories, metadata, and clean repo stub', () => {
    const root = tempDir('clean-room-init-create');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase]);

    assert.equal(result.status, 0, result.stderr);
    const taskIds = fs.readdirSync(artifactBase);
    assert.equal(taskIds.length, 1);
    assert.match(taskIds[0], /^task-[0-9a-f]{8}$/);

    const outputRoot = path.join(artifactBase, taskIds[0]);
    assert.equal(fs.existsSync(path.join(outputRoot, 'contaminated')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'clean')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'quarantine')), true);

    const metadata = readJson(path.join(outputRoot, 'clean-room-bootstrap.json'));
    assert.equal(metadata.task_id, taskIds[0]);
    assert.equal(metadata.target_profile, 'speckit-feature-folder');
    assert.equal(metadata.roots.contaminated_artifacts, path.join(outputRoot, 'contaminated'));
    assert.equal(metadata.roots.clean_artifacts, path.join(outputRoot, 'clean'));
    assert.equal(metadata.roots.quarantine, path.join(outputRoot, 'quarantine'));

    const stub = fs.readFileSync(path.join(targetDir, '.clean-room', 'README.md'), 'utf8');
    assert.match(stub, /Clean Room Bootstrap/);
    assert.match(stub, /Default target profile: `speckit-feature-folder`/);
    assert.doesNotMatch(stub, /source roots:/i);
    assert.match(result.stdout, /install safe hooks:/);
    assert.match(result.stdout, /uninstall runtime install:/);
  });

  test('init does not overwrite existing repo stub without force', () => {
    const root = tempDir('clean-room-init-conflict');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(path.join(targetDir, '.clean-room'), { recursive: true });
    const stubPath = path.join(targetDir, '.clean-room', 'README.md');
    fs.writeFileSync(stubPath, '# local clean-room notes\n');

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--task-id',
      'task-conflict',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap file already exists/);
    assert.equal(fs.readFileSync(stubPath, 'utf8'), '# local clean-room notes\n');
    assert.equal(fs.existsSync(path.join(artifactBase, 'task-conflict')), false);
  });

  test('init force overwrites existing repo stub', () => {
    const root = tempDir('clean-room-init-force');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(path.join(targetDir, '.clean-room'), { recursive: true });
    const stubPath = path.join(targetDir, '.clean-room', 'README.md');
    fs.writeFileSync(stubPath, '# local clean-room notes\n');

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--task-id',
      'task-force',
      '--force',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(stubPath, 'utf8'), /Default target profile: `speckit-feature-folder`/);
    assert.equal(fs.existsSync(path.join(artifactBase, 'task-force', 'clean-room-bootstrap.json')), true);
  });

  test('init rejects invalid target profile before writing files', () => {
    const root = tempDir('clean-room-init-invalid-profile');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--target-profile',
      'invalid-profile',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--target-profile must be one of/);
    assert.equal(fs.existsSync(artifactBase), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
  });

  test('installs Codex skills, agents, hooks, manifest, and preserves user hooks', () => {
    const codexHome = tempDir('clean-room-codex');
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
    }, null, 2));

    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'init', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'clean-architect.toml')));
    assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'contaminated-handoff-sanitizer.toml')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(codexHome, 'clean-room-install-manifest.json')));

    const hooksJson = readJson(path.join(codexHome, 'hooks.json'));
    assert.equal(
      hookTable(hooksJson).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo user-hook')
      ),
      true
    );
    assertManagedHookDetails(hooksJson);
    assert.deepEqual(managedHookMatchers(hooksJson, 'PreToolUse'), [
      'Bash|Shell|PowerShell|Monitor|exec_command|shell_command|write_stdin',
      'Read|Glob|Grep|LS|LSP|NotebookRead|view_image|list_dir|ListMcpResourcesTool|ReadMcpResourceTool|ListMcpResourceTemplatesTool|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource',
      'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    ]);
    assert.deepEqual(managedHookMatchers(hooksJson, 'PostToolUse'), [
      'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    ]);
    assert.match(postWriteHookCommand(hooksJson), /--check validate-handoff-package\.py/);
  });

  test('installs Claude skills, agents, hooks, manifest, and preserves user settings hooks', () => {
    const claudeHome = tempDir('clean-room-claude');
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'echo claude-user-hook' }],
          },
        ],
      },
    }, null, 2));

    const result = runInstall(['--claude', '--global', '--yes'], { CLAUDE_CONFIG_DIR: claudeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', 'init', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'agents', 'clean-architect.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'agents', 'contaminated-handoff-sanitizer.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));

    const settings = readJson(path.join(claudeHome, 'settings.json'));
    assert.equal(
      hookTable(settings).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo claude-user-hook')
      ),
      true
    );
    assertManagedHookDetails(settings);
    assert.deepEqual(managedHookMatchers(settings, 'PreToolUse'), [
      'Bash|Shell|PowerShell|Monitor|exec_command|shell_command|write_stdin',
      'Read|Glob|Grep|LS|LSP|NotebookRead|view_image|list_dir|ListMcpResourcesTool|ReadMcpResourceTool|ListMcpResourceTemplatesTool|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource',
      'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    ]);
    assert.match(postWriteHookCommand(settings), /--check validate-handoff-package\.py/);
  });

  test('bundled plugin hooks cover supported shell and read aliases', () => {
    const hooksJson = readJson(path.join(ROOT, 'hooks', 'hooks.json'));
    assert.deepEqual(managedHookMatchers(hooksJson, 'PreToolUse'), [
      'Bash|Shell|PowerShell|Monitor|exec_command|shell_command|write_stdin',
      'Read|Glob|Grep|LS|LSP|NotebookRead|view_image|list_dir|ListMcpResourcesTool|ReadMcpResourceTool|ListMcpResourceTemplatesTool|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource',
      'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    ]);
    assert.deepEqual(managedHookMatchers(hooksJson, 'PostToolUse'), [
      'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    ]);
  });

  test('installs Antigravity as a CLI plugin without enabling hooks', () => {
    const antigravityPlugin = path.join(tempDir('clean-room-antigravity'), 'plugins', 'clean-room');
    const result = runInstall(['--antigravity', '--global', '--yes'], {
      ANTIGRAVITY_PLUGIN_DIR: antigravityPlugin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'clean-architect.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'contaminated-handoff-sanitizer.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'clean-room-install-manifest.json')));
    assert.equal(readJson(path.join(antigravityPlugin, 'plugin.json')).hooks, undefined);
    assert.match(result.stdout, /hook registration unsupported/);
  });

  test('installs Antigravity locally to .agents plugin layout', () => {
    const cwd = tempDir('clean-room-antigravity-local');
    const result = runInstall(['--antigravity', '--local', '--yes'], {}, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'clean-room', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'clean-room', 'skills', 'clean-room', 'SKILL.md')));
  });

  test('installs all known runtime layouts locally', () => {
    const cwd = tempDir('clean-room-all-local');
    const result = runInstall(['--all', '--local', '--yes'], {}, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(cwd, '.codex', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.gemini', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.opencode', 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'clean-room', 'skills', 'clean-room', 'SKILL.md')));
  });

  test('installs all documented runtime layouts', () => {
    const root = tempDir('clean-room-all');
    const codexHome = path.join(root, 'codex');
    const claudeHome = path.join(root, 'claude');
    const antigravityPlugin = path.join(root, 'antigravity-cli', 'plugins', 'clean-room');
    const geminiHome = path.join(root, 'gemini');
    const opencodeHome = path.join(root, 'opencode');
    const kiloHome = path.join(root, 'kilo');
    const cursorHome = path.join(root, 'cursor');
    const copilotHome = path.join(root, 'copilot');
    const windsurfHome = path.join(root, 'windsurf');
    const augmentHome = path.join(root, 'augment');
    const traeHome = path.join(root, 'trae');
    const qwenHome = path.join(root, 'qwen');
    const hermesHome = path.join(root, 'hermes');
    const codebuddyHome = path.join(root, 'codebuddy');
    const result = runInstall(['--all', '--global', '--yes'], {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      ANTIGRAVITY_PLUGIN_DIR: antigravityPlugin,
      GEMINI_CONFIG_DIR: geminiHome,
      OPENCODE_CONFIG_DIR: opencodeHome,
      KILO_CONFIG_DIR: kiloHome,
      CURSOR_CONFIG_DIR: cursorHome,
      COPILOT_CONFIG_DIR: copilotHome,
      WINDSURF_CONFIG_DIR: windsurfHome,
      AUGMENT_CONFIG_DIR: augmentHome,
      TRAE_CONFIG_DIR: traeHome,
      QWEN_CONFIG_DIR: qwenHome,
      HERMES_HOME: hermesHome,
      CODEBUDDY_CONFIG_DIR: codebuddyHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'clean-architect.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'contaminated-handoff-sanitizer.md')));
    assert.ok(fs.existsSync(path.join(geminiHome, 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(kiloHome, 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(cursorHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(copilotHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(windsurfHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(augmentHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(traeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(qwenHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(hermesHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(codebuddyHome, 'skills', 'clean-room', 'SKILL.md')));
  });

  test('dry run makes no target changes', () => {
    const codexHome = path.join(tempDir('clean-room-dry-run'), 'codex');
    const result = runInstall(['--codex', '--global', '--dry-run', '--yes'], {
      CODEX_HOME: codexHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(codexHome), false);
  });

  test('generates command wrappers for command-only runtimes', () => {
    const root = tempDir('clean-room-command-wrapper');
    const geminiHome = path.join(root, 'gemini');
    const opencodeHome = path.join(root, 'opencode');

    let result = runInstall(['--gemini', '--global', '--yes'], { GEMINI_CONFIG_DIR: geminiHome });
    assert.equal(result.status, 0, result.stderr);
    const geminiCommand = path.join(geminiHome, 'commands', 'clean-room', 'clean-room.md');
    assert.ok(fs.existsSync(geminiCommand));
    assert.match(fs.readFileSync(geminiCommand, 'utf8'), /Run the bundled `clean-room` clean-room workflow/);

    result = runInstall(['--opencode', '--global', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-init.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-attended.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-refocus.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-resume.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-start-over.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-unattended.md')));
  });

  test('strict hooks fail before mutating unsupported runtimes', () => {
    const geminiHome = path.join(tempDir('clean-room-strict-hooks'), 'gemini');
    const result = runInstall(['--gemini', '--global', '--hooks=strict', '--yes'], {
      GEMINI_CONFIG_DIR: geminiHome,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--hooks=strict is not supported for gemini/);
    assert.equal(fs.existsSync(geminiHome), false);
  });

  test('installed safe hooks warn, no-op without env, and fail closed when enforced', () => {
    const codexHome = tempDir('clean-room-installed-safe-hook');
    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /safe hooks are installed but not enforcing/);

    const command = firstManagedHookCommand(path.join(codexHome, 'hooks.json'));
    let hook = spawnSync(command, {
      cwd: codexHome,
      encoding: 'utf8',
      env: {},
      input: '',
      shell: true,
    });
    assert.equal(hook.status, 0, hook.stderr);

    hook = spawnSync(command, {
      cwd: codexHome,
      encoding: 'utf8',
      env: { CLEAN_ROOM_HOOK_ENFORCE: '1' },
      input: '',
      shell: true,
    });
    assert.notEqual(hook.status, 0);
    assert.match(hook.stderr, /environment check failed/);
  });

  test('installed strict hooks fail closed without clean-room env', () => {
    const codexHome = tempDir('clean-room-installed-strict-hook');
    const result = runInstall(['--codex', '--global', '--hooks=strict', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    const command = firstManagedHookCommand(path.join(codexHome, 'hooks.json'));
    const hook = spawnSync(command, {
      cwd: codexHome,
      encoding: 'utf8',
      env: {},
      input: '',
      shell: true,
    });
    assert.notEqual(hook.status, 0);
    assert.match(hook.stderr, /environment check failed/);
  });

  test('reinstall is idempotent for managed hooks', () => {
    const codexHome = tempDir('clean-room-idempotent');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(managedHookCount(readJson(path.join(codexHome, 'hooks.json'))), 4);
  });

  test('backs up modified managed files before replacement', () => {
    const codexHome = tempDir('clean-room-backup');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    const skillPath = path.join(codexHome, 'skills', 'clean-room', 'SKILL.md');
    fs.writeFileSync(skillPath, '# local edit\n');
    result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(fs.readFileSync(skillPath, 'utf8'), '# local edit\n');

    const patchesDir = path.join(codexHome, 'clean-room-patches');
    const backups = fs.readdirSync(patchesDir);
    assert.equal(backups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(patchesDir, backups[0], 'skills', 'clean-room', 'SKILL.md'), 'utf8'),
      '# local edit\n'
    );
  });

  test('non-interactive install aborts on unknown conflicts', () => {
    const codexHome = tempDir('clean-room-conflict');
    const conflictPath = path.join(codexHome, 'skills', 'clean-room', 'SKILL.md');
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, '# user file\n');

    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(conflictPath, 'utf8'), '# user file\n');
  });

  test('install rejects pre-existing skills symlink outside target root', (t) => {
    const root = tempDir('clean-room-skills-symlink');
    const codexHome = path.join(root, 'codex');
    const outside = path.join(root, 'outside-skills');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'marker.txt'), 'keep\n');
    if (!symlinkDirOrSkip(t, outside, path.join(codexHome, 'skills'))) return;

    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install path must not contain symlinks/);
    assert.equal(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.existsSync(path.join(outside, 'clean-room')), false);
  });

  test('install rejects pre-existing hooks symlink outside target root', (t) => {
    const root = tempDir('clean-room-hooks-symlink');
    const codexHome = path.join(root, 'codex');
    const outside = path.join(root, 'outside-hooks');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    if (!symlinkDirOrSkip(t, outside, path.join(codexHome, 'hooks'))) return;

    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install path must not contain symlinks/);
    assert.equal(fs.existsSync(path.join(outside, 'clean-room')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md')), false);
  });

  test('uninstall removes only managed files and clean-room hooks', () => {
    const claudeHome = tempDir('clean-room-uninstall');
    const userSkill = path.join(claudeHome, 'skills', 'user-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(userSkill, '# user skill\n');
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'echo keep-me' }],
          },
        ],
      },
    }, null, 2));

    let result = runInstall(['--claude', '--global', '--yes'], { CLAUDE_CONFIG_DIR: claudeHome });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['--claude', '--global', '--yes', '--uninstall'], {
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')), false);
    assert.equal(fs.readFileSync(userSkill, 'utf8'), '# user skill\n');
    const settings = readJson(path.join(claudeHome, 'settings.json'));
    assert.equal(managedHookCount(settings), 0);
    assert.equal(
      hookTable(settings).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo keep-me')
      ),
      true
    );
  });

  test('uninstall warns about untracked package-path files without deleting them', () => {
    const cursorHome = tempDir('clean-room-uninstall-untracked');
    let result = runInstall(['--cursor', '--global', '--yes'], { CURSOR_CONFIG_DIR: cursorHome });
    assert.equal(result.status, 0, result.stderr);

    const manifestPath = path.join(cursorHome, 'clean-room-install-manifest.json');
    const manifest = readJson(manifestPath);
    delete manifest.files['skills/attended/SKILL.md'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const untracked = path.join(cursorHome, 'skills', 'attended', 'SKILL.md');
    assert.equal(fs.existsSync(untracked), true);
    result = runInstall(['--cursor', '--global', '--yes', '--uninstall'], {
      CURSOR_CONFIG_DIR: cursorHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /untracked package-path files left in place: 1/);
    assert.equal(fs.existsSync(untracked), true);
  });

  test('uninstall backs up modified managed files before removal', () => {
    const cursorHome = tempDir('clean-room-uninstall-backup');
    let result = runInstall(['--cursor', '--global', '--yes'], { CURSOR_CONFIG_DIR: cursorHome });
    assert.equal(result.status, 0, result.stderr);

    const skillPath = path.join(cursorHome, 'skills', 'clean-room', 'SKILL.md');
    fs.writeFileSync(skillPath, '# local edit before uninstall\n');
    result = runInstall(['--cursor', '--global', '--yes', '--uninstall'], {
      CURSOR_CONFIG_DIR: cursorHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(skillPath), false);

    const patchesDir = path.join(cursorHome, 'clean-room-patches');
    const backups = fs.readdirSync(patchesDir);
    assert.equal(backups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(patchesDir, backups[0], 'skills', 'clean-room', 'SKILL.md'), 'utf8'),
      '# local edit before uninstall\n'
    );
  });

  test('uninstall rejects symlinked managed directories without deleting outside files', (t) => {
    const root = tempDir('clean-room-uninstall-symlink');
    const codexHome = path.join(root, 'codex');
    const outside = path.join(root, 'outside-skills');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    const original = fs.readFileSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md'));
    fs.rmSync(path.join(codexHome, 'skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, 'clean-room'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'clean-room', 'SKILL.md'), original);
    if (!symlinkDirOrSkip(t, outside, path.join(codexHome, 'skills'))) return;

    result = runInstall(['--codex', '--global', '--yes', '--uninstall'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install path must not contain symlinks/);
    assert.equal(fs.existsSync(path.join(outside, 'clean-room', 'SKILL.md')), true);
  });

  test('install rejects modified managed files behind symlink without backup or overwrite', (t) => {
    const root = tempDir('clean-room-reinstall-symlink');
    const codexHome = path.join(root, 'codex');
    const outside = path.join(root, 'outside-skills');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    fs.rmSync(path.join(codexHome, 'skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, 'clean-room'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'clean-room', 'SKILL.md'), '# outside edit\n');
    if (!symlinkDirOrSkip(t, outside, path.join(codexHome, 'skills'))) return;

    result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install path must not contain symlinks/);
    assert.equal(fs.readFileSync(path.join(outside, 'clean-room', 'SKILL.md'), 'utf8'), '# outside edit\n');
    assert.equal(fs.existsSync(path.join(codexHome, 'clean-room-patches')), false);
  });

  test('uninstall without manifest removes clean-room hook registrations only', () => {
    const codexHome = tempDir('clean-room-uninstall-no-manifest');
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'python3 /tmp/hooks/clean-room-hook.py --check require-clean-room-env.py' },
              { type: 'command', command: 'echo keep-me' },
            ],
          },
        ],
      },
    }, null, 2));

    const result = runInstall(['--codex', '--global', '--yes', '--uninstall'], {
      CODEX_HOME: codexHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no install manifest found/);
    const hooksJson = readJson(path.join(codexHome, 'hooks.json'));
    assert.equal(managedHookCount(hooksJson), 0);
    assert.equal(
      hookTable(hooksJson).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo keep-me')
      ),
      true
    );
  });

  test('safe hook wrapper no-ops without env and strict/enforced mode fails closed', () => {
    let result = spawnSync('python3', [HOOK, '--mode', 'safe', '--check', 'require-clean-room-env.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {},
    });
    assert.equal(result.status, 0, result.stderr);

    result = spawnSync('python3', [HOOK, '--mode', 'strict', '--check', 'require-clean-room-env.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {},
    });
    assert.notEqual(result.status, 0);

    result = spawnSync('python3', [HOOK, '--mode', 'safe', '--check', 'require-clean-room-env.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { CLEAN_ROOM_HOOK_ENFORCE: '1' },
    });
    assert.notEqual(result.status, 0);
  });
});
