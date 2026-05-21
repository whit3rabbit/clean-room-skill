# Spec Schema Guide

## Artifact Names

Use these canonical artifact names unless the surrounding project already has a stricter convention:

- `task-manifest.json`
- `init-config.json`
- `clean-run-context.json`
- `source-index.json`
- `coverage-ledger.json`
- `evidence-ledger.json`
- `handoff-package.json`
- `behavior-spec.json`
- `skeleton-manifest.json`
- `qc-report.json`
- `contamination-incident.json`

For multiple source units, place unit specs under a clean directory such as `behavior-specs/` and keep each file schema-compatible with `behavior-spec.schema.json`.

## Evidence Status

Use one of these values on claims:

- `observed`: Directly visible in authorized source, public behavior, generated analysis, or runtime output.
- `derived`: Calculated from observed facts, such as an interface shape inferred from manifest metadata.
- `inferred`: Reasonable but not directly proven.
- `unknown`: Material question not answered.
- `error`: Tooling or analysis failed in a way that affects confidence.

Do not upgrade `inferred` or `unknown` claims to `observed` during clean editing.

## Task Manifest Content

Capture:

- authorization and scope
- target identifier and source acquisition basis
- source workspace and clean workspace identifiers
- trust boundary and required profiles
- controller policy when the run is explicitly attended or unattended
- optional initialization snapshot copied from `init-config.json`
- user-selected output format profile
- Agent 0-3 pipeline responsibilities, Agent 1.5 sanitizer role, and handoff rules
- artifact paths and retention policy
- contaminated artifact roots for `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- optional `source_index_ref` for contaminated controller preflight output
- prohibited actions
- role assignments
- handoff policy
- tool and model policy
- source units with neutral ids
- optional per-unit `source_index_refs` such as `source-index:batch-0001` or `source-index:segment-file-000001-0001`
- expected artifacts
- audit log refs

Use neutral ids such as `unit-auth-flow` or `unit-config-loading`. Avoid source path mirroring unless the path is already a public API or package name.

## Initialization And Clean Context

`init-config.json` records reusable controller-side preferences. It may contain source roots and contaminated-only rules, so keep it outside clean-role readable roots.

### Path Naming Guards

Default artifact roots live under `~/Documents/CleanRoom/<task-id>/`. If the user does not provide an explicitly approved neutral task ID, generate one as `task-` plus 8 lowercase hex characters. Do not use the source folder name as the task ID.

Clean and contaminated artifact roots must not contain source root basenames or meaningful non-generic tokens from those basenames. The environment preflight enforces this for `CLEAN_ROOM_CLEAN_ROOTS` and `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.

Capture:

- artifact base root, defaulting to `~/Documents/CleanRoom/<task-id>/` with a neutral task ID
- source roots, contaminated artifact root, clean root, quarantine root, and approved public references
- target profile
- default model plus optional clean, contaminated, or per-role overrides
- clean isolation mode `clean-workspace`
- user rules split into `clean_safe` and `contaminated_only`
- reconfiguration policy requiring confirmation for root, schema, and model changes

`clean-run-context.json` is the only run context Agent 2 and Agent 3 should read. It may contain clean artifact paths, target profile, native artifact expectations, approved public references, clean-safe rules, and clean-side model preferences. It must not contain source roots, contaminated artifact roots, source index refs, coverage ledgers, evidence ledgers, contaminated-only rules, or the full `task-manifest.json`.

## Source Index Content

`source-index.json` is a contaminated-only planning artifact generated before clean-room role sessions. Keep it under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.

Capture:

- generator name, version, scanner modes, limits, and source roots
- file metrics: bytes, lines, words, characters, and estimated tokens
- best-effort imports, exports, resolved local relationships, and unresolved references
- logical dependency groups, large word-count indicators, line-span file segments, and recommended Agent 1 batches
- optional AST/indexing dependency status recorded during preflight
- skipped files or directories and aggregate metrics

Do not send `source-index.json`, file paths, import/export listings, dependency graphs, or private symbols to Agent 1.5 or clean roles. Agent 0 may map recommended batches or segment refs into neutral `task-manifest.json` units, where one unit is one bounded Agent 1 source-reading assignment.

## Controller Policy And Run State

`controller_policy` is optional. Missing policy means `attended`.

- `attended`: agent zero pauses for human review at scope gate, handoff, QC deltas, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop with `max_iterations`, one unit per iteration, fresh role context, schema and leakage validation before advancing state, and hard stop conditions.

`run_state` is optional for compatibility with older manifests. When present, it records `generation`, `started_at`, optional `previous_generation_ref`, and `restart_reason`. Valid restart reasons are `user-requested`, `contamination`, `scope-change`, and `invalid-state`.

Agent zero generates the durable tasklist as `task-manifest.json` `units`. It may use `source-index.json` batches to keep assigned source-reading context small while preserving source relationships. It tracks source-side progress in `coverage-ledger.json` `source_units`, source-side evidence in `evidence-ledger.json`, clean-side feedback in `qc-report.json`, and loop-back work as abstract delta tickets. Do not use prior chat history as the source of truth for the next iteration.

## Format Selection

`task-manifest.json` records the user's output choice in `format_selection`. Use one canonical source model plus one target profile:

- `openspec-delta`: OpenSpec delta artifacts with `ADDED`, `MODIFIED`, `REMOVED`, or `RENAMED Requirements`.
- `gsd-planning-package`: GSD `.planning/` project and phase artifacts.
- `speckit-feature-folder`: Spec Kit `.specify/` constitution plus `specs/<feature-id>/` artifacts.
- `kiro-spec-folder`: Kiro `.kiro/specs/<slug>/` requirements, design, and tasks.

