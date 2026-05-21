# Clean Room

Clean-room workflow for turning authorized source analysis into clean specs and clean implementation code.

This is a POC based on the ideas presented here: 

https://malus.sh/blog.html

This plugin packages the `clean-room`, `attended`, `unattended`, `resume`, `start-over`, and `refocus` skills, Claude role agents, Codex role-agent templates, JSON schemas, examples, and hook guardrails for separating contaminated source analysis from clean behavioral specification and clean implementation work.

It is an engineering risk-reduction workflow. It is not legal advice and does not create a legal safe harbor.

## Use This For

- Authorized source-to-implementation migration work.
- Clean behavioral specifications for compatibility work.
- Implementation plans, clean code changes, verification reports, QC reports, open questions, and test plans.
- Documented separation between source-reading roles, clean planning roles, and clean implementation roles.

## Threat Model And Non-Goals

This workflow protects against:

- accidental source expression crossing into clean specs or clean implementation code
- clean agents reading contaminated roots
- contaminated agents writing clean artifacts
- clean or contaminated agents writing outside their role artifact or implementation roots
- unbounded unattended controller loops

It does not protect against:

- hostile local users
- compromised host tooling
- shared model context outside role isolation
- legal conclusions
- side channels through filenames, timing, or retained chat context

## Install

### Installation Model

The `clean-room-skill` npm package has two separate layers:

*   **Agent/runtime install**: installs clean-room skills, agent prompts, and verification hooks *into* your local or global agent runtimes (e.g., Claude Code, Codex, or Cursor). This is the default command behavior.
*   **Run bootstrap**: `clean-room-skill init` creates neutral external output folders and a clean-safe repo stub for a specific clean-room run. It does not install hooks, does not write active run artifacts, and does not replace the runtime skill workflow.

*   **Global Installation (Recommended)**: Integrates the clean-room workflow globally into your agent configuration directories (e.g., `~/.claude/` or `~/.codex/`).
*   **Local Installation**: Places the plugin directly inside your current repository's workspace (e.g., `.claude/` or `.codex/`).

Preferred direct installer:

```bash
npx clean-room-skill@latest
```

The installer prompts for runtime and scope when no flags are supplied. For non-interactive installs, pass the runtime and scope explicitly:

```bash
npx clean-room-skill@latest --codex --global --yes
npx clean-room-skill@latest --claude --global --yes
npx clean-room-skill@latest --antigravity --global --yes
npx clean-room-skill@latest --opencode --global --yes
npx clean-room-skill@latest --cursor --global --yes
npx clean-room-skill@latest --all --global --yes
```

Runtime support tiers:

- Verified: Codex and Claude Code. These installs have tested skill, agent, hook registration, and hook payload behavior.
- Layout-only / experimental: Antigravity, Gemini, OpenCode, Kilo, Cursor, GitHub Copilot, Windsurf, Augment, Trae, Qwen Code, Hermes Agent, and CodeBuddy. The installer writes files to expected layout roots, but this repo does not verify that those hosts load the files or enforce clean-room behavior.

Runtime install roots:

- Codex global: `CODEX_HOME` or `~/.codex`
- Claude Code global: `CLAUDE_CONFIG_DIR` or `~/.claude`
- Antigravity CLI global plugin: `ANTIGRAVITY_PLUGIN_DIR`, `ANTIGRAVITY_CLI_PLUGIN_DIR`, `ANTIGRAVITY_CONFIG_DIR/plugins/clean-room`, or `~/.gemini/antigravity-cli/plugins/clean-room`
- Gemini global legacy/enterprise: `GEMINI_CONFIG_DIR` or `~/.gemini`
- OpenCode global: `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`
- Kilo global: `KILO_CONFIG_DIR`, `KILO_CONFIG`, `XDG_CONFIG_HOME/kilo`, or `~/.config/kilo`
- Cursor global: `CURSOR_CONFIG_DIR` or `~/.cursor`
- GitHub Copilot global: `COPILOT_CONFIG_DIR` or `~/.copilot`
- Windsurf global: `WINDSURF_CONFIG_DIR` or `~/.codeium/windsurf`
- Augment global: `AUGMENT_CONFIG_DIR` or `~/.augment`
- Trae global: `TRAE_CONFIG_DIR` or `~/.trae`
- Qwen Code global: `QWEN_CONFIG_DIR` or `~/.qwen`
- Hermes Agent global: `HERMES_HOME` or `~/.hermes`
- CodeBuddy global: `CODEBUDDY_CONFIG_DIR` or `~/.codebuddy`

