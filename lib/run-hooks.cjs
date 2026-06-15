'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_ROLE,
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

const MAX_ARTIFACT_VALIDATION_FAILURES = 3;

function hookEnv(roots, role = DEFAULT_ROLE) {
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

function validateSchemaFile(python, filePath, schemaDir) {
  const scriptName = 'validate-json-schema.py';
  const result = spawnSync(python, [hookPath(scriptName)], {
    cwd: packageRoot(),
    env: taskManifestSchemaEnv(schemaDir),
    input: validationPayload(filePath),
    encoding: 'utf8',
    timeout: RUN_HOOK_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(hookFailureMessage(scriptName, filePath, result));
  }
}

function validateTaskManifestSchema(python, manifestPath, schemaDir) {
  validateSchemaFile(python, manifestPath, schemaDir);
}

function runHook(python, scriptName, filePath, roots, role = DEFAULT_ROLE) {
  const error = runHookFailure(python, scriptName, filePath, roots, role);
  if (error) {
    throw new Error(error);
  }
}

function runHookFailure(python, scriptName, filePath, roots, role = DEFAULT_ROLE) {
  const result = spawnSync(python, [hookPath(scriptName)], {
    cwd: packageRoot(),
    env: hookEnv(roots, role),
    input: validationPayload(filePath),
    encoding: 'utf8',
    timeout: RUN_HOOK_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    return hookFailureMessage(scriptName, filePath, result);
  }
  return null;
}

function hookFailureMessage(scriptName, filePath, result) {
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  const error = result.error?.message || '';
  return `${scriptName} failed for ${filePath}: ${stderr || stdout || error || `exit ${result.status}`}`;
}

function validateArtifacts(python, manifestPath, roots, filePaths = null, role = DEFAULT_ROLE) {
  const paths = filePaths || trackedArtifactPaths(manifestPath, roots);
  const failures = [];
  for (const filePath of paths) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const schemaError = runHookFailure(python, 'validate-json-schema.py', filePath, roots, role);
    if (schemaError) {
      failures.push(schemaError);
      if (failures.length >= MAX_ARTIFACT_VALIDATION_FAILURES) break;
      continue;
    }
    const leakageError = runHookFailure(python, 'check-artifact-leakage.py', filePath, roots, role);
    if (leakageError) {
      failures.push(leakageError);
      if (failures.length >= MAX_ARTIFACT_VALIDATION_FAILURES) break;
      continue;
    }
    if (path.basename(filePath) === HANDOFF_PACKAGE_NAME) {
      const handoffError = runHookFailure(python, 'validate-handoff-package.py', filePath, roots, role);
      if (handoffError) {
        failures.push(handoffError);
        if (failures.length >= MAX_ARTIFACT_VALIDATION_FAILURES) break;
      }
    }
  }
  if (failures.length > 0) {
    throw new Error([
      'clean-room artifact validation failed:',
      ...failures.map((failure) => `- ${failure}`),
      'Recovery: update stale artifacts to current schemas or move stale/legacy JSON out of contaminated and clean artifact roots, for example into quarantine/, then retry --dry-run.',
    ].join('\n'));
  }
}

module.exports = {
  hookEnv,
  hookFailureMessage,
  runHook,
  taskManifestSchemaEnv,
  validateArtifacts,
  validateSchemaFile,
  validateTaskManifestSchema,
  validationPayload,
};
