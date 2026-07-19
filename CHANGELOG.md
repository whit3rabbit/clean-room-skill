# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] - 2026-07-19

### Added

- Claude Code dynamic workflow install: the installer copies `workflows/*.js` into project-local `.claude/workflows/`, wired to the Claude Code runtime only (no other runtime ships a `Workflow()` engine). A new `workflows` artifact kind ships in the npm package.
- `clean-room-loop` skill: a Claude Code front door that launches the `clean-room-loop` dynamic workflow, running the unattended clean-room loop with in-session subagents (no per-token `claude -p` cost) and gating every wall crossing with the real leakage CLI. The front door initializes a project-local install when the current project lacks the workflow.

### Changed

- Skills now express a role-execution preference ladder: in-harness fresh-context roles first (the dynamic workflow on Claude Code, fresh subagent/skill sessions on other harnesses), with the durable runner's external process dispatch as a last resort. `--agent-runtime claude` (spawns `claude -p`, Claude-only, per-token) is the last option; non-Claude runtimes drive the runner with `run --agent-commands <adapter>`.
- Documented dynamic-workflow install and run in `README.md` and the repo guide.

## [0.6.6] - 2026-07-18

### Changed

- Bumped `actions/checkout` from 6.0.3 to 7.0.0.
- Bumped `actions/setup-node` from 6.4.0 to 7.0.0.
- Bumped `actions/setup-python` from 6.2.0 to 6.3.0.
- Bumped `hashgraph-online/ai-plugin-scanner-action` from 1.2.268 to 1.2.514.
- Bumped `react` from 19.2.6 to 19.2.7 (lockfile only, within existing range).
- Bumped `ink` from 7.0.3 to 7.1.0 (lockfile only, within existing range).

## [0.6.5] - 2026-06-24

### Added

- `clean-room-skill doctor --help`/`-h` prints usage and exits before hook validation.
- JSON schema validation repair output now suggests the kind-specific `clean-room-skill artifact template` (or builder script) command for creating a valid artifact.

### Changed

- Clean and contaminated role-agent prompts now document `Edit` and `MultiEdit` exact parameter names alongside `Read`, `Write`, and `Bash`.
- `clean-room-skill run` completion now aggregates every unmet terminal clean artifact into one error instead of failing one missing artifact per run, and reports a directory found where a file is expected (for example an empty `implementation-plan/` directory shadowing `implementation-plan.json`) distinctly from a missing artifact. This prevents a gate-by-gate retry loop when role agents under-produce artifacts.

## [0.6.4] - 2026-06-22

### Fixed

- Restored npm publishing to GitHub-hosted runners because npm trusted publishing provenance rejects self-hosted runners.

## [0.6.3] - 2026-06-22

### Changed

- CI checks now run on self-hosted runners while npm publishing stays on GitHub-hosted runners for trusted publishing provenance.

### Fixed

- Post-write hooks now validate JSON schema before leakage scanning so malformed artifacts fail with deterministic schema diagnostics.
- `clean-room-skill doctor` preserves required hook execution environment variables on self-hosted Linux runners and reports child hook signals instead of silent wrapped exit codes.

## [0.6.2] - 2026-06-22

### Added

- Added `clean-room-skill run --ccsilo [variant]` so the built-in Claude role-agent runtime can launch through ccsilo wrappers such as the OpenRouter variant while preserving only the required wrapper auth environment.

### Changed

- Clarified init, preflight, unattended, resume, and role-agent guidance so canonical artifacts start from generated CLI schemas/templates, and so runner-ready unattended work stays in the durable runner instead of main-chat role execution.
- Updated clean architect prompts to require every planned implementation path, including root package and build config files, to be covered by a referenced skeleton architecture area.

### Fixed

- Report schema validation now infers canonical artifact kind from exact or suffixed filenames before body heuristics, avoiding misleading `implementation-report` versus `qc-report` errors.
- Clean artifact leakage scanning now honors public API names referenced through `public_contract_refs` and avoids treating prose parentheticals as source-like calls.
- `clean-room-skill run` now fails closed when a root-level `task-manifest.json` conflicts with the active contaminated artifact manifest.
- OpenRouter wrapper failures now surface as credential diagnostics without leaking keys, and dry-run output identifies the bundled generated CLI schema source.
- ccsilo/OpenRouter runner guidance now explicitly uses `--ccsilo [variant]` and forbids writing API tokens into ccsilo or Claude settings files.

