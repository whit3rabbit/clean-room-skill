'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileHash, readJsonFile } = require('./fs-utils.cjs');
const { validateGoalContract } = require('./preflight-validation.cjs');
const {
  BASE_ENV_ALLOWLIST,
  CI_ENV_ALLOWLIST,
} = require('./run-constants.cjs');

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function defaultSchemaDir() {
  return path.join(packageRoot(), 'skills', 'clean-room', 'assets');
}

function validateSchemaDir(schemaDir, explicit = false) {
  let stat;
  try {
    stat = fs.statSync(schemaDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(schemaDirError('schema directory not found', schemaDir, explicit));
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(schemaDirError('schema path is not a directory', schemaDir, explicit));
  }
  const taskManifestSchema = path.join(schemaDir, 'task-manifest.schema.json');
  try {
    const schemaStat = fs.statSync(taskManifestSchema);
    if (!schemaStat.isFile()) {
      throw new Error(schemaDirError('schema directory is missing task-manifest.schema.json', schemaDir, explicit));
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(schemaDirError('schema directory is missing task-manifest.schema.json', schemaDir, explicit));
    }
    throw err;
  }
}

function schemaDirError(reason, schemaDir, explicit) {
  if (explicit) {
    return `${reason}: ${schemaDir}. Omit --schema-dir to use bundled schemas at ${defaultSchemaDir()}.`;
  }
  return `${reason}: ${schemaDir}. The bundled schema directory should contain task-manifest.schema.json.`;
}

function hookPath(scriptName) {
  return path.join(packageRoot(), 'hooks', scriptName);
}

function resolvePath(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('expected non-empty path value');
  }
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(baseDir, expanded);
}

function resolveManifestRoot(rawPath, manifestDir) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return null;
  }
  const expanded = rawPath === '~' ? os.homedir() : rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(manifestDir, expanded);
}

function resolveRoots(manifest, manifestDir, schemaDir) {
  const paths = manifest.artifact_paths || {};
  const contaminatedRoot = resolveManifestRoot(
    Array.isArray(paths.contaminated_artifact_roots) ? paths.contaminated_artifact_roots[0] : paths.contaminated_artifacts,
    manifestDir
  );
  const cleanRoot = resolveManifestRoot(paths.clean_artifacts, manifestDir);
  const implementationRoots = (paths.implementation_roots || [])
    .map((item) => resolveManifestRoot(item, manifestDir))
    .filter(Boolean);
  const sourceRoots = effectiveRoots(manifest, 'source_roots', manifestDir);
  const allowedReadRoots = effectiveRoots(manifest, 'approved_public_reference_roots', manifestDir);

  if (!contaminatedRoot) throw new Error('task manifest must provide a contaminated artifact root');
  if (!cleanRoot) throw new Error('task manifest must provide a clean artifact root');
  if (implementationRoots.length === 0) throw new Error('task manifest must provide at least one implementation root');

  validateRootSeparation({
    sourceRoots,
    contaminatedRoots: [contaminatedRoot],
    cleanRoots: [cleanRoot],
    implementationRoots,
    allowedReadRoots,
    schemaRoots: [schemaDir],
  });

  return {
    sourceRoots,
    contaminatedRoot,
    cleanRoot,
    implementationRoots,
    allowedReadRoots,
    schemaDir,
  };
}

function assertNoRootOverlap(leftRoots, rightRoots, message) {
  for (const left of leftRoots) {
    for (const right of rightRoots) {
      if (pathsOverlap(left, right)) {
        throw new Error(message);
      }
    }
  }
}

function rootComparisonPaths(root) {
  const resolved = path.resolve(root);
  const realPath = realpathIfExists(resolved);
  return realPath && realPath !== resolved ? [resolved, realPath] : [resolved];
}

function pathsOverlap(left, right) {
  for (const leftPath of rootComparisonPaths(left)) {
    for (const rightPath of rootComparisonPaths(right)) {
      if (pathIsUnder(leftPath, rightPath) || pathIsUnder(rightPath, leftPath)) {
        return true;
      }
    }
  }
  return false;
}

function validateRootSeparation(roots) {
  assertNoRootOverlap(roots.sourceRoots, roots.cleanRoots, 'source roots and clean roots must be separate');
  assertNoRootOverlap(roots.sourceRoots, roots.contaminatedRoots, 'source roots and contaminated artifact roots must be separate');
  assertNoRootOverlap(roots.sourceRoots, roots.implementationRoots, 'source roots and implementation roots must be separate');
  assertNoRootOverlap(roots.cleanRoots, roots.contaminatedRoots, 'clean roots and contaminated artifact roots must be separate');
  assertNoRootOverlap(roots.cleanRoots, roots.implementationRoots, 'clean roots and implementation roots must be separate');
  assertNoRootOverlap(roots.contaminatedRoots, roots.implementationRoots, 'contaminated artifact roots and implementation roots must be separate');
  assertNoRootOverlap(roots.allowedReadRoots, roots.sourceRoots, 'allowed clean read roots must not expose source roots');
  assertNoRootOverlap(roots.schemaRoots, roots.sourceRoots, 'schema directory must be separate from source roots');
  assertNoRootOverlap(roots.schemaRoots, roots.cleanRoots, 'schema directory must be separate from clean roots');
  assertNoRootOverlap(roots.schemaRoots, roots.implementationRoots, 'schema directory must be separate from implementation roots');
}

