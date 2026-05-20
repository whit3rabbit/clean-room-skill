# Spec Schema Guide

## Artifact Names

Use these canonical artifact names unless the surrounding project already has a stricter convention:

- `task-manifest.json`
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
- user-selected output format profile
- Agent 0-3 pipeline responsibilities and handoff rules
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

## Source Index Content

`source-index.json` is a contaminated-only planning artifact generated before clean-room role sessions. Keep it under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.

Capture:

- generator name, version, scanner modes, limits, and source roots
- file metrics: bytes, lines, words, characters, and estimated tokens
- best-effort imports, exports, resolved local relationships, and unresolved references
- logical dependency groups, large word-count indicators, line-span file segments, and recommended Agent 1 batches
- optional AST/indexing dependency status recorded during preflight
- skipped files or directories and aggregate metrics

Do not send `source-index.json`, file paths, import/export listings, dependency graphs, or private symbols to clean roles. Agent 0 may map recommended batches or segment refs into neutral `task-manifest.json` units, where one unit is one bounded Agent 1 source-reading assignment.

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

`task-manifest.json` records the required Agent 0-3 handoff contract:

- Agent 0: `contaminated-manager-verifier`; controller, scope manager, coverage verifier, and receiver of Agent 3's final report.
- Agent 1: `contaminated-source-analyst`; source reader and neutral task/spec generator.
- Agent 2: `clean-architect`; clean-domain schema base and merge manager using only approved handoff artifacts.
- Agent 3: `clean-qa-editor`; final schema, leakage, coverage, and testability QC reporter.

Agent 2 and Agent 3 must not read source roots, contaminated ledgers, or contaminated chat history. Agent 3 reports final QC back to Agent 0 with abstract findings or delta tickets only.

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
- leakage review status

Do not include code blocks that implement the behavior. Use declarative requirements.

Use `evidence_refs` values such as `evidence-ledger:item-001`. They must point to contaminated-side evidence ledger entries and must not carry source text into the clean artifact.

Package, namespace, module, class, function, method, variable, constant, field, and internal event names are private identifiers by default. Include a name only when it is public compatibility surface, and then record it in `public_surface` with `name`, `kind`, `visibility`, and `compatibility_reason`. Do not place source-private names in `summary`, claim text, `test_scenarios`, `open_questions`, or `compatibility_notes`.

## Coverage and Evidence Ledgers

Keep `coverage-ledger.json` and `evidence-ledger.json` in the contaminated artifact workspace. Clean roles may receive abstract coverage summaries or delta tickets only.

Capture:

- source unit status
- behavior spec refs
- evidence refs
- coverage gaps
- abstract delta tickets
- contaminated evidence descriptions that do not include source text in clean handoffs

`handoff-package.json` describes contaminated-to-clean transfer only. It may list task manifests, behavior specs, coverage-ledger summaries, open questions, test plans, and abstract delta tickets. Do not list source indexes, clean-produced skeleton manifests, or QC reports in that handoff.

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
- terminology issues
- clean-side changes made
- abstract delta tickets for contaminated verification

QC may edit clean specs for clarity, but must not introduce facts from source.

## Bundled Validator Scope

`hooks/validate-json-schema.py` is a lightweight local guardrail for common schema constraints: JSON syntax, artifact kind detection, required fields, type checks, enums, const values, local `$ref`, string length, regex patterns, date-time strings, numeric bounds, array item counts, uniqueness, `allOf`, `if`/`then`, and `additionalProperties: false`.

It is not a full JSON Schema 2020-12 implementation. Use a full validator for release-quality assurance, especially before publishing schema changes or accepting third-party artifact packages.
