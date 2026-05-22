# Clean Room Repo Guide

## Repo Quick Facts

- npm package: `clean-room-skill`.
- CLI entrypoint: `bin/install.js`.
- Executable inner-loop runner: `clean-room-skill run`.
- Full local verifier: `bin/verify.sh`.
- Node requirement: `>=22`.
- CI runs Node 22 with Python 3.12 on macOS.
- This repo installs clean-room skills, role agents, hooks, schemas, and examples for multiple agent runtimes.
- The workflow creates clean behavioral spec packages. It does not create replacement implementation code.
- Full docs: [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repo Map

- `bin/`: installer CLI and local verification script.
- `lib/`: installer helpers, hook config helpers, runtime layout logic, and inner-loop runner.
- `skills/`: skill entrypoints, schemas, references, scripts, and example spec packages.
- `agents/`: Claude role-agent prompts.
- `examples/codex/`: Codex role-agent templates.
- `hooks/`: Python guardrail hooks.
- `tests/`: Node tests and JSON Schema validation helper.
- `.github/workflows/`: CI and npm publish workflows.
- `.agents/plugins/marketplace.json`: Codex repo marketplace.
- `.claude-plugin/marketplace.json`: Claude Code marketplace.
- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`: runtime-specific plugin manifests.

## Commands

- Search with `st`, not ripgrep or grep.
- Install deps: `npm ci --ignore-scripts`.
- Run all Node tests: `npm test`.
- Run installer tests only: `npm run test:install`.
- Set up Python verifier deps on macOS/Homebrew Python: `python3 -m venv .venv && .venv/bin/python -m pip install "jsonschema[format]>=4.18,<5"`.
- Run full local checks: `npm run verify`.
- Dry-run installer: `node bin/install.js --dry-run --all --global`.
- Dry-run inner-loop runner: `node bin/install.js run --task-manifest <path> --agent-commands <path> --dry-run`.
- No lint script exists. Do not invent one.

## Verification

- JS changes: run `node --check` on touched JS/CJS files and `npm test`.
- Runner changes: run `node --check lib/run.cjs bin/install.js`, `node --test tests/run.test.js`, and `npm test`.
- Installer/runtime layout changes: run `npm run test:install` and `npm run verify`.
- Python hook or script changes: run `python3 -m py_compile hooks/*.py skills/clean-room/scripts/*.py skills/clean-room/scripts/source_index/*.py`.
- Schema or example changes: run `.venv/bin/python tests/validate_jsonschema.py` if `.venv` exists, otherwise use a Python with `jsonschema[format]>=4.18,<5`.
- Marketplace metadata changes: run `jq empty` on changed JSON files, confirm plugin names match runtime manifests, and confirm local source paths start with `./` and resolve inside the repo.
- Package or release-facing changes: run `npm pack --dry-run`.
- Documentation-only changes usually need review plus link/path checks, not the full test suite.

## Marketplace Metadata

- Codex marketplace file: `.agents/plugins/marketplace.json`.
- Claude Code marketplace file: `.claude-plugin/marketplace.json`.
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
- Publishing is triggered by a published GitHub release.
- The release tag must match `package.json` after stripping a leading `v`.
- Publish workflow runs `npm publish --provenance`.

## High-Risk Areas

Ask before changing:

- Dependencies or package manager behavior.
- JSON schemas or artifact compatibility.
- Hook policy, role boundaries, path checks, leakage checks, or deny-by-default behavior.
- Installer conflict handling, backup behavior, uninstall behavior, or runtime layout.
- Public CLI flags, CLI output, config format, or compatibility behavior.
- CI, release, publishing, or provenance workflows.

## Installer And Indexer Safety

- Runtime install/uninstall mutations are serialized per target root with `.clean-room-install.lock`.
- Installer plans are not authority for later destructive actions. Recheck managed file state immediately before writes and removals, and back up late changes before mutation.
- `clean-room-install-manifest.json` uses `phase: "installing"` until hook config mutation succeeds, then `phase: "complete"`. If hook config mutation fails after files are copied, preserve a manifest with `hook_registration.status: "failed"` when possible.
- Bootstrap `init` must use atomic no-clobber writes unless `--force` is set.
- `listFiles()` must stay iterative and bounded. Do not remove max depth, max file count, or readdir error handling.
- Source indexing must enforce per-file and total byte limits after read, record changed-during-read files as skipped, use `os.walk(onerror=...)`, and prune traversal after global limits with one aggregate skipped entry.
- Local npm helper installs must hold the cache-local install lock before mutating the shared npm prefix and must preserve the structured JSON contract for prefix creation errors, subprocess timeouts, and subprocess `OSError`s.

## Hook Failure Behavior

- Post-write hooks must fail closed without Python tracebacks when artifact `stat`, `read_text`, `read_bytes`, or referenced-artifact hashing raises `OSError`.
- Hook error output must use redacted path labels through `describe_path()` / `redact_text()` for clean and source-denied roles.
- `validate-json-schema.py` artifact kind inference is intentionally conservative. Ambiguous clean-root JSON should fail closed unless allowlisted.
- `clean-room-skill doctor` is a smoke test. It should assert expected failure reasons and include spawn status, signal/error, stdout, and stderr snippets when a hook command fails.

## Clean-Room Architecture

- The process separates contaminated source analysis from clean behavioral specification.
- The outer loop evolves specs. The inner clean-room loop completes one approved spec slice, then returns `clean-room-result.json`.
- `clean-room-skill run` executes only the inner clean-room loop. It requires schema-valid `loop_context`, selects at most one pending/gap unit inside `approved_scope_refs`, and uses a user-supplied `agent-commands` adapter with `shell: false`.
- Prompt rules are not a boundary. Use path separation, role-specific sessions, hooks, schema validation, and artifact quarantine.
- Recovery entry points must reload durable artifacts, not prior chat history.
- Never expose `source-index.json`, contaminated ledgers, source paths, private identifiers, or contaminated chat history to clean roles.

## Skill Entry Points

- `clean-room`: start the setup wizard when no durable artifacts are provided.
- `attended`: start with `controller_policy.mode` fixed to `attended`.
- `unattended`: start with bounded unattended defaults and `loop_context` for one approved spec slice.
- `resume`: continue from existing durable artifacts.
- `start-over`: archive or quarantine current artifacts without deletion, then restart with a fresh `task_id`.
- `refocus`: audit current artifacts against declared scope without expanding scope.

## Role Summary

- [Agent 0: Contaminated Manager Verifier](agents/contaminated-manager-verifier.md): validates authorization, decomposes scope, tracks coverage, verifies Agent 3 terminal reports from the contaminated side, and writes `clean-room-result.json`.
- [Agent 1: Contaminated Source Analyst](agents/contaminated-source-analyst.md): reads authorized source and writes neutral behavior specs with ledger references.
- [Agent 2: Clean Architect](agents/clean-architect.md): reads clean inputs, manages schema base, and builds `skeleton-manifest.json`.
- [Agent 3: Clean Implementer Verifier](agents/clean-qa-editor.md): implements only selected-slice work under implementation roots, records verification status, maintains QC, and emits one terminal report.
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

Clean roles may read only clean roots, implementation roots, schema roots, and approved public/reference roots. Contaminated roles may read authorized source roots and write only contaminated artifacts. Shell-style tools should be disabled inside role sessions because they can bypass path-aware hooks. Normal repo maintenance commands are allowed outside role sessions.

## Local Artifacts

- Do not edit `__pycache__/`, `.venv/`, `.syntext/`, `repomix-output.xml`, packed `.tgz` files, or `node_modules/` unless explicitly asked.
- Keep generated verification output out of commits unless the user asks for it.
