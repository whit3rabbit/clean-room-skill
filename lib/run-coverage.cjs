'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonFile } = require('./fs-utils.cjs');
const { PUBLIC_SURFACE_COMPLETION_LEVELS } = require('./run-constants.cjs');
const {
  cleanContextBehaviorSpecPaths,
  readCleanCompletionArtifact,
  readCleanRunContext,
  readOptionalJson,
} = require('./run-clean-artifacts.cjs');
const {
  requiredFoundationUnit,
  unitRefValues,
} = require('./run-manifest.cjs');

function approvedUnitIds(manifest) {
  const approved = new Set(manifest.loop_context.approved_scope_refs);
  const ids = new Set();
  for (const unit of manifest.units || []) {
    for (const candidate of unitRefValues(unit.unit_id)) {
      if (approved.has(candidate)) {
        ids.add(unit.unit_id);
      }
    }
  }
  return ids;
}

function coverageMap(coverageLedger) {
  const map = new Map();
  for (const unit of coverageLedger?.source_units || []) {
    if (typeof unit.unit_id === 'string') {
      map.set(unit.unit_id, unit.coverage_state);
    }
  }
  return map;
}

function foundationCovered(manifest, coverageLedger) {
  return coverageMap(coverageLedger).get(requiredFoundationUnit(manifest).unit_id) === 'covered';
}

function approvedNonFoundationUnitIds(manifest) {
  const units = manifestUnitMap(manifest);
  const ids = [];
  for (const unitId of approvedUnitIds(manifest)) {
    if (units.get(unitId)?.unit_kind !== 'foundation') {
      ids.push(unitId);
    }
  }
  return ids;
}

function validateFoundationCoverageGate(manifest, coverageLedger) {
  const nonFoundationIds = approvedNonFoundationUnitIds(manifest);
  if (nonFoundationIds.length > 0 && !foundationCovered(manifest, coverageLedger)) {
    throw new Error(`foundation unit must be covered before approving non-foundation unit: ${nonFoundationIds[0]}`);
  }
}

function manifestUnitMap(manifest) {
  const map = new Map();
  for (const unit of manifest.units || []) {
    if (unit && typeof unit.unit_id === 'string') {
      map.set(unit.unit_id, unit);
    }
  }
  return map;
}

function evidenceIdFromRef(ref) {
  const prefix = 'evidence-ledger:';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    return null;
  }
  return ref.slice(prefix.length);
}

function evidenceEntryMap(roots) {
  const evidence = readOptionalJson(path.join(roots.contaminatedRoot, 'evidence-ledger.json'));
  const map = new Map();
  for (const entry of evidence?.entries || []) {
    if (entry && typeof entry.evidence_id === 'string') {
      map.set(entry.evidence_id, entry);
    }
  }
  return { evidence, map };
}

function evidenceLedgerMissingMessage(ref) {
  return [
    `coverage-ledger references evidence but canonical evidence-ledger.json is missing: ${ref}`,
    'write one contaminated-side evidence-ledger.json; do not use per-unit evidence-ledger filenames',
  ].join('; ');
}

function evidenceSourceUnitMismatchMessage(ref, unitId) {
  return [
    `coverage-ledger evidence ref points at a different source unit: ${ref}`,
    'evidence source_unit_ref was rejected; value not shown because it may contain a source path or private identifier',
    `coverage unit_id=${unitId}`,
    `source_unit_ref must be the task-manifest unit id or accepted unit alias (${[...unitRefValues(unitId)].join(', ')})`,
    'source paths belong in evidence_location_ref or source_index_refs/visual_index_refs, not source_unit_ref',
  ].join('; ');
}

function hasUnresolvedCoverageTicket(coverageLedger, unitId) {
  return (coverageLedger?.abstract_delta_tickets || []).some((ticket) => {
    return (!ticket.unit_id || ticket.unit_id === unitId) && ticket.status !== 'resolved';
  });
}

function unresolvedHighPriorityDiscoveryLead(sourceUnit) {
  return (sourceUnit?.discovery_leads || []).find((lead) => {
    return lead?.priority === 'high' && lead.status !== 'resolved';
  }) || null;
}

function publicSurfaceRef(spec, item) {
  return `public_surface:${spec.spec_id}:${item.kind}:${item.name}`;
}

function requiredPublicSurfaceObligations(spec) {
  if (!PUBLIC_SURFACE_COMPLETION_LEVELS.has(spec?.compatibility_level)) {
    return [];
  }
  return (spec.public_surface || [])
    .filter((item) => item && typeof item.name === 'string' && typeof item.kind === 'string')
    .map((item) => ({
      ref: publicSurfaceRef(spec, item),
      spec_id: spec.spec_id,
      unit_id: spec.unit_id,
      name: item.name,
      kind: item.kind,
    }));
}

function behaviorSpecTestCoverageRefs(spec) {
  const refs = new Set();
  for (const scenario of spec?.test_scenarios || []) {
    for (const ref of scenario?.coverage || []) {
      if (typeof ref === 'string') {
        refs.add(ref);
      }
    }
  }
  return refs;
}

