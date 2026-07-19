// clean-room-loop — run the clean-room unattended loop with in-session agents, no `claude -p`.
//
// WHY THIS EXISTS: clean-room-skill's own runner (`clean-room-skill run --agent-runtime claude`)
// spawns `claude --print` per role = pay-per-token API. This workflow instead drives the six
// clean-room roles with the workflow's OWN agent() subagents, which run inside the Claude Code
// session (subscription, no per-token bill). It is the `/clean-room:unattended` loop, as a workflow.
//
// BOUNDARY (read before trusting this): a workflow agent() cannot set OS env, install hooks, or
// run a separate OS process, so it CANNOT reproduce clean-room's enforced wall. Separation here is
// context-level: each role is a fresh agent(), and only distilled NEUTRAL artifacts cross the wall
// (rabbit-flows' notes-not-chatter model). The real enforcement we keep is the CLI gate:
// `clean-room-skill artifact validate --task-manifest <m> --role <r> --path <p>` runs the ACTUAL
// check-artifact-leakage.py + schema + handoff hooks (pure Python, no `claude -p`). Every wall
// crossing passes that gate; fail => quarantine + regenerate. Residual gap: no hook stops a clean
// agent from reading source off disk. Mitigation: neutral artifacts carry no source paths (nothing
// to open), explicit prompt prohibition, and the leakage gate catches any leaked content that lands
// in a written artifact. This is a COST-FREE POC path, weaker than the enforced runner. Use the
// runner when you need the real wall.
//
// DEVIATION FROM THE SPINE (noted per CLAUDE.md "Bending"): this is not decompose->fan-out->gate->
// synthesize. It is a fixed 10-stage clean-room pipeline (mostly sequential, one fan-out over
// behavior units) with TWO independent CLI admission gates at the wall crossings. The clean-room
// process dictates the shape; we keep the required verification gate.
//
// `node --check` flags the trailing top-level return as "illegal return" — expected; the runtime
// wraps the script in an async function.
export const meta = {
  name: 'clean-room-loop',
  description: 'Run the clean-room unattended loop with in-session subagents and never spawn claude -p: analyze source, sanitize, gate for leakage via the clean-room CLI, plan, implement, polish, and verify coverage.',
  phases: [
    { title: 'Bootstrap' },
    { title: 'Index' },
    { title: 'Decompose' },
    { title: 'Analyze' },
    { title: 'Sanitize' },
    { title: 'Gate' },
    { title: 'Handoff' },
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Polish' },
    { title: 'Verify' },
    { title: 'Finalize' },
  ],
}

// ---------------------------------------------------------------------------
// args (from the clean-room-loop front-door skill; tolerate a bare string as endGoal)
// ---------------------------------------------------------------------------
const A = typeof args === 'string' ? { endGoal: args } : (args ?? {})
const G = {
  endGoal: A.endGoal ?? 'Produce a behavior-compatible clean implementation from approved clean specs.',
  targetStack: A.targetStack ?? {},
  licensePolicy: A.licensePolicy ?? null,
  dependencyPolicy: A.dependencyPolicy ?? null,
  compatibilityPolicy: A.compatibilityPolicy ?? null,
  featurePolicy: A.featurePolicy ?? null,
  codeHygienePolicy: A.codeHygienePolicy ?? null,
  sourceRoots: Array.isArray(A.sourceRoots) ? A.sourceRoots : (A.sourceRoots ? [A.sourceRoots] : []),
  artifactBase: A.artifactBase ?? '~/Documents/CleanRoom',
  project: A.project ?? null,
  taskId: A.taskId ?? null,
  schemaProfile: A.schemaProfile ?? 'speckit-feature-folder',
  maxIterations: Number.isInteger(A.maxIterations) ? A.maxIterations : 3,
  specSliceRef: A.specSliceRef ?? null,
}
if (!G.sourceRoots.length) {
  return { error: 'clean-room-loop requires args.sourceRoots (absolute path[s] to the authorized source).', args: A }
}
const GOAL_JSON = JSON.stringify(G, null, 2)

// A clean agent that off-scripts into source would break the wall. This line goes into every
// contaminated- AND clean-side worker prompt.
const NEUTRALITY =
  'NEUTRALITY: clean-room artifacts must be neutral. Never copy source text, raw diffs, private ' +
  'package/module/function/variable names, distinctive strings, copied comments, or source-shaped ' +
  'pseudocode into any behavior-spec, handoff, plan, or report. Describe observable public behavior, ' +
  'contracts, invariants, states, and errors in plain language. Preserve a public compatibility name ' +
  'ONLY with a recorded concrete compatibility reason.'
