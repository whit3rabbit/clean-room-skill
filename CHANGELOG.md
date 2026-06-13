# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