## [0.6.1] - 2026-06-18

### Changed

- Removed per-tool synrepo approval stanzas from repo-local `.codex/config.toml`.
- Ignored generated `skills/clean-room-workspace/fixtures/draft-behavior-spec.json` eval fixture.

## [0.6.0] - 2026-06-16

### Changed

- Clarified clean-room init and preflight guidance so new runs use the `clean-room-skill init` CLI bootstrap path, project task layout, and CLI-derived hook environment instead of hand-created folders.
- Updated README and architecture docs to align artifact CLI usage with project-layout and repo-local state details.

### Fixed

- Claude Code plugin installation now retries transient marketplace clone failures before failing the install.

## [0.5.0] - 2026-06-15

### Added

- `clean-room-skill artifact` subcommand to list canonical artifact kinds (`kinds`), write schema-shaped starters (`template`), and validate artifact JSON (`validate`).
- `clean-room-skill init` now records a repo-local `.clean-room/local-state.json` pointer and joins the recorded project by default on re-run; pass `--new-project` or `--single-task` to opt out.

### Changed

- Preflight template defaults now reflect the project layout (`<project>/tasks/<task-id>/` and `<project>/implementation/`).
- Role prompts and docs require using the `artifact` CLI to template and validate canonical artifacts rather than hand-writing them.

### Fixed

- `artifact validate` fails closed when a file maps to no canonical artifact kind (via `CLEAN_ROOM_REQUIRE_ARTIFACT_KIND`), requires `--path` files to live under the task-manifest roots, and rejects `--role` without `--task-manifest`.
- `artifact validate` warns when a contaminated-root `handoff-package.json` is validated under a non-sanitizer role, where the leakage scan would otherwise be silently skipped.
- `clean-room-skill init` surfaces an actionable error for a corrupt or invalid `.clean-room/local-state.json` (and `--force` now bypasses it), validates single-task local state, and warns when a run replaces a recorded project pointer.
- `clean-room-skill init` no longer aborts with a raw `EISDIR` when `.clean-room/.gitignore` is a directory, and no longer leaks a raw JSON parse error when recorded project metadata is unreadable.

## [0.4.1] - 2026-06-14

### Fixed

- Visual index generation now accounts for bytes read from invalid image files when enforcing the total byte cap.
- Clean artifact leakage scanning now catches source-root path disclosures across structured artifacts, preflight outputs, and run coverage state.

## [0.4.0] - 2026-06-13

### Added

- Added top-level `clean-room-skill --version` output.
- Added `clean-room-skill init --single-task` for the legacy flat task layout.

### Changed

- `clean-room-skill init` now creates a neutral project layout by default, with task roots under `<artifact-base>/<project>/tasks/<task-id>/` and a shared project-level `implementation/` root.
- Init output now prints `project root` and `task root` explicitly instead of the ambiguous `output folder`.
- Runtime skill and reference docs now align with the project-default bootstrap flow and release guidance requires matching version, changelog, and GitHub Release updates.

## [0.3.1] - 2026-06-13

### Fixed

- `listFiles()` now accepts `ignoreNamePrefixes` to filter stale implementation lock directories (`.clean-room-implementation.lock.stale.*`) from progress scans; stale lock recovery renames the dir rather than deleting it so the original can be inspected post-mortem
- Project neutrality check now catches workspace tokens as short as 2 characters (was 4), preventing short-but-meaningful workspace names from bypassing the leakage guard
- `validateBootstrapScaffold` uses `metadata.layout === 'project'` as the sole authoritative layout signal; stray `project_id` or `project_root` fields on a flat task no longer flip layout detection and redirect the shared implementation root
- `--force` now warns when adopting a project root that lacks or has invalid project metadata (`clean-room-project.json`), so operators know they are reusing existing `tasks/` and `implementation/` content
- `--dry-run` skips project metadata validation on imperfect existing project roots, preventing dry-run failures when previewing project init on a directory that was created without metadata

## [0.3.0] - 2026-06-11

### Added