Local installs are available through `--local` using each runtime's project config directory. Antigravity local installs write `.agents/plugins/clean-room/`. Claude local, Gemini, **OpenCode, and Kilo** receive generated command wrappers (e.g. `clean-room-clean-room.md`, `clean-room-init.md`); native skill runtimes receive `SKILL.md` directories. Gemini CLI support is legacy/enterprise compatibility because Google is transitioning consumer Gemini CLI users to Antigravity CLI on June 18, 2026. Cline is not included because it has no verified clean-room skill or command layout.

Hook modes:

- `--hooks=safe`: default. Copies hooks and registers a wrapper that no-ops unless `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present. This is compatibility-only; use `--hooks=strict` for dedicated Codex or Claude clean-room homes.
- `--hooks=copy-only` or `--no-hooks`: copies hook files but does not register Codex or Claude hook config.
- `--hooks=strict`: registers fail-closed hooks for dedicated clean-room homes. Strict mode is supported only for Codex and Claude Code because other runtime hook payloads are not verified. Antigravity receives hook scripts in the plugin directory, but the generated plugin manifest does not enable them until an Antigravity-specific hook payload adapter exists.

### Installer CLI Reference

Execute the installer via `npx` with the following parameters:

```bash
npx clean-room-skill@latest [runtimes] [scope] [options]
```

| Parameter | Type | Description |
| --- | --- | --- |
| `--claude` / `--codex` | Runtime | Selects the target agent runtime. (Supports `--all` for all runtimes) |
| `--global` / `--local` | Scope | Installs to the global user home config or the local project directory. |
| `--hooks=<mode>` | Option | Sets hook mode: `safe` (default, opt-in), `strict` (fail-closed), or `copy-only`. |
| `--no-hooks` | Option | Alias for `--hooks=copy-only`. Copies scripts without registering hooks. |
| `--config-dir <path>` | Option | Overrides the target root directory (only for single-runtime installs). |
| `--dry-run` | Option | Performs a trial run, logging actions without writing files. |
| `--uninstall` | Option | Removes all manifest-managed files and hook registrations. |
| `--yes` | Option | Non-interactive mode. Automatically accepts overwriting known files. |

Useful maintenance commands:

```bash
npx clean-room-skill@latest --dry-run --all --global
npx clean-room-skill@latest --codex --global --uninstall --yes
npx clean-room-skill@latest doctor --runtime codex --hooks=safe
```

The installer writes `clean-room-install-manifest.json` into each target root. Reinstalling replaces only manifest-managed files automatically. If a managed file was locally modified, the previous version is backed up under `clean-room-patches/<timestamp>/`. Unknown existing files are not overwritten in non-interactive mode.

### Bootstrap CLI Reference

Use `init` to prepare a clean implementation repository and external run folder before starting the agent workflow:

```bash
npx clean-room-skill@latest init
npx clean-room-skill@latest init --target-dir . --target-profile speckit-feature-folder
npx clean-room-skill@latest init --artifact-base ~/Documents/CleanRoom --task-id task-1234abcd
```

By default, `init` writes external run folders under `~/Documents/CleanRoom/<task-id>/` and creates:

- `contaminated/`
- `clean/`
- `quarantine/`
- `clean-room-bootstrap.json`
- `.clean-room/README.md` in the target repository

The repo-local `.clean-room/README.md` is clean-safe guidance only. Do not commit source roots, contaminated artifact paths, private identifiers, source-derived names, `init-config.json`, `task-manifest.json`, or `clean-run-context.json` into the clean implementation repository.

`init` prints the output folder, repo stub path, safe hook install command, runtime start guidance, and uninstall command. It never registers strict hooks. For normal use, install safe hooks into your agent home:

```bash
npx clean-room-skill@latest --codex --global --hooks=safe --yes
npx clean-room-skill@latest --claude --global --hooks=safe --yes
```

Use `--hooks=strict` only for dedicated clean-room Codex or Claude homes, not a daily agent profile.

Marketplace install remains available.

From Codex marketplace:

```bash
codex plugin marketplace add https://github.com/whit3rabbit/clean-room-skill.git
```

Then install or enable `clean-room` from the `clean-room-skill` marketplace. Enable plugin hooks in trusted Codex config before relying on guardrails:

```toml
[features]
plugin_hooks = true
```

From Claude Code marketplace:

```text
/plugin marketplace add https://github.com/whit3rabbit/clean-room-skill.git
/plugin install clean-room@clean-room-skill
```

Manual Antigravity install:

Clone this repository into your local plugins directory:

```bash
git clone https://github.com/whit3rabbit/clean-room-skill.git ~/.gemini/config/plugins/clean-room-skill
```

Reload or restart the host if the plugin is not visible immediately.

## Invocation

In Claude Code, use the plugin skill namespace:

```text
/clean-room
/clean-room:clean-room
/clean-room:init
/clean-room:attended
/clean-room:unattended
/clean-room:resume
/clean-room:start-over
/clean-room:refocus
```

`/clean-room` and `/clean-room:clean-room` start the setup wizard. `/clean-room:init` records reusable setup preferences before a run starts or changes. `/clean-room:attended` starts the same wizard with attended review gates. `/clean-room:unattended` starts it with bounded unattended defaults: one unit per iteration, finite max iterations, and the configured safety stop conditions. `/clean-room:resume`, `/clean-room:start-over`, and `/clean-room:refocus` recover runs from durable artifacts.

In Codex, invoke the `clean-room` plugin or one of its bundled skills explicitly with `@` or the skills UI. Do not rely on Claude-style `/clean-room:...` namespacing in Codex.

## Run Workflow

Use this sequence for normal runs and recovery:

| Situation | Claude command | Codex action | What the skill does |
| --- | --- | --- | --- |
| Initialize preferences | `/clean-room:init` | Invoke `init` | Records artifact roots, target profile, model preferences, clean-safe rules, and contaminated-only rules. Defaults artifacts to `~/Documents/CleanRoom/<task-id>/`. |
| New run, default review gates | `/clean-room` or `/clean-room:attended` | Invoke `clean-room` or `attended` | Confirms authorization, separated roots, target profile, and starts the scope gate in attended mode. |
| New bounded unattended run | `/clean-room:unattended` | Invoke `unattended` | Starts from the same scope gate, then records finite unattended bounds and stop conditions. |
| Continue an interrupted run | `/clean-room:resume` | Invoke `resume` | Reloads `task-manifest.json`, the initialization snapshot, ledgers, `clean-run-context.json`, `qc-report.json`, handoff artifacts, and abstract delta tickets, then continues from the earliest incomplete gate. |
| Restart a bad or obsolete run | `/clean-room:start-over` | Invoke `start-over` | Requires explicit confirmation, archives or quarantines current artifacts without deletion, then returns to the scope gate with a fresh `task_id`. |
| Correct drift without changing scope | `/clean-room:refocus` | Invoke `refocus` | Audits current artifacts against declared scope and routes Agent 0 back to missed gates without expanding scope. |

Before starting, prepare separate paths for source, contaminated artifacts, clean artifacts, optional clean reference docs, and quarantine. The default artifact base is `~/Documents/CleanRoom/<task-id>/`; if no explicitly approved neutral task ID is provided, use `task-` plus 8 lowercase hex characters. For recovery, provide the existing `task-manifest.json` or the artifact roots so the skill can reload durable state. Prior chat history is not task state.

## Quick Start: Onboarding your Codebase

Once the skill package is installed in your runtime, follow these steps to initialize and execute a clean-room specification task.

### Optional: Bootstrap Run Folders
Before invoking the runtime skill, you can create the external output folders and a clean-safe repository stub:

```bash
npx clean-room-skill@latest init
```

The command prints the output folder path to pass into the runtime skill. It does not write `init-config.json`, `task-manifest.json`, or `clean-run-context.json`; those are still created by the runtime initialization workflow.

### Step 1: Initialize Workspace Preferences
In your agent session (e.g., Claude Code), run the initialization subcommand:

```text
/clean-room:init
```

The agent will prompt you for setup choices and write an `init-config.json` file on the contaminated side (defaults to `~/Documents/CleanRoom/<task-id>/`). This file holds:
*   The paths to your **Authorized Source Roots** and **Clean Output Roots**.
*   Your output schema target profile (e.g., `speckit-feature-folder` or `openspec-delta`).
*   Model configurations and `clean_safe` or `contaminated_only` rules.

*Note: For security, `init-config.json` should never be written to or committed within your clean workspace.*

### Step 2: Establish the Scope and Task Manifest
Start the clean-room controller wizard:

```text
/clean-room
```

The agent (Agent 0) will:
1. Re-verify the path separation of your source, contaminated, and clean workspace roots.
2. Capture your authorization details and compile them into `task-manifest.json`.
3. If analyzing a complex scope, guide you to run the local preflight indexer to generate a `source-index.json` under your contaminated artifacts directory.
4. Decompose the workspace files into neutral, logical task units.

### Step 3: Run the Implementation Pipeline
Choose either **Attended** (with explicit manual approval checkpoints) or **Unattended** mode to begin work on the logical units:

```text
/clean-room:attended
/clean-room:unattended
```

*   **Agent 1** analyzes the source files mapped to the active unit and writes neutral draft specs under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
*   **Agent 1.5** sanitizes the drafts, ensuring no private symbols, code snippets, or structure are leaked.
*   **Agent 2** reads sanitized specs plus the clean destination foundation and writes `implementation-plan.json`.
*   **Agent 3** implements the plan under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, records verification status, and writes `implementation-report.json` plus `qc-report.json`.

## Operating Model

Use separate workspaces, worktrees, repositories, or profiles for contaminated and clean work:

- Contaminated source workspace: source-readable, read-only where practical.
- Contaminated artifact workspace: init configs, source indexes, task manifests, coverage ledgers, evidence ledgers, draft specs, and abstract delta tickets. Configure as `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Clean artifact workspace: clean run contexts, approved behavior specs, handoff packages, skeleton manifests, implementation plans, implementation reports, QC reports, and test plans. Configure as `CLEAN_ROOM_CLEAN_ROOTS`.
- Clean implementation workspace: clean destination code and tests. Configure as `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
- Clean allowed reference workspace: public documentation or destination constraints explicitly approved for clean and source-denied role reads.

### Path Naming Guards

Artifact paths must be neutral. Do not name task IDs, clean roots, implementation roots, or contaminated artifact roots after private source folders or private code identifiers.

When no explicitly approved neutral task ID is provided, the controller should generate `task-` plus 8 lowercase hex characters under `~/Documents/CleanRoom/`. The initialization wizard and `require-clean-room-env.py` preflight reject clean, implementation, or contaminated artifact paths that contain source root basenames or meaningful non-generic tokens from those basenames. Guard errors avoid printing the private source name.

Prompt instructions alone are not a boundary. Use path separation, role-specific sessions, hook checks, schema validation, and artifact quarantine.

## Separation Diagram

![Clean Room Architecture](assets/clean-room-arch.svg)

For a detailed breakdown of the flowchart representation, agent responsibilities, environment boundaries, and guardrail scripts, see the [Clean Room Architecture Documentation](docs/ARCHITECTURE.md).

## Roles

- Agent 0 / `contaminated-manager-verifier`: consumes contaminated source indexes, decomposes scope into logical batches, tracks coverage, verifies clean specs and terminal implementation reports against source, and influences Agent 2/3 only through durable sanitized artifacts.
- Agent 1 / `contaminated-source-analyst`: reads authorized source and writes neutral draft task/spec material with evidence references, not code.
- Agent 1.5 / `contaminated-handoff-sanitizer`: reviews Agent 1 drafts from a fresh source-denied contaminated context and approves only sanitized handoff candidates.
- Agent 2 / `clean-architect`: reads clean artifacts and the clean implementation foundation, then writes `implementation-plan.json` with relative destination paths, tests, constraints, risks, and argv-array verification commands.
- Agent 3 / `clean-qa-editor`: implements the clean plan under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, records verification status, maintains `qc-report.json`, and emits one terminal report for Agent 0 only when the assigned plan or task is complete, blocked, or quarantined.

Claude role agents are in `agents/`. Codex role-agent templates are in `examples/codex/.codex/agents/`.

## Required Environment

Set and pass this environment block into every clean-room role session before tool use:

```text
CLEAN_ROOM_ROLE
CLEAN_ROOM_SOURCE_ROOTS
CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS
CLEAN_ROOM_CLEAN_ROOTS
CLEAN_ROOM_IMPLEMENTATION_ROOTS
CLEAN_ROOM_SCHEMA_DIR
CLEAN_ROOM_ALLOWED_READ_ROOTS
```

For clean roles, reads are deny-by-default. They may read only `CLEAN_ROOM_CLEAN_ROOTS`, `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, `CLEAN_ROOM_SCHEMA_DIR`, and explicit public or destination constraint roots in `CLEAN_ROOM_ALLOWED_READ_ROOTS`. Agent 2 and Agent 3 receive `clean-run-context.json`, not the full `task-manifest.json`. Agent 1.5 is also source-denied: it may read only assigned contaminated artifacts, `CLEAN_ROOM_SCHEMA_DIR`, and explicit public or destination constraint roots. Source roots in `CLEAN_ROOM_SOURCE_ROOTS` stay denied.

