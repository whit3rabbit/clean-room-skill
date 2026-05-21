# Clean-Room Process

## Purpose

Use this process to turn authorized source analysis into clean behavioral specifications without moving source expression into the clean workspace. Treat the wall as a process, filesystem, and profile boundary. Prompt instructions alone are not sufficient.

This process reduces engineering risk. It does not resolve patent, trade-secret, license, contract, or jurisdiction-specific legal questions.

## Workspace Separation

Use separate locations for each trust domain:

- Contaminated source workspace: source-readable, read-only where practical, no clean implementation output.
- Contaminated artifact workspace: init configs, source indexes, task manifests, draft behavior specs, coverage ledgers, and abstract delta tickets. Configure it with `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Clean spec workspace: sanitized clean run contexts, behavior specs that passed leakage review, skeleton manifests, QC reports, and test plans.
- Clean allowed reference workspace: public documentation or destination constraints explicitly configured for clean and source-denied role reads.
- Optional implementation workspace: out of scope for this spec-only skill.

Prefer separate agent profiles or homes when the host supports them. Do not rely on one chat context with role labels as the only separation control.

Use host-level policy where available:

- Claude role agents live in `agents/`.
- Claude hook scaffolding lives in `hooks/`.
- Codex agent templates live in `examples/codex/.codex/agents/`.
- Codex plugin hooks may require enabling plugin hook support in the user or project config before they run.

For clean roles, configure read hooks as deny-by-default. `CLEAN_ROOM_CLEAN_ROOTS` is the clean artifact allowlist, and `CLEAN_ROOM_SCHEMA_DIR` is readable for bundled schemas. For Agent 1.5, configure reads as source-denied: assigned contaminated artifacts, `CLEAN_ROOM_SCHEMA_DIR`, and `CLEAN_ROOM_ALLOWED_READ_ROOTS` are allowed; source roots, clean roots, and `source-index.json` are denied. `CLEAN_ROOM_ALLOWED_READ_ROOTS` is the extra clean/source-denied read allowlist for public documentation or destination constraints. `CLEAN_ROOM_SOURCE_ROOTS` remains denied for source-denied roles even if a source path is also listed elsewhere.

For all roles, configure write hooks as deny-by-default. Clean roles may write only under `CLEAN_ROOM_CLEAN_ROOTS`. Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Source roots should remain read-only for contaminated roles.

Agent zero/controller is responsible for computing the role environment block and passing it into every new role session. Sessions must not rely on inherited values. The minimum block is:

- `CLEAN_ROOM_ROLE`
- `CLEAN_ROOM_SOURCE_ROOTS`
- `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- `CLEAN_ROOM_CLEAN_ROOTS`
- `CLEAN_ROOM_SCHEMA_DIR`
- `CLEAN_ROOM_ALLOWED_READ_ROOTS` for clean and source-denied roles, even when empty

Optional guardrail value:

- `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`: path-separated, line-oriented files containing private source package, module, function, method, variable, constant, field, or other internal identifiers that must not appear in clean artifacts. Blank lines and `#` comments are ignored. Files are bounded to 1,000,000 bytes each, 20,000 total terms, and 512 characters per term. This is for hook scanning only; keep it outside clean/source-denied readable roots and do not include its contents in clean artifacts or sanitizer-readable briefs.

Do not grant shell-style tools to clean-room role sessions. Shell access can bypass path-aware read and write hooks.

Run `scripts/build_source_index.py` only as controller preflight before clean-room role sessions. Treat `source-index.json` as contaminated-only: it may record source paths, private import/export identifiers, file metrics, large-file line spans, optional AST/indexing tool status, and dependency relationships. Agent 0 may consume it to create neutral `task-manifest.json` units, but it must not cross to Agent 1.5, clean roles, or clean handoff packages.

Use `scripts/clean_room_tool_manager.py --status` when the controller needs to inspect optional AST/indexing helpers before indexing. It checks env overrides, `~/.cache/re-skills/clean-room-tools/`, skill-local tools, and trusted PATH. It does not install anything unless the user explicitly runs `--install-local` with an exact version. Target-project `.local/bin`, `.bin`, and `node_modules/.bin` stay untrusted unless `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1` is set.

