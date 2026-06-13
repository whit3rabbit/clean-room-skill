# Clean Room Repo Guide

## Repo Quick Facts

- npm package: `clean-room-skill`.
- CLI entrypoint: `bin/install.js`.
- Executable inner-loop runner: `clean-room-skill run`.
- Full local verifier: `bin/verify.sh`.
- Node requirement: `>=22`.
- CI runs Node 24 with Python 3.12 on macOS.
- This repo installs clean-room skills, role agents, hooks, schemas, examples, and optional verification templates for multiple agent runtimes.
- Installer runtime flags: Codex, Claude Code, Antigravity, Gemini CLI, OpenCode, Kilo, Cursor, GitHub Copilot, Windsurf, Augment, Trae, Qwen Code, Hermes Agent, and CodeBuddy.
- Hook registration is verified for Codex, Claude Code, and OpenCode. Other runtime layouts are best-effort installs unless code and tests prove otherwise.
- The workflow creates clean behavioral spec packages and clean implementation outputs. It does not generate replacement code directly from source.
- Full docs: [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/REFERENCE.md](docs/REFERENCE.md).

## Repo Map

- `bin/`: installer CLI and local verification script.
- `lib/`: installer helpers, TUI, hook config helpers, runtime layout logic, preflight helpers, doctor checks, and inner-loop runner.
- `skills/`: skill entrypoints, schemas, references, source and visual index scripts, and example spec packages.
- `agents/`: Claude role-agent prompts.
- `examples/codex/`: Codex role-agent templates.
- `hooks/`: Python guardrail hooks.
- `templates/docker/`: optional Agent 3 verification images and example verification command policies.
- `tests/`: Node tests, JSON Schema fixtures, schema parity fixtures, and validation helper.
- `.github/workflows/`: CI and npm publish workflows.
- `.agents/plugins/marketplace.json`: Codex repo marketplace.
- `.agents/skills/synrepo/`: repo-bundled synrepo skill metadata.
- `.codex/`: repo-local Codex config and hook config used for this workspace.
- `.claude-plugin/marketplace.json`: Claude Code marketplace.
- `plugin.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json`: runtime-specific plugin manifests.

## Commands

- Search with `st`, not ripgrep or grep.
- Run a single test file: `node --test tests/install.test.js`.
- Install deps: `npm ci --ignore-scripts`.
- Run all Node tests: `npm test`.
- Run installer tests only: `npm run test:install`.
- Set up Python verifier deps on macOS/Homebrew Python: `python3 -m venv .venv && .venv/bin/python -m pip install "jsonschema[format]>=4.18,<5"`.
- Run full local checks: `npm run verify`.
- Dry-run bootstrap folder creation: `node bin/install.js init --dry-run`.
- Show preflight helper options: `node bin/install.js preflight --help`.
- Dry-run installer: `node bin/install.js --dry-run --all --global`.
- Check runtime install state: `node bin/install.js status --global`.
- Dry-run runtime updates: `node bin/install.js update --global --dry-run`.
- Smoke-test generated hooks: `node bin/install.js doctor --runtime codex --hooks=safe --config-dir <path>`.
- Smoke-test strict OpenCode hook bridge coverage: `node bin/install.js doctor --runtime opencode --hooks=strict --coverage --config-dir <path>`.
- Dry-run inner-loop unit selection: `node bin/install.js run --task-manifest <path> --dry-run`.
- Run inner-loop with adapter commands: `node bin/install.js run --task-manifest <path> --agent-commands <path>`.
- Run inner-loop with built-in Claude role-agent dispatch: `node bin/install.js run --task-manifest <path> --agent-runtime claude [--agent-config-dir <path>]`.
- Build source index help: `python3 skills/clean-room/scripts/build_source_index.py --help`.
- Build visual index help: `python3 skills/clean-room/scripts/build_visual_index.py --help`.
- Build optional Docker verification profiles: `docker compose -f templates/docker/compose.clean-room.yml build`.
- No lint script exists. Do not invent one.

## Verification

