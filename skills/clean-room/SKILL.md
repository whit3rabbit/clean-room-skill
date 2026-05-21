---
name: clean-room
description: Use for authorized clean-room, reverse-engineering, source-to-spec, compatibility rewrite, or migration tasks. Produces spec-only behavioral artifacts, skeleton manifests, QC reports, open questions, and test plans without replacement implementation code.
compatibility: Designed for Claude Code, Codex, and Antigravity. Requires separate contaminated and clean workspaces or profiles for real clean-room use.
metadata:
  phase: spec-only
  legal_posture: risk-reduction-not-legal-advice
---

# Clean Room

## Overview

Produce clean behavioral specifications from authorized source analysis while keeping contaminated source access separate from clean specification organization and QA. Stop at specs, skeleton manifests, compatibility notes, and test plans unless a separate clean implementation phase is explicitly designed.

This skill is not legal advice and does not create a legal safe harbor. Treat it as an engineering risk-reduction workflow for preserving a documented separation between source analysis and clean artifacts.

## Required Gates

1. Confirm authorization, source scope, destination scope, allowed actions, prohibited actions, and evidence handling rules.
2. Separate contaminated and clean work into different workspaces, worktrees, or repositories. Prefer separate agent profiles or homes when platform support exists.
3. Keep contaminated chat history, raw source, raw diffs, source excerpts, comments, distinctive identifiers, and implementation-shaped pseudocode out of clean artifacts.
4. Produce structured artifacts only: init config, clean run context, source index, task manifest, evidence ledger references, coverage ledger summaries, behavioral spec, handoff package, skeleton manifest, QC report, open questions, incident records, and test plan.
5. Do not generate replacement implementation code in the spec-only phase.
6. Treat `allowed-tools` and skill frontmatter as convenience, not as a security boundary. Enforce separation with workspace paths, profiles, role agents, hooks, schema validation, and artifact quarantine.

## Role Model

Use these roles conceptually. If the host supports subagents, map each role to a separate agent or profile. If not, run the phases manually and keep artifacts separated.

- Agent 0 / contaminated manager/verifier: consumes the contaminated source index, decomposes the source scope into logical batches, tracks coverage, assigns source-reading work, and checks final spec coverage against source behavior, discovered source tests, equal-output requirements, and public contract compatibility. It may read source but must send only abstract delta tickets across the wall.
- Agent 1 / contaminated source analyst/spec writer: reads source in a read-only manner and writes neutral draft tasks and behavioral specs. It treats discovered source tests as behavioral evidence and converts them into clean `test_scenarios` for the same observable outputs. It must avoid code, copied comments, distinctive identifiers unless public API compatibility requires them, source test names or fixture structure, and source-shaped pseudocode. It does not approve its own drafts for handoff.
- Agent 1.5 / contaminated handoff sanitizer: works in a fresh source-denied contaminated context, reads only Agent 0's neutral brief plus assigned draft artifacts, scrubs identifying material, and approves or quarantines handoff candidates.
- Agent 2 / clean architect/skeleton organizer: starts from the clean workspace, reads `clean-run-context.json` and approved clean handoff artifacts, manages the selected clean schema base, organizes specs into a target-neutral skeleton manifest, maps API, protocol, config, and data/schema compatibility into existing public contract and test mapping fields, and records target-language constraints without choosing a default language.
- Agent 3 / clean QA/spec editor: starts from the clean workspace, reads `clean-run-context.json` and clean artifacts only, checks schema conformance, terminology consistency, leakage risk, gaps, testability, source-test parity, equal-output assertions, and spec-to-contract-to-test alignment, then reports abstract findings back to Agent 0.

## Workflow

Read `references/PROCESS.md` before running the workflow. Read `references/LEAKAGE-RULES.md` before writing or reviewing any artifact that crosses from contaminated to clean work. Read `references/SPEC-SCHEMA.md` when creating or validating artifact contents. Read `references/TARGET-LANGUAGE-GUIDE.md` when a destination language, framework, or public compatibility target is part of the request.

Agent zero/controller must set and pass the clean-room environment block into every role session before tool use. Do not assume a new agent session inherits prior values. Required values are `CLEAN_ROOM_ROLE`, `CLEAN_ROOM_SOURCE_ROOTS`, `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`, `CLEAN_ROOM_CLEAN_ROOTS`, `CLEAN_ROOM_SCHEMA_DIR`, and, for clean or source-denied roles, `CLEAN_ROOM_ALLOWED_READ_ROOTS`.

When source scope is larger than a single obvious unit, run `scripts/build_source_index.py` as a controller preflight before starting clean-room role sessions. The resulting `source-index.json` is contaminated-only input for Agent 0. It may contain source paths, import/export names, dependency relationships, large-file segment spans, and optional local AST/indexing tool status, so do not place it in clean handoff packages or expose it to Agent 1.5, Agent 2, or Agent 3.