Do not treat skill frontmatter or allowed tool lists as a complete enforcement boundary.

The task manifest records the Agent 0-3 pipeline plus Agent 1.5 for new runs:

- Agent 0 is the contaminated manager/verifier.
- Agent 1 is the contaminated source analyst and neutral task/spec generator.
- Agent 1.5 is the contaminated handoff sanitizer and independent source-denied scrubber.
- Agent 2 is the clean architect and selected schema base merge manager.
- Agent 3 is the clean QA editor and final QC reporter back to Agent 0.

Agent 1.5 runs in the contaminated domain but must not read source roots, `source-index.json`, contaminated evidence ledgers, or Agent 1 source-reading chat history.
Agent 2 and Agent 3 are clean-domain roles. They must start from the clean workspace and read `clean-run-context.json`, approved behavior specs, handoff packages, schemas, and approved public references only. They must not read source workspaces, contaminated ledgers, contaminated chat history, or the full `task-manifest.json`.

## Controller Modes

`task-manifest.json` may include `controller_policy`. Missing policy means `attended`.

- `attended`: agent zero pauses for human review at scope gate, clean handoff, QC delta review, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop. It reloads `task-manifest.json`, `coverage-ledger.json`, `evidence-ledger.json`, and clean QC artifacts at the start of each iteration, selects at most one pending or gap unit, starts each role session from fresh context with the required environment block, validates schema and leakage results before state advances, and stops on any configured safety or ambiguity condition.

`task-manifest.json` may also include `run_state` to record the run generation, start timestamp, optional previous generation reference, and restart reason. It may include `initialization_snapshot`, an immutable copy of the effective `init-config.json` choices for resumability. New runs use generation `1`; start-over recovery increments generation or creates a fresh task id when prior state is not trusted.

The durable tasklist is `task-manifest.json` `units`, generated by agent zero during decomposition. For multi-file scopes, the task manifest may reference contaminated `source-index.json` batches through `source_index_ref` and per-unit `source_index_refs`. Progress is tracked in contaminated-side `coverage-ledger.json` and `evidence-ledger.json`; clean-side feedback returns through `qc-report.json` and abstract delta tickets only. Prior chat is not a source of truth for the next iteration.

## Recovery Entry Points

Use recovery entry points only when durable artifacts already exist:

- `resume`: reload the manifest, initialization snapshot, ledgers, QC report, clean run context, handoff artifacts, and abstract delta tickets; validate schema and leakage state; continue from the earliest incomplete gate under the recorded controller policy. If reusable `init-config.json` differs from the manifest snapshot, report drift and stop before applying changes.
- `start-over`: require explicit confirmation, archive or quarantine current artifacts without deletion, then return to the scope gate with a fresh `task_id`.
- `refocus`: compare current artifacts to declared scope, identify missed gates or open deltas, and steer Agent 0 back to the earliest required gate without expanding scope.

All recovery flows preserve the clean-room wall. Source indexes, private identifiers, contaminated evidence ledgers, and contaminated chat history remain out of Agent 1.5, clean roles, and clean handoff packages.

## Role Duties

Contaminated manager/verifier:

- Confirm authorization and source scope.
- Create or update controller-side `init-config.json` when the user invokes initialization, then snapshot effective preferences into `task-manifest.json`.
- Produce sanitized `clean-run-context.json` for Agent 2 and Agent 3. Include clean artifact paths, target profile, approved public refs, clean-safe rules, and clean-side model preferences only.
- Consume contaminated `source-index.json` when present.
- Split work into bounded logical units that can map to one source-index batch.
- Track coverage in `coverage-ledger.json`.
- Track contaminated evidence references in `evidence-ledger.json`.
- Provide Agent 1.5 only a neutral sanitizer brief with domain purpose, target profile, unit intent, public compatibility allowlist, and blocked categories.
- Compare clean artifacts against source behavior, discovered source tests, equal-output requirements, and public API/schema compatibility.
- Return only abstract delta tickets, such as "retry behavior after transient network failure is missing."

Contaminated source analyst/spec writer:

