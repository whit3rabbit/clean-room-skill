'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertManagedPath,
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
  readJsonFile,
} = require('./fs-utils.cjs');
const { packageVersion } = require('./install-artifacts.cjs');
const { expandTilde } = require('./runtime-layout.cjs');

const TARGET_PROFILES = new Set([
  'openspec-delta',
  'gsd-planning-package',
  'speckit-feature-folder',
  'kiro-spec-folder',
]);

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BOOTSTRAP_METADATA_FILE = 'clean-room-bootstrap.json';
const BOOTSTRAP_REPO_STUB = '.clean-room/README.md';
const BOOTSTRAP_DIRS = Object.freeze({
  contaminated: 'contaminated',
  clean: 'clean',
  implementation: 'implementation',
  quarantine: 'quarantine',
});

function defaultArtifactBase(homeDir = os.homedir()) {
  return path.join(homeDir, 'Documents', 'CleanRoom');
}

function generateTaskId() {
  return `task-${crypto.randomBytes(4).toString('hex')}`;
}

function printInitHelp() {
  console.log(`Usage: clean-room-skill init [options]

Create clean-room bootstrap folders and clean-safe repo guidance.

Options:
  --target-dir <path>      Repository to initialize (default: current directory)
  --artifact-base <path>   External CleanRoom base (default: ~/Documents/CleanRoom)
  --task-id <id>           Neutral task id (default: generated task-xxxxxxxx)
  --target-profile <name>  openspec-delta, gsd-planning-package,
                           speckit-feature-folder, or kiro-spec-folder
                           (default: speckit-feature-folder)
  --dry-run                Print actions without writing files
  --force                  Overwrite existing bootstrap metadata and repo stub
  -h, --help               Show this help
`);
}