Agent 0 must not directly steer Agent 2 or Agent 3. Clean roles accept Agent 0 input only as schema-valid durable sanitized artifacts already present in the clean workspace. Direct chat instructions, progress feedback, priority changes, implementation hints, or corrective coaching from Agent 0 are out of bounds. Agent 3 reports back to Agent 0 only at the terminal report gate, never during an active implementation loop.

Writes are also deny-by-default. Agent 2 writes only clean artifacts under `CLEAN_ROOM_CLEAN_ROOTS`. Agent 3 writes reports under `CLEAN_ROOM_CLEAN_ROOTS` and code/tests only under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`. Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Source roots stay read-only for contaminated roles unless a separate, explicit process outside this plugin changes that policy.

The environment preflight also audits root names. `CLEAN_ROOM_CLEAN_ROOTS`, `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, and `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS` must not contain source-derived project basenames or meaningful non-generic source-name tokens.

Optional hook-only guardrail:

```text
CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST
```

Set it to path-separated, line-oriented files containing private source package, module, class, function, method, variable, constant, field, or other internal identifiers to reject from clean artifacts. Blank lines and `#` comments are ignored. Files are bounded to 1,000,000 bytes each, 20,000 total terms, and 512 characters per term. Keep those files outside clean/source-denied readable roots and do not paste their contents into model-visible artifacts.

