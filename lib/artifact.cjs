'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  atomicWriteFile,
  atomicWriteFileNoOverwrite,
  readJsonFile,
} = require('./fs-utils.cjs');
const { parseArtifactArgs, printArtifactHelp } = require('./artifact-cli.cjs');
const {
  CLEAN_ROOM_ROLES,
  HANDOFF_PACKAGE_NAME,
  SANITIZER_ROLE,
} = require('./run-constants.cjs');
const {
  validateArtifacts,
  validateSchemaFile,
  validateTaskManifestSchema,
} = require('./run-hooks.cjs');
const {
  defaultSchemaDir,
  packageRoot,
  pathIsUnder,
  resolvePath,
  resolveRoots,
  validateTaskManifestLocation,
  validateSchemaDir,
} = require('./run-roots.cjs');
const {
  publicSurfaceRef,
  validateCoverageLedgerIntegrity,
  validateFoundationCoverageGate,
  validateSpecPlanPublicSurfaceJoin,
} = require('./run-coverage.cjs');

const ARTIFACT_KINDS = [
  'init-config',
  'preflight-goal',
  'clean-run-context',
  'task-manifest',
  'behavior-spec',
  'skeleton-manifest',
  'implementation-plan',
  'implementation-report',
  'polish-report',
  'clean-room-result',
  'qc-report',
  'coverage-ledger',
  'evidence-ledger',
  'source-index',
  'visual-index',
  'handoff-package',
  'contamination-incident',
  'role-session-brief',
  'controller-status',
];

const SPECIAL_CREATION = new Map([
  ['preflight-goal', 'clean-room-skill preflight --template or --input'],
  ['source-index', 'python3 skills/clean-room/scripts/build_source_index.py'],
  ['visual-index', 'python3 skills/clean-room/scripts/build_visual_index.py'],
]);

// Explicit kind -> bundled example mapping. Several kinds (behavior-spec,
// handoff-package) appear in more than one example directory, so resolving the
// template by scanning directories made the shipped starter depend on array
// ordering. Pin the source for every non-special kind here instead.
const TEMPLATE_EXAMPLE_SOURCES = Object.freeze({
  'init-config': ['contaminated-side', 'init-config.json'],
  'clean-run-context': ['minimal-spec-package', 'clean-run-context.json'],
  'task-manifest': ['contaminated-side', 'task-manifest.json'],
  'behavior-spec': ['minimal-spec-package', 'behavior-spec.json'],
  'skeleton-manifest': ['minimal-spec-package', 'skeleton-manifest.json'],
  'implementation-plan': ['minimal-spec-package', 'implementation-plan.json'],
  'implementation-report': ['minimal-spec-package', 'implementation-report.json'],
  'polish-report': ['minimal-spec-package', 'polish-report.json'],
  'clean-room-result': ['minimal-spec-package', 'clean-room-result.json'],
  'qc-report': ['minimal-spec-package', 'qc-report.json'],
  'coverage-ledger': ['contaminated-side', 'coverage-ledger.json'],
  'evidence-ledger': ['contaminated-side', 'evidence-ledger.json'],
  'handoff-package': ['minimal-spec-package', 'handoff-package.json'],
  'contamination-incident': ['minimal-spec-package', 'contamination-incident.json'],
  'role-session-brief': ['minimal-spec-package', 'role-session-brief.json'],
  'controller-status': ['contaminated-side', 'controller-status.json'],
});

function printKinds() {
  console.log('Canonical clean-room artifact kinds:');
  for (const kind of ARTIFACT_KINDS) {
    console.log(`- ${kind}: ${creationCommand(kind)}`);
  }
}

function creationCommand(kind) {
  return SPECIAL_CREATION.get(kind)
    || `clean-room-skill artifact template --kind ${kind} --output <path>`;
}

function validateKind(kind) {
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new Error(`unknown artifact kind: ${kind}`);
  }
}

function templateSourcePath(kind) {
  validateKind(kind);
  const special = SPECIAL_CREATION.get(kind);
  if (special) {
    throw new Error(`${kind}.json uses an artifact-specific generator: ${special}`);
  }
  const entry = TEMPLATE_EXAMPLE_SOURCES[kind];
  if (!entry) {
    throw new Error(`no bundled template example found for artifact kind: ${kind}`);
  }
  const [exampleDir, fileName] = entry;
  const candidate = path.join(packageRoot(), 'skills', 'clean-room', 'examples', exampleDir, fileName);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`no bundled template example found for artifact kind: ${kind}`);
  }
  return candidate;
}

