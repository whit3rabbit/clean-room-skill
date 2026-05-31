'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { fileHash } = require('./fs-utils.cjs');
const {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  POLISH_PHASE,
  REQUIRED_COVERAGE_PHASE,
  ROLE_BY_PHASE,
  SOURCE_DENIED_BRIEF_BLOCKED_NAMES,
} = require('./run-constants.cjs');
const { runHook } = require('./run-hooks.cjs');
const {
  envFromAllowlist,
  pathIsUnder,
  pathIsUnderAny,
  resolveExistingPathWithinRoots,
  resolvePath,
} = require('./run-roots.cjs');

function sourceDeniedPhase(phase) {
  return phase === 'sanitize-handoff' ||
    phase === 'clean-plan' ||
    phase === 'clean-implement-qc' ||
    phase === POLISH_PHASE;
}

function cleanPhase(phase) {
  return phase === 'clean-plan' || phase === 'clean-implement-qc' || phase === POLISH_PHASE;
}

function strictContextManagement(contextManagement) {
  return contextManagement?.mode === 'role-session-briefs' && contextManagement.enforcement === 'strict';
}

function pathLikeArg(value) {
  return path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value.includes('/') ||
    value.includes('\\');
}

function validateStageBoundaries(stage, index, context) {
  if (!context?.roots || !context?.configDir) {
    return;
  }
  const { roots, configDir } = context;
  const cwd = resolvePath(stage.cwd, configDir);
  if (pathIsUnderAny(cwd, roots.sourceRoots)) {
    throw new Error(`agent command stage ${index} cwd must not be under source roots`);
  }

  let allowed = false;
  if (stage.phase === 'contaminated-analysis' || stage.phase === 'contaminated-coverage-verify') {
    allowed = pathIsUnder(cwd, roots.contaminatedRoot) || pathIsUnder(cwd, configDir);
  } else if (stage.phase === 'sanitize-handoff') {
    allowed = pathIsUnder(cwd, roots.contaminatedRoot);
  } else if (stage.phase === 'clean-plan') {
    allowed = pathIsUnder(cwd, roots.cleanRoot) || pathIsUnderAny(cwd, roots.allowedReadRoots);
  } else if (stage.phase === 'clean-implement-qc' || stage.phase === POLISH_PHASE) {
    allowed = pathIsUnder(cwd, roots.cleanRoot) || pathIsUnderAny(cwd, roots.implementationRoots);
  }
  if (!allowed) {
    throw new Error(`agent command stage ${index} cwd is outside allowed roots for ${stage.phase}`);
  }

  if (sourceDeniedPhase(stage.phase) && pathLikeArg(stage.argv[0])) {
    const commandPath = resolvePath(stage.argv[0], cwd);
    if (pathIsUnderAny(commandPath, roots.sourceRoots)) {
      throw new Error(`agent command stage ${index} argv[0] must not resolve under source roots`);
    }
  }
}

function briefRootsForPhase(phase, roots) {
  if (cleanPhase(phase)) {
    return [roots.cleanRoot];
  }
  return [roots.contaminatedRoot];
}

function artifactRootsForPhase(phase, roots) {
  if (cleanPhase(phase)) {
    return [roots.cleanRoot, ...roots.implementationRoots, ...roots.allowedReadRoots];
  }
  return [roots.contaminatedRoot];
}

function resolveStageBriefPath(stage, configDir, roots) {
  const rawPath = stage.context?.brief_path;
  if (typeof rawPath !== 'string' || rawPath === '') {
    return null;
  }
  const briefPath = resolvePath(rawPath, configDir);
  const allowedRoots = briefRootsForPhase(stage.phase, roots);
  if (!pathIsUnderAny(briefPath, allowedRoots)) {
    throw new Error(`agent command stage context.brief_path for ${stage.phase} must resolve under its artifact root`);
  }
  if (fs.existsSync(briefPath)) {
    resolveExistingPathWithinRoots(briefPath, allowedRoots, `agent command stage context.brief_path for ${stage.phase}`);
  }
  return briefPath;
}