function validateTaskManifestLocation(taskManifestPath, roots) {
  const expected = path.join(roots.contaminatedRoot, 'task-manifest.json');
  if (!pathIsUnder(taskManifestPath, roots.contaminatedRoot)) {
    throw new Error(
      `task manifest must be under contaminated artifact root; resolved path: ${taskManifestPath}; expected: ${expected}`
    );
  }
  const realTaskManifestPath = realpathIfExists(taskManifestPath);
  const realContaminatedRoot = realpathIfExists(roots.contaminatedRoot) || roots.contaminatedRoot;
  if (!realTaskManifestPath || !pathIsUnder(realTaskManifestPath, realContaminatedRoot)) {
    throw new Error(
      `task manifest must resolve under contaminated artifact root; resolved path: ${taskManifestPath}; expected: ${expected}`
    );
  }
}

function effectiveRoots(manifest, field, manifestDir) {
  const values = manifest.initialization_snapshot?.effective_roots?.[field] || [];
  return values
    .map((item) => resolveManifestRoot(item, manifestDir))
    .filter(Boolean);
}

function envFromAllowlist(extraNames = []) {
  const env = {};
  for (const key of [...BASE_ENV_ALLOWLIST, ...CI_ENV_ALLOWLIST, ...extraNames]) {
    if (Object.hasOwn(process.env, key)) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function verifyPreflightGoal(manifest, manifestDir, roots) {
  const preflightGoalPath = resolveManifestRoot(manifest.preflight_goal_ref, manifestDir);
  const expected = path.join(roots.contaminatedRoot, 'preflight-goal.json');
  if (!preflightGoalPath) {
    throw new Error(`clean-room run requires task-manifest preflight_goal_ref; expected: ${expected}`);
  }
  if (!pathIsUnder(preflightGoalPath, roots.contaminatedRoot)) {
    throw new Error(
      `preflight goal must resolve under contaminated artifact root; resolved path: ${preflightGoalPath}; expected under: ${roots.contaminatedRoot}`
    );
  }
  let preflightGoalRealPath;
  try {
    preflightGoalRealPath = fs.realpathSync(preflightGoalPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`preflight goal not found: ${preflightGoalPath}; expected: ${expected}`);
    }
    throw err;
  }
  const contaminatedRootRealPath = realpathIfExists(roots.contaminatedRoot) || roots.contaminatedRoot;
  if (!pathIsUnder(preflightGoalRealPath, contaminatedRootRealPath)) {
    throw new Error(
      `preflight goal must resolve under contaminated artifact root; resolved path: ${preflightGoalPath}; expected under: ${roots.contaminatedRoot}`
    );
  }
  let stat;
  try {
    stat = fs.statSync(preflightGoalRealPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`preflight goal not found: ${preflightGoalPath}; expected: ${expected}`);
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`preflight goal is not a file: ${preflightGoalPath}`);
  }
  const actual = fileHash(preflightGoalRealPath).toLowerCase();
  const expectedHash = manifest.preflight_goal_sha256.toLowerCase();
  if (actual !== expectedHash) {
    throw new Error(`preflight goal sha256 mismatch: ${preflightGoalPath}`);
  }
  const preflightGoal = readJsonFile(preflightGoalRealPath, null);
  const errors = validateGoalContract(preflightGoal, { requireComplete: true, requireUnattended: true });
  if (preflightGoal?.controller_policy?.mode !== manifest.controller_policy?.mode) {
    errors.push('preflight goal controller_policy.mode must match task-manifest controller_policy.mode');
  }
  if (errors.length > 0) {
    throw new Error(`preflight goal is not runner-ready:\n  ${errors.join('\n  ')}`);
  }
}

function pathIsUnder(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathIsUnderAny(child, parents) {
  return parents.some((parent) => pathIsUnder(child, parent));
}

function realpathIfExists(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function realpathRoots(roots) {
  return roots.map((root) => realpathIfExists(root) || root);
}

function resolveExistingPathWithinRoots(filePath, allowedRoots, label) {
  const realPath = fs.realpathSync(filePath);
  if (!pathIsUnderAny(realPath, realpathRoots(allowedRoots))) {
    throw new Error(`${label} must resolve under allowed roots: ${filePath}`);
  }
  return realPath;
}

module.exports = {
  defaultSchemaDir,
  envFromAllowlist,
  hookPath,
  packageRoot,
  pathIsUnder,
  pathIsUnderAny,
  realpathIfExists,
  realpathRoots,
  resolveExistingPathWithinRoots,
  resolveManifestRoot,
  resolvePath,
  resolveRoots,
  validateTaskManifestLocation,
  validateSchemaDir,
  verifyPreflightGoal,
};