Do not grant shell-style tools to Agent 0, Agent 1, Agent 1.5, Agent 2, or the default Agent 3 profile. If Agent 3 verification needs a terminal, use an isolated verification home with strict hooks and `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`, then invoke only the installed `agent3-verification-runner.py` from an implementation-root cwd. The runner reads argv-array verification commands from `implementation-plan.json`, applies a small allowlist, strips clean-room root env values, and executes with `shell=False`. Shell access still does not replace OS/profile isolation for untrusted test code.

For multi-file scopes, run `skills/clean-room/scripts/build_source_index.py` as controller preflight before clean-room role sessions. Store `source-index.json` under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`, or pass `--contaminated-artifact-root` explicitly. The script refuses `--output` outside those roots. It is contaminated-only and must not be included in clean handoff packages or shown to Agent 1.5.

`source-index.json` includes bounded `skipped_entries` when the indexer intentionally or unavoidably omits input. Expected reasons include ignored directories, file count and byte caps, total byte caps, binary files, file stat or read errors, symlinks that resolve outside the source root, and directory traversal errors. Treat this list as coverage metadata: inspect it before deciding that a source index fully represents the authorized root.

Optional AST/indexing helpers are checked before the controller loop, not from clean-room role sessions:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --status
```

`--status` is stat-only by default. Use `--probe-tools` only when you want it to execute version commands for explicitly configured, cache-local, skill-local, system-path, or explicitly allowed project tools:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --status --probe-tools
```

Tools discovered under `/opt/homebrew` or `/usr/local` remain stat-only during `--probe-tools` unless you also pass `--allow-user-toolchain-probes`.

Local helper installs are explicit and strict SemVer version-pinned, and they write to `~/.cache/re-skills/clean-room-tools/`:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --install-local ast-grep --version <exact-version>
```