const CLEAN_DENY =
  'WALL: you are a SOURCE-DENIED clean role. Do NOT read the source roots, contaminated artifacts, ' +
  'source indexes, or any path under the contaminated root. Read ONLY the clean artifacts and the ' +
  'clean implementation root named in your inputs. If an input contains source text, private ' +
  'identifiers, or raw diffs, STOP and report leakage instead of using it.'

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------
const ROOTS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'cli', 'taskRoot', 'contaminatedRoot', 'cleanRoot', 'implementationRoot', 'quarantineRoot', 'schemaDir', 'preflightGoalPath', 'preflightGoalSha256'],
  properties: {
    ok: { type: 'boolean' },
    cli: { type: 'string' },                 // "clean-room-skill" or "npx clean-room-skill@latest"
    taskRoot: { type: 'string' },
    contaminatedRoot: { type: 'string' },
    cleanRoot: { type: 'string' },
    implementationRoot: { type: 'string' },
    quarantineRoot: { type: 'string' },
    schemaDir: { type: 'string' },           // "" => bundled schemas (omit --schema-dir)
    preflightGoalPath: { type: 'string' },
    preflightGoalSha256: { type: 'string' },
    error: { type: 'string' },
  },
}
const MANIFEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'manifestPath', 'foundationUnitId', 'behaviorUnitIds', 'specSliceRef'],
  properties: {
    ok: { type: 'boolean' },
    manifestPath: { type: 'string' },
    sanitizerBriefPath: { type: 'string' },
    foundationUnitId: { type: 'string' },
    behaviorUnitIds: { type: 'array', items: { type: 'string' } },
    specSliceRef: { type: 'string' },
    error: { type: 'string' },
  },
}
const UNIT_SPEC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'unitId', 'draftSpecPath'],
  properties: {
    ok: { type: 'boolean' },
    unitId: { type: 'string' },
    draftSpecPath: { type: 'string' },
    notes: { type: 'string' },
    error: { type: 'string' },
  },
}
const SANITIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'approvedSpecPath', 'handoffPath'],
  properties: {
    ok: { type: 'boolean' },
    approvedSpecPath: { type: 'string' },
    handoffPath: { type: 'string' },
    error: { type: 'string' },
  },
}
const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pass', 'detail'],
  properties: {
    pass: { type: 'boolean' },
    detail: { type: 'string' },   // stdout/stderr of the validate calls, or leakage reasons
  },
}
const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
}
const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['result', 'summary'],
  properties: {
    result: { type: 'string' },   // e.g. spec-slice-complete, coverage-complete, contamination-suspected, unit-blocked
    resultPath: { type: 'string' },
    summary: { type: 'string' },
  },
}

// The default workflow agent already has Bash (see security-audit.js, which shells out to recon.py /
// git / venv with no agentType). Every stage here needs Bash to run the clean-room CLI, so we use the
// default agent and keep each role's contract inline in its prompt. A Bash agent MAY export CLEAN_ROOM_*
// inline for a CLI subprocess — that is its own process, not a role session, so it costs no tokens and
// does not weaken anything.
const envPrefix = (R, role) =>
  `CLEAN_ROOM_ROLE=${role} ` +
  `CLEAN_ROOM_SOURCE_ROOTS='${G.sourceRoots.join(':')}' ` +
  `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS='${R.contaminatedRoot}' ` +
  `CLEAN_ROOM_CLEAN_ROOTS='${R.cleanRoot}' ` +
  `CLEAN_ROOM_IMPLEMENTATION_ROOTS='${R.implementationRoot}' ` +
  `CLEAN_ROOM_ALLOWED_READ_ROOTS='${R.cleanRoot}' ` +
  (R.schemaDir ? `CLEAN_ROOM_SCHEMA_DIR='${R.schemaDir}' ` : '')
const schemaFlag = (R) => (R.schemaDir ? ` --schema-dir '${R.schemaDir}'` : '')