- JS changes: run `node --check` on touched JS/CJS files and `npm test`.
- CLI/preflight/doctor/runner changes: run `node --check bin/install.js lib/doctor.cjs lib/preflight.cjs lib/run.cjs` plus touched JS/CJS files, then `npm test`.
- Runner changes: run `node --check lib/run.cjs lib/run-cli.cjs lib/run-controller.cjs bin/install.js`, `node --test tests/run.test.js`, and `npm test`.
- Installer/runtime layout changes: run `npm run test:install` and `npm run verify`.
- Installer TUI changes: use the MCP TUI test tool for at least one representative interactive flow.
- Python hook or script changes: run `python3 -m compileall -q hooks skills/clean-room/scripts`.
- Schema or example changes: run `.venv/bin/python tests/validate_jsonschema.py` if `.venv` exists, otherwise use a Python with `jsonschema[format]>=4.18,<5`.
- Source or visual index changes: run `node --test tests/source-index-policy.test.js tests/visual-index-policy.test.js` and the relevant `--help` command for the changed script.
- Docker template or container verification changes: run the relevant `node --test tests/hook-shell-policy.test.js` coverage. Build `templates/docker/compose.clean-room.yml` when Docker is available.
- Marketplace metadata changes: run `jq empty` on changed JSON files, confirm plugin names match runtime manifests, and confirm local source paths start with `./` and resolve inside the repo.
- Package or release-facing changes: run `npm pack --dry-run`.
- Documentation-only changes usually need review plus link/path checks, not the full test suite.

## Marketplace Metadata

- Codex marketplace file: `.agents/plugins/marketplace.json`.
- Claude Code marketplace file: `.claude-plugin/marketplace.json`.
- Root plugin manifest: `plugin.json`.
- Codex plugin manifest: `.codex-plugin/plugin.json`.
- Claude Code plugin manifest: `.claude-plugin/plugin.json`.
- This repo exposes the plugin at the repository root, so local marketplace sources should use `"./"`, not `"."`.
- Codex local entries must include `policy.installation`, `policy.authentication`, and `category`.
- Codex `policy.installation` values are `NOT_AVAILABLE`, `AVAILABLE`, or `INSTALLED_BY_DEFAULT`.
- Codex `policy.authentication` values are `ON_INSTALL` or `ON_USE`.
- Claude Code marketplace entries require `name` and `source`; local string sources must start with `./`.
- Antigravity does not use a documented `marketplace.json` format. It discovers plugin directories containing root `plugin.json` under workspace `.agents/plugins/` or global plugin locations.
- References:
  - Codex plugins: https://developers.openai.com/codex/plugins/build
  - Claude Code plugin marketplaces: https://code.claude.com/docs/en/plugin-marketplaces
  - Antigravity plugins: https://www.antigravity.google/docs/plugins
  - Antigravity Build with Google plugins: https://www.antigravity.google/docs/build-with-google

## Versioning And Release