Target-project `.local/bin`, `.bin`, and `node_modules/.bin` are ignored unless the controller opts into `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1`. Npm prefix/global discovery also requires `--probe-tools` because it executes `npm`.

## Controller Modes

Missing `controller_policy` means `attended`.

- `attended`: agent zero pauses for human review at scope gate, clean handoff, terminal implementation deltas, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop. It reloads durable artifacts each iteration, selects at most one pending or gap unit, starts each role from fresh context with the required environment block, validates before advancing state, and stops on any configured safety or ambiguity condition.

`task-manifest.json` may include `run_state` with the generation, start timestamp, previous generation reference, and restart reason. It may also include `initialization_snapshot`, which is the per-run copy of `init-config.json` preferences. Use durable artifacts to recover or start over without relying on chat history.

Agent zero generates the durable tasklist as neutral `task-manifest.json` `units`. For larger scopes, it may use `source-index.json` recommended batches and record `source_index_ref` plus per-unit `source_index_refs`. Progress is tracked in `coverage-ledger.json`, `evidence-ledger.json`, terminal `implementation-report.json`, `qc-report.json`, and abstract delta tickets, not in prior chat history or live clean-role feedback.

## Recovery Entry Points

- `resume`: reload durable artifacts, including implementation plan/report when present, validate schema and leakage state, compare reusable init config against the manifest snapshot when present, and continue from the earliest incomplete gate using the recorded `controller_policy`.
- `start-over`: require explicit confirmation, archive or quarantine the current artifact set without deletion, and restart from the scope gate with a fresh `task_id`.
- `refocus`: audit current artifacts against declared scope and steer Agent 0 back to missed gates without expanding scope.