Every real task must record the user's actual target profile. Do not default silently. Populate `native_artifacts` and `formatting_rules` with short path and formatting notes from `docs/research-skill-spec.md`.

## Agent Pipeline

`task-manifest.json` records the required Agent 0-3 handoff contract. New manifests should also include optional schema field `agent_1_5` for the source-denied sanitizer:

- Agent 0: `contaminated-manager-verifier`; controller, scope manager, coverage verifier, and receiver of Agent 3's final report.
- Agent 1: `contaminated-source-analyst`; source reader and neutral draft task/spec generator.
- Agent 1.5: `contaminated-handoff-sanitizer`; source-denied contaminated reviewer that sanitizes draft specs before clean handoff.
- Agent 2: `clean-architect`; clean-domain schema base and merge manager using only approved handoff artifacts.
- Agent 3: `clean-qa-editor`; final schema, leakage, coverage, and testability QC reporter.

Agent 1.5 may read only Agent 0's neutral sanitizer brief, assigned draft artifacts, schema assets, and explicit public or destination reference roots. Do not give it source roots, `source-index.json`, evidence ledger contents, private identifier denylist contents, raw diffs, source excerpts, or Agent 1 source-reading chat history.
Agent 2 and Agent 3 must start from the clean workspace and read `clean-run-context.json`, approved clean artifacts, schemas, and approved public references only. They must not read source roots, contaminated ledgers, contaminated chat history, or the full `task-manifest.json`. Agent 3 reports final QC back to Agent 0 with abstract findings or delta tickets only.

## Behavior Spec Content

Capture behavior rather than source structure:

- public surface and compatibility names
- producer role, source unit refs, evidence refs, confidence, and leakage risk
- inputs and outputs
- state transitions
- error conditions
- negative behaviors
- timing or ordering requirements
- security-relevant behavior
- invariants
- persistence, network, concurrency, or timing behavior when observable
- edge cases
- non-goals
- open questions
- test scenarios
- source-test-derived scenarios that validate equal output without copying source test names, fixtures, private helpers, or source-shaped structure
- API, protocol, config, and data/schema compatibility requirements
- leakage review status

Do not include code blocks that implement the behavior. Use declarative requirements.

Use `evidence_refs` values such as `evidence-ledger:item-001`. They must point to contaminated-side evidence ledger entries and must not carry source text into the clean artifact.

Package, namespace, module, class, function, method, variable, constant, field, and internal event names are private identifiers by default. Include a name only when it is public compatibility surface, and then record it in `public_surface` with `name`, `kind`, `visibility`, and `compatibility_reason`. Do not place source-private names in `summary`, claim text, `test_scenarios`, `open_questions`, or `compatibility_notes`.

Use existing fields for compatibility and parity. Put public API, protocol, config, and data/schema names in `public_surface` only when they are public compatibility surface. Put output equivalence in `outputs`, `observable_behaviors`, `invariants`, and `compatibility_notes` as applicable. Equal output includes public return values, serialized data, CLI or API responses, errors, state changes, ordering, and compatibility-relevant side effects.

For new handoff candidates, set `leakage_review.reviewer_role` to `contaminated-handoff-sanitizer`. Agent 1 may flag concerns in draft notes, but it does not pass its own artifacts for handoff.

## Coverage and Evidence Ledgers

Keep `coverage-ledger.json` and `evidence-ledger.json` in the contaminated artifact workspace. Clean roles may receive abstract coverage summaries or delta tickets only.

Capture:

- source unit status
- behavior spec refs
- evidence refs
- coverage gaps
- abstract delta tickets
- contaminated evidence descriptions that do not include source text in clean handoffs
- abstract source-test parity status and equal-output coverage gaps

`handoff-package.json` describes contaminated-to-clean transfer only. It may list `clean-run-context`, Agent 1.5-approved behavior specs, coverage-ledger summaries, open questions, test plans, and abstract delta tickets. Do not list full task manifests, source indexes, clean-produced skeleton manifests, or QC reports in that handoff.

## Skeleton Manifest Content

Map clean behavior specs to eventual implementation areas without imposing a source-derived design:

- destination area name
- area id naming policy
- related behavior spec ids
- public contract refs to preserve
- target constraints supplied by the user or destination repo
- dependency constraints
- forbidden implementation material
- test mapping
- tests to create
- open decision status and owner

Keep target language generic unless the user provides one.

Map API, protocol, config, and data/schema compatibility into `public_contracts` and area-level `public_contract_refs`. Map source-test-derived scenarios and equal-output requirements into `test_mapping` and `test_obligations`. Do not add schema fields for parity unless the artifact schema is intentionally versioned.

## QC Report Content

Capture:

- schema validation status
- leakage review status
- artifact hashes
- validator version
- leakage scan summary
- coverage status
- required rerun status
- contamination incidents
- missing behavior
- ambiguous behavior
- untestable claims
- missing source-test parity
- missing equal-output assertions
- mismatches between specs, public contracts, and test obligations
- terminology issues
- clean-side changes made
- abstract delta tickets for contaminated verification

QC may edit clean specs for clarity, but must not introduce facts from source.

## Bundled Validator Scope

`hooks/validate-json-schema.py` is a lightweight local guardrail for common schema constraints: JSON syntax, artifact kind detection, required fields, type checks, enums, const values, local `$ref`, string length, regex patterns, date-time strings, numeric bounds, array item counts, uniqueness, `allOf`, `if`/`then`, and `additionalProperties: false`.

It is not a full JSON Schema 2020-12 implementation. Use a full validator for release-quality assurance, especially before publishing schema changes or accepting third-party artifact packages.