function parseInitArgs(argv) {
  const options = {
    targetDir: process.cwd(),
    artifactBase: defaultArtifactBase(),
    taskId: null,
    targetProfile: 'speckit-feature-folder',
    dryRun: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--target-dir') {
      i += 1;
      options.targetDir = requiredValue(argv, i, '--target-dir');
    } else if (arg.startsWith('--target-dir=')) {
      options.targetDir = arg.slice('--target-dir='.length);
    } else if (arg === '--artifact-base') {
      i += 1;
      options.artifactBase = requiredValue(argv, i, '--artifact-base');
    } else if (arg.startsWith('--artifact-base=')) {
      options.artifactBase = arg.slice('--artifact-base='.length);
    } else if (arg === '--task-id') {
      i += 1;
      options.taskId = requiredValue(argv, i, '--task-id');
    } else if (arg.startsWith('--task-id=')) {
      options.taskId = arg.slice('--task-id='.length);
    } else if (arg === '--target-profile') {
      i += 1;
      options.targetProfile = requiredValue(argv, i, '--target-profile');
    } else if (arg.startsWith('--target-profile=')) {
      options.targetProfile = arg.slice('--target-profile='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown init option: ${arg}`);
    } else {
      throw new Error('clean-room-skill init does not accept positional arguments');
    }
  }

  return options;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function resolveInitOptions(options, env = process.env, homeDir = os.homedir()) {
  const taskId = options.taskId || generateTaskId();
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('--task-id must match [a-z0-9][a-z0-9-]{0,63}');
  }
  if (!TARGET_PROFILES.has(options.targetProfile)) {
    throw new Error(`--target-profile must be one of ${[...TARGET_PROFILES].join(', ')}`);
  }

  const targetDir = path.resolve(expandTilde(options.targetDir, homeDir));
  const artifactBase = path.resolve(expandTilde(options.artifactBase, homeDir));
  const outputRoot = path.join(artifactBase, taskId);
  const roots = {
    contaminated: path.join(outputRoot, 'contaminated'),
    clean: path.join(outputRoot, 'clean'),
    implementation: path.join(outputRoot, 'implementation'),
    quarantine: path.join(outputRoot, 'quarantine'),
  };

  return {
    ...options,
    env,
    homeDir,
    taskId,
    targetDir,
    artifactBase,
    outputRoot,
    roots,
    metadataPath: assertManagedPath(outputRoot, BOOTSTRAP_METADATA_FILE),
    repoStubPath: assertManagedPath(targetDir, BOOTSTRAP_REPO_STUB),
  };
}

function buildBootstrapMetadata(options) {
  return {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    created_at: new Date().toISOString(),
    task_id: options.taskId,
    target_profile: options.targetProfile,
    target_dir: options.targetDir,
    artifact_base_root: options.artifactBase,
    output_root: options.outputRoot,
    roots: {
      contaminated_artifacts: options.roots.contaminated,
      clean_artifacts: options.roots.clean,
      implementation_root: options.roots.implementation,
      quarantine: options.roots.quarantine,
    },
    note: 'Bootstrap metadata only. The clean-room skill creates active init-config.json, task-manifest.json, and clean-run-context.json artifacts.',
  };
}

function renderRepoStub(targetProfile) {
  return `# Clean Room Bootstrap

This repository has a clean-room bootstrap stub.

Active clean-room run artifacts are stored outside this repository. The bootstrap task root contains \`contaminated/\`, \`clean/\`, \`implementation/\`, and \`quarantine/\`. Do not commit source roots, contaminated artifact paths, private identifiers, source-derived names, or active \`init-config.json\`, \`task-manifest.json\`, or \`clean-run-context.json\` files here.

The final clean polish stage may create or update implementation-root \`AGENTS.md\`, \`.gitignore\`, and one local git commit through the bounded Agent 4 polish runner. That commit belongs to the clean implementation root, not to contaminated artifacts or source roots.

Default target profile: \`${targetProfile}\`

Start the runtime skill from your agent and provide the external output folder printed by \`clean-room-skill init\`.
`;
}

function assertWritableTargets(options) {
  const fileConflicts = [];
  for (const filePath of [options.metadataPath, options.repoStubPath]) {
    if (fs.existsSync(filePath) && !options.force) {
      fileConflicts.push(filePath);
    }
  }
  if (fileConflicts.length > 0) {
    throw new Error(`bootstrap file already exists; use --force to overwrite: ${fileConflicts.join(', ')}`);
  }

  const pathConflicts = [];
  for (const dirPath of Object.values(options.roots)) {
    if (fs.existsSync(dirPath) && !options.force) {
      pathConflicts.push(dirPath);
    }
  }
  if (pathConflicts.length > 0) {
    throw new Error(`bootstrap generated path already exists; use --force to reuse it: ${pathConflicts.join(', ')}`);
  }

  for (const dirPath of Object.values(options.roots)) {
    const stat = lstatIfExists(dirPath);
    if (stat && !stat.isDirectory()) {
      throw new Error(`bootstrap generated path is not a directory: ${dirPath}`);
    }
  }
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function requireDirectory(dirPath, label, errors) {
  const stat = lstatIfExists(dirPath);
  if (!stat) {
    errors.push(`${label} missing: ${dirPath}`);
    return;
  }
  if (!stat.isDirectory()) {
    errors.push(`${label} is not a directory: ${dirPath}`);
  }
}

function requireFile(filePath, label, errors) {
  const stat = lstatIfExists(filePath);
  if (!stat) {
    errors.push(`${label} missing: ${filePath}`);
    return;
  }
  if (!stat.isFile()) {
    errors.push(`${label} is not a file: ${filePath}`);
  }
}

function expectMetadataString(metadata, field, errors) {
  if (typeof metadata?.[field] !== 'string' || metadata[field].length === 0) {
    errors.push(`bootstrap metadata ${field} must be a non-empty string`);
    return null;
  }
  return metadata[field];
}

function assertMetadataPath(metadata, field, expectedPath, errors) {
  const value = expectMetadataString(metadata, field, errors);
  if (!value) return;
  if (path.resolve(expandTilde(value)) !== expectedPath) {
    errors.push(`bootstrap metadata ${field} must match ${expectedPath}`);
  }
}

function validateBootstrapScaffold(taskRoot) {
  if (typeof taskRoot !== 'string' || taskRoot.trim() === '') {
    throw new Error('bootstrap path requires a task root');
  }
  const outputRoot = path.resolve(taskRoot);
  const outputRootStat = lstatIfExists(outputRoot);
  if (!outputRootStat) {
    throw new Error(`bootstrap scaffold is invalid:
  bootstrap task root missing: ${outputRoot}`);
  }
  if (outputRootStat.isSymbolicLink()) {
    throw new Error(`bootstrap scaffold is invalid:
  bootstrap task root must not be a symbolic link: ${outputRoot}`);
  }
  if (!outputRootStat.isDirectory()) {
    throw new Error(`bootstrap scaffold is invalid:
  bootstrap task root is not a directory: ${outputRoot}`);
  }

  const metadataPath = assertManagedPath(outputRoot, BOOTSTRAP_METADATA_FILE);
  requireFileOrThrow(metadataPath, 'bootstrap metadata');

  const metadata = readJsonFile(metadataPath, null);
  const errors = [];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('bootstrap metadata must be an object');
  } else {
    if (metadata.schema !== 1) {
      errors.push('bootstrap metadata schema must be 1');
    }
    if (metadata.package !== 'clean-room-skill') {
      errors.push('bootstrap metadata package must be clean-room-skill');
    }
    const taskId = expectMetadataString(metadata, 'task_id', errors);
    if (taskId && taskId !== path.basename(outputRoot)) {
      errors.push('bootstrap metadata task_id must match the task root basename');
    }
    assertMetadataPath(metadata, 'output_root', outputRoot, errors);
  }

  const roots = {
    contaminated: path.join(outputRoot, BOOTSTRAP_DIRS.contaminated),
    clean: path.join(outputRoot, BOOTSTRAP_DIRS.clean),
    implementation: path.join(outputRoot, BOOTSTRAP_DIRS.implementation),
    quarantine: path.join(outputRoot, BOOTSTRAP_DIRS.quarantine),
  };
  for (const [label, dirPath] of Object.entries(roots)) {
    requireDirectory(dirPath, `bootstrap ${label} directory`, errors);
  }

  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    if (!metadata.roots || typeof metadata.roots !== 'object' || Array.isArray(metadata.roots)) {
      errors.push('bootstrap metadata roots must be an object');
    } else {
      assertMetadataPath(metadata.roots, 'contaminated_artifacts', roots.contaminated, errors);
      assertMetadataPath(metadata.roots, 'clean_artifacts', roots.clean, errors);
      assertMetadataPath(metadata.roots, 'implementation_root', roots.implementation, errors);
      assertMetadataPath(metadata.roots, 'quarantine', roots.quarantine, errors);
    }
  }

  const targetDir = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? expectMetadataString(metadata, 'target_dir', errors)
    : null;
  const repoStubPath = targetDir ? assertManagedPath(path.resolve(expandTilde(targetDir)), BOOTSTRAP_REPO_STUB) : null;
  if (repoStubPath) {
    requireFile(repoStubPath, 'bootstrap repo stub', errors);
  }

  if (errors.length > 0) {
    throw new Error(`bootstrap scaffold is invalid:\n  ${errors.join('\n  ')}`);
  }

  return {
    outputRoot,
    metadataPath,
    metadata,
    roots,
    repoStubPath,
  };
}

function requireFileOrThrow(filePath, label) {
  const errors = [];
  requireFile(filePath, label, errors);
  if (errors.length > 0) {
    throw new Error(`bootstrap scaffold is invalid:\n  ${errors.join('\n  ')}`);
  }
}

function resolveBootstrapScaffold(value, cwd = process.cwd(), homeDir = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--bootstrap requires a path');
  }
  const expanded = expandTilde(value, homeDir);
  const resolved = path.resolve(cwd, expanded);
  const taskRoot = path.basename(resolved) === BOOTSTRAP_METADATA_FILE
    ? path.dirname(resolved)
    : resolved;
  return validateBootstrapScaffold(taskRoot);
}