// ===========================================================================
// Phase 0 — Bootstrap: init + preflight-goal (unattended). Deterministic CLI, no claude -p.
// ===========================================================================
phase('Bootstrap')
const R = await agent(
  `You are a deterministic setup runner for a clean-room task. Run shell commands only. No claude -p.\n\n` +
  `STEP 1 — resolve the CLI. Run:\n` +
  `  command -v clean-room-skill >/dev/null 2>&1 && echo clean-room-skill || echo 'npx clean-room-skill@latest'\n` +
  `Use that exact string as CLI for every later call.\n\n` +
  `STEP 2 — bootstrap the run in the source repo. The primary source root is '${G.sourceRoots[0]}'. Run:\n` +
  `  $CLI init --target-dir '${G.sourceRoots[0]}' --artifact-base '${G.artifactBase}'` +
  `${G.project ? ` --project '${G.project}'` : ''}${G.taskId ? ` --task-id '${G.taskId}'` : ''} --target-profile '${G.schemaProfile}'\n` +
  `Then read '${G.sourceRoots[0]}/.clean-room/local-state.json' and extract: latest_task_root, implementation_root (project layout) ` +
  `or the per-task implementation/ (single-task). The task root contains contaminated/, clean/, quarantine/.\n\n` +
  `STEP 3 — write the preflight goal (UNATTENDED). Run:\n` +
  `  $CLI preflight --template --output '<taskRoot>/contaminated/preflight-goal.json'\n` +
  `Read that template, then OVERWRITE it with a COMPLETE unattended contract built from these user answers:\n` +
  `${GOAL_JSON}\n` +
  `Fill every canonical field of preflight-goal.schema.json: end_goal, target_stack, license_policy, dependency_policy, ` +
  `compatibility_policy, feature_policy, code_hygiene_policy, output_policy (artifact_base_root + implementation_root = the resolved roots), ` +
  `controller_policy {mode:"unattended", unattended_allowed_after_preflight:true, max_iterations:${G.maxIterations}}, ` +
  `intent_confirmation (end_goal_source/target_stack_source/controller_mode_source all "explicit-user-answer" + user summaries), ` +
  `and open_questions: []. Model the shape on the CLI template — do NOT invent non-canonical fields.\n` +
  `STEP 4 — validate + hash. Run:\n` +
  `  $CLI preflight --input '<taskRoot>/contaminated/preflight-goal.json' --output '<taskRoot>/contaminated/preflight-goal.json' --mode unattended\n` +
  `  shasum -a 256 '<taskRoot>/contaminated/preflight-goal.json'\n` +
  `preflight_goal_ref is the RELATIVE name 'preflight-goal.json'; preflightGoalSha256 is that hex digest.\n\n` +
  `Return the resolved absolute roots. schemaDir = "" (bundled). If any step fails, return ok:false with error and the failing command output.`,
  { label: 'bootstrap', phase: 'Bootstrap', model: 'sonnet', schema: ROOTS_SCHEMA },
)
if (!R?.ok) return { error: 'bootstrap failed', detail: R?.error ?? 'no output', phase: 'Bootstrap' }

// ===========================================================================
// Phase 1 — Source index (contaminated-only). Deterministic script, no claude -p.
// ===========================================================================
phase('Index')
const idx = await agent(
  `Deterministic step. Build the contaminated source index. Locate the bundled script (it ships with the ` +
  `clean-room-skill package): try, in order,\n` +
  `  find "$(npm root -g)/clean-room-skill" -name build_source_index.py 2>/dev/null | head -1\n` +
  `  find "$(${R.cli === 'clean-room-skill' ? 'dirname "$(command -v clean-room-skill)"' : 'echo .'}/.." -name build_source_index.py 2>/dev/null | head -1\n` +
  `Then run it with python3 over the source roots ${JSON.stringify(G.sourceRoots)}, writing ` +
  `'${R.contaminatedRoot}/source-index.json'. Use its --help to get exact flags. If the script cannot be found, ` +
  `write a minimal but schema-valid source-index.json by listing the source files (paths + sizes) — then run ` +
  `\`${R.cli} artifact validate --path '${R.contaminatedRoot}/source-index.json'${schemaFlag(R)}\` and fix until it passes.\n` +
  `Return ok + a one-line summary + the artifact path.`,
  { label: 'source-index', phase: 'Index', model: 'sonnet', schema: REPORT_SCHEMA },
)
if (!idx?.ok) return { error: 'source-index failed', detail: idx?.error, roots: R }

