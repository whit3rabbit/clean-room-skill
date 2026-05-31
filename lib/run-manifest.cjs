'use strict';

function unitRefValues(unitId) {
  return new Set([unitId, `unit:${unitId}`, `task-manifest:${unitId}`]);
}

function unitMatchesRef(unit, ref) {
  return typeof ref === 'string' && unitRefValues(unit.unit_id).has(ref);
}

function resolveManifestUnitRef(manifest, ref) {
  for (const unit of manifest.units || []) {
    if (unit && typeof unit.unit_id === 'string' && unitMatchesRef(unit, ref)) {
      return unit;
    }
  }
  return null;
}

function foundationUnits(manifest) {
  return (manifest.units || []).filter((unit) => unit?.unit_kind === 'foundation');
}

function requiredFoundationUnit(manifest) {
  const units = foundationUnits(manifest);
  if (units.length !== 1) {
    throw new Error('task manifest must include exactly one foundation unit');
  }
  return units[0];
}

function validateFoundationUnitContract(manifest) {
  const foundation = requiredFoundationUnit(manifest);
  const referenced = resolveManifestUnitRef(manifest, manifest.loop_context.foundation_unit_ref);
  if (!referenced) {
    throw new Error('loop_context.foundation_unit_ref does not match any task-manifest unit');
  }
  if (referenced.unit_id !== foundation.unit_id || referenced.unit_kind !== 'foundation') {
    throw new Error('loop_context.foundation_unit_ref must reference the foundation unit');
  }
}

function validateTaskManifestForRun(manifest) {
  if (typeof manifest.preflight_goal_ref !== 'string' || manifest.preflight_goal_ref === '') {
    throw new Error('clean-room run requires task-manifest preflight_goal_ref');
  }
  if (typeof manifest.preflight_goal_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(manifest.preflight_goal_sha256)) {
    throw new Error('clean-room run requires task-manifest preflight_goal_sha256');
  }
  if (!Array.isArray(manifest.handoff_sequence) || manifest.handoff_sequence.length === 0) {
    throw new Error('clean-room run requires task-manifest handoff_sequence');
  }
  if (!manifest.agent_pipeline?.agent_1_5) {
    throw new Error('clean-room run requires agent_pipeline.agent_1_5');
  }
  const policy = manifest.controller_policy || {};
  if (policy.mode !== 'unattended') {
    throw new Error('clean-room run requires controller_policy.mode to be "unattended"');
  }
  if (!Number.isInteger(policy.max_iterations) || policy.max_iterations < 1) {
    throw new Error('clean-room run requires controller_policy.max_iterations');
  }
  if (policy.max_units_per_iteration !== 1) {
    throw new Error('clean-room run requires controller_policy.max_units_per_iteration to be 1');
  }
  const loop = manifest.loop_context;
  if (!loop || typeof loop !== 'object') {
    throw new Error('clean-room run requires task-manifest loop_context');
  }
  if (loop.parent_loop_kind !== 'spec-development') {
    throw new Error('loop_context.parent_loop_kind must be "spec-development"');
  }
  if (loop.child_loop_kind !== 'clean-room') {
    throw new Error('loop_context.child_loop_kind must be "clean-room"');
  }
  if (loop.return_to !== 'outer-spec-loop') {
    throw new Error('loop_context.return_to must be "outer-spec-loop"');
  }
  if (!Array.isArray(loop.approved_scope_refs) || loop.approved_scope_refs.length === 0) {
    throw new Error('loop_context.approved_scope_refs must not be empty');
  }
  if (typeof loop.foundation_unit_ref !== 'string' || loop.foundation_unit_ref === '') {
    throw new Error('loop_context.foundation_unit_ref must be a non-empty string');
  }
  if (!Number.isInteger(loop.max_inner_iterations) || loop.max_inner_iterations < 1) {
    throw new Error('loop_context.max_inner_iterations must be a positive integer');
  }
  validateFoundationUnitContract(manifest);
}

function effectiveIterationCap(manifest, options) {
  const manifestCap = Math.min(
    manifest.controller_policy.max_iterations,
    manifest.loop_context.max_inner_iterations
  );
  if (options.maxIterations !== null) {
    if (options.maxIterations > manifestCap) {
      throw new Error('--max-iterations may only lower the manifest/loop cap');
    }
    return options.once ? 1 : options.maxIterations;
  }
  return options.once ? 1 : manifestCap;
}

module.exports = {
  effectiveIterationCap,
  requiredFoundationUnit,
  unitRefValues,
  validateFoundationUnitContract,
  validateTaskManifestForRun,
};
