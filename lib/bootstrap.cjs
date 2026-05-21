'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertManagedPath,
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
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
    metadataPath: assertManagedPath(outputRoot, 'clean-room-bootstrap.json'),
    repoStubPath: assertManagedPath(targetDir, '.clean-room/README.md'),
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
      quarantine: options.roots.quarantine,
    },
    note: 'Bootstrap metadata only. The clean-room skill creates active init-config.json, task-manifest.json, and clean-run-context.json artifacts.',
  };
}

function renderRepoStub(targetProfile) {
  return `# Clean Room Bootstrap

This repository has a clean-room bootstrap stub.

Active clean-room run artifacts are stored outside this repository. Do not commit source roots, contaminated artifact paths, private identifiers, source-derived names, or active \`init-config.json\`, \`task-manifest.json\`, or \`clean-run-context.json\` files here.

Default target profile: \`${targetProfile}\`

Start the runtime skill from your agent and provide the external output folder printed by \`clean-room-skill init\`.
`;
}

function assertWritableTargets(options) {
  const conflicts = [];
  for (const filePath of [options.metadataPath, options.repoStubPath]) {
    if (fs.existsSync(filePath) && !options.force) {
      conflicts.push(filePath);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`bootstrap file already exists; use --force to overwrite: ${conflicts.join(', ')}`);
  }
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
  console.log(`  quarantine: ${options.roots.quarantine}`);
  console.log(`  metadata: ${options.metadataPath}`);
  console.log(`  repo stub: ${options.repoStubPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('  install safe hooks: npx clean-room-skill@latest --codex --global --hooks=safe --yes');
  console.log('  start in your runtime: invoke the clean-room init skill, then clean-room');
  console.log('  uninstall runtime install: npx clean-room-skill@latest --codex --global --uninstall --yes');
  console.log('  strict hooks are only for dedicated clean-room Codex or Claude homes');
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
  defaultArtifactBase,
  generateTaskId,
  parseInitArgs,
  resolveInitOptions,
  runInit,
  TARGET_PROFILES,
};