// ===========================================================================
// Phase 2 — Decompose (Agent 0, contaminated, opus: trajectory-setting).
// ===========================================================================
phase('Decompose')
const M = await agent(
  `You are Agent 0, the contaminated manager-verifier of a clean-room run. Contaminated domain: you MAY read ` +
  `the authorized source ${JSON.stringify(G.sourceRoots)} and '${R.contaminatedRoot}/source-index.json'. Write ONLY under ` +
  `'${R.contaminatedRoot}'.\n\n` +
  `TASK: decompose the authorized source scope into stable, NEUTRAL units that do not mirror private source layout, ` +
  `and produce a runner-ready task-manifest.json.\n` +
  `1. Get the schema shape: \`${R.cli} artifact template --kind task-manifest --output '${R.contaminatedRoot}/task-manifest.json' --force\`.\n` +
  `2. Fill it. REQUIREMENTS (the runner validates these):\n` +
  `   - preflight_goal_ref: "preflight-goal.json"; preflight_goal_sha256: "${R.preflightGoalSha256}".\n` +
  `   - EXACTLY ONE unit with unit_kind:"foundation" (target stack, package boundaries, public surfaces, test entrypoints, ` +
  `     dependency policy, destination constraints). Give it a neutral unit_id like "unit-foundation".\n` +
  `   - One or more unit_kind:"behavior" units for observable flows, neutral ids (e.g. "unit-<verb>").\n` +
  `   - handoff_sequence: the full stage list preflight -> source-destination-discovery -> agent-0-decomposition -> ` +
  `     agent-1-analysis -> agent-1-5-sanitization -> clean-handoff -> clean-planning -> clean-implementation-qc -> ` +
  `     clean-polish-review -> agent-0-coverage-verification.\n` +
  `   - agent_pipeline with agent_0..agent_4 AND agent_1_5 populated (roles: contaminated-manager-verifier, ` +
  `     contaminated-source-analyst, contaminated-handoff-sanitizer, clean-architect, clean-qa-editor, clean-polish-reviewer).\n` +
  `   - controller_policy.mode:"unattended", max_units_per_iteration:1, max_iterations:${G.maxIterations}.\n` +
  `   - loop_context: parent_loop_kind:"spec-development", child_loop_kind:"clean-room", return_to:"outer-spec-loop", ` +
  `     foundation_unit_ref = your foundation unit id, approved_scope_refs = [foundation unit + the behavior units you want ` +
  `     in this slice], spec_slice_ref${G.specSliceRef ? ` = "${G.specSliceRef}"` : ' = "behavior-spec:<foundation unit id>"'}, ` +
  `     max_inner_iterations:${G.maxIterations}.\n` +
  `   - initialization_snapshot.effective_roots + artifact_paths pointing at the resolved roots ` +
  `     (contaminated '${R.contaminatedRoot}', clean '${R.cleanRoot}', implementation '${R.implementationRoot}', quarantine '${R.quarantineRoot}').\n` +
  `   - The manifest MUST resolve to '${R.contaminatedRoot}/task-manifest.json'.\n` +
  `3. Also write a neutral sanitizer brief: \`${R.cli} artifact template --kind neutral-sanitizer-brief --output ` +
  `'${R.contaminatedRoot}/neutral-sanitizer-brief.json' --force\` (if that kind exists; else skip) and fill domain purpose, ` +
  `target profile, unit intent, public compatibility allowlist, blocked categories.\n` +
  `4. Validate: \`${R.cli} artifact validate --path '${R.contaminatedRoot}/task-manifest.json'${schemaFlag(R)}\`. Fix until it passes.\n\n` +
  NEUTRALITY + '\n\n' +
  `Return manifestPath, sanitizerBriefPath (or ""), foundationUnitId, behaviorUnitIds[], specSliceRef.`,
  { label: 'decompose', phase: 'Decompose', model: 'opus', schema: MANIFEST_SCHEMA },
)
if (!M?.ok || !M?.manifestPath || !M?.foundationUnitId) {
  return { error: 'decompose produced no runner-ready manifest', detail: M?.error, roots: R }
}