- `package.json` version is the npm source of truth.
- Keep plugin metadata versions synchronized when changing package version.
- Every release must update `CHANGELOG.md` for the target version before tagging.
- Publishing is triggered by pushing a `v*` tag.
- The release tag must match `package.json` after stripping a leading `v`.
- Publish workflow uses npm trusted publishing and runs `npm publish`.
- npm trusted publishing is configured for GitHub Actions, repository `whit3rabbit/clean-room-skill`, workflow filename `publish.yml`.
- Keep `permissions.id-token: write` in `publish.yml`; it is required for OIDC trusted publishing.
- Release builds use Node 24 and `package-manager-cache: false`; do not re-enable npm caching in the publish job.
- Do not use `npm publish --provenance` here. Trusted publishing provides provenance with plain `npm publish`.
- Every npm release must have a matching GitHub Release for the same `vX.Y.Z` tag. GitHub Releases are informational and do not trigger npm publishing.
- GitHub Release notes should match or summarize the `CHANGELOG.md` entry for that version.
- Release flow:
  1. Bump `package.json` and `package-lock.json`, normally with `npm version X.Y.Z --no-git-tag-version --ignore-scripts`.
  2. Sync version fields in `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
  3. Update `CHANGELOG.md` with the same `X.Y.Z` version and release date.
  4. Run release-facing checks: `jq empty` on changed JSON metadata, `npm pack --dry-run`, and `npm run verify`.
  5. Commit the release changes, push the branch, create an annotated tag named exactly `vX.Y.Z`, and push the tag.
  6. Confirm the `Publish` workflow succeeds, then verify `npm view clean-room-skill version` returns `X.Y.Z`.
  7. Create or verify the GitHub Release for `vX.Y.Z`, and confirm it is not a draft or prerelease unless intentionally releasing a prerelease.
- Do not move, overwrite, or recreate published tags without explicit user approval. If npm publish has succeeded, fix release mistakes with a new patch version instead of republishing the same version.

## High-Risk Areas

Ask before changing:

- Dependencies or package manager behavior.
- JSON schemas or artifact compatibility.
- Hook policy, role boundaries, path checks, leakage checks, or deny-by-default behavior.
- Bootstrap project layout detection: `metadata.layout === 'project'` is the sole authoritative signal in `validateBootstrapScaffold`. Do not key layout detection off presence of `project_id` or `project_root` fields.
- Installer conflict handling, backup behavior, uninstall behavior, or runtime layout.
- Public CLI flags, CLI output, config format, or compatibility behavior.
- Docker or Podman verification policy, container profiles, network policy, dependency install policy, or clean/container mount behavior.
- CI, release, publishing, or provenance workflows.

## Installer And Indexer Safety

- Runtime install/update/uninstall mutations are serialized per target root with `.clean-room-install.lock`.
- `clean-room-skill run` mutations are serialized per contaminated root with `.clean-room-run.lock` and per implementation root with `.clean-room-implementation.lock`; `--dry-run` skips both locks.
- `status` is read-only. It may inspect manifests, managed file hashes, stale managed paths, conflicts, and hook registration state, but must not mutate target roots or hook config.
- `update` refreshes manifest-managed files without rerunning onboarding. It must preserve the prior manifest hook mode unless the user explicitly passes `--hooks=<mode>`.
- `update` should select only manifest-backed installs by default. Hook-only remnants are uninstall/repair concerns, not update targets.
- Installer plans are not authority for later destructive actions. Recheck managed file state immediately before writes and removals, and back up late changes before mutation.
- `clean-room-install-manifest.json` uses `phase: "installing"` until hook config mutation succeeds, then `phase: "complete"`. If hook config mutation fails after files are copied, preserve a manifest with `hook_registration.status: "failed"` when possible.
- Bootstrap `init` must use atomic no-clobber writes unless `--force` is set.
- `listFiles()` must stay iterative and bounded. Do not remove max depth, max file count, or readdir error handling.
- `listFiles()` accepts `ignoreNames` (exact Set) and `ignoreNamePrefixes` (startsWith filter). Implementation-root scans must pass both: `IMPLEMENTATION_IGNORE_NAMES` and `[IMPLEMENTATION_LOCK_STALE_PREFIX]`. Stale lock recovery renames dirs to `<lock>.stale.<ts>.<pid>` rather than deleting; only prefix filtering excludes these orphans.
- Source indexing must enforce per-file and total byte limits after read, record changed-during-read files as skipped, use `os.walk(onerror=...)`, and prune traversal after global limits with one aggregate skipped entry.
- Visual indexing must enforce non-overlapping visual roots, keep output under contaminated artifact roots, reject output under visual roots, enforce per-file and total byte limits after read, skip outside-root symlinks, record changed-during-read files as skipped, and write `visual-index.json` atomically.
- Local npm helper installs must hold the cache-local install lock before mutating the shared npm prefix and must preserve the structured JSON contract for prefix creation errors, subprocess timeouts, and subprocess `OSError`s.
- OpenCode hook support uses a generated managed local plugin bridge at `plugins/clean-room.ts`. It must keep the marker, `tool.execute.before` and `tool.execute.after` hooks, absolute wrapper path checks, bounded output, timeout handling, and `shell: false`.
- Agent 3 container verification is only a verification backend. It must never mount source roots or contaminated artifact roots into clean verification containers.

## Hook Failure Behavior

- Post-write hooks must fail closed without Python tracebacks when artifact `stat`, `read_text`, `read_bytes`, or referenced-artifact hashing raises `OSError`.
- Hook error output must use redacted path labels through `describe_path()` / `redact_text()` for clean and source-denied roles.
- `validate-json-schema.py` artifact kind inference is intentionally conservative. Ambiguous clean-root JSON should fail closed unless allowlisted.
- `clean-room-skill doctor` is a smoke test for Codex, Claude Code, and OpenCode hook wiring. It should assert expected failure reasons and include spawn status, signal/error, stdout, and stderr snippets when a hook command fails.
- `doctor --coverage` reports generated matcher/check coverage, but it does not prove host event coverage or full runtime isolation.

## Clean-Room Architecture

- The process separates contaminated source analysis from clean behavioral specification.
- Visual fallback evidence is contaminated source-domain input. Raw screenshots, visual roots, image hashes, exact UI palettes/layouts/iconography, copied visible words, and `visual-index.json` must not enter clean handoff packages.
- The outer loop evolves specs. The inner clean-room loop completes one approved spec slice, then returns `clean-room-result.json`.
- `clean-room-skill run` executes only the inner clean-room loop. It requires schema-valid `loop_context`, selects at most one pending/gap unit inside `approved_scope_refs`, supports optional `clean-polish-review`, and uses either a user-supplied `agent-commands` adapter with `shell: false` or built-in Claude role-agent dispatch.
- `coverage-ledger.json` may record contaminated-only `discovery_leads` for authorized related surfaces that Agent 1 detected but could not analyze in the assigned unit. High-priority leads must be resolved before a unit can be marked `covered`.
- Container execution policy supports `host`, `docker`, or `podman`; first-phase profiles are `node22`, `python312`, `go126`, and `rust-stable`. Container verification metadata is policy, not a shell escape hatch.
- Prompt rules are not a boundary. Use path separation, role-specific sessions, hooks, schema validation, and artifact quarantine.
- Recovery entry points must reload durable artifacts, not prior chat history.
- Never expose `source-index.json`, contaminated ledgers, source paths, private identifiers, or contaminated chat history to clean roles.

## Skill Entry Points

- `clean-room`: start the setup wizard when no durable artifacts are provided.
- `preflight`: create or review the required `preflight-goal.json` before source discovery or controller execution.
- `init`: record durable run preferences, separated roots, schema profile, model policy, and clean-safe/contaminated-only rules.
- `attended`: start with `controller_policy.mode` fixed to `attended`.
- `unattended`: start with bounded unattended defaults and `loop_context` for one approved spec slice. In Claude Code, prefer the durable runner with `--agent-runtime claude` when a valid unattended manifest can continue.
- `resume-cr`: continue from existing durable artifacts.
- `start-over`: archive or quarantine current artifacts without deletion, then restart with a fresh `task_id`.
- `refocus`: audit current artifacts against declared scope without expanding scope.

## Role Summary

- [Agent 0: Contaminated Manager Verifier](agents/contaminated-manager-verifier.md): validates authorization, decomposes scope, tracks coverage, verifies Agent 3 terminal reports from the contaminated side, and writes `clean-room-result.json`.
- [Agent 1: Contaminated Source Analyst](agents/contaminated-source-analyst.md): reads authorized source, inventories the assigned unit's observable surface, records unresolved authorized follow-up surfaces as contaminated `discovery_leads`, and writes neutral behavior specs with ledger references.
- [Agent 1.5: Contaminated Handoff Sanitizer](agents/contaminated-handoff-sanitizer.md): reviews Agent 1 drafts from a source-denied contaminated context, scrubs identifying material, and approves or quarantines clean handoff candidates.
- [Agent 2: Clean Architect](agents/clean-architect.md): reads clean inputs, maintains `skeleton-manifest.json` as the clean architecture map, and builds `implementation-plan.json`.
- [Agent 3: Clean Implementer Verifier](agents/clean-qa-editor.md): implements only selected-slice work under implementation roots, records verification status, maintains QC, and emits one terminal report.
- [Agent 4: Clean Polish Reviewer](agents/clean-polish-reviewer.md): performs final source-denied code polish, repo hygiene, verification review, writes `polish-report.json`, and may create one constrained implementation-root commit.
- [Agent 3 shell variant](agents/clean-implementer-verifier-shell.md): shell-capable verification profile for isolated strict-hook homes; use only for bounded Agent 3 verification through the installed runner.
- Leakage rules live in [skills/clean-room/references/LEAKAGE-RULES.md](skills/clean-room/references/LEAKAGE-RULES.md).

## Role Session Environment

Set these before any clean-room role session:

- `CLEAN_ROOM_ROLE`
- `CLEAN_ROOM_SOURCE_ROOTS`
- `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`
- `CLEAN_ROOM_CLEAN_ROOTS`
- `CLEAN_ROOM_IMPLEMENTATION_ROOTS`
- `CLEAN_ROOM_ALLOWED_READ_ROOTS`
- `CLEAN_ROOM_SCHEMA_DIR`

Clean roles may read only clean roots, implementation roots, schema roots, and approved public/reference roots. Contaminated roles may read authorized source roots and write only contaminated artifacts. Shell-style tools should be disabled inside role sessions because they can bypass path-aware hooks. Agent 3 and Agent 4 runner exceptions require their explicit `CLEAN_ROOM_ALLOW_AGENT*_SHELL` flags and cwd under implementation roots. Normal repo maintenance commands are allowed outside role sessions.

For visual fallback runs, screenshot or image roots belong in `CLEAN_ROOM_SOURCE_ROOTS` so clean/source-denied read hooks can protect them. `visual-index.json` stays under contaminated artifact roots.

## Testing

- Core helpers in `tests/install.test.js`: `runInstall(argv)` spawns the CLI and returns `{ status, stdout, stderr }`; `readJson(filePath)` reads and parses JSON; `tempDir(name)` creates a unique temp dir and registers cleanup.
- Use `process.stderr.write()` (not `console.warn`) for warnings the CLI emits to stderr when test assertions check `result.stderr`.

## Local Artifacts

- Do not edit `__pycache__/`, `.venv/`, `.syntext/`, `repomix-output.xml`, packed `.tgz` files, or `node_modules/` unless explicitly asked.
- Keep generated verification output out of commits unless the user asks for it.
