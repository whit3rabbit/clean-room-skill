#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const {
  atomicWriteFile,
  fileHash,
  listFiles,
  readJsonFile,
  removeEmptyParents,
  resolveInside,
  sha256Bytes,
  writeJsonFile,
} = require('../lib/fs-utils.cjs');
const {
  buildHookEntries,
  configPathForRuntime,
  mergeHookEntries,
  removeHookEntries,
} = require('../lib/hooks.cjs');
const {
  RUNTIMES,
  RUNTIME_FLAGS,
  resolveRuntimeLayout,
} = require('../lib/runtime-layout.cjs');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_NAME = 'clean-room-install-manifest.json';
const PATCHES_DIR_NAME = 'clean-room-patches';
const IGNORE_NAMES = new Set(['.DS_Store', '__pycache__', 'node_modules', '.syntext']);
const HOOK_MODES = new Set(['safe', 'copy-only', 'strict']);

function packageVersion() {
  const pkg = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'), null);
  return pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

function parseArgs(argv) {
  const options = {
    runtimes: [],
    scope: null,
    dryRun: false,
    yes: false,
    uninstall: false,
    hookMode: 'safe',
    configDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (RUNTIME_FLAGS[arg]) options.runtimes.push(RUNTIME_FLAGS[arg]);
    else if (arg === '--all') options.runtimes = [...RUNTIMES];
    else if (arg === '--global') options.scope = setExclusive(options.scope, 'global', '--global');
    else if (arg === '--local') options.scope = setExclusive(options.scope, 'local', '--local');
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--no-hooks') options.hookMode = 'copy-only';
    else if (arg === '--config-dir') {
      i += 1;
      if (i >= argv.length) throw new Error('--config-dir requires a path');
      options.configDir = argv[i];
    } else if (arg.startsWith('--config-dir=')) {
      options.configDir = arg.slice('--config-dir='.length);
    } else if (arg === '--hooks') {
      i += 1;
      if (i >= argv.length) throw new Error('--hooks requires safe, copy-only, or strict');
      options.hookMode = argv[i];
    } else if (arg.startsWith('--hooks=')) {
      options.hookMode = arg.slice('--hooks='.length);
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  options.runtimes = [...new Set(options.runtimes)];
  if (!HOOK_MODES.has(options.hookMode)) {
    throw new Error('--hooks must be one of safe, copy-only, or strict');
  }
  if (options.configDir && options.runtimes.length > 1) {
    throw new Error('--config-dir can only be used with one runtime');
  }
  return options;
}

function setExclusive(current, next, flag) {
  if (current && current !== next) {
    throw new Error(`${flag} conflicts with --${current}`);
  }
  return next;
}

function printHelp() {
  console.log(`Usage: clean-room-skill [runtime] [scope] [options]

Runtime:
  --codex              Install for Codex
  --claude             Install for Claude Code
  --antigravity        Install for Antigravity
  --gemini             Install for Gemini CLI
  --opencode           Install for OpenCode
  --kilo               Install for Kilo
  --cursor             Install for Cursor
  --copilot            Install for GitHub Copilot
  --windsurf           Install for Windsurf
  --augment            Install for Augment
  --trae               Install for Trae
  --qwen               Install for Qwen Code
  --hermes             Install for Hermes Agent
  --codebuddy          Install for CodeBuddy
  --all                Install for all supported runtimes

Scope:
  --global             Install to the runtime user config
  --local              Install to the current project config

Options:
  --hooks=<mode>       safe, copy-only, or strict (default: safe)
  --no-hooks           Alias for --hooks=copy-only
  --config-dir <path>  Override the target root for one runtime
  --dry-run            Print actions without writing files
  --yes                Non-interactive mode; unknown conflicts still abort
  --uninstall          Remove manifest-managed files and clean-room hook entries
`);
}

async function resolveInteractiveOptions(options) {
  if (options.runtimes.length > 0 && options.scope) {
    return options;
  }
  if (!process.stdin.isTTY || options.yes) {
    throw new Error('specify runtime and scope flags when running non-interactively');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (options.runtimes.length === 0) {
      const answer = await rl.question(`Runtime [${RUNTIMES.join('/')}/all]: `);
      const runtime = answer.trim().toLowerCase() || 'codex';
      if (runtime === 'all') options.runtimes = [...RUNTIMES];
      else if (RUNTIMES.includes(runtime)) options.runtimes = [runtime];
      else throw new Error(`unsupported runtime: ${answer}`);
    }
    if (!options.scope) {
      const answer = await rl.question('Scope [global/local]: ');
      const scope = answer.trim().toLowerCase() || 'global';
      if (scope !== 'global' && scope !== 'local') {
        throw new Error(`unsupported scope: ${answer}`);
      }
      options.scope = scope;
    }
    return options;
  } finally {
    rl.close();
  }
}

function resolveTargetRoot(runtime, scope, configDir) {
  return resolveRuntimeLayout(runtime, scope, { configDir }).targetRoot;
}

function sourceFile(relPath, hookMode) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relPath));
}