// ===========================================================================
// Phase 3 — Analyze (Agent 1, contaminated). Foundation first, then behavior units in parallel.
// ===========================================================================
phase('Analyze')
const analyzePrompt = (unitId, kind) =>
  `You are Agent 1, the contaminated source analyst. Contaminated domain: read the authorized source ` +
  `${JSON.stringify(G.sourceRoots)}, '${R.contaminatedRoot}/source-index.json', and '${M.manifestPath}'. Write ONLY under ` +
  `'${R.contaminatedRoot}'.\n\n` +
  `TASK: analyze unit "${unitId}" (kind: ${kind}) and write a DRAFT behavior spec of OBSERVED behavior — public ` +
  `contracts, invariants, state transitions, inputs/outputs, and errors — with evidence references that point at ` +
  `contaminated ledgers, NOT copied source.\n` +
  `1. \`${R.cli} artifact template --kind behavior-spec --output '${R.contaminatedRoot}/draft-behavior-spec-${unitId}.json' --force\`.\n` +
  `2. Fill it for this unit. Convert any observed source tests into clean equal-output test_scenarios (no copied test structure).\n` +
  `3. Validate: \`${R.cli} artifact validate --path '${R.contaminatedRoot}/draft-behavior-spec-${unitId}.json'${schemaFlag(R)}\`. Fix until it passes.\n\n` +
  NEUTRALITY + '\n' +
  `You draft only; you do NOT approve your own work for handoff. Return unitId + draftSpecPath.`

const foundationSpec = await agent(analyzePrompt(M.foundationUnitId, 'foundation'),
  { label: `analyze:${M.foundationUnitId}`, phase: 'Analyze', model: 'sonnet', schema: UNIT_SPEC_SCHEMA })
if (!foundationSpec?.ok || !foundationSpec?.draftSpecPath) {
  return { error: 'foundation analysis failed', detail: foundationSpec?.error, roots: R, manifest: M.manifestPath }
}
const behaviorSpecs = (await parallel(
  (M.behaviorUnitIds ?? []).map((uid) => () =>
    agent(analyzePrompt(uid, 'behavior'),
      { label: `analyze:${uid}`, phase: 'Analyze', model: 'sonnet', schema: UNIT_SPEC_SCHEMA })),
)).filter(Boolean).filter((s) => s.ok && s.draftSpecPath)
const draftSpecs = [foundationSpec, ...behaviorSpecs]

// ===========================================================================
// Phases 4+5 — Sanitize (Agent 1.5, source-denied) then the LEAKAGE GATE (independent CLI, real hooks).
// Bounded regenerate loop per spec. The gate is the wall crossing; it is NEVER self-validated.
// ===========================================================================
const MAX_SANITIZE_TRIES = 2
async function sanitizeAndGate(draft) {
  let feedback = ''
  for (let attempt = 1; attempt <= MAX_SANITIZE_TRIES; attempt += 1) {
    phase('Sanitize')
    const san = await agent(
      `You are Agent 1.5, the contaminated handoff sanitizer, in a FRESH source-DENIED context. You may read ONLY ` +
      `the draft spec '${draft.draftSpecPath}' and the sanitizer brief '${M.sanitizerBriefPath || '(none)'}'. Do NOT read the ` +
      `source roots, source index, or Agent 1's chat. Write ONLY under '${R.contaminatedRoot}'.\n\n` +
      `TASK: scrub the draft into an APPROVED behavior spec + a handoff package.\n` +
      `1. Copy the draft to '${R.contaminatedRoot}/approved-behavior-spec-${draft.unitId}.json' and REMOVE all identifying ` +
      `material: source paths, import/export listings, private identifiers, distinctive strings, copied comments, raw diffs, ` +
      `source excerpts, and source-shaped pseudocode. Keep a public compatibility name ONLY with a concrete recorded reason. ` +
      `Set leakage_review.reviewer_role = "contaminated-handoff-sanitizer".\n` +
      `2. Build the handoff: \`${R.cli} artifact template --kind handoff-package --output ` +
      `'${R.contaminatedRoot}/handoff-package-${draft.unitId}.json' --force\`, then fill it to reference the approved spec ` +
      `with correct sha256 checksums and no contaminated paths.\n` +
      (feedback ? `3. PRIOR GATE FAILURE — fix specifically: ${feedback}\n` : '') +
      NEUTRALITY + '\n' +
      `Return approvedSpecPath + handoffPath.`,
      { label: `sanitize:${draft.unitId}:${attempt}`, phase: 'Sanitize', model: 'sonnet', schema: SANITIZE_SCHEMA },
    )
    if (!san?.ok || !san?.approvedSpecPath || !san?.handoffPath) { feedback = san?.error ?? 'sanitizer produced no output'; continue }

    phase('Gate')
    const gate = await agent(
      `Independent leakage + schema + handoff GATE. Run ONLY these commands and report their combined result. No claude -p.\n` +
      `  ${envPrefix(R, 'contaminated-handoff-sanitizer')}${R.cli} artifact validate --task-manifest '${M.manifestPath}' ` +
      `--role contaminated-handoff-sanitizer --path '${san.approvedSpecPath}' --path '${san.handoffPath}'${schemaFlag(R)}\n` +
      `This runs the real check-artifact-leakage.py + schema + handoff hooks. pass=true ONLY if it exits 0 with no ` +
      `leakage/schema/handoff failure. On failure, put the exact failing reasons in detail so the sanitizer can fix them.`,
      { label: `gate:${draft.unitId}:${attempt}`, phase: 'Gate', model: 'haiku', schema: GATE_SCHEMA },
    )
    if (gate?.pass) return { unitId: draft.unitId, approvedSpecPath: san.approvedSpecPath, handoffPath: san.handoffPath }
    feedback = gate?.detail ?? 'gate failed without detail'
    // quarantine the rejected artifacts before regenerating
    await agent(
      `Move the leakage-rejected artifacts to quarantine so they never cross the wall. Run:\n` +
      `  mkdir -p '${R.quarantineRoot}' && mv -f '${san.approvedSpecPath}' '${san.handoffPath}' '${R.quarantineRoot}/' 2>/dev/null; echo done\n` +
      `Return ok:true, summary:"quarantined".`,
      { label: `quarantine:${draft.unitId}:${attempt}`, phase: 'Gate', model: 'haiku', schema: REPORT_SCHEMA },
    )
  }
  return null // exhausted retries => leakage could not be cleared for this unit
}

