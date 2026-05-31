'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fileHash,
  readJsonFile,
} = require('./fs-utils.cjs');
const {
  CLEAN_RUN_CONTEXT_NAME,
  HANDOFF_PACKAGE_NAME,
} = require('./run-constants.cjs');
const { runHook } = require('./run-hooks.cjs');
const { pathIsUnder } = require('./run-roots.cjs');

function readOptionalJson(filePath) {
  return fs.existsSync(filePath) ? readJsonFile(filePath, null) : null;
}

function cleanRunContextPath(roots) {
  return path.join(roots.cleanRoot, CLEAN_RUN_CONTEXT_NAME);
}

function readCleanRunContext(roots) {
  const contextPath = cleanRunContextPath(roots);
  if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
    return null;
  }
  return readJsonFile(contextPath, null);
}

function resolveCleanArtifactPath(rawPath, roots, label) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error(`${label} must be a non-empty clean artifact path`);
  }
  const expanded = rawPath === '~' ? os.homedir() : rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(roots.cleanRoot, expanded);
  if (!pathIsUnder(resolved, roots.cleanRoot)) {
    throw new Error(`${label} must resolve under CLEAN_ROOM_CLEAN_ROOTS: ${rawPath}`);
  }
  return resolved;
}

function cleanContextBehaviorSpecPaths(context, roots) {
  const refs = context?.clean_artifacts?.behavior_specs;
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((ref, index) => resolveCleanArtifactPath(ref, roots, `clean-run-context behavior_specs[${index}]`));
}

function cleanContextArtifactPath(context, roots, key, label) {
  const ref = context?.clean_artifacts?.[key];
  if (typeof ref !== 'string' || ref.trim() === '') {
    return null;
  }
  return resolveCleanArtifactPath(ref, roots, label);
}

function cleanCompletionArtifactPath(roots, key, defaultName, label) {
  const context = readCleanRunContext(roots);
  const contextPath = context ? cleanContextArtifactPath(context, roots, key, label) : null;
  return contextPath || path.join(roots.cleanRoot, defaultName);
}

function readCleanCompletionArtifact(roots, key, defaultName, label) {
  const artifactPath = cleanCompletionArtifactPath(roots, key, defaultName, label);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    return { artifactPath, artifact: null };
  }
  return { artifactPath, artifact: readJsonFile(artifactPath, null) };
}

function validateReferencedBehaviorSpecs(python, roots, specPaths) {
  for (const specPath of specPaths) {
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      throw new Error(`clean-run-context behavior spec does not exist: ${specPath}`);
    }
    runHook(python, 'validate-json-schema.py', specPath, roots);
    runHook(python, 'check-artifact-leakage.py', specPath, roots);
  }
}

function normalizeCleanRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function prefixOwnsPath(prefix, relPath) {
  const owner = normalizeCleanRelativePath(prefix);
  const target = normalizeCleanRelativePath(relPath);
  return owner !== '' && (target === owner || target.startsWith(`${owner}/`));
}

function skeletonAreaMap(skeleton) {
  const areas = new Map();
  for (const area of skeleton?.areas || []) {
    if (area && typeof area.area_id === 'string') {
      areas.set(area.area_id, area);
    }
  }
  return areas;
}

function validateSkeletonArchitecture(skeleton) {
  const areas = skeletonAreaMap(skeleton);
  for (const area of skeleton?.areas || []) {
    for (const dependencyRef of area.allowed_area_dependencies || []) {
      if (dependencyRef === area.area_id) {
        throw new Error(`skeleton-manifest architecture area must not depend on itself: ${area.area_id}`);
      }
      if (!areas.has(dependencyRef)) {
        throw new Error(`skeleton-manifest architecture area references unknown dependency area: ${dependencyRef}`);
      }
    }
  }
}

function validateAreaRefs(areaRefs, areas, label) {
  if (!Array.isArray(areaRefs) || areaRefs.length === 0) {
    throw new Error(`${label} must reference at least one architecture area`);
  }
  for (const areaRef of areaRefs) {
    if (!areas.has(areaRef)) {
      throw new Error(`${label} references unknown architecture area: ${areaRef}`);
    }
  }
}

function validatePathsOwnedByAreas(paths, areaRefs, areas, label) {
  validateAreaRefs(areaRefs, areas, label);
  const candidateAreas = areaRefs.map((areaRef) => areas.get(areaRef));
  for (const relPath of paths || []) {
    const owned = candidateAreas.some((area) => {
      return (area.owned_path_prefixes || []).some((prefix) => prefixOwnsPath(prefix, relPath));
    });
    if (!owned) {
      throw new Error(`${label} path is outside referenced architecture areas: ${relPath}`);
    }
  }
}