Optional AST/indexing helpers are detected before the controller loop through `scripts/clean_room_tool_manager.py --status` or through the dependency report embedded by `build_source_index.py`. No dependency is installed implicitly. Local installs require an explicit exact version, for example `scripts/clean_room_tool_manager.py --install-local ast-grep --version <exact-version>`, and write under `~/.cache/re-skills/clean-room-tools/`. Target-project `.local/bin`, `.bin`, and `node_modules/.bin` are ignored unless `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1` is set.

Controller mode defaults to `attended` when `task-manifest.json` has no `controller_policy`. In `attended` mode, agent zero pauses for human review at scope gate, handoff, QC deltas, blocked units, and final coverage. In `unattended` mode, agent zero may run a bounded controller loop: reload durable artifacts for each iteration, select at most one pending or gap unit, start each role from fresh context with the required environment block, validate before advancing, and stop on any configured safety or ambiguity condition.

Do not grant shell-style tools to clean-room role sessions. Use `--hooks=strict` for dedicated Codex or Claude clean-room homes so hooks fail closed if required environment is missing or shell tools are invoked under a clean-room role. Safe hook installs are compatibility-only until `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present.

## Recovery Entry Points

Use the recovery skills when a run already has durable artifacts:

- `resume`: reload `task-manifest.json`, its `initialization_snapshot`, ledgers, `qc-report.json`, and abstract delta tickets, then continue from the earliest incomplete gate using the recorded `controller_policy`. If `init-config.json` differs from the snapshot, report drift and wait for explicit confirmation.
- `start-over`: after explicit confirmation, non-destructively archive or quarantine existing artifacts and restart from the scope gate with a fresh `task_id`.
- `refocus`: audit declared scope against current artifacts and steer the workflow back to missed gates without expanding scope.

## Startup Wizard

Use the startup wizard when the user invokes this skill directly, such as `/clean-room` or `/clean-room:clean-room`, and does not provide an existing `task-manifest.json` or specific artifact review task.

Gather only the setup facts needed to decide whether the workflow may start, or invoke `init` when the user wants a dedicated setup pass:

- Authorization statement, requester, allowed actions, prohibited actions, and evidence handling.
- Artifact base root. Default to `~/Documents/CleanRoom/<task-id>/`.
- Source roots, contaminated artifact root, clean root, quarantine root, and optional public or destination reference roots.
- Target language or destination constraints, if known.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Default model plus optional clean, contaminated, or per-role overrides.
- Additional user rules split into clean-safe and contaminated-only rules.
- Controller mode. If unspecified, use `attended`.
- Run state. New runs use `generation: 1`, current `started_at`, and `restart_reason: user-requested`.

Before indexing or artifact generation, confirm that source roots, contaminated artifact roots, clean roots, approved public reference roots, and schema directory are separate paths. Stop if authorization is unclear, if the requested output includes replacement implementation code, or if clean and contaminated roots overlap. Agent 2 and Agent 3 must start from the clean root and must not receive source mounts or the full task manifest.

For `attended` mode, record a `controller_policy` that pauses for human review at scope gate, clean handoff, QC deltas, blocked units, and final coverage. Include stop conditions for `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, and `coverage-complete`; attended mode does not add an iteration-limit stop unless the user explicitly sets one.