const approved = (await parallel(draftSpecs.map((d) => () => sanitizeAndGate(d)))).filter(Boolean)
if (!approved.length) {
  return { result: 'contamination-suspected', summary: 'no spec cleared the leakage gate within the retry budget', roots: R, manifest: M.manifestPath }
}
const foundationApproved = approved.some((a) => a.unitId === M.foundationUnitId)
if (!foundationApproved) {
  return { result: 'unit-blocked', summary: 'foundation unit did not clear the leakage gate; behavior slices cannot proceed', roots: R }
}

// ===========================================================================
// Phase 6 — Clean handoff: clean-run-context + move approved artifacts across the wall (deterministic).
// ===========================================================================
phase('Handoff')
const handoff = await agent(
  `Deterministic wall-crossing step. Approved (gate-passed) artifacts:\n${JSON.stringify(approved, null, 2)}\n\n` +
  `1. Build the clean run context (clean-safe goal subset ONLY — never the full preflight-goal or task-manifest): ` +
  `\`${R.cli} artifact template --kind clean-run-context --output '${R.cleanRoot}/clean-run-context.json' --force\`, then fill ` +
  `goal_contract (clean-safe fields), code_hygiene_policy, target profile, clean artifact paths, and the implementation root ref ` +
  `'${R.implementationRoot}'. Do NOT include source paths or private identifiers.\n` +
  `2. Copy each approved-behavior-spec and handoff-package from the contaminated root into '${R.cleanRoot}/' ` +
  `(they already passed the leakage gate).\n` +
  `3. Validate everything now in the clean root: for each JSON file run ` +
  `\`${R.cli} artifact validate --task-manifest '${M.manifestPath}' --role clean-architect --path '<file>'${schemaFlag(R)}\` ` +
  `prefixed with ${envPrefix(R, 'clean-architect')}. Fix until all pass.\n` +
  `Return ok + summary + the clean artifact paths.`,
  { label: 'handoff', phase: 'Handoff', model: 'sonnet', schema: REPORT_SCHEMA },
)
if (!handoff?.ok) return { error: 'clean handoff failed', detail: handoff?.error, roots: R }

