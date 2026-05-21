# Clean Room

Spec-first clean-room workflow for software to spec. 

This is a POC based on the ideas presented here: 

https://malus.sh/blog.html

This plugin packages the `clean-room`, `attended`, `unattended`, `resume`, `start-over`, and `refocus` skills, Claude role agents, Codex role-agent templates, JSON schemas, examples, and hook guardrails for separating contaminated source analysis from clean behavioral specification work.

It is an engineering risk-reduction workflow. It is not legal advice and does not create a legal safe harbor.

## Use This For

- Authorized source-to-spec migration planning.
- Clean behavioral specifications for compatibility work.
- Skeleton manifests, QC reports, open questions, and test plans.
- Documented separation between source-reading roles and clean artifact roles.

## Threat Model And Non-Goals

This workflow protects against:

- accidental source expression crossing into clean specs
- clean agents reading contaminated roots
- contaminated agents writing clean artifacts
- clean or contaminated agents writing outside their role artifact roots
- unbounded unattended controller loops

It does not protect against:

- hostile local users
- compromised host tooling
- shared model context outside role isolation
- legal conclusions
- side channels through filenames, timing, or retained chat context

## Install

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

Local installs are available through `--local` using each runtime's project config directory. Antigravity local installs write `.agents/plugins/clean-room/`. Claude local, Gemini, OpenCode, and Kilo receive generated command wrappers; native skill runtimes receive `SKILL.md` directories. Gemini CLI support is legacy/enterprise compatibility because Google is transitioning consumer Gemini CLI users to Antigravity CLI on June 18, 2026. Cline is not included because it has no verified clean-room skill or command layout.

Hook modes:

- `--hooks=safe`: default. Copies hooks and registers a wrapper that no-ops unless `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present.
- `--hooks=copy-only` or `--no-hooks`: copies hook files but does not register Codex or Claude hook config.
- `--hooks=strict`: registers fail-closed hooks for dedicated clean-room homes. Strict mode is supported only for Codex and Claude Code because other runtime hook payloads are not verified. Antigravity receives hook scripts in the plugin directory, but the generated plugin manifest does not enable them until an Antigravity-specific hook payload adapter exists.

Useful maintenance commands:

```bash
npx clean-room-skill@latest --dry-run --all --global
npx clean-room-skill@latest --codex --global --uninstall --yes
```

The installer writes `clean-room-install-manifest.json` into each target root. Reinstalling replaces only manifest-managed files automatically. If a managed file was locally modified, the previous version is backed up under `clean-room-patches/<timestamp>/`. Unknown existing files are not overwritten in non-interactive mode.

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
/clean-room:attended
/clean-room:unattended
/clean-room:resume
/clean-room:start-over
/clean-room:refocus
```

`/clean-room` and `/clean-room:clean-room` start the setup wizard. `/clean-room:attended` starts the same wizard with attended review gates. `/clean-room:unattended` starts it with bounded unattended defaults: one unit per iteration, finite max iterations, and the configured safety stop conditions. `/clean-room:resume`, `/clean-room:start-over`, and `/clean-room:refocus` recover runs from durable artifacts.

In Codex, invoke the `clean-room` plugin or one of its bundled skills explicitly with `@` or the skills UI. Do not rely on Claude-style `/clean-room:...` namespacing in Codex.

## Run Workflow

Use this sequence for normal runs and recovery:

| Situation | Claude command | Codex action | What the skill does |
| --- | --- | --- | --- |
| New run, default review gates | `/clean-room` or `/clean-room:attended` | Invoke `clean-room` or `attended` | Confirms authorization, separated roots, target profile, and starts the scope gate in attended mode. |
| New bounded unattended run | `/clean-room:unattended` | Invoke `unattended` | Starts from the same scope gate, then records finite unattended bounds and stop conditions. |
| Continue an interrupted run | `/clean-room:resume` | Invoke `resume` | Reloads `task-manifest.json`, ledgers, `qc-report.json`, handoff artifacts, and abstract delta tickets, then continues from the earliest incomplete gate. |
| Restart a bad or obsolete run | `/clean-room:start-over` | Invoke `start-over` | Requires explicit confirmation, archives or quarantines current artifacts without deletion, then returns to the scope gate with a fresh `task_id`. |
| Correct drift without changing scope | `/clean-room:refocus` | Invoke `refocus` | Audits current artifacts against declared scope and routes Agent 0 back to missed gates without expanding scope. |

Before starting, prepare separate paths for source, contaminated artifacts, clean artifacts, optional clean reference docs, and quarantine. For recovery, provide the existing `task-manifest.json` or the artifact roots so the skill can reload durable state. Prior chat history is not task state.