For `unattended` mode, require explicit authorization, separated roots, and finite bounds before work starts. Record `controller_policy.mode` as `unattended`, `max_units_per_iteration` as `1`, `max_iterations` as `10` unless the user supplied another finite value, and include these stop conditions: `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, `coverage-complete`, and `iteration-limit-reached`.

Default sequence:

1. Initialization gate: record reusable preferences in controller-side `init-config.json` when requested, then copy effective choices into `task-manifest.json` `initialization_snapshot`.
2. Scope gate: record authorization and boundaries in `task-manifest.json`.
3. Format and pipeline gate: record the user's selected canonical-plus-target profile, model policy, `run_state`, Agent 0-3 handoff contract, and Agent 1.5 sanitizer role in `task-manifest.json`.
4. Clean context gate: create sanitized `clean-run-context.json` for Agent 2 and Agent 3. Include only clean artifact paths, target profile, approved public refs, clean-safe rules, and clean-side model preferences.
5. Controller preflight source index: run the bundled source indexer outside clean-room role sessions and write contaminated `source-index.json`.
6. Source decomposition: Agent 0 uses `source-index.json` to create `task-manifest.json` `units` with stable, non-source task identifiers. Prefer dependency groups and `recommended_batches`; when `large_items` or `file_segments` are present, narrow the unit to the relevant segment or batch before Agent 1 reads source. Unit descriptions must remain neutral.
7. Contaminated spec writing: Agent 1 produces one or more draft `behavior-spec.json` artifacts from observed behavior, discovered source tests, public API contracts, error conditions, invariants, state transitions, and compatibility requirements. Source tests are behavioral evidence: convert them into clean `test_scenarios` that validate the same observable outputs without copying source test names, fixtures, private helpers, or source-shaped structure.
8. Source-denied sanitization: Agent 1.5 receives only a neutral brief and assigned draft paths, removes identifying information, records `leakage_review.reviewer_role` as `contaminated-handoff-sanitizer`, and quarantines failed artifacts.
9. Clean handoff: move only Agent 1.5-approved structured artifacts plus `clean-run-context.json` to the clean workspace. Do not hand off the full `task-manifest.json`.
10. Clean schema and skeleton organization: Agent 2 starts from the clean root, reads `clean-run-context.json`, merges approved handoff artifacts into the selected clean schema base, and produces `skeleton-manifest.json` from the clean specs, target constraints, public compatibility requirements, and test obligations. Map API, protocol, config, and data/schema compatibility through existing `public_contracts`, `target_constraints`, `test_mapping`, and `test_obligations` fields.
11. Clean QC: Agent 3 starts from the clean root and produces `qc-report.json`, including schema status, leakage status, missing behavior, ambiguous behavior, testability, missing source-test parity, missing equal-output assertions, spec-to-contract-to-test mismatches, and recommended abstract delta tickets.
12. Contaminated coverage verification: Agent 0 compares clean specs and QC results against source coverage in `coverage-ledger.json`, `evidence-ledger.json`, `qc-report.json`, discovered source tests, equal-output requirements, public contracts, and abstract delta tickets. Send only abstract delta tickets back to clean work.
13. Stop when coverage is complete enough for the requested spec package. Do not implement replacement code.

## Artifact Set

Use the JSON schemas in `assets/` as the contract for machine-readable artifacts:

- `task-manifest.schema.json`
- `init-config.schema.json`
- `clean-run-context.schema.json`
- `source-index.schema.json`
- `coverage-ledger.schema.json`
- `evidence-ledger.schema.json`
- `handoff-package.schema.json`
- `behavior-spec.schema.json`
- `skeleton-manifest.schema.json`
- `qc-report.schema.json`
- `contamination-incident.schema.json`

Use `hooks/` as optional guardrail and audit scaffolding. Configure the host with explicit role and path environment variables before relying on the scripts:

- `CLEAN_ROOM_ROLE`
- `CLEAN_ROOM_SOURCE_ROOTS`
- `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- `CLEAN_ROOM_CLEAN_ROOTS`
- `CLEAN_ROOM_ALLOWED_READ_ROOTS`
- `CLEAN_ROOM_SCHEMA_DIR`
- Optional `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` for hook-only scanning of private source identifiers.

For clean roles, read access is deny-by-default: allow only `CLEAN_ROOM_CLEAN_ROOTS`, `CLEAN_ROOM_SCHEMA_DIR`, and explicit public or destination constraint roots in `CLEAN_ROOM_ALLOWED_READ_ROOTS`. Agent 1.5 is source-denied: allow only assigned contaminated artifacts, `CLEAN_ROOM_SCHEMA_DIR`, and explicit public or destination constraint roots. Write access is also deny-by-default: clean roles write only under `CLEAN_ROOM_CLEAN_ROOTS`; contaminated roles write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Prefer one artifact directory for contaminated outputs and a separate artifact directory for clean outputs. Mark every behavioral claim as `observed`, `derived`, `inferred`, `unknown`, or `error`.

## Output Rules

Allowed clean-side content:

- Neutral behavior descriptions.
- Public interface names only when needed for compatibility.
- Inputs, outputs, state transitions, invariants, errors, timing expectations, and test scenarios.
- Source-test-derived scenarios that validate equal output for public return values, serialized data, CLI or API responses, errors, state changes, ordering, and compatibility-relevant side effects.
- Abstract implementation constraints such as "must preserve stable sort order" or "must reject malformed input before persistence."

Blocked clean-side content:

- Source files, source excerpts, copied comments, raw diffs, stack traces containing source lines, and decompiled output.
- Pseudocode that mirrors source structure, function ordering, private helper names, or distinctive control flow.
- Nonessential package, module, class, function, method, variable, constant, field, internal identifiers, magic strings, log messages, UI copy, formatting, and naming schemes.
- Patent, trade-secret, or licensing conclusions presented as verified legal findings.

Identifier rule: package names, namespace/module paths, class names, function or method names, variable names, constants, fields, and internal event names are contaminated unless they are public compatibility surface. If retained, list the name in `public_surface` or `public_contracts` with `name`, `kind`, `visibility`, and a concrete compatibility reason; otherwise rewrite to neutral behavior.

## Completion Criteria

Finish the spec-only phase when:

- `task-manifest.json` defines source scope, clean scope, selected target profile, Agent 0-3 pipeline, Agent 1.5 sanitizer role for new runs, handoff rules, optional `initialization_snapshot`, optional `source_index_ref`, and units.
- `clean-run-context.json` exists for Agent 2 and Agent 3 and does not contain source roots, contaminated roots, source index refs, ledger paths, or the full task manifest.
- Every in-scope unit has a behavior spec or an explicit out-of-scope record.
- Source tests discovered in scope are represented as clean, leakage-safe `test_scenarios` or explicit coverage gaps.
- `skeleton-manifest.json` maps clean specs to target-neutral implementation areas, public contracts, and tests.
- `qc-report.json` records schema status, leakage review, unresolved gaps, source-test parity status, equal-output assertion status, and abstract delta tickets.
- No replacement code has been generated.