// ===========================================================================
// Phase 7 — Plan (Agent 2 clean-architect, source-denied, opus). Writes plan, NO code.
// ===========================================================================
phase('Plan')
const plan = await agent(
  `You are Agent 2, the clean architect. ${CLEAN_DENY}\n\n` +
  `Inputs (clean only): '${R.cleanRoot}/clean-run-context.json', the approved behavior specs + handoff packages under ` +
  `'${R.cleanRoot}', and the clean destination foundation under '${R.implementationRoot}' (read-only). You may run ` +
  `\`${R.cli} artifact template|validate\` via Bash but you MUST NOT read source or write code.\n\n` +
  `TASK: produce the clean plan.\n` +
  `1. skeleton-manifest.json — the destination architecture map: architecture areas with owned_path_prefixes, ` +
  `responsibilities, forbidden responsibilities, allowed dependencies, refactor triggers. Template + fill under '${R.cleanRoot}'.\n` +
  `2. implementation-plan.json — map approved specs to relative destination target_paths + test_paths + work items + ` +
  `argv-array verification commands + risks + acceptance criteria + public_contract_refs + code_hygiene_policy (from clean-run-context). ` +
  `Every target/test path must belong to a skeleton area. Do NOT choose dependencies by copying source manifests. Mark work BLOCKED ` +
  `instead of guessing when specs are ambiguous.\n` +
  `3. Validate both: \`${envPrefix(R, 'clean-architect')}${R.cli} artifact validate --task-manifest '${M.manifestPath}' ` +
  `--role clean-architect --path '${R.cleanRoot}/skeleton-manifest.json' --path '${R.cleanRoot}/implementation-plan.json'${schemaFlag(R)}\`. Fix until it passes.\n\n` +
  NEUTRALITY + '\n' +
  `Return ok + summary + artifact paths.`,
  { label: 'plan', phase: 'Plan', model: 'opus', schema: REPORT_SCHEMA },
)
if (!plan?.ok) return { error: 'clean planning failed', detail: plan?.error, roots: R }

// ===========================================================================
// Phase 8 — Implement + QC (Agent 3 clean-qa-editor). Writes code+tests under the implementation root.
// ===========================================================================
phase('Implement')
const impl = await agent(
  `You are Agent 3, the clean implementer-verifier. ${CLEAN_DENY}\n\n` +
  `Inputs (clean only): '${R.cleanRoot}/clean-run-context.json' and '${R.cleanRoot}/implementation-plan.json'. Write CODE, TESTS, ` +
  `fixtures, and destination project files ONLY under the implementation root '${R.implementationRoot}'. Write the reports ` +
  `(implementation-report.json, qc-report.json) under '${R.cleanRoot}'. Never write clean-room JSON artifacts into the implementation root.\n\n` +
  `TASK:\n` +
  `1. Implement the unblocked work items from implementation-plan.json for the current slice, respecting code_hygiene_policy ` +
  `(file line caps, split strategy, forbidden patterns).\n` +
  `2. Run the plan's argv-array verification commands with cwd under '${R.implementationRoot}' (e.g. the test command). Record ` +
  `pass/fail. Record any code-hygiene violations as "code-hygiene" findings in qc-report.json.\n` +
  `3. Template + fill '${R.cleanRoot}/implementation-report.json' and '${R.cleanRoot}/qc-report.json', then validate both: ` +
  `\`${envPrefix(R, 'clean-qa-editor')}${R.cli} artifact validate --task-manifest '${M.manifestPath}' --role clean-qa-editor ` +
  `--path '${R.cleanRoot}/implementation-report.json' --path '${R.cleanRoot}/qc-report.json'${schemaFlag(R)}\`. Fix until it passes.\n\n` +
  NEUTRALITY + '\n' +
  `Emit ONE terminal report. Return ok + summary + artifact paths.`,
  { label: 'implement', phase: 'Implement', model: 'sonnet', schema: REPORT_SCHEMA },
)
if (!impl?.ok) return { error: 'clean implementation failed', detail: impl?.error, roots: R }