## Operating Model

Use separate workspaces, worktrees, repositories, or profiles for contaminated and clean work:

- Contaminated source workspace: source-readable, read-only where practical.
- Contaminated artifact workspace: source indexes, task manifests, coverage ledgers, evidence ledgers, draft specs, and abstract delta tickets. Configure as `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Clean spec workspace: approved behavior specs, handoff packages, skeleton manifests, QC reports, and test plans.
- Clean allowed reference workspace: public documentation or destination constraints explicitly approved for clean-role reads.

Prompt instructions alone are not a boundary. Use path separation, role-specific sessions, hook checks, schema validation, and artifact quarantine.

## Separation Diagram

![Clean Room Architecture](assets/clean-room-arch.svg)

For a detailed breakdown of the flowchart representation, agent responsibilities, environment boundaries, and guardrail scripts, see the [Clean Room Architecture Documentation](docs/ARCHITECTURE.md).

## Roles

- Agent 0 / `contaminated-manager-verifier`: consumes contaminated source indexes, decomposes scope into logical batches, tracks coverage, verifies clean specs against source, and receives Agent 3 final QC reports.
- Agent 1 / `contaminated-source-analyst`: reads authorized source and writes neutral task/spec material with evidence references, not code.
- Agent 2 / `clean-architect`: reads approved clean artifacts, manages the selected clean schema base, and organizes artifacts into target-neutral skeleton manifests.
- Agent 3 / `clean-qa-editor`: validates schema conformance, leakage risk, terminology, coverage gaps, and testability, then reports abstract findings back to Agent 0.

Claude role agents are in `agents/`. Codex role-agent templates are in `examples/codex/.codex/agents/`.

## Required Environment

Set and pass this environment block into every clean-room role session before tool use:

```text
CLEAN_ROOM_ROLE
CLEAN_ROOM_SOURCE_ROOTS
CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS
CLEAN_ROOM_CLEAN_ROOTS
CLEAN_ROOM_SCHEMA_DIR
CLEAN_ROOM_ALLOWED_READ_ROOTS
```

For clean roles, reads are deny-by-default. They may read only `CLEAN_ROOM_CLEAN_ROOTS` plus explicit public or destination constraint roots in `CLEAN_ROOM_ALLOWED_READ_ROOTS`. Source roots in `CLEAN_ROOM_SOURCE_ROOTS` stay denied.

Writes are also deny-by-default. Clean roles may write only under `CLEAN_ROOM_CLEAN_ROOTS`. Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`. Source roots stay read-only for contaminated roles unless a separate, explicit process outside this plugin changes that policy.

Optional hook-only guardrail:

```text
CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST
```

Set it to path-separated, line-oriented files containing private source package, module, class, function, method, variable, constant, field, or other internal identifiers to reject from clean artifacts. Blank lines and `#` comments are ignored. Files are bounded to 1,000,000 bytes each, 20,000 total terms, and 512 characters per term. Keep those files outside clean-role readable roots and do not paste their contents into model-visible artifacts.

Do not grant shell-style tools to clean-room role sessions. Shell access can bypass path-aware read and write hooks.

For multi-file scopes, run `skills/clean-room/scripts/build_source_index.py` as controller preflight before clean-room role sessions. Store `source-index.json` under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`, or pass `--contaminated-artifact-root` explicitly. The script refuses `--output` outside those roots. It is contaminated-only and must not be included in clean handoff packages.

Optional AST/indexing helpers are checked before the controller loop, not from clean-room role sessions:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --status
```

