'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const HOOK = path.join(ROOT, 'hooks', 'clean-room-hook.py');
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

function runInstall(args, env = {}, cwd = ROOT) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hookTable(value) {
  return value.hooks && typeof value.hooks === 'object' ? value.hooks : value;
}

function managedHookCount(value) {
  const table = hookTable(value);
  let count = 0;
  for (const entries of Object.values(table)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
          count += 1;
        }
      }
    }
  }
  return count;
}

function postWriteHookCommand(value) {
  const entries = hookTable(value).PostToolUse || [];
  for (const entry of entries) {
    if (entry.matcher !== 'Write|Edit|MultiEdit') continue;
    for (const hook of entry.hooks || []) {
      if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
        return hook.command;
      }
    }
  }
  return null;
}

describe('clean-room-skill installer', () => {
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
    assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'clean-architect.toml')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(codexHome, 'clean-room-install-manifest.json')));

    const hooksJson = readJson(path.join(codexHome, 'hooks.json'));
    assert.equal(
      hookTable(hooksJson).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo user-hook')
      ),
      true
    );
    assert.equal(managedHookCount(hooksJson), 4);
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
    assert.ok(fs.existsSync(path.join(claudeHome, 'agents', 'clean-architect.md')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));

    const settings = readJson(path.join(claudeHome, 'settings.json'));
    assert.equal(
      hookTable(settings).PreToolUse.some((entry) =>
        (entry.hooks || []).some((hook) => hook.command === 'echo claude-user-hook')
      ),
      true
    );
    assert.equal(managedHookCount(settings), 4);
    assert.match(postWriteHookCommand(settings), /--check validate-handoff-package\.py/);
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

  test('installs all supported runtimes locally', () => {
    const cwd = tempDir('clean-room-all-local');
    const result = runInstall(['--all', '--local', '--yes'], {}, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(cwd, '.codex', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.gemini', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.opencode', 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'clean-room', 'skills', 'clean-room', 'SKILL.md')));
  });

  test('installs all documented runtimes', () => {
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
    assert.ok(fs.existsSync(path.join(geminiHome, 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(kiloHome, 'command', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(cursorHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(copilotHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(windsurfHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(augmentHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(traeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(qwenHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(hermesHome, 'skills', 'clean-room', 'clean-room', 'SKILL.md')));
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