function writeArtifactTemplate(options, context) {
  if (!options.kind) {
    throw new Error('--kind is required');
  }
  if (!options.output) {
    throw new Error('--output is required');
  }
  const cwd = context.cwd || process.cwd();
  const sourcePath = templateSourcePath(options.kind);
  const outputPath = resolvePath(options.output, cwd);
  const template = readJsonFile(sourcePath, null);
  const data = `${JSON.stringify(template, null, 2)}\n`;
  if (options.dryRun) {
    console.log(`Would write ${options.kind} artifact template: ${outputPath}`);
    return { outputPath, kind: options.kind, dryRun: true };
  }
  try {
    if (options.force) {
      atomicWriteFile(outputPath, data, 'utf8');
    } else {
      atomicWriteFileNoOverwrite(outputPath, data, 'utf8');
    }
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(`artifact output already exists; use --force to overwrite: ${outputPath}`);
    }
    throw err;
  }
  console.log(`Wrote ${options.kind} artifact template: ${outputPath}`);
  return { outputPath, kind: options.kind, dryRun: false };
}

function resolveValidationPaths(rawPaths, cwd) {
  if (rawPaths.length === 0) {
    throw new Error('--path is required');
  }
  return rawPaths.map((item) => {
    const filePath = resolvePath(item, cwd);
    if (!fs.existsSync(filePath)) {
      throw new Error(`artifact path not found: ${filePath}`);
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`artifact path is not a file: ${filePath}`);
    }
    return filePath;
  });
}

function manifestArtifactRoots(roots) {
  return [roots.contaminatedRoot, roots.cleanRoot, ...roots.implementationRoots].filter(Boolean);
}

function assertPathsWithinRoots(filePaths, roots) {
  const artifactRoots = manifestArtifactRoots(roots);
  for (const filePath of filePaths) {
    if (!artifactRoots.some((root) => pathIsUnder(filePath, root))) {
      throw new Error(`artifact path is outside the task manifest roots; validate it from its task root or pass the matching --task-manifest: ${filePath}`);
    }
  }
}

function warnOnUnscannedHandoff(filePaths, roots, role) {
  if (role === SANITIZER_ROLE) {
    return;
  }
  for (const filePath of filePaths) {
    if (path.basename(filePath) !== HANDOFF_PACKAGE_NAME) {
      continue;
    }
    const underContaminated = pathIsUnder(filePath, roots.contaminatedRoot);
    const underClean = roots.cleanRoot ? pathIsUnder(filePath, roots.cleanRoot) : false;
    if (underContaminated && !underClean) {
      process.stderr.write(
        `warning: leakage scanning of a contaminated-root ${HANDOFF_PACKAGE_NAME} requires --role ${SANITIZER_ROLE}; `
        + `the leakage scan was skipped for ${filePath}\n`,
      );
    }
  }
}

function validateArtifactPaths(options, context) {
  const cwd = context.cwd || process.cwd();
  const schemaDir = options.schemaDir ? resolvePath(options.schemaDir, cwd) : defaultSchemaDir();
  validateSchemaDir(schemaDir, Boolean(options.schemaDir));
  const filePaths = resolveValidationPaths(options.paths, cwd);

  // `artifact validate` is an explicit validation gate, so an input the schema
  // hook cannot map to a canonical artifact kind must fail closed. The flag is
  // forwarded to the bundled hook through HOOK_ONLY_ENV_ALLOWLIST.
  process.env.CLEAN_ROOM_REQUIRE_ARTIFACT_KIND = '1';

  if (options.taskManifest) {
    if (!CLEAN_ROOM_ROLES.has(options.role)) {
      throw new Error(`unknown clean-room role: ${options.role}`);
    }
    const taskManifestPath = resolvePath(options.taskManifest, cwd);
    if (!fs.existsSync(taskManifestPath)) {
      throw new Error(`task manifest not found: ${taskManifestPath}`);
    }
    if (!fs.statSync(taskManifestPath).isFile()) {
      throw new Error(`task manifest is not a file: ${taskManifestPath}`);
    }
    validateTaskManifestSchema(options.python, taskManifestPath, schemaDir);
    const manifest = readJsonFile(taskManifestPath, null);
    const roots = resolveRoots(manifest, path.dirname(taskManifestPath), schemaDir);
    validateTaskManifestLocation(taskManifestPath, roots);
    assertPathsWithinRoots(filePaths, roots);
    warnOnUnscannedHandoff(filePaths, roots, options.role);
    validateArtifacts(options.python, taskManifestPath, roots, filePaths, options.role);
  } else {
    if (options.roleProvided) {
      throw new Error('--role requires --task-manifest');
    }
    for (const filePath of filePaths) {
      validateSchemaFile(options.python, filePath, schemaDir);
    }
  }

  const label = filePaths.length === 1 ? 'artifact' : 'artifacts';
  console.log(`Validated ${filePaths.length} ${label}.`);
  return { paths: filePaths };
}