## Artifacts

The schema contract lives in `skills/clean-room/assets/`:

- `task-manifest.schema.json`
- `init-config.schema.json`
- `clean-run-context.schema.json`
- `source-index.schema.json`
- `coverage-ledger.schema.json`
- `evidence-ledger.schema.json`
- `handoff-package.schema.json`
- `behavior-spec.schema.json`
- `skeleton-manifest.schema.json`
- `implementation-plan.schema.json`
- `implementation-report.schema.json`
- `qc-report.schema.json`
- `contamination-incident.schema.json`

Clean-side example artifact shapes are in `skills/clean-room/examples/minimal-spec-package/`. Verification commands in clean plans and reports are argv arrays, not shell strings. Contaminated-side controller examples, including `source-index.json`, are in `skills/clean-room/examples/contaminated-side/`. They are examples only, not outputs from a real source review.

## Workflow

1. Record reusable setup preferences in `init-config.json` when requested, then snapshot effective choices into `task-manifest.json`.
2. Record authorization, scope, prohibited actions, evidence handling, and role root paths in `task-manifest.json`.
3. Record the user's selected target profile, model policy, `run_state`, Agent 0-3 pipeline, and Agent 1.5 sanitizer role in `task-manifest.json`.
4. Create `clean-run-context.json` for Agent 2 and Agent 3. It must record artifact-only coordination and must not contain source roots, contaminated roots, source index refs, or ledger paths.
5. Run source index preflight when the source scope needs relationship-aware batching.
6. Decompose the source scope into bounded, neutral `task-manifest.json` units. One unit may map to one source-index batch or, for large files, one preflight segment.
7. Write contaminated-side draft behavior specs from observed behavior, public contracts, states, errors, invariants, and test scenarios.
8. Sanitize specs through Agent 1.5 using `skills/clean-room/references/LEAKAGE-RULES.md`; Agent 1.5 gets only a neutral brief and assigned draft paths.
9. Move only Agent 1.5-approved structured artifacts and `clean-run-context.json` into the clean workspace through `handoff-package.json`. Do not include `task-manifest.json` or `source-index.json`.
10. Agent 2 writes `implementation-plan.json` from clean specs, clean run context, target constraints, and the clean implementation foundation.
11. Agent 3 implements work items under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`, records verification status, and writes `implementation-report.json` without Agent 0 guidance. Run terminal verification only through the installed Agent 3 verification runner.
12. Produce or update `qc-report.json` with schema status, leakage status, gaps, and testability notes.
13. After Agent 3 reaches complete, blocked, or quarantined, Agent 0 verifies coverage from the contaminated side.
14. Repeat only through updated durable clean artifacts and abstract delta tickets. Do not steer an in-progress Agent 2 or Agent 3 session.

## Hook Guardrails

Agent/tool hook scaffolding lives in `hooks/`. Security enforcement uses installer-generated Codex or Claude hook configs with absolute wrapper paths. Runtime plugin manifests do not declare static package hooks because cwd-relative hook commands are fragile.

The generated hook configs route through `hooks/clean-room-hook.py`. In safe mode, the wrapper exits successfully unless `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present. Safe mode is compatibility-only until enforcement is enabled. In strict mode, it runs the configured checks immediately and fails closed when required role or path configuration is missing. Prefer strict mode for dedicated Codex or Claude clean-room homes.