function validateImplementationPlanArchitecture(plan, skeleton, roots, skeletonPath) {
  const areas = skeletonAreaMap(skeleton);
  const referencedSkeletonPath = resolveCleanArtifactPath(
    plan.architecture_manifest_ref,
    roots,
    'implementation-plan architecture_manifest_ref'
  );
  if (path.resolve(referencedSkeletonPath) !== path.resolve(skeletonPath)) {
    throw new Error('implementation-plan architecture_manifest_ref must match clean-run-context skeleton_manifest');
  }
  for (const workItem of plan.work_items || []) {
    const label = `implementation-plan work item ${workItem.work_item_id || '<unknown>'}`;
    validatePathsOwnedByAreas(
      [...(workItem.target_paths || []), ...(workItem.test_paths || [])],
      workItem.architecture_area_refs,
      areas,
      label
    );
  }
  for (const refactor of plan.planned_refactors || []) {
    const label = `implementation-plan planned refactor ${refactor.refactor_id || '<unknown>'}`;
    validatePathsOwnedByAreas(
      [...(refactor.existing_paths || []), ...(refactor.target_paths || []), ...(refactor.test_paths || [])],
      refactor.architecture_area_refs,
      areas,
      label
    );
  }
}

function handoffArtifactIndex(handoffPath, roots) {
  const handoff = readJsonFile(handoffPath, null);
  const index = new Map();
  for (const item of handoff?.artifacts || []) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') {
      continue;
    }
    const artifactPath = resolveCleanArtifactPath(item.path, roots, 'handoff artifact path');
    index.set(artifactPath, item);
  }
  return index;
}

function validateHandoffCoversBehaviorSpecs(context, roots, specPaths) {
  const handoffRef = context?.clean_artifacts?.handoff_package || HANDOFF_PACKAGE_NAME;
  const handoffPath = resolveCleanArtifactPath(handoffRef, roots, 'clean-run-context handoff_package');
  if (!fs.existsSync(handoffPath) || !fs.statSync(handoffPath).isFile()) {
    throw new Error(`clean-run-context handoff package does not exist: ${handoffPath}`);
  }
  const artifacts = handoffArtifactIndex(handoffPath, roots);
  for (const specPath of specPaths) {
    const item = artifacts.get(specPath);
    if (!item) {
      throw new Error(`handoff-package.json does not include clean-run-context behavior spec: ${specPath}`);
    }
    const expected = String(item.sha256 || '').toLowerCase();
    const actual = fileHash(specPath).toLowerCase();
    if (expected !== actual) {
      throw new Error(`handoff-package.json sha256 mismatch for behavior spec: ${specPath}`);
    }
  }
}

function validateCleanRunContextReferences(python, roots) {
  const context = readCleanRunContext(roots);
  if (!context) {
    return;
  }
  const specPaths = cleanContextBehaviorSpecPaths(context, roots);
  const skeletonPath = cleanContextArtifactPath(context, roots, 'skeleton_manifest', 'clean-run-context skeleton_manifest');
  const planPath = cleanContextArtifactPath(context, roots, 'implementation_plan', 'clean-run-context implementation_plan');
  let skeleton = null;
  validateReferencedBehaviorSpecs(python, roots, specPaths);
  if (specPaths.length > 0 || skeletonPath) {
    if (!skeletonPath || !fs.existsSync(skeletonPath) || !fs.statSync(skeletonPath).isFile()) {
      throw new Error(`clean-run-context skeleton manifest does not exist: ${skeletonPath || 'missing skeleton_manifest ref'}`);
    }
    runHook(python, 'validate-json-schema.py', skeletonPath, roots, 'clean-architect');
    runHook(python, 'check-artifact-leakage.py', skeletonPath, roots, 'clean-architect');
    skeleton = readJsonFile(skeletonPath, null);
    validateSkeletonArchitecture(skeleton);
  }
  validateHandoffCoversBehaviorSpecs(context, roots, specPaths);
  if (planPath && fs.existsSync(planPath) && fs.statSync(planPath).isFile() && skeletonPath) {
    const plan = readJsonFile(planPath, null);
    validateImplementationPlanArchitecture(plan, skeleton, roots, skeletonPath);
  }
}

function behaviorSpecOpenQuestionTickets(roots) {
  const context = readCleanRunContext(roots);
  if (!context) {
    return [];
  }
  const specPaths = cleanContextBehaviorSpecPaths(context, roots);
  const openSpecCount = specPaths.filter((specPath) => {
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      return false;
    }
    const spec = readJsonFile(specPath, null);
    return Array.isArray(spec.open_questions) && spec.open_questions.length > 0;
  }).length;
  if (openSpecCount === 0) {
    return [];
  }
  return [
    {
      ticket_id: 'delta-open-questions',
      kind: 'ambiguity',
      summary: `${openSpecCount} approved behavior spec(s) still contain open questions.`,
      requested_clean_change: 'Resolve or remove approved behavior spec open questions before marking the spec slice complete.',
      status: 'open',
    },
  ];
}

module.exports = {
  behaviorSpecOpenQuestionTickets,
  cleanCompletionArtifactPath,
  cleanContextArtifactPath,
  cleanContextBehaviorSpecPaths,
  readCleanCompletionArtifact,
  readCleanRunContext,
  readOptionalJson,
  resolveCleanArtifactPath,
  skeletonAreaMap,
  validateCleanRunContextReferences,
  validatePathsOwnedByAreas,
};
