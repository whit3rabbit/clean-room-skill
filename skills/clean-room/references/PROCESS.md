# Clean-Room Process

## Purpose

Use this process to turn authorized source analysis into clean behavioral specifications and then into clean implementation code without moving source expression into the clean workspace. Treat the wall as a process, filesystem, and profile boundary. Prompt instructions alone are not sufficient.

This process reduces engineering risk. It does not resolve patent, trade-secret, license, contract, or jurisdiction-specific legal questions.

## Workspace Separation

Use separate locations for each trust domain:

- Contaminated source workspace: source-readable, read-only where practical, no clean implementation output.
- Contaminated artifact workspace: init configs, source indexes, task manifests, draft behavior specs, coverage ledgers, and abstract delta tickets. Configure it with `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Clean artifact workspace: sanitized clean run contexts, behavior specs that passed leakage review, skeleton manifests, implementation plans, implementation reports, QC reports, and test plans. Configure it with `CLEAN_ROOM_CLEAN_ROOTS`.
- Clean implementation workspace: clean destination code and tests. Configure it with `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
- Clean allowed reference workspace: public documentation or destination constraints explicitly configured for clean and source-denied role reads.

### Path Naming Guards

Clean, contaminated, and implementation paths must remain neutral. If the user does not provide an explicitly approved neutral task ID, generate one as `task-` plus 8 lowercase hex characters and use it under `~/Documents/CleanRoom/`.

Do not derive task IDs, clean roots, contaminated artifact roots, or implementation roots from source folder names. The initialization wizard and environment preflight reject artifact paths that contain a source root basename or meaningful non-generic tokens from that basename.

Prefer separate agent profiles or homes when the host supports them. Do not rely on one chat context with role labels as the only separation control.

Use host-level policy where available:

- Claude role agents live in `agents/`.
- Claude hook scaffolding lives in `hooks/`.
- Codex agent templates live in `examples/codex/.codex/agents/`.
- Codex plugin hooks may require enabling plugin hook support in the user or project config before they run.

For clean roles, configure read hooks as deny-by-default. `CLEAN_ROOM_CLEAN_ROOTS` is the clean artifact allowlist, `CLEAN_ROOM_IMPLEMENTATION_ROOTS` is the clean destination foundation allowlist, and `CLEAN_ROOM_SCHEMA_DIR` is readable for bundled schemas. For Agent 1.5, configure reads as source-denied: assigned contaminated artifacts, `CLEAN_ROOM_SCHEMA_DIR`, and `CLEAN_ROOM_ALLOWED_READ_ROOTS` are allowed; source roots, clean roots, implementation roots, and `source-index.json` are denied. `CLEAN_ROOM_ALLOWED_READ_ROOTS` is the extra clean/source-denied read allowlist for public documentation or destination constraints. `CLEAN_ROOM_SOURCE_ROOTS` remains denied for source-denied roles even if a source path is also listed elsewhere.

For all roles, configure write hooks as deny-by-default. Agent 2 writes only under `CLEAN_ROOM_CLEAN_ROOTS`. Agent 3 writes clean reports under `CLEAN_ROOM_CLEAN_ROOTS` and code/tests only under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`. Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Source roots should remain read-only for contaminated roles.

Agent zero/controller is responsible for computing the role environment block and passing it into every new role session. Sessions must not rely on inherited values. The minimum block is:

- `CLEAN_ROOM_ROLE`
- `CLEAN_ROOM_SOURCE_ROOTS`
- `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- `CLEAN_ROOM_CLEAN_ROOTS`
- `CLEAN_ROOM_IMPLEMENTATION_ROOTS`
- `CLEAN_ROOM_SCHEMA_DIR`
- `CLEAN_ROOM_ALLOWED_READ_ROOTS` for clean and source-denied roles, even when empty

Optional guardrail value:

- `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`: path-separated, line-oriented files containing private source package, module, function, method, variable, constant, field, or other internal identifiers that must not appear in clean artifacts. Blank lines and `#` comments are ignored. Files are bounded to 1,000,000 bytes each, 20,000 total terms, and 512 characters per term. This is for hook scanning only; keep it outside clean/source-denied readable roots and do not include its contents in clean artifacts or sanitizer-readable briefs.

Do not grant shell-style tools to Agent 0, Agent 1, Agent 1.5, Agent 2, or the default Agent 3 profile. Agent 3 terminal verification may use shell-style tools only when `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`, strict hooks are installed, the command cwd is under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, and the command invokes the installed `agent3-verification-runner.py`. Shell access still does not replace OS/profile isolation for untrusted test code.

Run `scripts/build_source_index.py` only as controller preflight before clean-room role sessions. Treat `source-index.json` as contaminated-only: it may record source paths, private import/export identifiers, file metrics, large-file line spans, optional AST/indexing tool status, and dependency relationships. Agent 0 may consume it to create neutral `task-manifest.json` units, but it must not cross to Agent 1.5, clean roles, or clean handoff packages.

Use `scripts/clean_room_tool_manager.py --status` when the controller needs to inspect optional AST/indexing helpers before indexing. It checks env overrides, `~/.cache/re-skills/clean-room-tools/`, skill-local tools, system PATH roots, and user toolchain PATH roots. It does not install anything unless the user explicitly runs `--install-local` with a strict SemVer version. Target-project `.local/bin`, `.bin`, and `node_modules/.bin` stay untrusted unless `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1` is set. Tools discovered under `/opt/homebrew` or `/usr/local` remain stat-only during `--probe-tools` unless `--allow-user-toolchain-probes` is also set.

Do not treat skill frontmatter or allowed tool lists as a complete enforcement boundary.

The task manifest records the Agent 0-3 pipeline plus Agent 1.5 for new runs:

- Agent 0 is the contaminated manager/verifier.
- Agent 1 is the contaminated source analyst and neutral task/spec generator.
- Agent 1.5 is the contaminated handoff sanitizer and independent source-denied scrubber.
- Agent 2 is the clean architect and implementation planner.
- Agent 3 is the clean implementer/verifier and emits one terminal implementation report for Agent 0.

Agent 1.5 runs in the contaminated domain but must not read source roots, `source-index.json`, contaminated evidence ledgers, or Agent 1 source-reading chat history.
Agent 2 and Agent 3 are clean-domain roles. They may read `clean-run-context.json`, approved behavior specs, handoff packages, schemas, approved public references, and clean implementation roots only. Agent 2 writes implementation plans, not code. Agent 3 writes implementation code only under implementation roots. They must not read source workspaces, contaminated ledgers, contaminated chat history, or the full `task-manifest.json`. Agent 0 may influence these roles only through durable sanitized artifacts, not direct messages, implementation hints, progress feedback, or priority changes.

## Controller Modes

`task-manifest.json` may include `controller_policy`. Missing policy means `attended`.

- `attended`: agent zero pauses for human review at scope gate, clean handoff, terminal implementation delta review, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop. It reloads `task-manifest.json`, `coverage-ledger.json`, `evidence-ledger.json`, and clean QC artifacts at the start of each iteration, selects at most one pending or gap unit, starts each role session from fresh context with the required environment block, validates schema and leakage results before state advances, and stops on any configured safety or ambiguity condition.

`task-manifest.json` may also include `run_state` to record the run generation, start timestamp, optional previous generation reference, and restart reason. It may include `initialization_snapshot`, an immutable copy of the effective `init-config.json` choices for resumability. New runs use generation `1`; start-over recovery increments generation or creates a fresh task id when prior state is not trusted.

The durable tasklist is `task-manifest.json` `units`, generated by agent zero during decomposition. For multi-file scopes, the task manifest may reference contaminated `source-index.json` batches through `source_index_ref` and per-unit `source_index_refs`. Progress is tracked in contaminated-side `coverage-ledger.json` and `evidence-ledger.json`; clean-side feedback returns only after terminal Agent 3 status through `implementation-report.json`, `qc-report.json`, and abstract delta tickets. Prior chat is not a source of truth for the next iteration.