function addFile(desired, sourceRel, destRel, hookMode) {
  desired.set(destRel.replace(/\\/g, '/'), sourceFile(sourceRel, hookMode));
}

function addTree(desired, sourceRel, destRel, hookMode, options = {}) {
  const sourceRoot = path.join(PACKAGE_ROOT, sourceRel);
  for (const rel of listFiles(sourceRoot, { ignoreNames: IGNORE_NAMES })) {
    if (options.filter && !options.filter(rel)) continue;
    const sourcePath = `${sourceRel}/${rel}`.replace(/\\/g, '/');
    const destPath = destRel ? `${destRel}/${rel}` : rel;
    addFile(desired, sourcePath, destPath, hookMode);
  }
}

function splitSkillFile(content) {
  if (!content.startsWith('---\n')) {
    return { frontmatter: '', body: content };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: '', body: content };
  }
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + '\n---\n'.length),
  };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function yamlString(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

function generateCommandWrapper(skillName) {
  const skillPath = path.join(PACKAGE_ROOT, 'skills', skillName, 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  const { frontmatter, body } = splitSkillFile(content);
  const description = frontmatterValue(frontmatter, 'description') ||
    `Run the ${skillName} clean-room workflow.`;
  const argumentHint = frontmatterValue(frontmatter, 'argument-hint');
  const lines = [
    '---',
    `description: ${yamlString(description)}`,
  ];
  if (argumentHint) {
    lines.push(`argument-hint: ${yamlString(argumentHint)}`);
  }
  lines.push(
    '---',
    '',
    `# ${skillName}`,
    '',
    `Run the bundled \`${skillName}\` clean-room workflow using the user's command arguments.`,
    '',
    body.trimStart()
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function generatePluginManifest() {
  const source = readJsonFile(path.join(PACKAGE_ROOT, 'plugin.json'), {});
  const manifest = {
    name: 'clean-room',
    version: packageVersion(),
    description: 'Spec-first clean-room workflow for authorized source analysis without replacement code.',
    ...source,
    skills: './skills/',
    agents: './agents/',
  };
  delete manifest.hooks;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function addCommandWrappers(desired, artifact) {
  const skillsRoot = path.join(PACKAGE_ROOT, artifact.source);
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const destName = `${artifact.commandPrefix || ''}${entry.name}.md`;
    const destRel = `${artifact.destSubpath}/${destName}`.replace(/\\/g, '/');
    desired.set(destRel, Buffer.from(generateCommandWrapper(entry.name), 'utf8'));
  }
}

function addArtifact(desired, artifact, hookMode) {
  if (artifact.kind === 'skills' || artifact.kind === 'agents') {
    addTree(desired, artifact.source, artifact.destSubpath, hookMode);
    return;
  }
  if (artifact.kind === 'hooks') {
    addTree(desired, artifact.source, artifact.destSubpath, hookMode, {
      filter: (rel) => rel.endsWith('.py'),
    });
    return;
  }
  if (artifact.kind === 'commands') {
    addCommandWrappers(desired, artifact);
    return;
  }
  if (artifact.kind === 'plugin-manifest') {
    desired.set(artifact.destSubpath, Buffer.from(generatePluginManifest(), 'utf8'));
    return;
  }
  throw new Error(`unsupported artifact kind: ${artifact.kind}`);
}

function layoutFromInput(runtimeOrLayout, scope, configDir) {
  if (runtimeOrLayout && typeof runtimeOrLayout === 'object') {
    return runtimeOrLayout;
  }
  return resolveRuntimeLayout(runtimeOrLayout, scope, { configDir });
}

function buildDesiredFiles(runtimeOrLayout, hookMode, scope = 'global', configDir = null) {
  const layout = layoutFromInput(runtimeOrLayout, scope, configDir);
  const desired = new Map();
  for (const artifact of layout.artifacts) {
    addArtifact(desired, artifact, hookMode);
  }
  return desired;
}

function readManifest(targetRoot) {
  const manifestPath = path.join(targetRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath, null);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  return manifest;
}

function manifestHash(manifest, relPath) {
  const entry = manifest?.files?.[relPath];
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.sha256 === 'string') return entry.sha256;
  return null;
}

function planInstall(targetRoot, desired, manifest) {
  const unknownConflicts = [];
  const writes = [];
  const removals = [];
  const backups = [];

  for (const [relPath, bytes] of desired) {
    const fullPath = resolveInside(targetRoot, relPath);
    const desiredHash = sha256Bytes(bytes);
    const knownHash = manifestHash(manifest, relPath);
    if (fs.existsSync(fullPath)) {
      const currentHash = fileHash(fullPath);
      if (knownHash && currentHash !== knownHash) {
        backups.push(relPath);
      } else if (!knownHash && currentHash !== desiredHash) {
        unknownConflicts.push(relPath);
      }
    }
    writes.push(relPath);
  }

  for (const relPath of Object.keys(manifest?.files || {})) {
    if (desired.has(relPath)) continue;
    const fullPath = resolveInside(targetRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && fileHash(fullPath) !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }

  return { unknownConflicts, writes, removals, backups };
}

async function confirmUnknownConflicts(conflicts, options) {
  if (conflicts.length === 0) return false;
  if (options.dryRun) return false;
  if (options.yes || !process.stdin.isTTY) {
    throw new Error(
      `unknown existing file(s) would be overwritten: ${conflicts.join(', ')}. ` +
      'Run interactively to confirm or remove the conflict.'
    );
  }
  console.log('Unknown existing files would be overwritten:');
  for (const conflict of conflicts) {
    console.log(`  ${conflict}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Overwrite these files? Type yes to continue: ');
    if (answer.trim() !== 'yes') {
      throw new Error('aborted by user');
    }
    return true;
  } finally {
    rl.close();
  }
}

function backupFile(targetRoot, relPath, backupRoot) {
  const source = resolveInside(targetRoot, relPath);
  const dest = resolveInside(backupRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createBackupWriter(targetRoot, dryRun) {
  let backupRoot = null;
  return {
    backup(relPath) {
      if (dryRun) return null;
      if (!backupRoot) {
        backupRoot = path.join(targetRoot, PATCHES_DIR_NAME, timestampForPath());
      }
      backupFile(targetRoot, relPath, backupRoot);
      return backupRoot;
    },
    get root() {
      return backupRoot;
    },
  };
}

function applyInstall(targetRoot, desired, manifest, plan, options) {
  const backupWriter = createBackupWriter(targetRoot, options.dryRun);
  if (options.dryRun) return null;
  fs.mkdirSync(targetRoot, { recursive: true });

  const backedUp = new Set();
  for (const relPath of [...plan.backups, ...plan.unknownConflicts]) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath) && !backedUp.has(relPath)) {
      backupWriter.backup(relPath);
      backedUp.add(relPath);
    }
  }

  for (const relPath of plan.removals) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }

  for (const [relPath, bytes] of desired) {
    const fullPath = resolveInside(targetRoot, relPath);
    atomicWriteFile(fullPath, bytes);
  }

  const nextManifest = {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    runtime: manifest?.runtime || null,
    scope: manifest?.scope || null,
    hooks_mode: options.hookMode,
    installed_at: new Date().toISOString(),
    files: {},
  };
  for (const [relPath, bytes] of desired) {
    nextManifest.files[relPath] = { sha256: sha256Bytes(bytes) };
  }
  return { backupRoot: backupWriter.root, manifest: nextManifest };
}

function writeInstallManifest(targetRoot, manifest, runtime, scope, hookMode, dryRun) {
  if (dryRun) return;
  const next = {
    ...manifest,
    runtime,
    scope,
    hooks_mode: hookMode,
  };
  writeJsonFile(path.join(targetRoot, MANIFEST_NAME), next);
}

function resolvePython3() {
  const result = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error('python3 is required to install clean-room hooks');
  }
  const pythonPath = String(result.stdout || '').trim();
  if (!path.isAbsolute(pythonPath)) {
    throw new Error('python3 did not resolve to an absolute executable path');
  }
  return pythonPath;
}

function validateRuntimeOptions(options) {
  for (const runtime of options.runtimes) {
    const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
    if (options.hookMode === 'strict' && !layout.supportsHookRegistration) {
      throw new Error(`--hooks=strict is not supported for ${runtime}; hook registration is verified only for codex and claude`);
    }
  }
}

function configureHooks(layout, hookMode, dryRun) {
  if (hookMode === 'copy-only') {
    return { status: 'copy-only' };
  }
  if (!layout.supportsHookRegistration) {
    return { status: 'unsupported' };
  }
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return { status: 'unsupported' };
  const pythonPath = resolvePython3();
  const wrapperPath = path.join(layout.targetRoot, 'hooks', 'clean-room', 'clean-room-hook.py');
  const entries = buildHookEntries({ pythonPath, wrapperPath, mode: hookMode });
  mergeHookEntries(configPath, entries, { dryRun });
  return { status: 'registered' };
}

async function installRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
  const manifest = readManifest(targetRoot);
  const desired = buildDesiredFiles(layout, options.hookMode);
  const plan = planInstall(targetRoot, desired, manifest);
  const adoptedUnknowns = await confirmUnknownConflicts(plan.unknownConflicts, options);

  console.log(`${options.dryRun ? 'Would install' : 'Installing'} ${runtime} to ${targetRoot}`);
  console.log(`  files: ${plan.writes.length}`);
  if (plan.removals.length) console.log(`  stale managed removals: ${plan.removals.length}`);
  if (plan.backups.length || adoptedUnknowns) {
    console.log(`  backups: ${plan.backups.length + (adoptedUnknowns ? plan.unknownConflicts.length : 0)}`);
  }
  if (options.dryRun && plan.unknownConflicts.length) {
    console.log(`  unknown conflicts: ${plan.unknownConflicts.length}`);
  }

  const hookResult = configureHooks(layout, options.hookMode, true);
  const result = applyInstall(targetRoot, desired, manifest, plan, options);
  if (!options.dryRun) {
    configureHooks(layout, options.hookMode, false);
  }
  if (hookResult.status === 'unsupported' && options.hookMode === 'safe') {
    console.log('  hook registration unsupported for this runtime; copied hooks only');
  }
  if (result) {
    writeInstallManifest(targetRoot, result.manifest, runtime, options.scope, options.hookMode, options.dryRun);
    if (result.backupRoot) {
      console.log(`  backed up modified files to ${result.backupRoot}`);
    }
  }
}

function planUninstall(targetRoot, manifest) {
  const files = Object.keys(manifest?.files || {});
  const backups = [];
  const removals = [];
  for (const relPath of files) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const knownHash = manifestHash(manifest, relPath);
    if (knownHash && fileHash(fullPath) !== knownHash) {
      backups.push(relPath);
    }
    removals.push(relPath);
  }
  return { backups, removals };
}

function removeHookRegistrations(layout, dryRun) {
  if (!layout.supportsHookRegistration) return null;
  const configPath = configPathForRuntime(layout.runtime, layout.targetRoot);
  if (!configPath) return null;
  return removeHookEntries(configPath, { dryRun });
}

function uninstallRuntime(runtime, options) {
  const layout = resolveRuntimeLayout(runtime, options.scope, { configDir: options.configDir });
  const targetRoot = layout.targetRoot;
  const manifest = readManifest(targetRoot);
  console.log(`${options.dryRun ? 'Would uninstall' : 'Uninstalling'} ${runtime} from ${targetRoot}`);
  if (!manifest) {
    console.log('  no install manifest found');
    removeHookRegistrations(layout, options.dryRun);
    return;
  }
  const plan = planUninstall(targetRoot, manifest);
  console.log(`  managed removals: ${plan.removals.length}`);
  if (plan.backups.length) {
    console.log(`  backups: ${plan.backups.length}`);
  }

  if (options.dryRun) return;
  const backupWriter = createBackupWriter(targetRoot, false);
  for (const relPath of plan.backups) {
    backupWriter.backup(relPath);
  }
  for (const relPath of plan.removals) {
    const fullPath = resolveInside(targetRoot, relPath);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true });
      removeEmptyParents(path.dirname(fullPath), targetRoot);
    }
  }
  removeHookRegistrations(layout, false);
  fs.rmSync(path.join(targetRoot, MANIFEST_NAME), { force: true });
  removeEmptyParents(targetRoot, path.dirname(targetRoot));
  if (backupWriter.root) {
    console.log(`  backed up modified files to ${backupWriter.root}`);
  }
}

async function main() {
  const options = await resolveInteractiveOptions(parseArgs(process.argv.slice(2)));
  if (!options.scope) {
    options.scope = 'global';
  }
  validateRuntimeOptions(options);
  for (const runtime of options.runtimes) {
    if (options.uninstall) {
      uninstallRuntime(runtime, options);
    } else {
      await installRuntime(runtime, options);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`clean-room-skill: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDesiredFiles,
  parseArgs,
  planInstall,
  resolveTargetRoot,
};