After install, run a smoke check:

```bash
clean-room-skill doctor --runtime codex --hooks=strict
```

Use `--runtime claude` for Claude Code, and add `--config-dir <path>` when testing an alternate config root.

Expanded matcher coverage applies only to tool events the host runtime actually emits; do not treat matcher names as proof that an unsupported host tool is guarded.

### What Doctor Verifies

`doctor` verifies that Codex or Claude hook config exists, contains four generated clean-room hooks, uses absolute wrapper paths, uses the requested safe or strict mode, and that smoke payloads fail for missing environment, source reads, source writes, shell use, and malformed post-write JSON. It also verifies that safe hooks no-op without clean-room env.

It does not verify every runtime tool event, every matcher name emitted by the host, host-side hook enablement outside the config file, legal clean-room sufficiency, or full JSON Schema conformance. Treat it as an install smoke test, not a complete enforcement proof.

- `clean-room-hook.py`: safe/strict dispatch wrapper for the policy checks below.
- `agent3-verification-runner.py`: runs Agent 3 argv-array verification commands with `shell=False`, a small allowlist, sanitized env, bounded output, timeout, and root traversal checks.
- `require-clean-room-env.py`: fails closed when required role and root environment is missing.
- `deny-clean-room-shell.py`: denies shell-style tools for clean-room role sessions except installed Agent 3 verification-runner invocations explicitly allowed under implementation roots.
- `deny-clean-source-read.py`: denies clean and source-denied role reads from source roots and unapproved paths.
- `deny-contaminated-clean-write.py`: enforces role write roots. Agent 2 writes clean artifacts only, Agent 3 may write clean reports and implementation-root files, and contaminated roles write only under contaminated artifact roots.
- `check-artifact-leakage.py`: scans clean artifacts, plus Agent 1.5 staged contaminated artifacts, for high-risk leakage markers, source-like identifiers, and optional private identifier denylist matches.
- `validate-json-schema.py`: checks JSON syntax and common bundled clean-room schema constraints, including the conditional and bounded fields used by these schemas. Under clean roots, unknown JSON artifacts are rejected unless explicitly allowlisted through `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST`. It is a lightweight guardrail, not a full JSON Schema 2020-12 validator.
- `validate-handoff-package.py`: verifies handoff artifact paths stay under clean roots, do not point into source or contaminated roots, do not include `task-manifest.json` or `source-index.json`, and match declared `sha256` values.