function validateBehaviorSpecPublicSurfaceCoverage(specPath, spec, obligations) {
  const coveredRefs = behaviorSpecTestCoverageRefs(spec);
  for (const obligation of obligations) {
    if (!coveredRefs.has(obligation.ref)) {
      throw new Error(`public_surface obligation missing from behavior spec test coverage: ${obligation.ref} (${specPath})`);
    }
  }
}

function publicSurfaceCoverageMap(sourceUnit) {
  const map = new Map();
  for (const item of sourceUnit?.public_surface_coverage || []) {
    if (item && typeof item.ref === 'string') {
      map.set(item.ref, item);
    }
  }
  return map;
}

function planWorkItemCoverageMap(plan) {
  const map = new Map();
  for (const workItem of plan?.work_items || []) {
    const workItemId = workItem?.work_item_id;
    if (typeof workItemId !== 'string') {
      continue;
    }
    for (const ref of workItem.public_contract_refs || []) {
      if (typeof ref !== 'string') {
        continue;
      }
      if (!map.has(ref)) {
        map.set(ref, []);
      }
      map.get(ref).push(workItemId);
    }
  }
  return map;
}

function planWorkItemIdsForRef(workItemsByRef, ref) {
  return workItemsByRef.get(ref) || [];
}

function validatePlanAndReportPublicSurfaceCoverage(plan, report, obligations) {
  if (obligations.length === 0) {
    return;
  }
  if (!plan) {
    throw new Error('public_surface completion requires implementation-plan.json');
  }
  if (!report) {
    throw new Error('public_surface completion requires implementation-report.json');
  }
  const workItemsByRef = planWorkItemCoverageMap(plan);
  const completedWorkItems = new Set(report.completed_work_items || []);
  for (const obligation of obligations) {
    const workItemIds = planWorkItemIdsForRef(workItemsByRef, obligation.ref);
    if (workItemIds.length === 0) {
      throw new Error(`public_surface obligation missing from implementation plan: ${obligation.ref}`);
    }
    if (!workItemIds.some((workItemId) => completedWorkItems.has(workItemId))) {
      throw new Error(`public_surface obligation work item is not complete: ${obligation.ref}`);
    }
  }
}

function validateCoverageLedgerPublicSurfaceCoverage(sourceUnit, obligations) {
  if (obligations.length === 0) {
    return;
  }
  const coverageByRef = publicSurfaceCoverageMap(sourceUnit);
  for (const obligation of obligations) {
    const coverage = coverageByRef.get(obligation.ref);
    if (!coverage) {
      throw new Error(`coverage-ledger missing public_surface_coverage for: ${obligation.ref}`);
    }
    if (coverage.status !== 'covered') {
      throw new Error(`coverage-ledger public_surface_coverage is not covered: ${obligation.ref}`);
    }
    if (!Array.isArray(coverage.evidence_refs) || coverage.evidence_refs.length === 0) {
      throw new Error(`coverage-ledger public_surface_coverage has no evidence_refs: ${obligation.ref}`);
    }
  }
}

function matchingBehaviorSpecsForUnit(roots, unitId) {
  const context = readCleanRunContext(roots);
  if (!context) {
    return [];
  }
  const matches = [];
  for (const specPath of cleanContextBehaviorSpecPaths(context, roots)) {
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      continue;
    }
    const spec = readJsonFile(specPath, null);
    if (spec.unit_id === unitId || (spec.source_unit_refs || []).includes(unitId)) {
      matches.push({ specPath, spec });
    }
  }
  return matches;
}

function validateCoveredBehaviorSpecs(roots, sourceUnit) {
  const unitId = sourceUnit.unit_id;
  const specs = matchingBehaviorSpecsForUnit(roots, unitId);
  if (specs.length === 0) {
    throw new Error(`covered coverage-ledger unit has no clean behavior spec: ${unitId}`);
  }
  const { artifact: plan } = readCleanCompletionArtifact(roots, 'implementation_plan', 'implementation-plan.json', 'clean-run-context implementation_plan');
  const { artifact: report } = readCleanCompletionArtifact(roots, 'implementation_report', 'implementation-report.json', 'clean-run-context implementation_report');
  for (const { specPath, spec } of specs) {
    if (Array.isArray(spec.coverage_gaps) && spec.coverage_gaps.length > 0) {
      throw new Error(`covered behavior spec has unresolved coverage_gaps: ${specPath}`);
    }
    if (Array.isArray(spec.open_questions) && spec.open_questions.length > 0) {
      throw new Error(`covered behavior spec has unresolved open_questions: ${specPath}`);
    }
    const obligations = requiredPublicSurfaceObligations(spec);
    validateBehaviorSpecPublicSurfaceCoverage(specPath, spec, obligations);
    validatePlanAndReportPublicSurfaceCoverage(plan, report, obligations);
    validateCoverageLedgerPublicSurfaceCoverage(sourceUnit, obligations);
  }
}

