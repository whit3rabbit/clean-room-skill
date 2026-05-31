'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  HANDOFF_PACKAGE_NAME,
  HOOK_ONLY_ENV_ALLOWLIST,
  MAX_OUTPUT_BYTES,
  RUN_HOOK_TIMEOUT_MS,
} = require('./run-constants.cjs');
const { trackedArtifactPaths } = require('./run-progress.cjs');
const {
  envFromAllowlist,
  hookPath,
  packageRoot,
} = require('./run-roots.cjs');

function hookEnv(roots, role = 'contaminated-manager-verifier') {
  return {
    ...envFromAllowlist(HOOK_ONLY_ENV_ALLOWLIST),
    CLEAN_ROOM_ROLE: role,
    CLEAN_ROOM_SOURCE_ROOTS: roots.sourceRoots.join(path.delimiter),
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: roots.contaminatedRoot,
    CLEAN_ROOM_CLEAN_ROOTS: roots.cleanRoot,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: roots.implementationRoots.join(path.delimiter),
    CLEAN_ROOM_ALLOWED_READ_ROOTS: roots.allowedReadRoots.join(path.delimiter),
    CLEAN_ROOM_SCHEMA_DIR: roots.schemaDir,
  };
}

function validationPayload(filePath) {
  return JSON.stringify({ tool_input: { file_path: filePath } });
}

function taskManifestSchemaEnv(schemaDir) {
  return {
    ...envFromAllowlist(HOOK_ONLY_ENV_ALLOWLIST),
    CLEAN_ROOM_SCHEMA_DIR: schemaDir,
  };
}

function validateTaskManifestSchema(python, manifestPath, schemaDir) {
  const scriptName = 'validate-json-schema.py';
  const result = spawnSync(python, [hookPath(scriptName)], {
    cwd: packageRoot(),
    env: taskManifestSchemaEnv(schemaDir),
    input: validationPayload(manifestPath),
    encoding: 'utf8',
    timeout: RUN_HOOK_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const error = result.error?.message || '';
    throw new Error(`${scriptName} failed for ${manifestPath}: ${stderr || stdout || error || `exit ${result.status}`}`);
  }
}

function runHook(python, scriptName, filePath, roots, role = 'contaminated-manager-verifier') {
  const result = spawnSync(python, [hookPath(scriptName)], {
    cwd: packageRoot(),
    env: hookEnv(roots, role),
    input: validationPayload(filePath),
    encoding: 'utf8',
    timeout: RUN_HOOK_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const error = result.error?.message || '';
    throw new Error(`${scriptName} failed for ${filePath}: ${stderr || stdout || error || `exit ${result.status}`}`);
  }
}

function validateArtifacts(python, manifestPath, roots, filePaths = null) {
  const paths = filePaths || trackedArtifactPaths(manifestPath, roots);
  for (const filePath of paths) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    runHook(python, 'validate-json-schema.py', filePath, roots);
    runHook(python, 'check-artifact-leakage.py', filePath, roots);
    if (path.basename(filePath) === HANDOFF_PACKAGE_NAME) {
      runHook(python, 'validate-handoff-package.py', filePath, roots);
    }
  }
}

module.exports = {
  hookEnv,
  runHook,
  validateArtifacts,
  validateTaskManifestSchema,
};