// Two independent modes, picked by which inputs are present:
//   --spec + --plan            post-Plan join check, before any coverage-ledger exists
//   --task-manifest [+ --coverage-ledger]  post-Verify full gate check (real runner logic)
function checkCoveragePaths(options, context) {
  const cwd = context.cwd || process.cwd();

  if (options.specs.length > 0 || options.plan) {
    if (options.specs.length === 0 || !options.plan) {
      throw new Error('check-coverage post-plan mode requires at least one --spec and --plan');
    }
    const planPath = resolvePath(options.plan, cwd);
    if (!fs.existsSync(planPath)) {
      throw new Error(`implementation plan not found: ${planPath}`);
    }
    const plan = readJsonFile(planPath, null);
    let obligationCount = 0;
    for (const specArg of options.specs) {
      const specPath = resolvePath(specArg, cwd);
      if (!fs.existsSync(specPath)) {
        throw new Error(`behavior spec not found: ${specPath}`);
      }
      const spec = readJsonFile(specPath, null);
      const result = validateSpecPlanPublicSurfaceJoin(specPath, spec, plan);
      obligationCount += result.obligationCount;
    }
    console.log(`Checked ${options.specs.length} spec(s) against ${planPath}: ${obligationCount} public_surface obligation(s) joined.`);
    return { mode: 'plan-join', specs: options.specs.length, obligations: obligationCount };
  }

  if (options.taskManifest) {
    const taskManifestPath = resolvePath(options.taskManifest, cwd);
    if (!fs.existsSync(taskManifestPath)) {
      throw new Error(`task manifest not found: ${taskManifestPath}`);
    }
    const manifest = readJsonFile(taskManifestPath, null);
    const schemaDir = options.schemaDir ? resolvePath(options.schemaDir, cwd) : defaultSchemaDir();
    const roots = resolveRoots(manifest, path.dirname(taskManifestPath), schemaDir);
    const coverageLedgerPath = options.coverageLedger
      ? resolvePath(options.coverageLedger, cwd)
      : path.join(roots.contaminatedRoot, 'coverage-ledger.json');
    if (!fs.existsSync(coverageLedgerPath)) {
      throw new Error(`coverage-ledger not found: ${coverageLedgerPath}`);
    }
    const coverageLedger = readJsonFile(coverageLedgerPath, null);
    validateCoverageLedgerIntegrity(manifest, roots, coverageLedger);
    validateFoundationCoverageGate(manifest, coverageLedger);
    console.log(`Checked coverage-ledger integrity: ${coverageLedgerPath} against ${taskManifestPath}.`);
    return { mode: 'coverage-ledger', coverageLedgerPath };
  }

  throw new Error('check-coverage requires either (--spec + --plan) or (--task-manifest [+ --coverage-ledger])');
}

// Reads spec_id from the spec file itself instead of asking the caller to type it,
// so the exact typo class this file's other gates exist to catch (a hand-typed
// unit_id where spec_id belongs) cannot happen for this ref.
function printPublicSurfaceRef(options, context) {
  const cwd = context.cwd || process.cwd();
  const specArg = options.specs[0];
  if (!specArg || !options.kind || !options.refName) {
    throw new Error('public-surface-ref requires --spec, --kind, and --name');
  }
  const specPath = resolvePath(specArg, cwd);
  if (!fs.existsSync(specPath)) {
    throw new Error(`behavior spec not found: ${specPath}`);
  }
  const spec = readJsonFile(specPath, null);
  if (!spec || typeof spec.spec_id !== 'string' || !spec.spec_id) {
    throw new Error(`behavior spec has no spec_id: ${specPath}`);
  }
  const ref = publicSurfaceRef(spec, { kind: options.kind, name: options.refName });
  console.log(ref);
  return { ref };
}

function runArtifact(argv, context = {}) {
  const options = parseArtifactArgs(argv);
  if (options.help) {
    printArtifactHelp();
    return null;
  }
  if (options.command === 'kinds') {
    printKinds();
    return { kinds: [...ARTIFACT_KINDS] };
  }
  if (options.command === 'template') {
    return writeArtifactTemplate(options, context);
  }
  if (options.command === 'validate') {
    return validateArtifactPaths(options, context);
  }
  if (options.command === 'check-coverage') {
    return checkCoveragePaths(options, context);
  }
  if (options.command === 'public-surface-ref') {
    return printPublicSurfaceRef(options, context);
  }
  throw new Error('artifact command is required');
}

module.exports = {
  ARTIFACT_KINDS,
  SPECIAL_CREATION,
  parseArtifactArgs,
  runArtifact,
};
