'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertManagedPath,
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
  lstatIfExists,
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
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BOOTSTRAP_METADATA_FILE = 'clean-room-bootstrap.json';
const PROJECT_METADATA_FILE = 'clean-room-project.json';
const PROJECT_TASKS_DIR = 'tasks';
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

function generateProjectId() {
  return `proj-${crypto.randomBytes(4).toString('hex')}`;
}

function printInitHelp() {
  console.log(`Usage: clean-room-skill init [options]

Create clean-room bootstrap folders and clean-safe repo guidance.

Options:
  --target-dir <path>      Repository to initialize (default: current directory)
  --artifact-base <path>   External CleanRoom base (default: ~/Documents/CleanRoom)
  --task-id <id>           Neutral task id (default: generated task-xxxxxxxx)
  --project <name>         Group this task under a clean-room project; joins the
                           project when it already exists. Project names must be
                           neutral ([a-z0-9][a-z0-9-]{0,63}) and never derived
                           from source or workspace folder names. Project layout:
                           <base>/<project>/tasks/<task-id> with one shared
                           <base>/<project>/implementation root for all tasks
  --new-project            Create a project with a generated proj-xxxxxxxx name
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
    projectId: null,
    newProject: false,
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
    } else if (arg === '--new-project') {
      options.newProject = true;
    } else if (arg === '--project') {
      i += 1;
      options.projectId = requiredValue(argv, i, '--project');
    } else if (arg.startsWith('--project=')) {
      options.projectId = arg.slice('--project='.length);
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

  if (options.projectId !== null && options.newProject) {
    throw new Error('--project and --new-project cannot be combined');
  }

  return options;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function normalizeNameToken(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNeutralProjectId(projectId, targetDir) {
  const projectToken = normalizeNameToken(projectId);
  const targetToken = normalizeNameToken(path.basename(targetDir));
  // Substring overlap is only meaningful for tokens long enough to identify a
  // workspace; short tokens would reject unrelated neutral names.
  const overlapping = projectToken === targetToken
    || (targetToken.length >= 4 && projectToken.includes(targetToken))
    || (projectToken.length >= 4 && targetToken.includes(projectToken));
  if (overlapping) {
    throw new Error('--project must be a neutral name; do not derive project names from workspace or source folder names');
  }
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

  const projectMode = options.projectId !== null || options.newProject === true;
  const projectId = projectMode ? (options.projectId || generateProjectId()) : null;
  if (projectMode) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('--project must match [a-z0-9][a-z0-9-]{0,63}');
    }
    assertNeutralProjectId(projectId, targetDir);
  }

  const projectRoot = projectMode ? path.join(artifactBase, projectId) : null;
  const outputRoot = projectMode
    ? path.join(projectRoot, PROJECT_TASKS_DIR, taskId)
    : path.join(artifactBase, taskId);
  const roots = {
    contaminated: path.join(outputRoot, BOOTSTRAP_DIRS.contaminated),
    clean: path.join(outputRoot, BOOTSTRAP_DIRS.clean),
    implementation: projectMode
      ? path.join(projectRoot, BOOTSTRAP_DIRS.implementation)
      : path.join(outputRoot, BOOTSTRAP_DIRS.implementation),
    quarantine: path.join(outputRoot, BOOTSTRAP_DIRS.quarantine),
  };

  return {
    ...options,
    env,
    homeDir,
    taskId,
    projectId,
    projectRoot,
    targetDir,
    artifactBase,
    outputRoot,
    roots,
    metadataPath: assertManagedPath(outputRoot, BOOTSTRAP_METADATA_FILE),
    projectMetadataPath: projectMode ? assertManagedPath(projectRoot, PROJECT_METADATA_FILE) : null,
    repoStubPath: assertManagedPath(targetDir, BOOTSTRAP_REPO_STUB),
  };
}

function buildBootstrapMetadata(options) {
  return {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    created_at: new Date().toISOString(),
    ...(options.projectId
      ? {
        layout: 'project',
        project_id: options.projectId,
        project_root: options.projectRoot,
      }
      : {}),
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

function buildProjectMetadata(options) {
  return {
    schema: 1,
    package: 'clean-room-skill',
    version: packageVersion(),
    created_at: new Date().toISOString(),
    project_id: options.projectId,
    artifact_base_root: options.artifactBase,
    project_root: options.projectRoot,
    implementation_root: options.roots.implementation,
    tasks_dir: path.join(options.projectRoot, PROJECT_TASKS_DIR),
    note: 'Project metadata only. Tasks are discovered by scanning tasks/; the shared implementation root is the clean destination for every task in this project.',
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

function resolveExistingProject(options) {
  if (!options.projectRoot) {
    return { mode: 'none' };
  }
  const projectRootStat = lstatIfExists(options.projectRoot);
  if (!projectRootStat) {
    return { mode: 'new' };
  }
  if (projectRootStat.isSymbolicLink()) {
    throw new Error(`project root must not be a symbolic link: ${options.projectRoot}`);
  }
  if (!projectRootStat.isDirectory()) {
    throw new Error(`project root is not a directory: ${options.projectRoot}`);
  }
  if (options.force) {
    return { mode: 'existing' };
  }
  if (!fs.existsSync(options.projectMetadataPath)) {
    throw new Error(`project root exists but ${PROJECT_METADATA_FILE} is missing; use --force to adopt it: ${options.projectRoot}`);
  }
  const metadata = readJsonFile(options.projectMetadataPath, null);
  const errors = [];
  validateProjectMetadataObject(metadata, options.projectRoot, errors);
  if (errors.length > 0) {
    throw new Error(`project root exists but ${PROJECT_METADATA_FILE} is invalid; use --force to adopt it:\n  ${errors.join('\n  ')}`);
  }
  return { mode: 'existing' };
}

function assertWritableTargets(options) {
  const projectState = resolveExistingProject(options);
  const joiningExistingProject = projectState.mode === 'existing';

  const fileConflicts = [];
  if (fs.existsSync(options.metadataPath) && !options.force) {
    fileConflicts.push(options.metadataPath);
  }
  // A second task joining a project commonly shares the same target repo; its
  // existing stub is reused, not a conflict.
  if (fs.existsSync(options.repoStubPath) && !options.force && !joiningExistingProject) {
    fileConflicts.push(options.repoStubPath);
  }
  if (fileConflicts.length > 0) {
    throw new Error(`bootstrap file already exists; use --force to overwrite: ${fileConflicts.join(', ')}`);
  }

  const pathConflicts = [];
  for (const [label, dirPath] of Object.entries(options.roots)) {
    // The project-level implementation root is shared across tasks, so it may
    // already exist once the project metadata has been validated.
    if (label === 'implementation' && joiningExistingProject) {
      continue;
    }
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

  return projectState;
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

function expectMetadataString(metadata, field, errors, label = 'bootstrap metadata') {
  if (typeof metadata?.[field] !== 'string' || metadata[field].length === 0) {
    errors.push(`${label} ${field} must be a non-empty string`);
    return null;
  }
  return metadata[field];
}

function assertMetadataPath(metadata, field, expectedPath, errors, label = 'bootstrap metadata') {
  const value = expectMetadataString(metadata, field, errors, label);
  if (!value) return;
  if (path.resolve(expandTilde(value)) !== expectedPath) {
    errors.push(`${label} ${field} must match ${expectedPath}`);
  }
}

function validateProjectMetadataObject(metadata, projectRoot, errors) {
  const label = 'project metadata';
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (metadata.schema !== 1) {
    errors.push(`${label} schema must be 1`);
  }
  if (metadata.package !== 'clean-room-skill') {
    errors.push(`${label} package must be clean-room-skill`);
  }
  const projectId = expectMetadataString(metadata, 'project_id', errors, label);
  if (projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      errors.push(`${label} project_id must match [a-z0-9][a-z0-9-]{0,63}`);
    }
    if (projectId !== path.basename(projectRoot)) {
      errors.push(`${label} project_id must match the project root basename`);
    }
  }
  assertMetadataPath(metadata, 'project_root', projectRoot, errors, label);
  assertMetadataPath(metadata, 'implementation_root', path.join(projectRoot, BOOTSTRAP_DIRS.implementation), errors, label);
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
  const metadataIsObject = Boolean(metadata) && typeof metadata === 'object' && !Array.isArray(metadata);
  if (!metadataIsObject) {
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

  // Project layouts nest the task root under <project>/tasks/ and share one
  // project-level implementation root. Never trust the metadata paths
  // directly: derive the project root from the task root location, then
  // require the metadata to match the derived layout.
  const projectLayout = metadataIsObject
    && (metadata.layout !== undefined || metadata.project_id !== undefined || metadata.project_root !== undefined);
  let projectRoot = null;
  let projectId = null;
  let projectMetadataPath = null;
  if (projectLayout) {
    if (metadata.layout !== 'project'
      || typeof metadata.project_id !== 'string'
      || typeof metadata.project_root !== 'string') {
      errors.push('bootstrap metadata project layout requires layout "project", project_id, and project_root');
    }
    const tasksDir = path.dirname(outputRoot);
    if (path.basename(tasksDir) !== PROJECT_TASKS_DIR) {
      errors.push(`bootstrap project task root must live under a ${PROJECT_TASKS_DIR}/ directory: ${outputRoot}`);
    } else {
      projectRoot = path.dirname(tasksDir);
      requireDirectory(projectRoot, 'project root', errors);
      assertMetadataPath(metadata, 'project_root', projectRoot, errors);
      projectId = expectMetadataString(metadata, 'project_id', errors);
      if (projectId) {
        if (!PROJECT_ID_PATTERN.test(projectId)) {
          errors.push('bootstrap metadata project_id must match [a-z0-9][a-z0-9-]{0,63}');
        }
        if (projectId !== path.basename(projectRoot)) {
          errors.push('bootstrap metadata project_id must match the project root basename');
        }
      }
      try {
        projectMetadataPath = assertManagedPath(projectRoot, PROJECT_METADATA_FILE);
      } catch (err) {
        errors.push(err.message);
      }
      if (projectMetadataPath) {
        requireFile(projectMetadataPath, 'project metadata', errors);
        if (fs.existsSync(projectMetadataPath)) {
          validateProjectMetadataObject(readJsonFile(projectMetadataPath, null), projectRoot, errors);
        }
      }
    }
  }

  const roots = {
    contaminated: path.join(outputRoot, BOOTSTRAP_DIRS.contaminated),
    clean: path.join(outputRoot, BOOTSTRAP_DIRS.clean),
    implementation: projectRoot
      ? path.join(projectRoot, BOOTSTRAP_DIRS.implementation)
      : path.join(outputRoot, BOOTSTRAP_DIRS.implementation),
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
    projectRoot,
    projectId,
    projectMetadataPath,
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

function writeProjectMetadataFile(options) {
  const metadata = buildProjectMetadata(options);
  if (options.force) {
    // A forced rewrite refreshes the metadata but keeps the project's
    // original creation time when the prior file is readable. --force is
    // also the documented way to adopt invalid metadata, so parse failures
    // fall back to the fresh timestamp instead of aborting.
    try {
      const existing = readJsonFile(options.projectMetadataPath, null);
      if (typeof existing?.created_at === 'string' && existing.created_at.length > 0) {
        metadata.created_at = existing.created_at;
      }
    } catch {
      // Keep the fresh created_at when existing metadata is unreadable.
    }
    atomicWriteFile(options.projectMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return;
  }
  const data = `${JSON.stringify(metadata, null, 2)}\n`;
  try {
    atomicWriteFileNoOverwrite(options.projectMetadataPath, data, 'utf8');
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw err;
    }
    // Joining an existing project, or losing a creation race: exactly one
    // writer wins the no-overwrite link; everyone else validates the winner's
    // metadata and proceeds without rewriting it.
    const errors = [];
    validateProjectMetadataObject(readJsonFile(options.projectMetadataPath, null), options.projectRoot, errors);
    if (errors.length > 0) {
      throw new Error(`existing ${PROJECT_METADATA_FILE} is invalid; use --force to adopt it:\n  ${errors.join('\n  ')}`);
    }
  }
}

function applyBootstrap(options) {
  const projectState = assertWritableTargets(options);
  if (!options.dryRun) {
    if (options.projectRoot) {
      fs.mkdirSync(path.join(options.projectRoot, PROJECT_TASKS_DIR), { recursive: true });
    }
    for (const dir of Object.values(options.roots)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (options.projectRoot) {
      writeProjectMetadataFile(options);
    }
    const metadata = `${JSON.stringify(buildBootstrapMetadata(options), null, 2)}\n`;
    writeBootstrapFile(options.metadataPath, metadata, options.force);
    if (options.force || !fs.existsSync(options.repoStubPath)) {
      writeBootstrapFile(options.repoStubPath, renderRepoStub(options.targetProfile), options.force);
    }
  }
  printInitResult(options, projectState);
}

function printInitResult(options, projectState = { mode: 'none' }) {
  const verb = options.dryRun ? 'Would create' : 'Created';
  console.log(`${verb} clean-room bootstrap`);
  if (options.projectId) {
    const projectLabel = projectState.mode === 'existing' ? 'existing' : 'new';
    console.log(`  project: ${options.projectId} (${projectLabel})`);
    console.log(`  project root: ${options.projectRoot}`);
  }
  console.log(`  output folder: ${options.outputRoot}`);
  console.log(`  contaminated artifacts: ${options.roots.contaminated}`);
  console.log(`  clean artifacts: ${options.roots.clean}`);
  if (options.projectId) {
    console.log(`  implementation root (shared): ${options.roots.implementation}`);
  } else {
    console.log(`  implementation root: ${options.roots.implementation}`);
  }
  console.log(`  quarantine: ${options.roots.quarantine}`);
  console.log(`  metadata: ${options.metadataPath}`);
  if (options.projectId) {
    console.log(`  project metadata: ${options.projectMetadataPath}`);
  }
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
  console.log('    installer compatibility: npx clean-room-skill@latest --pi --global --yes');
  console.log('    start in Pi: /skill:init, then /skill:clean-room or /skill:attended');
  console.log('    Pi installs do not register clean-room hooks');
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
  PROJECT_METADATA_FILE,
  defaultArtifactBase,
  generateProjectId,
  generateTaskId,
  parseInitArgs,
  resolveBootstrapScaffold,
  resolveInitOptions,
  runInit,
  TARGET_PROFILES,
  validateBootstrapScaffold,
};