## Recovery Entry Points

Use recovery entry points only when durable artifacts already exist:

- `resume`: reload the manifest, initialization snapshot, ledgers, clean run context, handoff artifacts, implementation plan, implementation report, QC report, and abstract delta tickets; validate schema and leakage state; continue from the earliest incomplete gate under the recorded controller policy. If reusable `init-config.json` differs from the manifest snapshot, report drift and stop before applying changes.
- `start-over`: require explicit confirmation, archive or quarantine current artifacts without deletion, then return to the scope gate with a fresh `task_id`.
- `refocus`: compare current artifacts to declared scope, identify missed gates or open deltas, and steer Agent 0 back to the earliest required gate without expanding scope.

All recovery flows preserve the clean-room wall. Source indexes, private identifiers, contaminated evidence ledgers, and contaminated chat history remain out of Agent 1.5, clean roles, and clean handoff packages.

## Role Duties

Contaminated manager/verifier:

- Confirm authorization and source scope.
- Create or update controller-side `init-config.json` when the user invokes initialization, then snapshot effective preferences into `task-manifest.json`.
- Produce sanitized `clean-run-context.json` for Agent 2 and Agent 3. Include clean artifact paths, implementation root environment references, target profile, approved public refs, clean-safe rules, clean-side model preferences, and artifact-only coordination policy only.
- Consume contaminated `source-index.json` when present.
- Split work into bounded logical units that can map to one source-index batch.
- Track coverage in `coverage-ledger.json`.
- Track contaminated evidence references in `evidence-ledger.json`.
- Provide Agent 1.5 only a neutral sanitizer brief with domain purpose, target profile, unit intent, public compatibility allowlist, and blocked categories.
- Compare clean artifacts and terminal implementation reports against source behavior, discovered source tests, equal-output requirements, and public API/schema compatibility.
- Return only abstract delta tickets into a fresh clean artifact cycle, such as "retry behavior after transient network failure is missing."

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

Clean architect/implementation planner:

- Start from the clean artifact workspace and read only `clean-run-context.json`, approved clean artifacts, schemas, approved public references, and `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
- Ignore direct Agent 0 messages or manager notes unless they arrive as schema-valid clean artifacts for a fresh clean session.
- Merge approved handoff artifacts into the selected clean schema base.
- Inspect the clean destination foundation to identify relative target paths, local patterns, tests, dependencies, and argv-array verification commands.
- Produce `implementation-plan.json` as the primary code-development contract.
- Keep `skeleton-manifest.json` valid when the selected target profile expects it.
- Do not write implementation code.

Clean implementer/verifier:

- Start from the clean domain and validate `clean-run-context.json` before using run preferences.
- Read `implementation-plan.json` and implement each unblocked work item.
- Write code, tests, fixtures, and destination project files only under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
- Run bounded argv-array verification commands only through the installed Agent 3 verification runner.
- Produce or update `implementation-report.json` with changed paths, verification results, blockers, and abstract delta tickets.
- Maintain `qc-report.json` for schema, leakage, and clean artifact status when the run expects it.
- Do not report progress or ask Agent 0 for guidance while implementing. Mark `implementation-report.json` as terminal only after the plan or task is complete, blocked, or quarantined.

## Workflow

1. Initialization gate:
   - Record reusable preferences in `init-config.json` when requested.
   - Default the artifact base root to `~/Documents/CleanRoom/<task-id>/` unless the user selects another separated location. Generate a neutral `task-` plus 8 lowercase hex characters when the user does not provide an explicitly approved neutral task ID.
   - Reject clean, contaminated, or implementation roots that mirror source root basenames or meaningful non-generic source-name tokens.
   - Record model preferences as a default model plus optional domain or role overrides.
   - Split user rules into clean-safe and contaminated-only rules.
   - Set clean isolation mode to `clean-workspace` and record separate implementation roots.
2. Scope gate:
   - Record requester, target identifier, authorization text, source scope, clean output scope, prohibited actions, and evidence handling.
   - Record the user's selected `format_selection.target_profile` and native artifact expectations from `docs/research-skill-spec.md`.
   - Record `controller_policy` when the task should run in explicit attended or bounded unattended mode.
   - Record `run_state` with generation, start timestamp, and restart reason.
   - Record `initialization_snapshot` when init preferences exist.
   - Record the Agent 0-3 pipeline, Agent 1.5 sanitizer role, and handoff rules.
   - Record the source roots, contaminated artifact roots, clean roots, implementation roots, schema directory, and clean/source-denied allowed read roots that agent zero/controller will pass to each session.
   - Stop if authorization or ownership is unclear.
3. Clean context:
   - Create `clean-run-context.json` for Agent 2 and Agent 3.
   - Include only clean artifact paths, implementation root environment references, target profile, native artifact expectations, approved public references, clean-safe rules, and clean-side model preferences.
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
   - Do not include clean-produced skeleton manifests, implementation plans, implementation reports, or QC reports in contaminated-to-clean handoff packages.
   - Preserve producer role and Agent 1.5 review status.
   - Create `handoff-package.json`.
9. Plan implementation:
   - Agent 2 starts from the clean artifact workspace and builds or merges the clean schema base from `clean-run-context.json`, approved handoff artifacts, the selected target profile, target constraints, and clean implementation foundation.
   - Produce `implementation-plan.json` with relative destination paths, work items, tests, constraints, risks, and argv-array verification commands.
   - Keep `skeleton-manifest.json` valid when the target profile expects it.
   - Avoid implementation code, private algorithm choices, source-derived layout, and source-shaped pseudocode.
10. Implement and verify:
   - Agent 3 starts from the clean domain, reads `implementation-plan.json`, and writes code/tests only under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
   - Run bounded argv-array verification commands only through the installed Agent 3 verification runner.
   - Record changed paths, verification status, blockers, and abstract delta tickets in `implementation-report.json`.
   - Maintain `qc-report.json` for schema, leakage, source-test parity, equal-output assertions, and spec-to-plan-to-test mismatches.
   - Do not send Agent 0 progress updates or partial findings while work remains in progress.
11. Verify coverage:
   - Contaminated manager checks gaps against source behavior, discovered source tests, equal-output requirements, public contract compatibility, and terminal implementation reports.
   - Return only abstract deltas through updated durable artifacts for a fresh clean cycle.
   - In unattended mode, reload durable artifacts and process at most one pending or gap unit per iteration.
   - Repeat analyze, sanitize, handoff, plan, implement, and QC until implementation coverage is acceptable or a stop condition is reached. Do not steer an active Agent 2 or Agent 3 session.

## Stop Conditions

Stop the workflow when any of these occur:

- Authorization is missing or narrower than the requested analysis.
- Clean roles were exposed to source, contaminated chat history, raw diffs, or copied source expression.
- Clean roles were given the full `task-manifest.json`, source roots, contaminated roots, source index refs, coverage ledgers, or evidence ledgers instead of `clean-run-context.json`.
- Agent 1.5 was exposed to source roots, `source-index.json` contents, contaminated evidence ledgers, private identifier lists, raw diffs, source excerpts, or Agent 1 source-reading chat history.
- Implementation roots overlap source, contaminated artifact roots, clean artifact roots, or schema roots.
- Agent 2 is asked to write code.
- Agent 3 needs shell access without `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`, outside implementation roots, or for anything except the installed verification runner.
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
- `implementation-plan.json`
- `implementation-report.json`
- `qc-report.json`
- `contamination-incident.json` records when applicable
- test plan content embedded in behavior specs, skeleton manifest, and implementation plan
- open questions and abstract delta tickets that remain unresolved

The clean artifact workspace package must contain only clean-approved artifacts. The clean implementation workspace contains the destination code changes. Keep raw contaminated ledgers in the contaminated artifact workspace unless a separate audit handoff explicitly includes them outside the clean workspace.
