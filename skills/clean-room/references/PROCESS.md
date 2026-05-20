# Clean-Room Process

## Purpose

Use this process to turn authorized source analysis into clean behavioral specifications without moving source expression into the clean workspace. Treat the wall as a process, filesystem, and profile boundary. Prompt instructions alone are not sufficient.

This process reduces engineering risk. It does not resolve patent, trade-secret, license, contract, or jurisdiction-specific legal questions.

## Workspace Separation

Use separate locations for each trust domain:

- Contaminated source workspace: source-readable, read-only where practical, no clean implementation output.
- Contaminated artifact workspace: source indexes, task manifests, draft behavior specs, coverage ledgers, and abstract delta tickets. Configure it with `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Clean spec workspace: behavior specs that passed leakage review, skeleton manifests, QC reports, and test plans.
- Clean allowed reference workspace: public documentation or destination constraints explicitly configured for clean-role reads.
- Optional implementation workspace: out of scope for this spec-only skill.

Prefer separate agent profiles or homes when the host supports them. Do not rely on one chat context with role labels as the only separation control.

Use host-level policy where available:

- Claude role agents live in `agents/`.
- Claude hook scaffolding lives in `hooks/`.
- Codex agent templates live in `examples/codex/.codex/agents/`.
- Codex plugin hooks may require enabling plugin hook support in the user or project config before they run.

For clean roles, configure read hooks as deny-by-default. `CLEAN_ROOM_CLEAN_ROOTS` is the clean artifact allowlist. `CLEAN_ROOM_ALLOWED_READ_ROOTS` is the only extra clean-role read allowlist for public documentation or destination constraints. `CLEAN_ROOM_SOURCE_ROOTS` remains denied even if a source path is also listed elsewhere.

For all roles, configure write hooks as deny-by-default. Clean roles may write only under `CLEAN_ROOM_CLEAN_ROOTS`. Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Source roots should remain read-only for contaminated roles.

Agent zero/controller is responsible for computing the role environment block and passing it into every new role session. Sessions must not rely on inherited values. The minimum block is:

- `CLEAN_ROOM_ROLE`
- `CLEAN_ROOM_SOURCE_ROOTS`
- `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- `CLEAN_ROOM_CLEAN_ROOTS`
- `CLEAN_ROOM_SCHEMA_DIR`
- `CLEAN_ROOM_ALLOWED_READ_ROOTS` for clean roles, even when empty

Optional guardrail value:

- `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`: path-separated, line-oriented files containing private source package, module, function, method, variable, constant, field, or other internal identifiers that must not appear in clean artifacts. Blank lines and `#` comments are ignored. Files are bounded to 1,000,000 bytes each, 20,000 total terms, and 512 characters per term. This is for hook scanning only; keep it outside clean-role readable roots and do not include its contents in clean artifacts.

Do not grant shell-style tools to clean-room role sessions. Shell access can bypass path-aware read and write hooks.

Run `scripts/build_source_index.py` only as controller preflight before clean-room role sessions. Treat `source-index.json` as contaminated-only: it may record source paths, private import/export identifiers, file metrics, large-file line spans, optional AST/indexing tool status, and dependency relationships. Agent 0 may consume it to create neutral `task-manifest.json` units, but it must not cross to clean roles or clean handoff packages.

Use `scripts/clean_room_tool_manager.py --status` when the controller needs to inspect optional AST/indexing helpers before indexing. It checks env overrides, `~/.cache/re-skills/clean-room-tools/`, skill-local tools, and trusted PATH. It does not install anything unless the user explicitly runs `--install-local` with an exact version. Target-project `.local/bin`, `.bin`, and `node_modules/.bin` stay untrusted unless `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1` is set.

Do not treat skill frontmatter or allowed tool lists as a complete enforcement boundary.

The task manifest also records the Agent 0-3 pipeline:

- Agent 0 is the contaminated manager/verifier.
- Agent 1 is the contaminated source analyst and neutral task/spec generator.
- Agent 2 is the clean architect and selected schema base merge manager.
- Agent 3 is the clean QA editor and final QC reporter back to Agent 0.

Agent 2 and Agent 3 are clean-domain roles. They must not read source workspaces, contaminated ledgers, or contaminated chat history.

## Controller Modes

`task-manifest.json` may include `controller_policy`. Missing policy means `attended`.

- `attended`: agent zero pauses for human review at scope gate, clean handoff, QC delta review, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop. It reloads `task-manifest.json`, `coverage-ledger.json`, `evidence-ledger.json`, and clean QC artifacts at the start of each iteration, selects at most one pending or gap unit, starts each role session from fresh context with the required environment block, validates schema and leakage results before state advances, and stops on any configured safety or ambiguity condition.

`task-manifest.json` may also include `run_state` to record the run generation, start timestamp, optional previous generation reference, and restart reason. New runs use generation `1`; start-over recovery increments generation or creates a fresh task id when prior state is not trusted.

The durable tasklist is `task-manifest.json` `units`, generated by agent zero during decomposition. For multi-file scopes, the task manifest may reference contaminated `source-index.json` batches through `source_index_ref` and per-unit `source_index_refs`. Progress is tracked in contaminated-side `coverage-ledger.json` and `evidence-ledger.json`; clean-side feedback returns through `qc-report.json` and abstract delta tickets only. Prior chat is not a source of truth for the next iteration.

## Recovery Entry Points

Use recovery entry points only when durable artifacts already exist:

- `resume`: reload the manifest, ledgers, QC report, handoff artifacts, and abstract delta tickets; validate schema and leakage state; continue from the earliest incomplete gate under the recorded controller policy.
- `start-over`: require explicit confirmation, archive or quarantine current artifacts without deletion, then return to the scope gate with a fresh `task_id`.
- `refocus`: compare current artifacts to declared scope, identify missed gates or open deltas, and steer Agent 0 back to the earliest required gate without expanding scope.

All recovery flows preserve the clean-room wall. Contaminated artifacts, source indexes, private identifiers, and contaminated chat history remain out of clean roles and clean handoff packages.

## Role Duties

Contaminated manager/verifier:

- Confirm authorization and source scope.
- Consume contaminated `source-index.json` when present.
- Split work into bounded logical units that can map to one source-index batch.
- Track coverage in `coverage-ledger.json`.
- Track contaminated evidence references in `evidence-ledger.json`.
- Compare clean artifacts against source behavior.
- Return only abstract delta tickets, such as "retry behavior after transient network failure is missing."

Contaminated source analyst/spec writer:

- Read only the source needed for the assigned unit.
- Describe observable behavior, public contracts, states, errors, invariants, and compatibility requirements.
- Mark every claim as `observed`, `derived`, `inferred`, `unknown`, or `error`.
- Treat package, module, class, function, method, variable, constant, and field names as private identifiers unless they are public compatibility surface.
- Remove source expression before handoff.

Clean architect/skeleton organizer:

- Read only approved clean artifacts.
- Manage the selected clean schema base and merge approved handoff artifacts into it.
- Map specs to target-neutral modules, packages, components, or service areas.
- Record target-language constraints supplied by the user or destination repo.
- Produce `skeleton-manifest.json`.

Clean QA/spec editor:

- Validate schema conformance.
- Check for leakage indicators.
- Normalize terminology.
- Identify ambiguity, missing edge cases, and untestable claims.
- Produce `qc-report.json`.

## Workflow

1. Scope gate:
   - Record requester, target identifier, authorization text, source scope, clean output scope, prohibited actions, and evidence handling.
   - Record the user's selected `format_selection.target_profile` and native artifact expectations from `docs/research-skill-spec.md`.
   - Record `controller_policy` when the task should run in explicit attended or bounded unattended mode.
   - Record `run_state` with generation, start timestamp, and restart reason.
   - Record the Agent 0-3 pipeline and handoff rules.
   - Record the source roots, contaminated artifact roots, clean roots, schema directory, and clean-role allowed read roots that agent zero/controller will pass to each session.
   - Stop if authorization or ownership is unclear.