`--status` is stat-only by default. Use `--probe-tools` only when you want it to execute discovered tools with version commands:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --status --probe-tools
```

Local helper installs are explicit and version-pinned, and they write to `~/.cache/re-skills/clean-room-tools/`:

```bash
python3 skills/clean-room/scripts/clean_room_tool_manager.py --install-local ast-grep --version <exact-version>
```

Target-project `.local/bin`, `.bin`, and `node_modules/.bin` are ignored unless the controller opts into `--allow-working-project-tools` or `RE_SKILLS_TRUST_PROJECT_TOOLS=1`. Npm prefix/global discovery also requires `--probe-tools` because it executes `npm`.

## Controller Modes

Missing `controller_policy` means `attended`.

- `attended`: agent zero pauses for human review at scope gate, clean handoff, QC deltas, blocked units, and final coverage.
- `unattended`: agent zero runs a bounded controller loop. It reloads durable artifacts each iteration, selects at most one pending or gap unit, starts each role from fresh context with the required environment block, validates before advancing state, and stops on any configured safety or ambiguity condition.

`task-manifest.json` may include `run_state` with the generation, start timestamp, previous generation reference, and restart reason. Use it to recover or start over from durable artifacts without relying on chat history.

Agent zero generates the durable tasklist as neutral `task-manifest.json` `units`. For larger scopes, it may use `source-index.json` recommended batches and record `source_index_ref` plus per-unit `source_index_refs`. Progress is tracked in `coverage-ledger.json`, `evidence-ledger.json`, `qc-report.json`, and abstract delta tickets, not in prior chat history.

## Recovery Entry Points

- `resume`: reload durable artifacts, validate schema and leakage state, and continue from the earliest incomplete gate using the recorded `controller_policy`.
- `start-over`: require explicit confirmation, archive or quarantine the current artifact set without deletion, and restart from the scope gate with a fresh `task_id`.
- `refocus`: audit current artifacts against declared scope and steer Agent 0 back to missed gates without expanding scope.

## Artifacts

The schema contract lives in `skills/clean-room/assets/`:

- `task-manifest.schema.json`
- `source-index.schema.json`
- `coverage-ledger.schema.json`
- `evidence-ledger.schema.json`
- `handoff-package.schema.json`
- `behavior-spec.schema.json`
- `skeleton-manifest.schema.json`
- `qc-report.schema.json`
- `contamination-incident.schema.json`

Example artifact shapes are in `skills/clean-room/examples/minimal-spec-package/`. They are examples only, not outputs from a real source review.

## Workflow

1. Record authorization, scope, prohibited actions, evidence handling, and role root paths in `task-manifest.json`.
2. Record the user's selected target profile, `run_state`, and Agent 0-3 pipeline in `task-manifest.json`.
3. Run source index preflight when the source scope needs relationship-aware batching.
4. Decompose the source scope into bounded, neutral `task-manifest.json` units. One unit may map to one source-index batch or, for large files, one preflight segment.
5. Write contaminated-side behavior specs from observed behavior, public contracts, states, errors, invariants, and test scenarios.
6. Scrub specs using `skills/clean-room/references/LEAKAGE-RULES.md`.
7. Move only approved structured artifacts into the clean workspace through `handoff-package.json`. Do not include `source-index.json`.
8. Build or merge the clean schema base and `skeleton-manifest.json` from clean specs, target profile, and target constraints.
9. Produce `qc-report.json` with schema status, leakage status, gaps, and testability notes.
10. Verify coverage from the contaminated side and repeat only with abstract delta tickets.
11. Stop at the spec package. Do not implement replacement code in this plugin workflow.

## Hook Guardrails

Hook scaffolding lives in `hooks/` and is declared by `hooks/hooks.json`.

`hooks/hooks.json` routes through `hooks/clean-room-hook.py`. In safe mode, the wrapper exits successfully unless `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present. In strict mode, it runs the configured checks immediately and fails closed when required role or path configuration is missing.

`hooks/hooks.json` uses commands relative to the plugin package root, such as `python3 hooks/clean-room-hook.py --mode safe ...`. Confirm the host executes plugin hooks from that directory during install smoke tests.

- `clean-room-hook.py`: safe/strict dispatch wrapper for the policy checks below.
- `require-clean-room-env.py`: fails closed when required role and root environment is missing.
- `deny-clean-room-shell.py`: denies shell-style tools for clean-room role sessions.
- `deny-clean-source-read.py`: denies clean-role reads from source roots and unapproved paths.
- `deny-contaminated-clean-write.py`: enforces role write roots. Clean roles write only under clean roots; contaminated roles write only under contaminated artifact roots.
- `check-artifact-leakage.py`: scans clean artifacts for high-risk leakage markers, source-like identifiers, and optional private identifier denylist matches.
- `validate-json-schema.py`: checks JSON syntax and common bundled clean-room schema constraints, including the conditional and bounded fields used by these schemas. Under clean roots, unknown JSON artifacts are rejected unless explicitly allowlisted through `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST`. It is a lightweight guardrail, not a full JSON Schema 2020-12 validator.
- `validate-handoff-package.py`: verifies handoff artifact paths stay under clean roots, do not point into source or contaminated roots, do not include `source-index.json`, and match declared `sha256` values.

These scripts are guardrail and audit support. They are not a substitute for separate workspaces and role isolation.

For release-quality schema assurance, run a full JSON Schema validator in addition to the bundled lightweight hook.

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
quick_validate skills/refocus
quick_validate skills/resume
quick_validate skills/start-over
quick_validate skills/unattended
```