function writeBootstrapFile(filePath, data, force) {
  try {
    if (force) {
      atomicWriteFile(filePath, data, 'utf8');
    } else {
      atomicWriteFileNoOverwrite(filePath, data, 'utf8');
    }
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(`bootstrap file already exists; use --force to overwrite: ${filePath}`);
    }
    throw err;
  }
}

function applyBootstrap(options) {
  assertWritableTargets(options);
  if (!options.dryRun) {
    for (const dir of Object.values(options.roots)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const metadata = `${JSON.stringify(buildBootstrapMetadata(options), null, 2)}\n`;
    writeBootstrapFile(options.metadataPath, metadata, options.force);
    writeBootstrapFile(options.repoStubPath, renderRepoStub(options.targetProfile), options.force);
  }
  printInitResult(options);
}

function printInitResult(options) {
  const verb = options.dryRun ? 'Would create' : 'Created';
  console.log(`${verb} clean-room bootstrap`);
  console.log(`  output folder: ${options.outputRoot}`);
  console.log(`  contaminated artifacts: ${options.roots.contaminated}`);
  console.log(`  clean artifacts: ${options.roots.clean}`);
  console.log(`  implementation root: ${options.roots.implementation}`);
  console.log(`  quarantine: ${options.roots.quarantine}`);
  console.log(`  metadata: ${options.metadataPath}`);
  console.log(`  repo stub: ${options.repoStubPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('  Codex:');
  console.log('    install safe hooks: npx clean-room-skill@latest --codex --global --hooks=safe --yes');
  console.log('    start in Codex: invoke the init skill, then clean-room through @ or the skills UI');
  console.log('    uninstall runtime install: npx clean-room-skill@latest --codex --global --uninstall --yes');
  console.log('  Claude Code:');
  console.log('    install safe hooks: npx clean-room-skill@latest --claude --global --hooks=safe --yes');
  console.log('    start in Claude Code: /clean-room:init, then /clean-room or /clean-room:attended');
  console.log('    uninstall runtime install: npx clean-room-skill@latest --claude --global --uninstall --yes');
  console.log('  Pi:');
  console.log('    install package skills: pi install npm:clean-room-skill@latest');
  console.log('    start in Pi: /skill:init, then /skill:clean-room or /skill:attended');
  console.log('    Pi package install does not register clean-room hooks');
  console.log('  strict hooks are only for dedicated clean-room Codex, Claude, or OpenCode homes');
}

function runInit(argv, context = {}) {
  const parsed = parseInitArgs(argv);
  if (parsed.help) {
    printInitHelp();
    return null;
  }
  const resolved = resolveInitOptions(parsed, context.env || process.env, context.homeDir || os.homedir());
  applyBootstrap(resolved);
  return resolved;
}

module.exports = {
  BOOTSTRAP_METADATA_FILE,
  defaultArtifactBase,
  generateTaskId,
  parseInitArgs,
  resolveBootstrapScaffold,
  resolveInitOptions,
  runInit,
  TARGET_PROFILES,
  validateBootstrapScaffold,
};