2. Source index preflight:
   - Run `scripts/build_source_index.py` outside clean-room role sessions when source scope is larger than a single obvious unit.
   - Write `source-index.json` under the contaminated artifact workspace.
   - Keep dependency detection pre-loop and bounded; do not install Homebrew, npm, SDK, pip, or local-download tools implicitly.
   - Validate the source index schema before Agent 0 consumes it.
3. Decompose:
   - Create the tasklist as bounded source units with neutral ids in `task-manifest.json`.
   - Prefer behavior or public surface groupings over source-file mirroring.
   - Use source-index dependency groups, `recommended_batches`, `large_items`, and `file_segments` to keep Agent 1 context small while preserving import/export relationships.
4. Analyze:
   - Read source in the contaminated workspace.
   - Write behavior specs using the schema fields.
   - Include only compatibility-relevant public names.
   - Record retained public names in `public_surface` with `name`, `kind`, `visibility`, and compatibility reasons.
5. Scrub:
   - Apply `LEAKAGE-RULES.md`.
   - Remove copied expression and source-shaped structure.
   - Run the leakage hook with `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` when a private identifier list exists.
   - Record unresolved questions instead of guessing.
6. Handoff:
   - Move only clean-approved structured artifacts to the clean workspace.
   - Include coverage summaries or abstract delta tickets, not raw contaminated ledgers.
   - Do not include `source-index.json`, source paths, import/export listings, or dependency graphs.
   - Do not include clean-produced skeleton manifests or QC reports in contaminated-to-clean handoff packages.
   - Preserve producer role and review status.
   - Create `handoff-package.json`.
7. Organize:
   - Agent 2 builds or merges the clean schema base from approved handoff artifacts, the selected target profile, and target constraints.
   - Build a skeleton manifest from clean specs and target constraints.
   - Avoid implementation code, private algorithm choices, or source-derived layout.
8. QC:
   - Agent 3 validates schemas and reviews leakage risk.
   - Record artifact hashes, leakage scan summary, coverage status, and contamination incidents.
   - Produce abstract delta tickets for gaps and report them back to Agent 0.
9. Verify coverage:
   - Contaminated manager checks gaps against source.
   - Return only abstract deltas.
   - In unattended mode, reload durable artifacts and process at most one pending or gap unit per iteration.
   - Repeat analyze, scrub, handoff, organize, and QC until coverage is acceptable or a stop condition is reached.

## Stop Conditions

Stop the workflow when any of these occur:

- Authorization is missing or narrower than the requested analysis.
- Clean roles were exposed to source, contaminated chat history, raw diffs, or copied source expression.
- A requested output requires replacement implementation code.
- Schema validation or leakage scan fails.
- A unit is blocked, ownership is unclear, or the source scope changes.
- An unattended loop reaches its configured iteration limit.
- Patent, trade-secret, license, or contract analysis is needed from counsel.
- The source scope is too large to keep bounded source index or coverage records.

## Final Package

Produce a final audit package containing:

- `task-manifest.json`
- contaminated-side `source-index.json`
- contaminated-side `coverage-ledger.json`
- contaminated-side `evidence-ledger.json`
- `handoff-package.json`
- one or more `behavior-spec.json` files, or a directory of unit-specific behavior specs
- `skeleton-manifest.json`
- `qc-report.json`
- `contamination-incident.json` records when applicable
- test plan content embedded in behavior specs and skeleton manifest
- open questions and abstract delta tickets that remain unresolved

The clean workspace package must contain only clean-approved artifacts. Keep raw contaminated ledgers in the contaminated artifact workspace unless a separate audit handoff explicitly includes them outside the clean workspace.