function validateStageContext(stage, index, context = {}) {
  const strict = strictContextManagement(context.contextManagement);
  if (stage.context === undefined) {
    if (strict) {
      throw new Error(`agent command stage ${index} must provide context in strict context-management mode`);
    }
    return;
  }
  if (!stage.context || typeof stage.context !== 'object' || Array.isArray(stage.context)) {
    throw new Error(`agent command stage ${index} context must be an object`);
  }
  const allowedKeys = new Set(['fresh_session', 'brief_path']);
  for (const key of Object.keys(stage.context)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`agent command stage ${index} context.${key} is not supported`);
    }
  }
  if (stage.context.fresh_session !== undefined && typeof stage.context.fresh_session !== 'boolean') {
    throw new Error(`agent command stage ${index} context.fresh_session must be a boolean`);
  }
  if (stage.context.brief_path !== undefined && (typeof stage.context.brief_path !== 'string' || stage.context.brief_path === '')) {
    throw new Error(`agent command stage ${index} context.brief_path must be a non-empty string`);
  }
  if (strict && stage.context.fresh_session !== true) {
    throw new Error(`agent command stage ${index} context.fresh_session must be true in strict context-management mode`);
  }
  if (strict && !stage.context.brief_path) {
    throw new Error(`agent command stage ${index} context.brief_path is required in strict context-management mode`);
  }
  if (stage.context.brief_path && context.roots && context.configDir) {
    resolveStageBriefPath(stage, context.configDir, context.roots);
  }
}

function validateCommandConfig(config, context = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('agent command config must be a JSON object');
  }
  if (config.version !== 1) {
    throw new Error('agent command config version must be 1');
  }
  if (!Array.isArray(config.stages) || config.stages.length === 0) {
    throw new Error('agent command config must include stages');
  }
  let hasCoveragePhase = false;
  for (const [index, stage] of config.stages.entries()) {
    if (!stage || typeof stage !== 'object') {
      throw new Error(`agent command stage ${index} must be an object`);
    }
    if (!Object.hasOwn(ROLE_BY_PHASE, stage.phase)) {
      throw new Error(`agent command stage ${index} has unsupported phase`);
    }
    if (stage.role !== ROLE_BY_PHASE[stage.phase]) {
      throw new Error(`agent command stage ${index} role does not match phase ${stage.phase}`);
    }
    if (!Array.isArray(stage.argv) || stage.argv.length === 0 || stage.argv.some((item) => typeof item !== 'string' || item === '')) {
      throw new Error(`agent command stage ${index} must provide non-empty argv strings`);
    }
    if (typeof stage.cwd !== 'string' || stage.cwd === '') {
      throw new Error(`agent command stage ${index} must provide cwd`);
    }
    if (stage.timeout_ms !== undefined) {
      if (!Number.isInteger(stage.timeout_ms) || stage.timeout_ms < 1 || stage.timeout_ms > MAX_TIMEOUT_MS) {
        throw new Error(`agent command stage ${index} timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`);
      }
    }
    if (stage.env !== undefined) {
      if (!stage.env || typeof stage.env !== 'object' || Array.isArray(stage.env)) {
        throw new Error(`agent command stage ${index} env must be an object`);
      }
      for (const [key, value] of Object.entries(stage.env)) {
        if (key.startsWith('CLEAN_ROOM_')) {
          throw new Error(`agent command stage ${index} env must not override CLEAN_ROOM_* values`);
        }
        if (typeof value !== 'string') {
          throw new Error(`agent command stage ${index} env values must be strings`);
        }
      }
    }
    if (stage.phase === REQUIRED_COVERAGE_PHASE) {
      hasCoveragePhase = true;
    }
    validateStageContext(stage, index, context);
  }
  if (!hasCoveragePhase) {
    throw new Error(`agent command config must include ${REQUIRED_COVERAGE_PHASE}`);
  }
  const implementIndex = config.stages.findIndex((stage) => stage.phase === 'clean-implement-qc');
  const polishIndex = config.stages.findIndex((stage) => stage.phase === POLISH_PHASE);
  const coverageIndex = config.stages.findIndex((stage) => stage.phase === REQUIRED_COVERAGE_PHASE);
  if (polishIndex !== -1) {
    if (implementIndex === -1 || implementIndex > polishIndex) {
      throw new Error(`${POLISH_PHASE} must run after clean-implement-qc`);
    }
    if (coverageIndex < polishIndex) {
      throw new Error(`${POLISH_PHASE} must run before ${REQUIRED_COVERAGE_PHASE}`);
    }
  }
  for (const [index, stage] of config.stages.entries()) {
    validateStageBoundaries(stage, index, context);
  }
}