These scripts are guardrail and audit support. They are not a substitute for separate workspaces and role isolation.

For release-quality schema assurance, run a full JSON Schema validator in addition to the bundled lightweight hook.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `python3 is required to install clean-room hooks` | Python missing or not on `PATH` | Install Python 3 or use `--hooks=copy-only` |
| `safe hooks are installed but not enforcing` | Safe mode default | Set `CLEAN_ROOM_HOOK_ENFORCE=1`, set clean-room env vars, or reinstall with `--hooks=strict` in a dedicated profile |
| Hook config write failed after files copied | Partial installer state | Fix the filesystem error, then re-run the same installer command to repair hook registration |
| Install manifest write failed after files copied | Files and hook config may be installed but not tracked | Re-run the same installer command before relying on uninstall tracking |
| Hook reports `could not read` or `could not stat` | Artifact disappeared, permissions changed, or path was replaced during post-write validation | Restore readable artifact state and retry; hooks fail closed without printing private paths |
| `source-index.json` is missing files | Limits, unreadable directories, ignored directories, binary files, or symlinks outside the source root | Inspect `skipped_entries` and adjust limits or permissions if the omissions matter |

## References

- `skills/clean-room/SKILL.md`: main skill instructions.
- `skills/clean-room/references/PROCESS.md`: detailed process.
- `skills/clean-room/references/LEAKAGE-RULES.md`: clean handoff rules.
- `skills/clean-room/references/SPEC-SCHEMA.md`: artifact schema guidance.
- `skills/clean-room/references/TARGET-LANGUAGE-GUIDE.md`: target constraint guidance.

## Dry Run

From the repository root, run a minimal hook smoke test before relying on the workflow:

```bash
export CLEAN_ROOM_ROLE=clean-qa-editor
export CLEAN_ROOM_SOURCE_ROOTS="$PWD/source"
export CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS="$PWD/contaminated-artifacts"
export CLEAN_ROOM_CLEAN_ROOTS="$PWD/skills/clean-room/examples/minimal-spec-package"
export CLEAN_ROOM_IMPLEMENTATION_ROOTS="$PWD/implementation"
export CLEAN_ROOM_ALLOWED_READ_ROOTS=""
export CLEAN_ROOM_SCHEMA_DIR="$PWD/skills/clean-room/assets"

printf '{"tool_input":{"file_path":"%s"}}' "$PWD/skills/clean-room/examples/minimal-spec-package/behavior-spec.json" \
  | python3 hooks/check-artifact-leakage.py

printf '{"tool_input":{"file_path":"%s"}}' "$PWD/skills/clean-room/examples/minimal-spec-package/behavior-spec.json" \
  | python3 hooks/validate-json-schema.py

python3 hooks/clean-room-hook.py --mode safe --check require-clean-room-env.py </dev/null
```

## Local Verification

After changing plugin metadata, hooks, schemas, or skill instructions, run the same local checks used for pull request CI:

```bash
npm run verify
```

Note: The unit test suite (`npm test`) utilizes the native Node.js test runner and requires Node.js >= 22 to execute successfully.

The full JSON Schema validation requires Python `jsonschema` with format extras. On macOS with Homebrew Python, use a repo-local venv:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install "jsonschema[format]>=4.18,<5"
npm run verify
```

Optional, if an external skill-creator `quick_validate` command is installed on your machine:

```bash
quick_validate skills/attended
quick_validate skills/clean-room
quick_validate skills/init
quick_validate skills/refocus
quick_validate skills/resume
quick_validate skills/start-over
quick_validate skills/unattended
```