- Read only the source needed for the assigned unit.
- Describe observable behavior, public contracts, states, errors, invariants, and compatibility requirements.
- Treat discovered source tests as behavioral evidence and convert them into clean `test_scenarios` that validate the same observable outputs.
- Define equal output in behavioral terms: public return values, serialized data, CLI or API responses, errors, state changes, ordering, and compatibility-relevant side effects.
- Mark every claim as `observed`, `derived`, `inferred`, `unknown`, or `error`.
- Treat package, module, class, function, method, variable, constant, and field names as private identifiers unless they are public compatibility surface.
- Write drafts and flag suspected leakage, but do not approve your own work for handoff.

Contaminated handoff sanitizer:

- Start from a fresh source-denied context with no Agent 1 source-reading chat history.
- Read only Agent 0's neutral brief, assigned draft artifacts, schema assets, and explicit public or destination reference roots.
- Remove source expression, source paths, import/export listings, dependency graphs, source test names, fixture structure, private helpers, copied comments, raw diffs, distinctive strings, and source-shaped structure before handoff.
- Preserve public names only when listed in `public_surface` with compatibility reasons.
- Record `leakage_review.reviewer_role` as `contaminated-handoff-sanitizer`.
- Quarantine failed artifacts and return only abstract regeneration feedback to Agent 0.

Clean architect/skeleton organizer:

- Start from the clean workspace and read only `clean-run-context.json`, approved clean artifacts, schemas, and approved public references.
- Manage the selected clean schema base from `clean-run-context.json` and merge approved handoff artifacts into it.
- Map specs to target-neutral modules, packages, components, or service areas.
- Record target-language constraints supplied by the user or destination repo.
- Map API, protocol, config, and data/schema compatibility into existing public contract, target constraint, test mapping, and test obligation fields.
- Produce `skeleton-manifest.json`.

Clean QA/spec editor:

- Start from the clean workspace and validate `clean-run-context.json` before using run preferences.
- Validate schema conformance.
- Check for leakage indicators.
- Normalize terminology.
- Identify ambiguity, missing edge cases, untestable claims, missing source-test parity, missing equal-output assertions, and mismatches between specs, public contracts, and test obligations.
- Produce `qc-report.json`.

## Workflow

1. Initialization gate:
   - Record reusable preferences in `init-config.json` when requested.
   - Default the artifact base root to `~/Documents/CleanRoom/<task-id>/` unless the user selects another separated location.
   - Record model preferences as a default model plus optional domain or role overrides.
   - Split user rules into clean-safe and contaminated-only rules.
   - Set clean isolation mode to `clean-workspace`; Docker or container execution is out of scope for v1.
2. Scope gate:
   - Record requester, target identifier, authorization text, source scope, clean output scope, prohibited actions, and evidence handling.
   - Record the user's selected `format_selection.target_profile` and native artifact expectations from `docs/research-skill-spec.md`.
   - Record `controller_policy` when the task should run in explicit attended or bounded unattended mode.
   - Record `run_state` with generation, start timestamp, and restart reason.
   - Record `initialization_snapshot` when init preferences exist.
   - Record the Agent 0-3 pipeline, Agent 1.5 sanitizer role, and handoff rules.
   - Record the source roots, contaminated artifact roots, clean roots, schema directory, and clean/source-denied allowed read roots that agent zero/controller will pass to each session.
   - Stop if authorization or ownership is unclear.
3. Clean context:
   - Create `clean-run-context.json` for Agent 2 and Agent 3.
   - Include only clean artifact paths, target profile, native artifact expectations, approved public references, clean-safe rules, and clean-side model preferences.
   - Do not include source roots, contaminated roots, source index refs, coverage ledgers, evidence ledgers, contaminated-only rules, or the full task manifest.
4. Source index preflight:
   - Run `scripts/build_source_index.py` outside clean-room role sessions when source scope is larger than a single obvious unit.
   - Write `source-index.json` under the contaminated artifact workspace.
   - Keep dependency detection pre-loop and bounded; do not install Homebrew, npm, SDK, pip, or local-download tools implicitly.
   - Validate the source index schema before Agent 0 consumes it.