function resolveAllowedArtifactRefPath(rawPath, allowedRoots) {
  if (typeof rawPath !== 'string' || rawPath === '') {
    throw new Error('role-session brief artifact path must be a non-empty string');
  }
  const candidates = path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)
    ? [path.resolve(rawPath)]
    : allowedRoots.map((root) => path.resolve(root, rawPath));
  for (const candidate of candidates) {
    if (pathIsUnderAny(candidate, allowedRoots) && fs.existsSync(candidate)) {
      resolveExistingPathWithinRoots(candidate, allowedRoots, 'role-session brief artifact path');
      return candidate;
    }
  }
  const fallback = candidates[0];
  if (!pathIsUnderAny(fallback, allowedRoots)) {
    throw new Error(`role-session brief artifact path is outside allowed roots: ${rawPath}`);
  }
  return fallback;
}

function validateBriefArtifactRefs(stage, roots, brief, budgets) {
  const artifactRefs = Array.isArray(brief.allowed_artifacts) ? brief.allowed_artifacts : [];
  if (budgets && artifactRefs.length > budgets.max_artifact_refs) {
    throw new Error(`role-session brief allowed_artifacts exceeds max_artifact_refs ${budgets.max_artifact_refs}`);
  }

  let totalBytes = 0;
  const allowedRoots = artifactRootsForPhase(stage.phase, roots);
  for (const artifact of artifactRefs) {
    if (!artifact || typeof artifact !== 'object') continue;
    if (sourceDeniedPhase(stage.phase) && SOURCE_DENIED_BRIEF_BLOCKED_NAMES.has(path.basename(artifact.path))) {
      throw new Error(`role-session brief artifact is forbidden for source-denied phase ${stage.phase}: ${artifact.path}`);
    }
    const artifactPath = resolveAllowedArtifactRefPath(artifact.path, allowedRoots);
    if (!fs.existsSync(artifactPath)) {
      if (artifact.required === false) {
        continue;
      }
      throw new Error(`role-session brief artifact not found: ${artifact.path}`);
    }
    resolveExistingPathWithinRoots(artifactPath, allowedRoots, `role-session brief artifact path ${artifact.path}`);
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile()) {
      throw new Error(`role-session brief artifact is not a file: ${artifact.path}`);
    }
    if (Number.isInteger(artifact.max_bytes) && stat.size > artifact.max_bytes) {
      throw new Error(`role-session brief artifact exceeds max_bytes: ${artifact.path}`);
    }
    totalBytes += stat.size;
    if (budgets && totalBytes > budgets.max_referenced_artifact_bytes) {
      throw new Error(`role-session brief referenced artifacts exceed max_referenced_artifact_bytes ${budgets.max_referenced_artifact_bytes}`);
    }
    const expected = String(artifact.sha256 || '').toLowerCase();
    const actual = fileHash(artifactPath).toLowerCase();
    if (expected && expected !== actual) {
      throw new Error(`role-session brief artifact sha256 mismatch: ${artifact.path}`);
    }
  }
}

function validateSessionBriefContent(stage, manifest, unit, brief, strict) {
  if (brief.role !== stage.role) {
    throw new Error(`role-session brief role does not match stage role ${stage.role}`);
  }
  if (brief.phase !== stage.phase) {
    throw new Error(`role-session brief phase does not match stage phase ${stage.phase}`);
  }
  if (brief.unit_id !== unit.unit_id) {
    throw new Error(`role-session brief unit_id does not match selected unit ${unit.unit_id}`);
  }
  if (brief.spec_slice_ref !== manifest.loop_context.spec_slice_ref) {
    throw new Error(`role-session brief spec_slice_ref does not match ${manifest.loop_context.spec_slice_ref}`);
  }
  if (strict && brief.fresh_context_required !== true) {
    throw new Error('role-session brief must require fresh context in strict mode');
  }
}

function prepareStageSessionContext(python, stage, configDir, roots, manifest, unit, strict) {
  const briefPath = resolveStageBriefPath(stage, configDir, roots);
  if (!briefPath) {
    return null;
  }
  if (!fs.existsSync(briefPath)) {
    throw new Error(`role-session brief not found: ${briefPath}`);
  }
  resolveExistingPathWithinRoots(briefPath, briefRootsForPhase(stage.phase, roots), `role-session brief for ${stage.phase}`);
  const budgets = manifest.context_management?.budgets || null;
  const briefText = fs.readFileSync(briefPath, 'utf8');
  if (budgets && briefText.length > budgets.max_brief_chars) {
    throw new Error(`role-session brief exceeds max_brief_chars ${budgets.max_brief_chars}`);
  }
  runHook(python, 'validate-json-schema.py', briefPath, roots, stage.role);
  runHook(python, 'check-artifact-leakage.py', briefPath, roots, stage.role);
  const brief = JSON.parse(briefText);
  validateSessionBriefContent(stage, manifest, unit, brief, strict);
  validateBriefArtifactRefs(stage, roots, brief, budgets);
  return {
    briefPath,
    briefRef: stage.context.brief_path,
    briefHash: fileHash(briefPath),
    freshContextRequired: stage.context?.fresh_session === true || brief.fresh_context_required === true,
    roleSessionId: randomUUID(),
  };
}

