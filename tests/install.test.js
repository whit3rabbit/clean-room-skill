'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const {
  applyInstall,
  applyUninstall,
  planInstall,
  planUninstall,
} = require('../lib/install-plan.cjs');
const {
  parseRuntimeSelection,
  runtimeInstallStatus,
} = require('../bin/install.js');
const {
  atomicWriteFileNoOverwrite,
  listFiles,
  sha256Bytes,
} = require('../lib/fs-utils.cjs');
const { OPENCODE_PLUGIN_MARKER } = require('../lib/hooks.cjs');
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

const TEST_TIMEOUT_MS = 30_000;
const CLAUDE_PLUGIN_ID = 'clean-room@clean-room-skill';
const CLAUDE_MARKETPLACE_NAME = 'clean-room-skill';
const CLAUDE_PLUGIN_SOURCE_URL = 'https://github.com/whit3rabbit/clean-room-skill.git';

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) {
    return nodeSpawnSync(command, { timeout: TEST_TIMEOUT_MS, ...(args || {}) });
  }
  return nodeSpawnSync(command, args, { timeout: TEST_TIMEOUT_MS, ...(options || {}) });
}

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

function assertOpenCodePlugin(root, mode = 'safe') {
  const pluginPath = path.join(root, 'plugins', 'clean-room.ts');
  assert.ok(fs.existsSync(pluginPath));
  const content = fs.readFileSync(pluginPath, 'utf8');
  assert.ok(content.includes(OPENCODE_PLUGIN_MARKER));
  assert.match(content, /"tool\.execute\.before"/);
  assert.match(content, /"tool\.execute\.after"/);
  assert.match(content, /shell: false/);
  assert.match(content, new RegExp(`const CLEAN_ROOM_HOOK_MODE = "${mode}"`));
  const wrapper = content.match(/const CLEAN_ROOM_HOOK_WRAPPER = "([^"]+)"/)?.[1];
  assert.ok(wrapper);
  assert.equal(path.isAbsolute(wrapper), true);
  assert.equal(
    fs.realpathSync.native(wrapper),
    fs.realpathSync.native(path.join(root, 'hooks', 'clean-room', 'clean-room-hook.py'))
  );
  assert.match(content, /deny-clean-room-shell\.py/);
  assert.match(content, /deny-clean-source-read\.py/);
  assert.match(content, /deny-contaminated-clean-write\.py/);
  assert.match(content, /validate-handoff-package\.py/);
  return content;
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

function writeRenameFailurePreload(root, basename, failOn = 1) {
  const preload = path.join(root, `fail-${basename}.cjs`);
  fs.writeFileSync(preload, `
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const realRenameSync = fs.renameSync;
let seen = 0;

fs.renameSync = function renameSyncWithInjectedFailure(source, destination) {
  if (path.basename(String(destination)) === ${JSON.stringify(basename)}) {
    seen += 1;
    if (seen === ${Number(failOn)}) {
      const err = new Error('injected rename failure for ' + destination);
      err.code = 'EACCES';
      throw err;
    }
  }
  return realRenameSync.apply(this, arguments);
};
`);
  return preload;
}

function writeLock(lockPath, pid, createdAt) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    pid,
    created_at: createdAt.toISOString(),
  }, null, 2)}\n`);
  fs.utimesSync(lockPath, createdAt, createdAt);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packageVersion() {
  return readJson(path.join(ROOT, 'package.json')).version;
}

function claudePluginSource() {
  return `${CLAUDE_PLUGIN_SOURCE_URL}#v${packageVersion()}`;
}

function createClaudeStub(root, initial = {}) {
  const homeDir = path.join(root, 'home');
  const binDir = path.join(homeDir, '.local', 'bin');
  const statePath = path.join(root, 'claude-plugin-state.json');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    marketplaces: initial.marketplaces ? [CLAUDE_MARKETPLACE_NAME] : [],
    plugins: initial.plugins ? [CLAUDE_PLUGIN_ID] : [],
    calls: [],
  }, null, 2)}\n`);

  const stubPath = path.join(binDir, 'claude');
  fs.writeFileSync(stubPath, `#!${process.execPath}
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const statePath = process.env.CLEAN_ROOM_CLAUDE_STUB_STATE;
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '.', '.claude');
const marketplaceName = ${JSON.stringify(CLAUDE_MARKETPLACE_NAME)};
const pluginId = ${JSON.stringify(CLAUDE_PLUGIN_ID)};
const pluginSource = ${JSON.stringify(CLAUDE_PLUGIN_SOURCE_URL)};
const version = ${JSON.stringify(packageVersion())};
const agentFiles = ${JSON.stringify([
  'clean-architect.md',
  'clean-implementer-verifier-shell.md',
  'clean-polish-reviewer.md',
  'clean-qa-editor.md',
  'contaminated-handoff-sanitizer.md',
  'contaminated-manager-verifier.md',
  'contaminated-source-analyst.md',
])};
const args = process.argv.slice(2);

function pluginInstallPath() {
  return path.join(configDir, 'plugins', 'cache', marketplaceName, 'clean-room', version);
}

function writePluginFiles() {
  const root = pluginInstallPath();
  fs.mkdirSync(path.join(root, 'skills', 'clean-room', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
    name: 'clean-room',
    skills: './skills/',
    agents: './agents/'
  }, null, 2) + '\\n');
  for (const file of agentFiles) {
    fs.writeFileSync(path.join(root, 'agents', file), '# stub agent\\n');
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { marketplaces: [], plugins: [], calls: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n');
}

function has(value, list) {
  return Array.isArray(list) && list.includes(value);
}

const state = readState();
state.calls.push({ args, configDir });

const fail = process.env.CLEAN_ROOM_CLAUDE_STUB_FAIL;
if (fail && args.join(' ').includes(fail)) {
  writeState(state);
  console.error('stubbed claude failure for ' + fail);
  process.exit(42);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list' && args.includes('--json')) {
  console.log(JSON.stringify((state.marketplaces || []).map((name) => ({
    name,
    source: 'git',
    url: pluginSource,
    installLocation: path.join(configDir, 'plugins', 'marketplaces', name),
  }))));
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (!has(marketplaceName, state.marketplaces)) state.marketplaces.push(marketplaceName);
  console.log('stub marketplace added');
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  state.marketplaces = (state.marketplaces || []).filter((name) => name !== marketplaceName);
  state.plugins = (state.plugins || []).filter((id) => id !== pluginId);
  console.log('stub marketplace removed');
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'update') {
  console.log('stub marketplace updated');
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'list' && args.includes('--json')) {
  if (has(pluginId, state.plugins)) writePluginFiles();
  console.log(JSON.stringify((state.plugins || []).map((id) => ({
    id,
    version,
    scope: 'user',
    enabled: true,
    installPath: pluginInstallPath(),
  }))));
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'install') {
  if (!has(pluginId, state.plugins)) state.plugins.push(pluginId);
  writePluginFiles();
  console.log('stub plugin installed');
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'update') {
  if (has(pluginId, state.plugins)) writePluginFiles();
  console.log('stub plugin updated');
  writeState(state);
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'uninstall') {
  state.plugins = (state.plugins || []).filter((id) => id !== pluginId);
  console.log('stub plugin uninstalled');
  writeState(state);
  process.exit(0);
}

console.error('unexpected claude stub command: ' + args.join(' '));
writeState(state);
process.exit(2);
`);
  fs.chmodSync(stubPath, 0o755);

  return {
    binDir,
    homeDir,
    statePath,
    executable: stubPath,
    env: {
      HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      CLEAN_ROOM_CLAUDE_EXECUTABLE: stubPath,
      CLEAN_ROOM_CLAUDE_STUB_STATE: statePath,
    },
  };
}

function readClaudeStubCalls(stub) {
  return readJson(stub.statePath).calls.map((call) => call.args.join(' '));
}

function writeClaudeHijack(binDir, markerPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const stubPath = path.join(binDir, 'claude');
  fs.writeFileSync(stubPath, `#!/bin/sh
printf '%s\\n' "$*" > "${markerPath}"
case " $* " in
  *" --json"*) printf '[]\\n' ;;