5. Decompose:
   - Create the tasklist as bounded source units with neutral ids in `task-manifest.json`.
   - Prefer behavior or public surface groupings over source-file mirroring.
   - Use source-index dependency groups, `recommended_batches`, `large_items`, and `file_segments` to keep Agent 1 context small while preserving import/export relationships.
6. Analyze:
   - Read source in the contaminated workspace.
   - Write draft behavior specs using the schema fields.
   - If source tests are discovered, record their behavioral intent as evidence and create leakage-safe `test_scenarios` for the same observable outputs.
   - Record equal-output expectations for public return values, serialized data, CLI or API responses, errors, state changes, ordering, and compatibility-relevant side effects.
   - Include only compatibility-relevant public names.
   - Record retained public names in `public_surface` with `name`, `kind`, `visibility`, and compatibility reasons.
7. Sanitize:
   - Apply `LEAKAGE-RULES.md`.
   - Start Agent 1.5 from fresh context without source access or Agent 1 source-reading chat history.
   - Use only the neutral sanitizer brief and assigned draft artifact paths.
   - Remove copied expression and source-shaped structure.
   - Run the leakage hook with `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` when a private identifier list exists.
   - Record unresolved questions instead of guessing.
8. Handoff:
   - Move only Agent 1.5-approved structured artifacts and `clean-run-context.json` to the clean workspace.
   - Include only allowed handoff artifact types: `clean-run-context`, `behavior-spec`, `coverage-ledger-summary`, `open-questions`, `test-plan`, and `abstract-delta-ticket`.
   - Use `coverage-ledger-summary` for neutral coverage status only; do not include raw contaminated ledgers.
   - Do not include `task-manifest.json`, `source-index.json`, source paths, import/export listings, or dependency graphs.
   - Do not include clean-produced skeleton manifests or QC reports in contaminated-to-clean handoff packages.
   - Preserve producer role and Agent 1.5 review status.
   - Create `handoff-package.json`.
9. Organize:
   - Agent 2 starts from the clean workspace and builds or merges the clean schema base from `clean-run-context.json`, approved handoff artifacts, the selected target profile, and target constraints.
   - Build a skeleton manifest from clean specs and target constraints.
   - Carry API, protocol, config, and data/schema compatibility through `public_contracts`, `target_constraints`, `test_mapping`, and `test_obligations`.
   - Avoid implementation code, private algorithm choices, or source-derived layout.
10. QC:
   - Agent 3 starts from the clean workspace, validates schemas, and reviews leakage risk.
   - Record artifact hashes, leakage scan summary, coverage status, and contamination incidents.
   - Flag missing source-test parity, missing equal-output assertions, and mismatches between specs, public contracts, and test obligations.
   - Produce abstract delta tickets for gaps and report them back to Agent 0.
11. Verify coverage:
   - Contaminated manager checks gaps against source behavior, discovered source tests, equal-output requirements, and public contract compatibility.
   - Return only abstract deltas.
   - In unattended mode, reload durable artifacts and process at most one pending or gap unit per iteration.
   - Repeat analyze, sanitize, handoff, organize, and QC until coverage is acceptable or a stop condition is reached.

## Stop Conditions

Stop the workflow when any of these occur:

- Authorization is missing or narrower than the requested analysis.
- Clean roles were exposed to source, contaminated chat history, raw diffs, or copied source expression.
- Clean roles were given the full `task-manifest.json`, source roots, contaminated roots, source index refs, coverage ledgers, or evidence ledgers instead of `clean-run-context.json`.
- Agent 1.5 was exposed to source roots, `source-index.json` contents, contaminated evidence ledgers, private identifier lists, raw diffs, source excerpts, or Agent 1 source-reading chat history.
- A requested output requires replacement implementation code.
- Schema validation or leakage scan fails.
- A unit is blocked, ownership is unclear, or the source scope changes.
- An unattended loop reaches its configured iteration limit.
- Patent, trade-secret, license, or contract analysis is needed from counsel.
- The source scope is too large to keep bounded source index or coverage records.

## Final Package

Produce a final audit package containing:

- `task-manifest.json`
- `init-config.json`
- `clean-run-context.json`
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