// ===========================================================================
// Phase 9 — Polish (Agent 4 clean-polish-reviewer). Review + hygiene + optional single local commit.
// ===========================================================================
phase('Polish')
const polish = await agent(
  `You are Agent 4, the clean polish reviewer. ${CLEAN_DENY}\n\n` +
  `Inputs (clean only): clean-run-context, implementation-plan, implementation-report, qc-report under '${R.cleanRoot}', and the ` +
  `clean code under '${R.implementationRoot}'.\n\n` +
  `TASK: review the final clean implementation for security, docs/comments, exception handling, resource leaks, race conditions, ` +
  `missing tests, and repository hygiene.\n` +
  `1. Create or update '${R.implementationRoot}/AGENTS.md' with gotchas + build/test/dev commands discovered from the clean code. ` +
  `Update '${R.implementationRoot}/.gitignore' only for real generated outputs/deps/caches/build artifacts.\n` +
  `2. Template + fill '${R.cleanRoot}/polish-report.json' (include git.include_paths listing the terminal Agent 3 changes + your ` +
  `polish changes, if you make a commit). Optionally: in '${R.implementationRoot}' run git init if needed and make ONE local commit ` +
  `containing only the include_paths. Do NOT push, tag, reset, clean, or delete branches.\n` +
  `3. Validate: \`${envPrefix(R, 'clean-polish-reviewer')}${R.cli} artifact validate --task-manifest '${M.manifestPath}' ` +
  `--role clean-polish-reviewer --path '${R.cleanRoot}/polish-report.json'${schemaFlag(R)}\`. Fix until it passes.\n\n` +
  `Return ok + summary + artifact paths.`,
  { label: 'polish', phase: 'Polish', model: 'sonnet', schema: REPORT_SCHEMA },
)
if (!polish?.ok) return { error: 'clean polish failed', detail: polish?.error, roots: R }

// ===========================================================================
// Phase 10 — Coverage verify (Agent 0, contaminated, opus) + completion GATE.
// ===========================================================================
phase('Verify')
const verify = await agent(
  `You are Agent 0 again, the contaminated manager-verifier, in the completion gate. Contaminated domain: you MAY read the ` +
  `source ${JSON.stringify(G.sourceRoots)}, the contaminated ledgers under '${R.contaminatedRoot}', and the TERMINAL clean reports ` +
  `under '${R.cleanRoot}' (implementation-report, qc-report, polish-report, approved specs, implementation-plan). Write ONLY under '${R.contaminatedRoot}'.\n\n` +
  `TASK: verify clean coverage against the authorized source scope, then write the terminal result.\n` +
  `1. Template + fill '${R.contaminatedRoot}/coverage-ledger.json': mark each approved-scope unit covered ONLY when a matching clean ` +
  `behavior spec, plan mappings, a terminal implementation report, a passed QC report, valid evidence refs, and required ` +
  `public-surface mappings all exist. Leave unresolved high-priority discovery_leads blocking.\n` +
  `2. Template + fill '${R.contaminatedRoot}/clean-room-result.json' with a result of: "coverage-complete" or "spec-slice-complete" ` +
  `if the gate is met; otherwise "unit-blocked" or "spec-delta-required". Completion is DENY-BY-DEFAULT: a completion claim must be ` +
  `backed by the durable canonical artifacts above, not a synthetic summary.\n` +
  `3. Validate: \`${R.cli} artifact validate --path '${R.contaminatedRoot}/coverage-ledger.json' --path ` +
  `'${R.contaminatedRoot}/clean-room-result.json'${schemaFlag(R)}\` (the schema hook rejects unbacked completion claims). Fix until it passes.\n\n` +
  `Return result (the result string), resultPath, and a plain-language summary.`,
  { label: 'verify', phase: 'Verify', model: 'opus', schema: RESULT_SCHEMA },
)

// ===========================================================================
// Phase 11 — Finalize / write-back (durable run log; script variables evaporate).
// ===========================================================================
phase('Finalize')
await agent(
  `Write a durable run-log entry (memory rule: workflow variables evaporate). Append a dated section to ` +
  `'${R.taskRoot}/clean-room-loop-run-log.md' (create if missing) summarizing this run: result="${verify?.result ?? 'unknown'}", ` +
  `roots, manifest '${M.manifestPath}', units approved ${JSON.stringify(approved.map((a) => a.unitId))}, and the terminal summary ` +
  `${JSON.stringify(verify?.summary ?? '')}. Note that this run used in-session subagents only and never spawned claude -p. ` +
  `Keep it under ~40 lines. Return ok + summary.`,
  { label: 'finalize', phase: 'Finalize', model: 'haiku', schema: REPORT_SCHEMA },
)

return {
  result: verify?.result ?? 'unknown',
  summary: verify?.summary ?? 'clean-room-loop completed',
  resultPath: verify?.resultPath ?? `${R.contaminatedRoot}/clean-room-result.json`,
  taskRoot: R.taskRoot,
  manifest: M.manifestPath,
  unitsApproved: approved.map((a) => a.unitId),
  cleanRoot: R.cleanRoot,
  implementationRoot: R.implementationRoot,
}