esac
exit 0
`);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function writeClaudeWrapper(wrapperPath, targetPath) {
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh
exec "${targetPath}" "$@"
`);
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function writeLegacyClaudeStandaloneInstall(claudeHome) {
  const files = {};
  function writeManaged(relPath, content) {
    const fullPath = path.join(claudeHome, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    files[relPath] = { sha256: sha256Bytes(Buffer.from(content)) };
  }

  writeManaged('skills/clean-room/SKILL.md', '# legacy clean-room skill\n');
  writeManaged('skills/init/SKILL.md', '# legacy init skill\n');
  writeManaged('agents/clean-architect.md', '# legacy clean architect\n');
  fs.writeFileSync(path.join(claudeHome, 'clean-room-install-manifest.json'), `${JSON.stringify({
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    runtime: 'claude',
    scope: 'global',
    hooks_mode: 'copy-only',
    phase: 'complete',
    installed_at: new Date().toISOString(),
    files,
  }, null, 2)}\n`);
}

describe('clean-room-skill installer', () => {
  test('prints installed package version', () => {
    const result = runInstall(['--version']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageVersion());
    assert.equal(result.stderr, '');
  });

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
    assert.match(result.stdout, /project: proj-[0-9a-f]{8} \(new\)/);
    assert.match(result.stdout, new RegExp(`${escapeRegExp(artifactBase)}[/\\\\]proj-[0-9a-f]{8}[/\\\\]tasks[/\\\\]task-dry`));
    assert.equal(fs.existsSync(artifactBase), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
  });

  test('init creates generated project task directories, metadata, and clean repo stub', () => {
    const root = tempDir('clean-room-init-create');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase]);

    assert.equal(result.status, 0, result.stderr);
    const projectIds = fs.readdirSync(artifactBase);
    assert.equal(projectIds.length, 1);
    assert.match(projectIds[0], /^proj-[0-9a-f]{8}$/);

    const projectRoot = path.join(artifactBase, projectIds[0]);
    const taskIds = fs.readdirSync(path.join(projectRoot, 'tasks'));
    assert.equal(taskIds.length, 1);
    assert.match(taskIds[0], /^task-[0-9a-f]{8}$/);

    const outputRoot = path.join(projectRoot, 'tasks', taskIds[0]);
    assert.equal(fs.existsSync(path.join(outputRoot, 'contaminated')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'clean')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'implementation')), false);
    assert.equal(fs.existsSync(path.join(outputRoot, 'quarantine')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'implementation')), true);

    const projectMetadata = readJson(path.join(projectRoot, 'clean-room-project.json'));
    assert.equal(projectMetadata.project_id, projectIds[0]);
    assert.equal(projectMetadata.project_root, projectRoot);
    assert.equal(projectMetadata.implementation_root, path.join(projectRoot, 'implementation'));

    const metadata = readJson(path.join(outputRoot, 'clean-room-bootstrap.json'));
    assert.equal(metadata.layout, 'project');
    assert.equal(metadata.project_id, projectIds[0]);
    assert.equal(metadata.project_root, projectRoot);
    assert.equal(metadata.task_id, taskIds[0]);
    assert.equal(metadata.target_profile, 'speckit-feature-folder');
    assert.equal(fs.existsSync(path.join(artifactBase, 'clean-room-project.json')), false);
    assert.equal(fs.existsSync(path.join(outputRoot, 'tasks')), false);
    assert.equal(metadata.roots.contaminated_artifacts, path.join(outputRoot, 'contaminated'));
    assert.equal(metadata.roots.clean_artifacts, path.join(outputRoot, 'clean'));
    assert.equal(metadata.roots.implementation_root, path.join(projectRoot, 'implementation'));
    assert.equal(metadata.roots.quarantine, path.join(outputRoot, 'quarantine'));

    const stub = fs.readFileSync(path.join(targetDir, '.clean-room', 'README.md'), 'utf8');
    assert.match(stub, /Clean Room Bootstrap/);
    assert.match(stub, /Default target profile: `speckit-feature-folder`/);
    assert.match(stub, /shared `implementation\/` clean destination/);
    assert.doesNotMatch(stub, /source roots:/i);
    assert.match(result.stdout, /project: proj-[0-9a-f]{8} \(new\)/);
    assert.match(result.stdout, /project root:/);
    assert.match(result.stdout, /task root:/);
    assert.match(result.stdout, /implementation root \(shared\):/);
    assert.match(result.stdout, /Codex:/);
    assert.match(result.stdout, /npx clean-room-skill@latest --codex --global --hooks=safe --yes/);
    assert.match(result.stdout, /start in Codex: invoke the init skill, then clean-room through @ or the skills UI/);
    assert.match(result.stdout, /npx clean-room-skill@latest --codex --global --uninstall --yes/);
    assert.match(result.stdout, /Claude Code:/);
    assert.match(result.stdout, /npx clean-room-skill@latest --claude --global --hooks=safe --yes/);
    assert.match(result.stdout, /start in Claude Code: \/clean-room:init, then \/clean-room or \/clean-room:attended/);
    assert.match(result.stdout, /npx clean-room-skill@latest --claude --global --uninstall --yes/);
    assert.match(result.stdout, /Pi:/);
    assert.match(result.stdout, /pi install npm:clean-room-skill@latest/);
    assert.match(result.stdout, /npx clean-room-skill@latest --pi --global --yes/);
    assert.match(result.stdout, /start in Pi: \/skill:init, then \/skill:clean-room or \/skill:attended/);
    assert.match(result.stdout, /Pi installs do not register clean-room hooks/);
    const codexStartLine = result.stdout.split('\n').find((line) => line.includes('start in Codex:'));
    assert.ok(codexStartLine);
    assert.doesNotMatch(codexStartLine, /\/clean-room/);
  });

  test('init --single-task creates the legacy flat task layout', () => {
    const root = tempDir('clean-room-init-single-task');
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
      'task-single',
      '--single-task',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const outputRoot = path.join(artifactBase, 'task-single');
    assert.equal(fs.existsSync(path.join(outputRoot, 'contaminated')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'clean')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'implementation')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'quarantine')), true);
    assert.equal(fs.existsSync(path.join(artifactBase, 'clean-room-project.json')), false);
    const metadata = readJson(path.join(outputRoot, 'clean-room-bootstrap.json'));
    assert.equal('layout' in metadata, false);
    assert.equal('project_id' in metadata, false);
    assert.equal(metadata.roots.implementation_root, path.join(outputRoot, 'implementation'));
    assert.match(result.stdout, /task root:/);
    assert.doesNotMatch(result.stdout, /project root:/);
    assert.match(result.stdout, /implementation root:/);
    assert.doesNotMatch(result.stdout, /implementation root \(shared\):/);
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
      '--single-task',
      '--force',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(stubPath, 'utf8'), /Default target profile: `speckit-feature-folder`/);
    assert.equal(fs.existsSync(path.join(artifactBase, 'task-force', 'clean-room-bootstrap.json')), true);
    assert.equal(fs.existsSync(path.join(artifactBase, 'task-force', 'implementation')), true);
  });

  test('init rejects existing generated task paths without force', () => {
    const root = tempDir('clean-room-init-existing-generated');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-existing');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(taskRoot, 'contaminated'), { recursive: true });

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--task-id',
      'task-existing',
      '--single-task',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap generated path already exists/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'clean-room-bootstrap.json')), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
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

  test('init project mode creates project layout with shared implementation root', () => {
    const root = tempDir('clean-room-init-project-create');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    const taskRoot = path.join(projectRoot, 'tasks', 'task-aaaa1111');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall([
      'init',
      '--target-dir',
      targetDir,
      '--artifact-base',
      artifactBase,
      '--project',
      'amber-meadow',
      '--task-id',
      'task-aaaa1111',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /project: amber-meadow \(new\)/);
    assert.match(result.stdout, /implementation root \(shared\):/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated')), true);
    assert.equal(fs.existsSync(path.join(taskRoot, 'clean')), true);
    assert.equal(fs.existsSync(path.join(taskRoot, 'quarantine')), true);
    assert.equal(fs.existsSync(path.join(taskRoot, 'implementation')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'implementation')), true);

    const projectMetadata = readJson(path.join(projectRoot, 'clean-room-project.json'));
    assert.equal(projectMetadata.schema, 1);
    assert.equal(projectMetadata.project_id, 'amber-meadow');
    assert.equal(projectMetadata.project_root, projectRoot);
    assert.equal(projectMetadata.implementation_root, path.join(projectRoot, 'implementation'));
    assert.equal(projectMetadata.tasks_dir, path.join(projectRoot, 'tasks'));

    const metadata = readJson(path.join(taskRoot, 'clean-room-bootstrap.json'));
    assert.equal(metadata.layout, 'project');
    assert.equal(metadata.project_id, 'amber-meadow');
    assert.equal(metadata.project_root, projectRoot);
    assert.equal(metadata.task_id, 'task-aaaa1111');
    assert.equal(metadata.output_root, taskRoot);
    assert.equal(metadata.roots.contaminated_artifacts, path.join(taskRoot, 'contaminated'));
    assert.equal(metadata.roots.implementation_root, path.join(projectRoot, 'implementation'));
  });

  test('init project mode joins existing project without force', () => {
    const root = tempDir('clean-room-init-project-join');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    fs.mkdirSync(targetDir, { recursive: true });

    const first = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const projectMetadataBefore = fs.readFileSync(path.join(projectRoot, 'clean-room-project.json'), 'utf8');

    const second = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-bbbb2222',
    ]);

    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /project: amber-meadow \(existing\)/);
    assert.equal(fs.existsSync(path.join(projectRoot, 'tasks', 'task-bbbb2222', 'contaminated')), true);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, 'clean-room-project.json'), 'utf8'),
      projectMetadataBefore,
    );
    const metadata = readJson(path.join(projectRoot, 'tasks', 'task-bbbb2222', 'clean-room-bootstrap.json'));
    assert.equal(metadata.roots.implementation_root, path.join(projectRoot, 'implementation'));
  });

  test('init new-project generates a neutral project id', () => {
    const root = tempDir('clean-room-init-new-project');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--new-project',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const projectIds = fs.readdirSync(artifactBase);
    assert.equal(projectIds.length, 1);
    assert.match(projectIds[0], /^proj-[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(path.join(artifactBase, projectIds[0], 'clean-room-project.json')), true);
    assert.equal(fs.existsSync(path.join(artifactBase, projectIds[0], 'implementation')), true);
  });

  test('init rejects invalid project names and conflicting project flags', () => {
    const root = tempDir('clean-room-init-project-invalid');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const badName = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--project', 'Amber_Meadow',
    ]);
    assert.notEqual(badName.status, 0);
    assert.match(badName.stderr, /--project must match/);
    assert.equal(fs.existsSync(artifactBase), false);

    const conflicting = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--new-project',
    ]);
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /--project and --new-project cannot be combined/);
    assert.equal(fs.existsSync(artifactBase), false);

    const singleTaskProject = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--single-task',
    ]);
    assert.notEqual(singleTaskProject.status, 0);
    assert.match(singleTaskProject.stderr, /--single-task cannot be combined/);
    assert.equal(fs.existsSync(artifactBase), false);

    const singleTaskNewProject = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--new-project', '--single-task',
    ]);
    assert.notEqual(singleTaskNewProject.status, 0);
    assert.match(singleTaskNewProject.stderr, /--single-task cannot be combined/);
    assert.equal(fs.existsSync(artifactBase), false);
  });

  test('init rejects project names derived from the target workspace name', () => {
    const root = tempDir('clean-room-init-project-neutrality');
    const targetDir = path.join(root, 'widgetizer');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    for (const projectName of ['widgetizer', 'my-widgetizer-port']) {
      const result = runInstall([
        'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--project', projectName,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--project must be a neutral name/);
    }
    assert.equal(fs.existsSync(artifactBase), false);
  });

  test('init rejects project names derived from short workspace names', () => {
    // Regression: clause-2 threshold was 4; workspace tokens of len 2-3 bypassed the guard.
    const root = tempDir('clean-room-init-project-neutrality-short');
    const targetDir = path.join(root, 'xyz');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    // 'xyz' (len 3) contained in 'xyz-feature' (token 'xyzfeature') must be caught.
    const derived = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--project', 'xyz-feature',
    ]);
    assert.notEqual(derived.status, 0);
    assert.match(derived.stderr, /--project must be a neutral name/);

    // A genuinely neutral name that does not contain 'xyz' must be allowed.
    const neutral = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--project', 'proj-alpha',
    ]);
    assert.equal(neutral.status, 0, neutral.stderr);
    assert.equal(fs.existsSync(path.join(artifactBase, 'proj-alpha', 'clean-room-project.json')), true);
  });

  test('init rejects existing project root without metadata unless forced', () => {
    const root = tempDir('clean-room-init-project-adopt');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-room-project\.json is missing; use --force to adopt/);
    assert.equal(fs.existsSync(path.join(projectRoot, 'tasks')), false);

    const forced = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111', '--force',
    ]);
    assert.equal(forced.status, 0, forced.stderr);
    const projectMetadata = readJson(path.join(projectRoot, 'clean-room-project.json'));
    assert.equal(projectMetadata.project_id, 'amber-meadow');
  });

  test('init --force warns when adopting a project root that lacks metadata', () => {
    const root = tempDir('clean-room-init-project-force-warn');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111', '--force',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning:.*--force is adopting project root without clean-room-project\.json/);
    // Metadata is stamped by the forced write.
    const written = readJson(path.join(projectRoot, 'clean-room-project.json'));
    assert.equal(written.project_id, 'amber-meadow');
  });

  test('init force rewrite preserves original project created_at', () => {
    const root = tempDir('clean-room-init-project-created-at');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectMetadataPath = path.join(artifactBase, 'amber-meadow', 'clean-room-project.json');
    fs.mkdirSync(targetDir, { recursive: true });

    const first = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(first.status, 0, first.stderr);

    const metadata = readJson(projectMetadataPath);
    metadata.created_at = '2020-01-02T03:04:05.000Z';
    fs.writeFileSync(projectMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const forced = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-bbbb2222', '--force',
    ]);
    assert.equal(forced.status, 0, forced.stderr);
    const rewritten = readJson(projectMetadataPath);
    assert.equal(rewritten.created_at, '2020-01-02T03:04:05.000Z');
    assert.equal(rewritten.project_id, 'amber-meadow');
  });

  test('init rejects existing generated task paths inside a project', () => {
    const root = tempDir('clean-room-init-project-task-conflict');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    fs.mkdirSync(targetDir, { recursive: true });

    const first = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(first.status, 0, first.stderr);
    fs.mkdirSync(path.join(projectRoot, 'tasks', 'task-bbbb2222', 'contaminated'), { recursive: true });

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-bbbb2222',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap generated path already exists/);
    assert.equal(fs.existsSync(path.join(projectRoot, 'tasks', 'task-bbbb2222', 'clean-room-bootstrap.json')), false);
  });

  test('init project dry run makes no changes', () => {
    const root = tempDir('clean-room-init-project-dry-run');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111', '--dry-run',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would create clean-room bootstrap/);
    assert.match(result.stdout, /project: amber-meadow \(new\)/);
    assert.match(result.stdout, /implementation root \(shared\):/);
    assert.equal(fs.existsSync(artifactBase), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
  });

  test('init project dry run succeeds even when project root exists without metadata', () => {
    // Regression: assertWritableTargets called resolveExistingProject before the
    // dryRun guard, causing --dry-run to throw on imperfect existing project roots.
    const root = tempDir('clean-room-init-project-dry-run-imperfect');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true }); // no metadata file

    const result = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111', '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would create clean-room bootstrap/);
    // Dry run must not write any files.
    assert.equal(fs.existsSync(path.join(projectRoot, 'clean-room-project.json')), false);
    assert.equal(fs.existsSync(path.join(targetDir, '.clean-room')), false);
  });

  test('preflight template writes an attended draft with blocking questions', () => {
    const root = tempDir('clean-room-preflight-template');
    const output = path.join(root, 'preflight-goal.json');

    const result = runInstall(['preflight', '--template', '--output', output]);

    assert.equal(result.status, 0, result.stderr);
    const goal = readJson(output);
    assert.equal(goal.controller_policy.mode, 'attended');
    assert.equal(goal.controller_policy.unattended_allowed_after_preflight, false);
    assert.equal(goal.open_questions.some((question) => question.blocking === true), true);
    assert.match(result.stdout, /Wrote preflight goal/);
  });

  test('preflight bootstrap task root writes to generated contaminated root', () => {
    const root = tempDir('clean-room-preflight-bootstrap-root');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-bootstrap-root');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-bootstrap-root', '--single-task']);
    assert.equal(init.status, 0, init.stderr);

    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);
    const output = path.join(taskRoot, 'contaminated', 'preflight-goal.json');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(output), true);
    const goal = readJson(output);
    assert.equal(goal.controller_policy.mode, 'attended');
    assert.equal(goal.output_policy.artifact_base_root, taskRoot);
    assert.equal(goal.output_policy.implementation_root, path.join(taskRoot, 'implementation'));
    assert.match(result.stdout, /Wrote preflight goal/);
  });

  test('preflight bootstrap metadata path writes to generated contaminated root', () => {
    const root = tempDir('clean-room-preflight-bootstrap-metadata');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-bootstrap-metadata');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-bootstrap-metadata', '--single-task']);
    assert.equal(init.status, 0, init.stderr);

    const result = runInstall([
      'preflight',
      '--template',
      '--bootstrap',
      path.join(taskRoot, 'clean-room-bootstrap.json'),
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated', 'preflight-goal.json')), true);
    const goal = readJson(path.join(taskRoot, 'contaminated', 'preflight-goal.json'));
    assert.equal(goal.output_policy.artifact_base_root, taskRoot);
    assert.equal(goal.output_policy.implementation_root, path.join(taskRoot, 'implementation'));
  });

  test('preflight bootstrap rejects input contracts with mismatched output roots', () => {
    const root = tempDir('clean-room-preflight-bootstrap-input-mismatch');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-bootstrap-input-mismatch');
    const input = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-bootstrap-input-mismatch', '--single-task']);
    assert.equal(init.status, 0, init.stderr);

    const result = runInstall(['preflight', '--input', input, '--bootstrap', taskRoot]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight goal does not match bootstrap scaffold/);
    assert.match(result.stderr, /output_policy\.artifact_base_root must match bootstrap task root/);
    assert.match(result.stderr, /output_policy\.implementation_root must match bootstrap implementation root/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated', 'preflight-goal.json')), false);
  });

  test('preflight bootstrap accepts input contracts with matching output roots', () => {
    const root = tempDir('clean-room-preflight-bootstrap-input-match');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-bootstrap-input-match');
    const input = path.join(root, 'preflight-goal.json');
    const goal = readJson(path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json'));
    goal.output_policy.artifact_base_root = taskRoot;
    goal.output_policy.implementation_root = path.join(taskRoot, 'implementation');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(input, `${JSON.stringify(goal, null, 2)}\n`);

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-bootstrap-input-match', '--single-task']);
    assert.equal(init.status, 0, init.stderr);

    const result = runInstall(['preflight', '--input', input, '--bootstrap', taskRoot]);
    const output = path.join(taskRoot, 'contaminated', 'preflight-goal.json');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(output), true);
    const written = readJson(output);
    assert.equal(written.output_policy.artifact_base_root, taskRoot);
    assert.equal(written.output_policy.implementation_root, path.join(taskRoot, 'implementation'));
  });

  test('preflight bootstrap project task root writes goal with shared implementation root', () => {
    const root = tempDir('clean-room-preflight-bootstrap-project');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    const taskRoot = path.join(projectRoot, 'tasks', 'task-aaaa1111');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(init.status, 0, init.stderr);

    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);
    const output = path.join(taskRoot, 'contaminated', 'preflight-goal.json');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(output), true);
    const goal = readJson(output);
    assert.equal(goal.output_policy.artifact_base_root, taskRoot);
    assert.equal(goal.output_policy.implementation_root, path.join(projectRoot, 'implementation'));
  });

  test('preflight rejects project scaffold with missing shared implementation root', () => {
    const root = tempDir('clean-room-preflight-bootstrap-project-broken');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    const taskRoot = path.join(projectRoot, 'tasks', 'task-aaaa1111');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(init.status, 0, init.stderr);
    fs.rmSync(path.join(projectRoot, 'implementation'), { recursive: true, force: true });

    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap scaffold is invalid/);
    assert.match(result.stderr, /bootstrap implementation directory missing/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated', 'preflight-goal.json')), false);
  });

  test('preflight rejects project scaffold with tampered project root metadata', () => {
    const root = tempDir('clean-room-preflight-bootstrap-project-tampered');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const projectRoot = path.join(artifactBase, 'amber-meadow');
    const taskRoot = path.join(projectRoot, 'tasks', 'task-aaaa1111');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase,
      '--project', 'amber-meadow', '--task-id', 'task-aaaa1111',
    ]);
    assert.equal(init.status, 0, init.stderr);

    const metadataPath = path.join(taskRoot, 'clean-room-bootstrap.json');
    const metadata = readJson(metadataPath);
    metadata.project_root = path.join(root, 'elsewhere');
    metadata.roots.implementation_root = path.join(root, 'elsewhere', 'implementation');
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap scaffold is invalid/);
    assert.match(result.stderr, /project_root must match/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated', 'preflight-goal.json')), false);
  });

  test('validateBootstrapScaffold does not treat stray project_id field as project layout', () => {
    // Regression: layout detection keyed on presence of any of
    // layout/project_id/project_root; a stray project_id breadcrumb on a flat task
    // would flip detection and attempt project-layout validation, causing a spurious
    // "must live under a tasks/ directory" error.
    const root = tempDir('clean-room-preflight-bootstrap-stray-project-id');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-stray-id');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall([
      'init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-stray-id', '--single-task',
    ]);
    assert.equal(init.status, 0, init.stderr);

    // Inject a stray project_id without setting layout: 'project'.
    const metadataPath = path.join(taskRoot, 'clean-room-bootstrap.json');
    const metadata = readJson(metadataPath);
    metadata.project_id = 'stray-field';
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    // Must succeed: stray project_id without layout:'project' should not trigger
    // project-layout validation.
    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);
    assert.equal(result.status, 0, result.stderr);
  });

  test('preflight rejects broken bootstrap scaffold without writing', () => {
    const root = tempDir('clean-room-preflight-bootstrap-broken');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const taskRoot = path.join(artifactBase, 'task-bootstrap-broken');
    fs.mkdirSync(targetDir, { recursive: true });

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', artifactBase, '--task-id', 'task-bootstrap-broken', '--single-task']);
    assert.equal(init.status, 0, init.stderr);
    fs.rmSync(path.join(taskRoot, 'implementation'), { recursive: true, force: true });

    const result = runInstall(['preflight', '--template', '--bootstrap', taskRoot]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap scaffold is invalid/);
    assert.match(result.stderr, /bootstrap implementation directory missing/);
    assert.equal(fs.existsSync(path.join(taskRoot, 'contaminated', 'preflight-goal.json')), false);
  });

  test('preflight rejects symlinked bootstrap task root', () => {
    const root = tempDir('clean-room-preflight-bootstrap-symlink');
    const targetDir = path.join(root, 'repo');
    const artifactBase = path.join(root, 'artifacts');
    const realTaskRoot = path.join(root, 'real-task-root');
    const symlinkTaskRoot = path.join(artifactBase, 'task-bootstrap-symlink');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.dirname(symlinkTaskRoot), { recursive: true });

    const init = runInstall(['init', '--target-dir', targetDir, '--artifact-base', root, '--task-id', 'real-task-root', '--single-task']);
    assert.equal(init.status, 0, init.stderr);

    fs.symlinkSync(realTaskRoot, symlinkTaskRoot, 'dir');

    const result = runInstall(['preflight', '--template', '--bootstrap', symlinkTaskRoot]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap scaffold is invalid/);
    assert.match(result.stderr, /bootstrap task root must not be a symbolic link/);
    assert.equal(fs.existsSync(path.join(realTaskRoot, 'contaminated', 'preflight-goal.json')), false);
  });

  test('preflight rejects bootstrap and output together', () => {
    const root = tempDir('clean-room-preflight-bootstrap-output');
    const output = path.join(root, 'preflight-goal.json');

    const result = runInstall([
      'preflight',
      '--template',
      '--bootstrap',
      path.join(root, 'task-root'),
      '--output',
      output,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--bootstrap conflicts with --output/);
    assert.equal(fs.existsSync(output), false);
  });

  test('preflight dry run does not write output', () => {
    const root = tempDir('clean-room-preflight-dry-run');
    const output = path.join(root, 'preflight-goal.json');

    const result = runInstall(['preflight', '--template', '--output', output, '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would write preflight goal/);
    assert.equal(fs.existsSync(output), false);
  });

  test('preflight input validates and normalizes a completed contract', () => {
    const root = tempDir('clean-room-preflight-input');
    const input = path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json');
    const output = path.join(root, 'preflight-goal.json');

    const result = runInstall(['preflight', '--input', input, '--output', output]);

    assert.equal(result.status, 0, result.stderr);
    const goal = readJson(output);
    assert.equal(goal.goal_id, 'goal-task-example');
    assert.equal(goal.open_questions.length, 0);
  });

  test('preflight refuses overwrite without force and allows force', () => {
    const root = tempDir('clean-room-preflight-force');
    const output = path.join(root, 'preflight-goal.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(output, '{"existing":true}\n');

    let result = runInstall(['preflight', '--template', '--output', output]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.deepEqual(readJson(output), { existing: true });

    result = runInstall(['preflight', '--template', '--output', output, '--force']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson(output).controller_policy.mode, 'attended');
  });

  test('preflight rejects unattended template and unattended open questions', () => {
    const root = tempDir('clean-room-preflight-unattended');
    const output = path.join(root, 'preflight-goal.json');

    let result = runInstall(['preflight', '--template', '--mode', 'unattended', '--output', output]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /template supports attended/);

    const input = path.join(root, 'unattended-open.json');
    const goal = readJson(path.join(ROOT, 'skills', 'clean-room', 'examples', 'contaminated-side', 'preflight-goal.json'));
    goal.controller_policy.mode = 'unattended';
    goal.controller_policy.unattended_allowed_after_preflight = true;
    goal.open_questions = [
      {
        question_id: 'blocking',
        question: 'Still unclear.',
        blocking: true,
      },
    ];
    fs.writeFileSync(input, `${JSON.stringify(goal, null, 2)}\n`);

    result = runInstall(['preflight', '--input', input, '--mode', 'unattended', '--output', output]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires no open_questions/);
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
    assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'clean-polish-reviewer.toml')));
    assert.ok(fs.existsSync(path.join(codexHome, 'agents', 'contaminated-handoff-sanitizer.toml')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'clean-room', 'agent3-verification-runner.py')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'clean-room', 'agent4-polish-runner.py')));
    assert.ok(fs.existsSync(path.join(codexHome, 'clean-room-install-manifest.json')));
    assert.equal(readJson(path.join(codexHome, 'clean-room-install-manifest.json')).phase, 'complete');

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

  test('installs Claude plugin, hooks, manifest, and preserves user settings hooks', () => {
    const root = tempDir('clean-room-claude');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));
    fs.mkdirSync(claudeHome, { recursive: true });
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

    const result = runInstall(['--claude', '--global', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'init', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'agents', 'clean-architect.md')), false);
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'agent3-verification-runner.py')));
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'agent4-polish-runner.py')));
    const manifest = readJson(path.join(claudeHome, 'clean-room-install-manifest.json'));
    assert.equal(manifest.claude_plugin.plugin_id, CLAUDE_PLUGIN_ID);
    assert.equal(manifest.claude_plugin.source, claudePluginSource());
    assert.equal(manifest.claude_plugin.marketplace_added_by_installer, true);
    assert.equal(manifest.claude_plugin.plugin_installed_by_installer, true);
    assert.deepEqual(readJson(stub.statePath).plugins, [CLAUDE_PLUGIN_ID]);

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
    assert.deepEqual(readClaudeStubCalls(stub).filter((call) => call.includes('plugin install')), [
      `plugin install ${CLAUDE_PLUGIN_ID} --scope user`,
    ]);
  });

  test('Claude plugin executable override supports wrappers and ignores PATH hijacks', () => {
    const root = tempDir('clean-room-claude-wrapper');
    const stub = createClaudeStub(path.join(root, 'stub'));
    const marker = path.join(root, 'marker.txt');
    const hijackBin = path.join(root, 'hijack-bin');
    const wrapper = writeClaudeWrapper(path.join(root, 'silo', 'ccsilo-claude'), stub.executable);
    const claudeHome = path.join(root, 'config');
    writeClaudeHijack(hijackBin, marker);

    const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      HOME: stub.homeDir,
      PATH: hijackBin,
      CLEAN_ROOM_CLAUDE_EXECUTABLE: wrapper,
      CLEAN_ROOM_CLAUDE_STUB_STATE: stub.statePath,
      CLAUDE_CONFIG_DIR: claudeHome,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.ok(readClaudeStubCalls(stub).includes(`plugin install ${CLAUDE_PLUGIN_ID} --scope user`));
  });

  test('Claude plugin PATH discovery skips unsafe local entries', () => {
    const root = tempDir('clean-room-claude-path-skip');
    const cases = [
      {
        name: 'cwd',
        cwd: path.join(root, 'cwd'),
        binDir: path.join(root, 'cwd'),
      },
      {
        name: 'repo-local',
        cwd: path.join(root, 'repo'),
        binDir: path.join(root, 'repo', 'bin'),
      },
      {
        name: 'node-modules-bin',
        cwd: path.join(root, 'repo-node-modules'),
        binDir: path.join(root, 'repo-node-modules', 'node_modules', '.bin'),
      },
    ];

    for (const item of cases) {
      const stub = createClaudeStub(path.join(root, `${item.name}-stub`));
      const marker = path.join(root, `${item.name}-marker.txt`);
      const claudeHome = path.join(root, `${item.name}-config`);
      fs.mkdirSync(item.cwd, { recursive: true });
      writeClaudeHijack(item.binDir, marker);

      const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
        ...stub.env,
        CLEAN_ROOM_CLAUDE_EXECUTABLE: '',
        PATH: `${item.binDir}${path.delimiter}${stub.binDir}`,
        CLAUDE_CONFIG_DIR: claudeHome,
      }, item.cwd);

      assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
      assert.equal(fs.existsSync(marker), false, item.name);
      assert.ok(readClaudeStubCalls(stub).includes(`plugin install ${CLAUDE_PLUGIN_ID} --scope user`), item.name);
    }
  });

  test('Claude plugin PATH discovery fails closed when PATH is ambiguous', () => {
    const root = tempDir('clean-room-claude-path-ambiguous');
    const cwd = path.join(root, 'work');
    const stub = createClaudeStub(path.join(root, 'stub'));
    const marker = path.join(root, 'marker.txt');
    const hijackBin = path.join(root, 'tmp-bin');
    const claudeHome = path.join(root, 'config');
    fs.mkdirSync(cwd, { recursive: true });
    writeClaudeHijack(hijackBin, marker);

    const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLEAN_ROOM_CLAUDE_EXECUTABLE: '',
      PATH: `${hijackBin}${path.delimiter}${stub.binDir}`,
      CLAUDE_CONFIG_DIR: claudeHome,
    }, cwd);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /multiple claude executables on sanitized PATH/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(readClaudeStubCalls(stub).length, 0);
  });

  test('Claude plugin executable override rejects unsafe paths', () => {
    const root = tempDir('clean-room-claude-override-unsafe');
    const cases = [
      {
        name: 'relative',
        cwd: path.join(root, 'relative-work'),
        executable: 'claude',
        expected: /CLEAN_ROOM_CLAUDE_EXECUTABLE must be an absolute path/,
      },
      {
        name: 'cwd',
        cwd: path.join(root, 'cwd-work'),
        binDir: path.join(root, 'cwd-work'),
        expected: /CLEAN_ROOM_CLAUDE_EXECUTABLE (target )?must not be under the current working directory/,
      },
      {
        name: 'node-modules-bin',
        cwd: path.join(root, 'node-work'),
        binDir: path.join(root, 'project', 'node_modules', '.bin'),
        expected: /CLEAN_ROOM_CLAUDE_EXECUTABLE must not be under node_modules\/\.bin/,
      },
    ];

    for (const item of cases) {
      const marker = path.join(root, `${item.name}-marker.txt`);
      const claudeHome = path.join(root, `${item.name}-config`);
      fs.mkdirSync(item.cwd, { recursive: true });
      const executable = item.binDir ? writeClaudeHijack(item.binDir, marker) : item.executable;

      const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
        HOME: path.join(root, `${item.name}-home`),
        PATH: '',
        CLEAN_ROOM_CLAUDE_EXECUTABLE: executable,
        CLAUDE_CONFIG_DIR: claudeHome,
      }, item.cwd);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.equal(fs.existsSync(marker), false, item.name);
    }
  });

  test('Claude plugin commands fail closed without a sanitized PATH candidate', () => {
    const root = tempDir('clean-room-claude-path-empty');
    const cwd = path.join(root, 'cwd');
    const marker = path.join(root, 'marker.txt');
    const claudeHome = path.join(root, 'config');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    writeClaudeHijack(cwd, marker);

    const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      HOME: home,
      PATH: cwd,
      CLEAN_ROOM_CLAUDE_EXECUTABLE: '',
      CLAUDE_CONFIG_DIR: claudeHome,
    }, cwd);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sanitized PATH/);
    assert.equal(fs.existsSync(marker), false);
  });

  test('runtime plugin manifests do not declare cwd-fragile static hooks', () => {
    assert.equal(readJson(path.join(ROOT, 'plugin.json')).hooks, undefined);
    assert.equal(readJson(path.join(ROOT, '.codex-plugin', 'plugin.json')).hooks, undefined);
    const claudeManifest = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'));
    assert.equal(claudeManifest.hooks, undefined);
    assert.equal(claudeManifest.agents, undefined);
    assert.equal(fs.existsSync(path.join(ROOT, 'hooks', 'hooks.json')), false);
  });

  test('unattended prompts fail closed instead of doing role work in main chat', () => {
    for (const relPath of ['skills/unattended/SKILL.md', 'skills/resume-cr/SKILL.md']) {
      const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      assert.match(content, /npx clean-room-skill@latest run/, relPath);
      assert.match(content, /--agent-runtime claude/, relPath);
      assert.match(content, /Do not search plugin cache paths for schema files/, relPath);
      assert.match(content, /do not pass `--schema-dir \/dev\/null`/, relPath);
      assert.match(content, /must not perform Agent 1, Agent 2, Agent 3, or Agent 4 work/, relPath);
      assert.match(content, /Do not ask to continue while/, relPath);
      assert.match(content, /Claude role-agent dispatch unavailable/, relPath);
    }
  });

  test('role agents document Claude Code tool parameter contract', () => {
    const relPaths = [
      'agents/clean-architect.md',
      'agents/clean-implementer-verifier-shell.md',
      'agents/clean-polish-reviewer.md',
      'agents/clean-qa-editor.md',
      'agents/contaminated-handoff-sanitizer.md',
      'agents/contaminated-manager-verifier.md',
      'agents/contaminated-source-analyst.md',
    ];
    for (const relPath of relPaths) {
      const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      assert.match(content, /`Read` uses `file_path`/, relPath);
      assert.match(content, /`Write` uses `file_path` and `content`/, relPath);
      assert.match(content, /`Bash` uses `command` only/, relPath);
    }
  });

  test('bundled skills satisfy OpenCode frontmatter requirements', () => {
    const skillsRoot = path.join(ROOT, 'skills');
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf8');
      assert.ok(content.startsWith('---\n'), entry.name);
      const end = content.indexOf('\n---\n', 4);
      assert.notEqual(end, -1, entry.name);
      const frontmatter = content.slice(4, end);
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
      assert.equal(name, entry.name);
      assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(description && description.length <= 1024, entry.name);
    }
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
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'clean-polish-reviewer.md')));
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

  test('installs Pi skills and copied hooks without hook registration', () => {
    const root = tempDir('clean-room-pi');
    const piHome = path.join(root, 'pi-agent');

    let result = runInstall(['--pi', '--global', '--config-dir', piHome, '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(piHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(piHome, 'skills', 'init', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(piHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.ok(fs.existsSync(path.join(piHome, 'hooks', 'clean-room', 'agent3-verification-runner.py')));
    assert.ok(fs.existsSync(path.join(piHome, 'clean-room-install-manifest.json')));
    assert.equal(fs.existsSync(path.join(piHome, 'settings.json')), false);
    assert.match(result.stdout, /hook registration unsupported/);

    result = runInstall(['status', '--pi', '--global', '--config-dir', piHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pi \(global\) installed/);
    assert.match(result.stdout, /hooks: safe; registration unsupported/);

    fs.rmSync(path.join(piHome, 'skills', 'init', 'SKILL.md'));
    result = runInstall(['status', '--pi', '--global', '--config-dir', piHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pi \(global\) update-available/);
    assert.match(result.stdout, /managed file\(s\) missing/);

    result = runInstall(['update', '--pi', '--global', '--config-dir', piHome, '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(piHome, 'skills', 'init', 'SKILL.md')));

    result = runInstall(['--pi', '--global', '--config-dir', piHome, '--uninstall', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(piHome, 'clean-room-install-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(piHome, 'skills', 'clean-room', 'SKILL.md')), false);
  });

  test('installs Pi locally to .pi skill layout', () => {
    const cwd = tempDir('clean-room-pi-local');
    const result = runInstall(['--pi', '--local', '--yes'], {}, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(cwd, '.pi', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.pi', 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.equal(fs.existsSync(path.join(cwd, '.pi', 'settings.json')), false);
  });

  test('installs all known runtime layouts locally', () => {
    const cwd = tempDir('clean-room-all-local');
    const result = runInstall(['--all', '--local', '--yes'], {}, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(cwd, '.codex', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.gemini', 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.opencode', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.opencode', 'commands', 'clean-room-clean-room.md')));
    assertOpenCodePlugin(path.join(cwd, '.opencode'));
    assert.ok(fs.existsSync(path.join(cwd, '.pi', 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'clean-room', 'skills', 'clean-room', 'SKILL.md')));
  });

  test('installs all documented runtime layouts', () => {
    const root = tempDir('clean-room-all');
    const codexHome = path.join(root, 'codex');
    const claudeHome = path.join(root, 'claude');
    const claudeStub = createClaudeStub(path.join(root, 'claude-stub'));
    const antigravityPlugin = path.join(root, 'antigravity-cli', 'plugins', 'clean-room');
    const geminiHome = path.join(root, 'gemini');
    const opencodeHome = path.join(root, 'opencode');
    const homeDir = path.join(root, 'home');
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
      ...claudeStub.env,
      HOME: homeDir,
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
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')), false);
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.deepEqual(readJson(claudeStub.statePath).plugins, [CLAUDE_PLUGIN_ID]);
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'clean-architect.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'clean-polish-reviewer.md')));
    assert.ok(fs.existsSync(path.join(antigravityPlugin, 'agents', 'contaminated-handoff-sanitizer.md')));
    assert.ok(fs.existsSync(path.join(geminiHome, 'commands', 'clean-room', 'clean-room.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-clean-room.md')));
    assertOpenCodePlugin(opencodeHome);
    assert.ok(fs.existsSync(path.join(homeDir, '.pi', 'agent', 'skills', 'clean-room', 'SKILL.md')));
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
    assert.match(result.stdout, /hook registration: would update/);
    assert.match(result.stdout, /python3 required when applying/);
    assert.equal(fs.existsSync(codexHome), false);
  });

  test('Claude global dry run plans plugin install without calling Claude CLI', () => {
    const root = tempDir('clean-room-claude-dry-run');
    const claudeHome = path.join(root, 'config');
    const emptyPath = path.join(root, 'empty-bin');
    fs.mkdirSync(emptyPath, { recursive: true });

    const result = runInstall(['--claude', '--global', '--dry-run', '--yes'], {
      CLAUDE_CONFIG_DIR: claudeHome,
      PATH: emptyPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Claude plugin marketplace: would add ${claudePluginSource().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, new RegExp(`Claude plugin: would install ${CLAUDE_PLUGIN_ID}`));
    assert.equal(fs.existsSync(claudeHome), false);
  });

  test('dry run does not require python3 for hook-capable runtimes', () => {
    const root = tempDir('clean-room-dry-run-no-python');
    const binDir = path.join(root, 'bin');
    const codexHome = path.join(root, 'codex');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));

    const result = runInstall(['--codex', '--global', '--dry-run', '--yes'], {
      CODEX_HOME: codexHome,
      PATH: binDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hook registration: would update/);
    assert.equal(fs.existsSync(codexHome), false);
  });

  test('atomicWriteFileNoOverwrite preserves existing files', () => {
    const root = tempDir('clean-room-no-overwrite');
    const target = path.join(root, 'nested', 'file.txt');

    atomicWriteFileNoOverwrite(target, 'first\n', 'utf8');

    assert.throws(() => atomicWriteFileNoOverwrite(target, 'second\n', 'utf8'), /file already exists/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'first\n');
  });

  test('listFiles enforces explicit traversal bounds', () => {
    const root = tempDir('clean-room-list-files-bounds');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'one.txt'), 'one\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'two\n');

    assert.throws(() => listFiles(root, { maxDepth: 1 }), /max depth 1/);
    assert.throws(() => listFiles(root, { maxFiles: 1 }), /max files 1/);
  });

  test('listFiles ignoreNamePrefixes excludes entries whose names start with a prefix', () => {
    // Regression: stale lock dirs (.clean-room-implementation.lock.stale.<ts>.<pid>)
    // were not in IMPLEMENTATION_IGNORE_NAMES and leaked into progress scans.
    const root = tempDir('clean-room-list-files-prefixes');
    fs.mkdirSync(path.join(root, '.clean-room-implementation.lock'), { recursive: true });
    fs.writeFileSync(path.join(root, '.clean-room-implementation.lock', 'owner.json'), '{}');
    fs.mkdirSync(path.join(root, '.clean-room-implementation.lock.stale.20260101T000000000Z.12345'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.clean-room-implementation.lock.stale.20260101T000000000Z.12345', 'owner.json'),
      '{}'
    );
    fs.writeFileSync(path.join(root, 'real-file.txt'), 'content\n');

    // Without filtering: the stale dir is visible.
    const all = listFiles(root, { ignoreNames: ['.clean-room-implementation.lock'] });
    assert.ok(all.some((f) => f.includes('.stale.')), 'stale dir should appear without prefix filter');

    // With prefix filter: both the exact lock name and the stale dirs are excluded.
    const filtered = listFiles(root, {
      ignoreNames: ['.clean-room-implementation.lock'],
      ignoreNamePrefixes: ['.clean-room-implementation.lock.stale.'],
    });
    assert.deepEqual(filtered, ['real-file.txt']);
  });

  test('interactive runtime selection accepts multiple values and installed defaults', () => {
    const statuses = [
      { runtime: 'codex', state: 'not-installed' },
      { runtime: 'claude', state: 'installed' },
      { runtime: 'antigravity', state: 'not-installed' },
      { runtime: 'gemini', state: 'hooks-only' },
    ];

    assert.deepEqual(
      parseRuntimeSelection('1, claude 3-4 claude', statuses, 'install'),
      ['codex', 'claude', 'antigravity', 'gemini']
    );
    assert.deepEqual(parseRuntimeSelection('', statuses, 'install'), ['codex']);
    assert.deepEqual(parseRuntimeSelection('', statuses, 'uninstall'), ['claude', 'gemini']);
    assert.deepEqual(parseRuntimeSelection('', statuses, 'update'), ['claude']);
    assert.deepEqual(parseRuntimeSelection('installed', statuses, 'uninstall'), ['claude', 'gemini']);
    assert.deepEqual(parseRuntimeSelection('installed', statuses, 'update'), ['claude']);
    assert.deepEqual(parseRuntimeSelection('all', statuses, 'update'), ['claude']);
    assert.throws(() => parseRuntimeSelection('codex', statuses, 'update'), /codex is not installed in this scope/);
    assert.throws(() => parseRuntimeSelection('4', statuses, 'update'), /gemini is not installed in this scope/);
    assert.throws(() => parseRuntimeSelection('99', statuses, 'install'), /out of range/);
  });

  test('interactive install status detects manifests and hook-only installs', () => {
    const codexHome = tempDir('clean-room-interactive-status');
    let status = runtimeInstallStatus('codex', 'global', codexHome);
    assert.equal(status.state, 'not-installed');

    let result = runInstall(['--codex', '--global', '--config-dir', codexHome, '--yes']);
    assert.equal(result.status, 0, result.stderr);
    status = runtimeInstallStatus('codex', 'global', codexHome);
    assert.equal(status.state, 'installed');
    assert.match(status.detail, /phase complete/);

    const hooksOnlyHome = tempDir('clean-room-interactive-hooks-only');
    fs.writeFileSync(path.join(hooksOnlyHome, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'python3 /tmp/hooks/clean-room-hook.py' }],
          },
        ],
      },
    }, null, 2));
    status = runtimeInstallStatus('codex', 'global', hooksOnlyHome);
    assert.equal(status.state, 'hooks-only');
  });

  test('status reports install version, drift, and hook state', () => {
    const root = tempDir('clean-room-status-command');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));

    let result = runInstall(['status', '--claude', '--global'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room-skill package version:/);
    assert.match(result.stdout, /claude \(global\) not-installed/);

    result = runInstall(['--claude', '--global', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);

    result = runInstall(['status', '--claude', '--global'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude \(global\) installed/);
    assert.match(result.stdout, /version: [0-9]+\.[0-9]+\.[0-9]+/);
    assert.match(result.stdout, /phase: complete/);
    assert.match(result.stdout, /hooks: safe; registration present/);
    assert.match(result.stdout, /files: [0-9]+; missing 0; modified 0; stale 0; conflicts 0/);
    assert.match(result.stdout, /plugin: clean-room@clean-room-skill; marketplace clean-room-skill/);
    assert.match(result.stdout, /plugin agents: ok; present 7; missing 0/);

    const manifest = readJson(path.join(claudeHome, 'clean-room-install-manifest.json'));
    fs.rmSync(path.join(manifest.claude_plugin.install_path, 'agents', 'clean-architect.md'));
    result = runInstall(['status', '--claude', '--global'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude \(global\) update-available/);
    assert.match(result.stdout, /plugin agents: missing; present 6; missing 1/);
    assert.match(result.stdout, /Claude role-agent dispatch unavailable/);
  });

  test('update refreshes an installed runtime without rerunning onboarding', () => {
    const root = tempDir('clean-room-update-command');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));
    const manifestPath = path.join(claudeHome, 'clean-room-install-manifest.json');

    let result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson(manifestPath).hooks_mode, 'copy-only');

    result = runInstall(['update', '--claude', '--global', '--dry-run'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would update claude/);
    assert.match(result.stdout, /Claude plugin marketplace: would refresh/);
    assert.match(result.stdout, /Claude plugin: would update or install/);
    assert.equal(readJson(manifestPath).hooks_mode, 'copy-only');

    result = runInstall(['update', '--claude', '--global'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updating claude/);
    assert.equal(readJson(manifestPath).hooks_mode, 'copy-only');
    assert.equal(fs.existsSync(path.join(claudeHome, 'settings.json')), false);
    assert.ok(readClaudeStubCalls(stub).includes(`plugin update ${CLAUDE_PLUGIN_ID}`));
  });

  test('Claude global install migrates managed standalone skills after plugin install succeeds', () => {
    const root = tempDir('clean-room-claude-migrate');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));
    fs.mkdirSync(claudeHome, { recursive: true });
    writeLegacyClaudeStandaloneInstall(claudeHome);

    const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'init', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'agents', 'clean-architect.md')), false);
    assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.deepEqual(readJson(stub.statePath).plugins, [CLAUDE_PLUGIN_ID]);
    assert.equal(readJson(path.join(claudeHome, 'clean-room-install-manifest.json')).claude_plugin.plugin_installed_by_installer, true);
  });

  test('Claude plugin install failure leaves legacy standalone skills intact', () => {
    const root = tempDir('clean-room-claude-plugin-failure');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));
    fs.mkdirSync(claudeHome, { recursive: true });
    writeLegacyClaudeStandaloneInstall(claudeHome);

    const result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CLEAN_ROOM_CLAUDE_STUB_FAIL: 'plugin install',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Claude plugin command failed/);
    assert.equal(fs.readFileSync(path.join(claudeHome, 'skills', 'clean-room', 'SKILL.md'), 'utf8'), '# legacy clean-room skill\n');
    assert.equal(fs.readFileSync(path.join(claudeHome, 'skills', 'init', 'SKILL.md'), 'utf8'), '# legacy init skill\n');
    assert.equal(fs.existsSync(path.join(claudeHome, 'hooks', 'clean-room', 'clean-room-hook.py')), false);
  });

  test('Claude global reinstall does not reinstall an existing managed plugin', () => {
    const root = tempDir('clean-room-claude-reinstall');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));

    let result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);

    result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);

    const installCalls = readClaudeStubCalls(stub)
      .filter((call) => call === `plugin install ${CLAUDE_PLUGIN_ID} --scope user`);
    assert.equal(installCalls.length, 1);
  });

  test('generates command wrappers for command-only runtimes', () => {
    const root = tempDir('clean-room-command-wrapper');
    const geminiHome = path.join(root, 'gemini');
    const opencodeHome = path.join(root, 'opencode');

    let result = runInstall(['--gemini', '--global', '--yes'], { GEMINI_CONFIG_DIR: geminiHome });
    assert.equal(result.status, 0, result.stderr);
    const geminiCommand = path.join(geminiHome, 'commands', 'clean-room', 'clean-room.md');
    assert.ok(fs.existsSync(geminiCommand));
    const geminiCleanRoom = fs.readFileSync(geminiCommand, 'utf8');
    assert.match(geminiCleanRoom, /Run the bundled `clean-room` clean-room workflow/);
    assert.match(geminiCleanRoom, /Run State Discovery Before Wizard/);

    result = runInstall(['--opencode', '--global', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(opencodeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-clean-room.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-init.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-attended.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-refocus.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-resume-cr.md')));
    assert.equal(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-resume.md')), false);
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-start-over.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-unattended.md')));
    assertOpenCodePlugin(opencodeHome);
    const opencodeCleanRoom = fs.readFileSync(path.join(opencodeHome, 'commands', 'clean-room-clean-room.md'), 'utf8');
    const opencodeAttended = fs.readFileSync(path.join(opencodeHome, 'commands', 'clean-room-attended.md'), 'utf8');
    const opencodeUnattended = fs.readFileSync(path.join(opencodeHome, 'commands', 'clean-room-unattended.md'), 'utf8');
    assert.match(opencodeCleanRoom, /Run State Discovery Before Wizard/);
    assert.match(opencodeAttended, /Run State Discovery Before Wizard/);
    assert.match(opencodeUnattended, /Run State Discovery Before Wizard/);
    assert.match(opencodeAttended, /schema errors instead of restarting preflight/);
    assert.match(opencodeUnattended, /schema errors instead of restarting preflight/);
  });

  test('installs OpenCode native skills, commands, and local plugin hook bridge', () => {
    const opencodeHome = path.join(tempDir('clean-room-opencode'), 'opencode');

    let result = runInstall(['--opencode', '--global', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(opencodeHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-clean-room.md')));
    assertOpenCodePlugin(opencodeHome, 'safe');
    assert.equal(fs.existsSync(path.join(opencodeHome, 'opencode.json')), false);

    result = runInstall(['status', '--opencode', '--global'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /opencode \(global\) installed/);
    assert.match(result.stdout, /hooks: safe; registration present/);

    result = runInstall(['--opencode', '--global', '--hooks=strict', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assertOpenCodePlugin(opencodeHome, 'strict');
    assert.equal(readJson(path.join(opencodeHome, 'clean-room-install-manifest.json')).hooks_mode, 'strict');

    result = runInstall(['--opencode', '--global', '--hooks=copy-only', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(opencodeHome, 'plugins', 'clean-room.ts')), false);
    assert.ok(fs.existsSync(path.join(opencodeHome, 'hooks', 'clean-room', 'clean-room-hook.py')));
    assert.equal(readJson(path.join(opencodeHome, 'clean-room-install-manifest.json')).hooks_mode, 'copy-only');
  });

  test('strict hooks fail before mutating unsupported runtimes', () => {
    const geminiHome = path.join(tempDir('clean-room-strict-hooks'), 'gemini');
    const result = runInstall(['--gemini', '--global', '--hooks=strict', '--yes'], {
      GEMINI_CONFIG_DIR: geminiHome,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--hooks=strict is not supported for gemini/);
    assert.equal(fs.existsSync(geminiHome), false);

    const piHome = path.join(tempDir('clean-room-pi-strict-hooks'), 'pi-agent');
    const piResult = runInstall(['--pi', '--global', '--config-dir', piHome, '--hooks=strict', '--yes']);
    assert.notEqual(piResult.status, 0);
    assert.match(piResult.stderr, /--hooks=strict is not supported for pi/);
    assert.equal(fs.existsSync(piHome), false);
  });

  test('install lock recovers stale locks and preserves fresh locks', () => {
    const staleHome = tempDir('clean-room-install-stale-lock');
    const staleLock = path.join(staleHome, '.clean-room-install.lock');
    writeLock(staleLock, 2147483647, new Date(Date.now() - 120_000));

    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: staleHome });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readdirSync(staleHome).some((name) => name.startsWith('.clean-room-install.lock.stale.')),
      true
    );

    const freshHome = tempDir('clean-room-install-fresh-lock');
    const freshLock = path.join(freshHome, '.clean-room-install.lock');
    writeLock(freshLock, process.pid, new Date());

    result = runInstall(['--codex', '--global', '--yes'], {
      CODEX_HOME: freshHome,
      CLEAN_ROOM_INSTALL_LOCK_WAIT_MS: '50',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /install lock is held/);
    assert.equal(fs.existsSync(freshLock), true);
  });

  test('installed safe hooks warn, no-op without env, and fail closed when enforced', () => {
    const codexHome = tempDir('clean-room-installed-safe-hook');
    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /safe hooks are installed; clean-room init\/onboarding must set role environment variables/);

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

  test('doctor validates generated Codex, Claude, and OpenCode hook registration', () => {
    const root = tempDir('clean-room-doctor');
    const codexHome = path.join(root, 'codex');
    const claudeHome = path.join(root, 'claude');
    const opencodeHome = path.join(root, 'opencode');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['doctor', '--runtime', 'codex', '--hooks=safe', '--config-dir', codexHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room doctor passed for codex/);
    result = runInstall(['doctor', '--runtime', 'codex', '--hooks=safe', '--coverage', '--config-dir', codexHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room hook coverage:/);
    assert.match(result.stdout, /unsupported surfaces:/);

    const claudeStub = createClaudeStub(path.join(root, 'claude-stub'));
    result = runInstall(['--claude', '--global', '--hooks=strict', '--yes'], {
      ...claudeStub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['doctor', '--runtime=claude', '--hooks=strict', '--config-dir', claudeHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room doctor passed for claude/);
    assert.match(result.stdout, /plugin agents: 7/);
    result = runInstall(['doctor', '--runtime=claude', '--hooks=strict', '--coverage', '--config-dir', claudeHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room Claude plugin agent coverage:/);

    result = runInstall(['--opencode', '--global', '--hooks=strict', '--yes'], {
      OPENCODE_CONFIG_DIR: opencodeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['doctor', '--runtime=opencode', '--hooks=strict', '--coverage', '--config-dir', opencodeHome]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-room doctor passed for opencode/);
    assert.match(result.stdout, /clean-room OpenCode plugin coverage:/);
    assert.match(result.stdout, /tool\.execute\.before/);
  });

  test('doctor rejects Claude installs without plugin role agents', () => {
    const root = tempDir('clean-room-doctor-claude-missing-agents');
    const claudeHome = path.join(root, 'claude');
    const claudeStub = createClaudeStub(path.join(root, 'claude-stub'));
    let result = runInstall(['--claude', '--global', '--hooks=strict', '--yes'], {
      ...claudeStub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);

    const manifest = readJson(path.join(claudeHome, 'clean-room-install-manifest.json'));
    fs.rmSync(path.join(manifest.claude_plugin.install_path, 'agents', 'clean-architect.md'));

    result = runInstall(['doctor', '--runtime=claude', '--hooks=strict', '--config-dir', claudeHome]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Claude role-agent dispatch unavailable/);
    assert.match(result.stderr, /clean-architect\.md/);
  });

  test('doctor rejects managed hook commands with shell suffixes', () => {
    const codexHome = tempDir('clean-room-doctor-shell-suffix');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    const configPath = path.join(codexHome, 'hooks.json');
    const config = readJson(configPath);
    let changed = false;
    for (const entries of Object.values(hookTable(config))) {
      if (changed || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (changed) break;
        for (const hook of entry.hooks || []) {
          if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
            hook.command = `${hook.command} ; echo bypass`;
            changed = true;
            break;
          }
        }
      }
    }
    assert.equal(changed, true);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    result = runInstall(['doctor', '--runtime', 'codex', '--hooks=safe', '--config-dir', codexHome]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected arguments|invalid check name/);
  });

  test('doctor includes spawn diagnostics when a hook command fails', () => {
    const codexHome = tempDir('clean-room-doctor-diagnostics');
    let result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);

    const configPath = path.join(codexHome, 'hooks.json');
    const config = readJson(configPath);
    let changed = false;
    for (const entries of Object.values(hookTable(config))) {
      if (changed || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (changed) break;
        for (const hook of entry.hooks || []) {
          if (typeof hook.command === 'string' && hook.command.includes('clean-room-hook.py')) {
            hook.command = hook.command.replace(/^'[^']*'/, "'/no/such/python'");
            changed = true;
            break;
          }
        }
      }
    }
    assert.equal(changed, true);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    result = runInstall(['doctor', '--runtime', 'codex', '--hooks=safe', '--config-dir', codexHome]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /safe hook did not no-op without clean-room env/);
    assert.match(result.stderr, /status=/);
    assert.match(result.stderr, /stderr=/);
  });

  test('install records partial state when hook config write fails after files are copied', () => {
    const root = tempDir('clean-room-hook-config-failure');
    const codexHome = path.join(root, 'codex');
    const preload = writeRenameFailurePreload(root, 'hooks.json');

    let result = runInstall(['--codex', '--global', '--yes'], {
      CODEX_HOME: codexHome,
      NODE_OPTIONS: `--require=${preload}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /partial install state/);
    assert.match(result.stderr, /managed files were written/);
    assert.match(result.stderr, /hook config write failed/);
    assert.match(result.stderr, /install manifest records the failed hook registration/);
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md')));

    const manifestPath = path.join(codexHome, 'clean-room-install-manifest.json');
    const manifest = readJson(manifestPath);
    assert.equal(manifest.hook_registration.status, 'failed');

    result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(managedHookCount(readJson(path.join(codexHome, 'hooks.json'))), 4);
    assert.equal(readJson(manifestPath).hook_registration, undefined);
  });

  test('install reports recoverable partial state when manifest write fails', () => {
    const root = tempDir('clean-room-manifest-failure');
    const codexHome = path.join(root, 'codex');
    const preload = writeRenameFailurePreload(root, 'clean-room-install-manifest.json', 2);

    let result = runInstall(['--codex', '--global', '--yes'], {
      CODEX_HOME: codexHome,
      NODE_OPTIONS: `--require=${preload}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /partial install state/);
    assert.match(result.stderr, /managed files were written/);
    assert.match(result.stderr, /hook config was updated/);
    assert.match(result.stderr, /install manifest was not completed/);
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'clean-room', 'SKILL.md')));
    assert.equal(managedHookCount(readJson(path.join(codexHome, 'hooks.json'))), 4);
    assert.equal(readJson(path.join(codexHome, 'clean-room-install-manifest.json')).phase, 'installing');

    result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(codexHome, 'clean-room-install-manifest.json')));
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

  test('applyInstall backs up a managed file changed after planning', () => {
    const targetRoot = tempDir('clean-room-apply-install-race');
    const relPath = 'skills/clean-room/SKILL.md';
    const fullPath = path.join(targetRoot, relPath);
    const oldBytes = Buffer.from('# old\n');
    const newBytes = Buffer.from('# new\n');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, oldBytes);

    const desired = new Map([[relPath, newBytes]]);
    const manifest = { files: { [relPath]: { sha256: sha256Bytes(oldBytes) } } };
    const plan = planInstall(targetRoot, desired, manifest);
    assert.deepEqual(plan.backups, []);

    fs.writeFileSync(fullPath, '# late edit\n');
    const result = applyInstall(targetRoot, desired, manifest, plan, { dryRun: false, hookMode: 'safe' });

    assert.equal(fs.readFileSync(fullPath, 'utf8'), '# new\n');
    assert.equal(fs.readFileSync(path.join(result.backupRoot, relPath), 'utf8'), '# late edit\n');
  });

  test('applyUninstall backs up a managed file changed after planning', () => {
    const targetRoot = tempDir('clean-room-apply-uninstall-race');
    const relPath = 'skills/clean-room/SKILL.md';
    const fullPath = path.join(targetRoot, relPath);
    const oldBytes = Buffer.from('# old\n');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, oldBytes);
    fs.writeFileSync(path.join(targetRoot, 'clean-room-install-manifest.json'), '{}\n');

    const manifest = { files: { [relPath]: { sha256: sha256Bytes(oldBytes) } } };
    const plan = planUninstall(targetRoot, manifest);
    assert.deepEqual(plan.backups, []);

    fs.writeFileSync(fullPath, '# late edit before uninstall\n');
    const result = applyUninstall(targetRoot, plan, false);

    assert.equal(fs.existsSync(fullPath), false);
    assert.equal(fs.readFileSync(path.join(result.backupRoot, relPath), 'utf8'), '# late edit before uninstall\n');
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

  test('install rejects symlinked install root', (t) => {
    const root = tempDir('clean-room-root-symlink');
    const realCodexHome = path.join(root, 'real-codex');
    const linkedCodexHome = path.join(root, 'linked-codex');
    fs.mkdirSync(realCodexHome, { recursive: true });
    if (!symlinkDirOrSkip(t, realCodexHome, linkedCodexHome)) return;

    const result = runInstall(['--codex', '--global', '--yes'], { CODEX_HOME: linkedCodexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install root must not be a symlink/);
    assert.equal(fs.existsSync(path.join(realCodexHome, 'skills', 'clean-room', 'SKILL.md')), false);
  });

  test('uninstall removes only managed files and clean-room hooks', () => {
    const root = tempDir('clean-room-uninstall');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'));
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

    let result = runInstall(['--claude', '--global', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    result = runInstall(['--claude', '--global', '--yes', '--uninstall'], {
      ...stub.env,
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
    assert.deepEqual(readJson(stub.statePath).plugins, []);
    const calls = readClaudeStubCalls(stub);
    assert.ok(calls.includes(`plugin uninstall ${CLAUDE_PLUGIN_ID}`));
    assert.ok(calls.includes(`plugin marketplace remove ${CLAUDE_MARKETPLACE_NAME}`));
  });

  test('uninstall leaves pre-existing Claude plugin when manifest did not install it', () => {
    const root = tempDir('clean-room-uninstall-preexisting-plugin');
    const claudeHome = path.join(root, 'config');
    const stub = createClaudeStub(path.join(root, 'stub'), { marketplaces: true, plugins: true });

    let result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(claudeHome, 'clean-room-install-manifest.json');
    const manifest = readJson(manifestPath);
    assert.equal(manifest.claude_plugin.plugin_installed_by_installer, false);
    assert.equal(manifest.claude_plugin.marketplace_added_by_installer, false);

    result = runInstall(['--claude', '--global', '--hooks=copy-only', '--yes', '--uninstall'], {
      ...stub.env,
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJson(stub.statePath).plugins, [CLAUDE_PLUGIN_ID]);
    assert.equal(readClaudeStubCalls(stub).some((call) => call.startsWith('plugin uninstall ')), false);
  });

  test('uninstall removes OpenCode managed files and preserves unrelated plugins', () => {
    const opencodeHome = tempDir('clean-room-opencode-uninstall');
    const userPlugin = path.join(opencodeHome, 'plugins', 'user.ts');
    fs.mkdirSync(path.dirname(userPlugin), { recursive: true });
    fs.writeFileSync(userPlugin, 'export const UserPlugin = async () => ({})\n');

    let result = runInstall(['--opencode', '--global', '--yes'], { OPENCODE_CONFIG_DIR: opencodeHome });
    assert.equal(result.status, 0, result.stderr);
    assertOpenCodePlugin(opencodeHome);

    result = runInstall(['--opencode', '--global', '--yes', '--uninstall'], {
      OPENCODE_CONFIG_DIR: opencodeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(opencodeHome, 'plugins', 'clean-room.ts')), false);
    assert.equal(fs.existsSync(path.join(opencodeHome, 'skills', 'clean-room', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(opencodeHome, 'commands', 'clean-room-clean-room.md')), false);
    assert.equal(fs.readFileSync(userPlugin, 'utf8'), 'export const UserPlugin = async () => ({})\n');
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

  test('source index records an aggregate skip after max files is reached', () => {
    const root = tempDir('clean-room-source-index-limit');
    const sourceRoot = path.join(root, 'source');
    const artifactRoot = path.join(root, 'artifacts');
    const outputPath = path.join(artifactRoot, 'source-index.json');
    fs.mkdirSync(path.join(sourceRoot, 'subdir'), { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(sourceRoot, 'b.js'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(sourceRoot, 'subdir', 'c.js'), 'export const c = 3;\n');

    const result = spawnSync('python3', [
      path.join(ROOT, 'skills', 'clean-room', 'scripts', 'build_source_index.py'),
      '--source-root',
      sourceRoot,
      '--output',
      outputPath,
      '--contaminated-artifact-root',
      artifactRoot,
      '--task-id',
      'task-limit',
      '--max-files',
      '1',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const index = readJson(outputPath);
    assert.equal(index.files.length, 1);
    assert.equal(
      index.skipped_entries.some((entry) =>
        entry.reason === 'remaining-files-skipped-after-limit:file-count-limit'
      ),
      true
    );
  });

  test('source index rejects roots overlapping implementation roots from env', () => {
    const root = tempDir('clean-room-source-index-implementation-overlap');
    const sourceRoot = path.join(root, 'implementation');
    const artifactRoot = path.join(root, 'artifacts');
    const outputPath = path.join(artifactRoot, 'source-index.json');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'a.js'), 'export const a = 1;\n');

    const result = spawnSync('python3', [
      path.join(ROOT, 'skills', 'clean-room', 'scripts', 'build_source_index.py'),
      '--source-root',
      sourceRoot,
      '--output',
      outputPath,
      '--contaminated-artifact-root',
      artifactRoot,
      '--task-id',
      'task-overlap',
      '--skip-tool-detection',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLEAN_ROOM_IMPLEMENTATION_ROOTS: sourceRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source roots and CLEAN_ROOM_IMPLEMENTATION_ROOTS roots must be separate/);
    assert.equal(fs.existsSync(outputPath), false);
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