function stagePrompt(stage, manifest, unit, iteration, sessionContext = null) {
  return [
    `CLEAN_ROOM_CONTROLLER_PHASE=${stage.phase}`,
    `CLEAN_ROOM_CONTROLLER_ITERATION=${iteration}`,
    `CLEAN_ROOM_SELECTED_UNIT_ID=${unit.unit_id}`,
    `CLEAN_ROOM_SPEC_SLICE_REF=${manifest.loop_context.spec_slice_ref}`,
    ...(sessionContext ? [`CLEAN_ROOM_SESSION_BRIEF_PATH=${sessionContext.briefPath}`] : []),
    '',
    'Run only this configured clean-room stage from durable artifacts.',
    'Do not use prior chat history as state.',
    ...(sessionContext ? ['Read CLEAN_ROOM_SESSION_BRIEF_PATH first and load only the artifact refs it permits.'] : []),
    '',
  ].join('\n');
}

function stageEnv(stage, roots, manifest, unit, iteration, sessionContext = null) {
  const env = {
    ...envFromAllowlist(),
    ...(stage.env || {}),
    CLEAN_ROOM_ROLE: stage.role,
    CLEAN_ROOM_SOURCE_ROOTS: roots.sourceRoots.join(path.delimiter),
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: roots.contaminatedRoot,
    CLEAN_ROOM_CLEAN_ROOTS: roots.cleanRoot,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: roots.implementationRoots.join(path.delimiter),
    CLEAN_ROOM_ALLOWED_READ_ROOTS: roots.allowedReadRoots.join(path.delimiter),
    CLEAN_ROOM_SCHEMA_DIR: roots.schemaDir,
    CLEAN_ROOM_SELECTED_UNIT_ID: unit.unit_id,
    CLEAN_ROOM_SPEC_SLICE_REF: manifest.loop_context.spec_slice_ref,
    CLEAN_ROOM_CONTROLLER_ITERATION: String(iteration),
    CLEAN_ROOM_CONTROLLER_PHASE: stage.phase,
  };
  if (sessionContext) {
    env.CLEAN_ROOM_SESSION_BRIEF_PATH = sessionContext.briefPath;
    env.CLEAN_ROOM_ROLE_SESSION_ID = sessionContext.roleSessionId;
    if (sessionContext.freshContextRequired) {
      env.CLEAN_ROOM_FRESH_CONTEXT_REQUIRED = '1';
    }
  }
  return env;
}

function runStage(stage, configDir, roots, manifest, unit, iteration, sessionContext = null) {
  const cwd = resolvePath(stage.cwd, configDir);
  const timeout = stage.timeout_ms || DEFAULT_TIMEOUT_MS;
  const input = stagePrompt(stage, manifest, unit, iteration, sessionContext);
  const budgets = manifest.context_management?.budgets || null;
  if (budgets && input.length > budgets.max_prompt_chars) {
    throw new Error(`stage prompt exceeds max_prompt_chars ${budgets.max_prompt_chars}`);
  }
  const result = spawnSync(stage.argv[0], stage.argv.slice(1), {
    cwd,
    env: stageEnv(stage, roots, manifest, unit, iteration, sessionContext),
    input,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    phase: stage.phase,
    role: stage.role,
    status: result.status === 0 ? 'passed' : 'failed',
    signal: result.signal || null,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr || result.error?.message || ''),
    ...(sessionContext ? {
      session_brief_ref: sessionContext.briefRef,
      session_brief_sha256: sessionContext.briefHash,
      role_session_id: sessionContext.roleSessionId,
    } : {}),
  };
}

function truncateOutput(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= 4096) {
    return text;
  }
  return `${text.slice(0, 4096)}\n[truncated]`;
}

module.exports = {
  prepareStageSessionContext,
  runStage,
  strictContextManagement,
  validateCommandConfig,
};