- Clean-room project grouping: multiple tasks may share a single implementation root under `~/Documents/CleanRoom/<project>/tasks/<task-id>/` with one `<project>/implementation/` root; `clean-room-skill run` enforces at most one active task per project with an advisory `.clean-room-implementation.lock`
- CI now automatically creates GitHub Releases when the publish workflow runs

## [0.2.3] - 2026-06-10

### Changed

- Improved clean-room recovery guidance and Claude tool prompts for resume and start-over flows

## [0.2.2] - 2026-06-10

### Changed

- Added npx fallback for CLI commands in README and skill references

## [0.2.1] - 2026-06-04

### Added

- Pi runtime compatibility support

### Changed

- Tightened Agent 4 commit flow and polish schema

### Fixed

- Leakage policy now denies `include_paths` fields to prevent path disclosure

## [0.2.0] - 2026-06-02

### Changed

- Documented deny-by-default completion validation: `task-manifest.json`, `coverage-ledger.json`, and `clean-room-result*.json` writes that claim completion must be backed by durable canonical clean artifacts
- Documented clean-room installer and verification scope in architecture references

## [0.1.15] - 2026-06-01

### Added

- Support for built-in Claude Code agent dispatch for unattended runs (`--agent-runtime claude`)

## [0.1.14] - 2026-05-31

### Changed

- Renamed `resume` skill to `resume-cr` to avoid conflicts
- Added runner ETA debug output and improved polish phase output handling

## [0.1.13] - 2026-05-31

### Added

- Runtime metadata fields and OpenCode local plugin bridge support

### Changed

- Refactored preflight validation into focused modules

## [0.1.12] - 2026-05-28

### Added

- Public-surface parity enforcement in clean-room validation

### Changed

- Clarified discovery leads and foundation unit flow in role guidance

## [0.1.11] - 2026-05-26

### Added

- Visual-index support for screenshot/image fallback evidence
- CI now runs on Node 24

### Changed

- Hardened clean-room completion gates
- Hardened clean-room artifact placement rules
- Hardened leakage scan for normalized source names

## [0.1.10] - 2026-05-23

### Fixed

- Fixed leakage scan for lowercase dotted module identifiers

### Changed

- Hardened clean-room hook boundaries and contaminated artifact read constraints
- Hardened sanitizer read allowlist in source-read hook
- Hardened Claude CLI executable resolution and PATH hijacking protections

## [0.1.9] - 2026-05-22

### Added

- Agent 4 Clean Polish Reviewer: final source-denied code polish, repo hygiene, `polish-report.json`, and constrained implementation-root git commit
- Architecture map enforcement for clean-room planning (`skeleton-manifest.json`)

### Changed

- Tightened clean-room parity enforcement between specs and implementation

## [0.1.8] - 2026-05-22

### Added

- Support for explicit Claude executable wrappers via `CLEAN_ROOM_CLAUDE_EXECUTABLE`
- Session briefs for clean-room role context management
- Strict runner adapter context handoff documentation
- Repair hints in schema hook failures

### Fixed

- Fixed leakage scanner bypass for lowercase dotted module identifiers

## [0.1.7] - 2026-05-22

### Fixed

- Fixed clean-room state discovery loop

## [0.1.6] - 2026-05-22

### Changed

- Documented Claude plugin installs and tightened runtime selection

## [0.1.5] - 2026-05-22

### Added

- Bootstrap-aware preflight validation and init checks

## [0.1.4] - 2026-05-22

### Fixed

- Validate Claude manifest and remove invalid agents field

## [0.1.3] - 2026-05-21

### Added

- Install status and update operations (`status`, `update` subcommands)
- Trusted npm publishing documentation

### Changed

- Hardened clean-room locks, hooks, and runner validation
- Refined installer prompts and safe hook guidance
- Hardened run environment and fixed schema heuristics
- Updated AGENTS repo guidance

## [0.1.2] - 2026-05-21

### Added

- Preflight goal contract (`preflight-goal.json`) for clean-room runs
- Clean-room bootstrap init command

### Fixed

- Fixed trusted npm publish workflow

### Changed

- Hardened installer against races and traversal limits

## [0.1.1] - 2026-05-21

### Added

- Initial npm release