// Lighter than validateCoverageLedgerIntegrity: checks whether a spec's public_surface
// obligations JOIN to the plan's public_contract_refs, with no coverage-ledger and no
// completion status required. Meant to run right after Plan, before any code is written,
// so a spec_id/unit_id ref mismatch fails in one cheap step instead of surviving all the
// way to the Verify gate after Implement and Polish already spent tokens on it.
function validateSpecPlanPublicSurfaceJoin(specPath, spec, plan) {
  const obligations = requiredPublicSurfaceObligations(spec);
  if (obligations.length === 0) {
    return { obligationCount: 0 };
  }
  if (!plan) {
    throw new Error('public_surface completion requires implementation-plan.json');
  }
  validateBehaviorSpecPublicSurfaceCoverage(specPath, spec, obligations);
  const workItemsByRef = planWorkItemCoverageMap(plan);
  for (const obligation of obligations) {
    const workItemIds = planWorkItemIdsForRef(workItemsByRef, obligation.ref);
    if (workItemIds.length === 0) {
      throw new Error(`public_surface obligation missing from implementation plan public_contract_refs: ${obligation.ref} (${specPath})`);
    }
  }
  return { obligationCount: obligations.length };
}

function validateCoverageLedgerIntegrity(manifest, roots, coverageLedger) {
  if (!coverageLedger) {
    return;
  }
  const units = manifestUnitMap(manifest);
  const evidenceRefs = [];
  const coveredSourceUnits = [];

  for (const sourceUnit of coverageLedger.source_units || []) {
    const unitId = sourceUnit?.unit_id;
    if (!units.has(unitId)) {
      throw new Error(`coverage-ledger references unknown task-manifest unit: ${unitId || '<missing>'}`);
    }

    for (const ref of sourceUnit.evidence_refs || []) {
      const evidenceId = evidenceIdFromRef(ref);
      if (evidenceId) {
        evidenceRefs.push({ ref, evidenceId, unitId });
      }
    }
    for (const coverage of sourceUnit?.public_surface_coverage || []) {
      for (const ref of coverage?.evidence_refs || []) {
        const evidenceId = evidenceIdFromRef(ref);
        if (evidenceId) {
          evidenceRefs.push({ ref, evidenceId, unitId });
        }
      }
    }

    if (sourceUnit.coverage_state === 'covered') {
      if (!Array.isArray(sourceUnit.evidence_refs) || sourceUnit.evidence_refs.length === 0) {
        throw new Error(`covered coverage-ledger unit has no evidence_refs: ${unitId}`);
      }
      if (Array.isArray(sourceUnit.coverage_gaps) && sourceUnit.coverage_gaps.length > 0) {
        throw new Error(`covered coverage-ledger unit has unresolved coverage_gaps: ${unitId}`);
      }
      if (hasUnresolvedCoverageTicket(coverageLedger, unitId)) {
        throw new Error(`covered coverage-ledger unit has unresolved coverage gaps: ${unitId}`);
      }
      const discoveryLead = unresolvedHighPriorityDiscoveryLead(sourceUnit);
      if (discoveryLead) {
        throw new Error(`covered coverage-ledger unit has unresolved high-priority discovery_leads: ${unitId} (${discoveryLead.lead_id || '<missing>'})`);
      }
      coveredSourceUnits.push(sourceUnit);
    }
  }

  if (evidenceRefs.length > 0) {
    const { evidence, map } = evidenceEntryMap(roots);
    if (!evidence) {
      throw new Error(evidenceLedgerMissingMessage(evidenceRefs[0].ref));
    }
    for (const { ref, evidenceId, unitId } of evidenceRefs) {
      const entry = map.get(evidenceId);
      if (!entry) {
        throw new Error(`coverage-ledger references missing evidence-ledger item in canonical evidence-ledger.json: ${ref}`);
      }
      if (entry.source_unit_ref && !unitRefValues(unitId).has(entry.source_unit_ref)) {
        throw new Error(evidenceSourceUnitMismatchMessage(ref, unitId));
      }
    }
  }

  for (const sourceUnit of coveredSourceUnits) {
    validateCoveredBehaviorSpecs(roots, sourceUnit);
  }
}

function selectUnit(manifest, coverageLedger) {
  const approved = approvedUnitIds(manifest);
  if (approved.size === 0) {
    throw new Error('loop_context.approved_scope_refs does not match any task-manifest unit');
  }
  const coverage = coverageMap(coverageLedger);
  for (const unit of manifest.units || []) {
    if (!approved.has(unit.unit_id)) continue;
    const coverageState = coverage.get(unit.unit_id);
    if (coverageState === 'covered' || coverageState === 'out-of-scope' || coverageState === 'blocked') {
      continue;
    }
    if (unit.status === 'pending' || coverageState === 'gap' || coverageState === 'not-started' || coverageState === 'in-progress') {
      return unit;
    }
  }
  return null;
}

module.exports = {
  approvedUnitIds,
  coverageMap,
  publicSurfaceRef,
  selectUnit,
  validateCoverageLedgerIntegrity,
  validateFoundationCoverageGate,
  validateSpecPlanPublicSurfaceJoin,
};
