# Clean Room Reference

This is the compact reference for CLI flags, runtime install details, hook smoke tests, troubleshooting, and local verification. The architecture and role boundary model live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Installer

Usage:

```bash
npx clean-room-skill@latest [runtime] [scope] [options]
```

Interactive mode prompts for install, uninstall, status, or update; global or local scope; runtime selection; and hook mode.

Runtime flags:

| Flag | Runtime |
| --- | --- |
| `--codex` | Codex |
| `--claude` | Claude Code |
| `--antigravity` | Antigravity |
| `--gemini` | Gemini CLI |
| `--opencode` | OpenCode |
| `--kilo` | Kilo |
| `--cursor` | Cursor |
| `--copilot` | GitHub Copilot |
| `--windsurf` | Windsurf |
| `--augment` | Augment |
| `--trae` | Trae |
| `--qwen` | Qwen Code |
| `--hermes` | Hermes Agent |
| `--codebuddy` | CodeBuddy |
| `--all` | All known runtime layouts |

Scope and options:

| Option | Description |
| --- | --- |
| `--global` | Install to the runtime user config. |
| `--local` | Install to the current project config. |
| `--hooks=<mode>` | `safe`, `strict`, or `copy-only`; default is `safe`. |
| `--no-hooks` | Alias for `--hooks=copy-only`. |
| `--config-dir <path>` | Override the target root for one runtime. |
| `--dry-run` | Print planned actions without writing files. |
| `--yes` | Non-interactive mode; unknown conflicts still abort. |
| `--uninstall` | Remove manifest-managed files and clean-room hook entries. |

Useful commands:

```bash
npx clean-room-skill@latest --dry-run --all --global
npx clean-room-skill@latest --codex --global --uninstall --yes
npx clean-room-skill@latest status --codex --global
npx clean-room-skill@latest update --codex --global --yes
```

The installer serializes install and uninstall per target root with `.clean-room-install.lock`. Reinstalling replaces only manifest-managed files automatically. Unknown existing files are not overwritten in non-interactive mode.

Claude global installs call the Claude CLI for plugin marketplace and plugin operations. To use a silo wrapper or non-standard Claude executable, set `CLEAN_ROOM_CLAUDE_EXECUTABLE=/absolute/path/to/wrapper`. The path must be absolute, executable, outside the current working directory, and outside `node_modules/.bin`. When the variable is unset, the installer searches a sanitized `PATH` and fails closed if more than one `claude` executable remains.

## Runtime Support

Verified:

- Codex
- Claude Code
- OpenCode

Layout-only or experimental:

- Antigravity
- Gemini CLI
- Kilo
- Cursor
- GitHub Copilot
- Windsurf
- Augment
- Trae
- Qwen Code
- Hermes Agent
- CodeBuddy

Layout-only installs write files to expected runtime locations, but this repository does not verify that those hosts load the files or emit all hook events needed for clean-room enforcement. OpenCode installs are verified through a generated local plugin bridge at `plugins/clean-room.ts`; `doctor` verifies that bridge and the Python guardrails, not every OpenCode tool surface.

### Pi Package Compatibility

Pi can install this package and load the bundled skills from the package metadata:

```bash
pi install npm:clean-room-skill@latest
pi install https://github.com/whit3rabbit/clean-room-skill
```

Pi invokes skills as `/skill:<name>`. Use `/skill:init` for the setup pass, `/skill:clean-room` for the startup wizard, `/skill:attended` for attended controller mode, and `/skill:unattended` for bounded unattended mode. Pi support is package compatibility only: it does not add a `--pi` installer target, does not participate in `--all`, and does not register clean-room hooks. Clean-room safety still depends on role separation, path isolation, schema validation, and supported hook runtimes.

Global install roots:

| Runtime | Global root |
| --- | --- |
| Codex | `CODEX_HOME` or `~/.codex` |
| Claude Code | `CLAUDE_CONFIG_DIR` or `~/.claude` |
| Antigravity | `ANTIGRAVITY_PLUGIN_DIR`, `ANTIGRAVITY_CLI_PLUGIN_DIR`, `ANTIGRAVITY_CONFIG_DIR/plugins/clean-room`, or `~/.gemini/antigravity-cli/plugins/clean-room` |
| Gemini CLI | `GEMINI_CONFIG_DIR` or `~/.gemini` |
| OpenCode | `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` |
| Kilo | `KILO_CONFIG_DIR`, `KILO_CONFIG`, `XDG_CONFIG_HOME/kilo`, or `~/.config/kilo` |
| Cursor | `CURSOR_CONFIG_DIR` or `~/.cursor` |
| GitHub Copilot | `COPILOT_CONFIG_DIR` or `~/.copilot` |
| Windsurf | `WINDSURF_CONFIG_DIR` or `~/.codeium/windsurf` |
| Augment | `AUGMENT_CONFIG_DIR` or `~/.augment` |
| Trae | `TRAE_CONFIG_DIR` or `~/.trae` |
| Qwen Code | `QWEN_CONFIG_DIR` or `~/.qwen` |
| Hermes Agent | `HERMES_HOME` or `~/.hermes` |
| CodeBuddy | `CODEBUDDY_CONFIG_DIR` or `~/.codebuddy` |

Local installs use each runtime's project config directory. Antigravity local installs write `.agents/plugins/clean-room/`.

## Agent Metadata Compatibility

Runtime agent metadata is intentionally runtime-specific. Claude Code Markdown agents support documented `model`, `effort`, `color`, and optional `memory` frontmatter. Clean-room role agents use `model`, `effort`, and `color` only. They do not use persistent `memory`, because clean-room state must come from durable artifacts, role-session briefs, and fresh role sessions rather than runtime recall.

Codex TOML agents support documented session config fields such as `model`, `model_reasoning_effort`, `developer_instructions`, `sandbox_mode`, `mcp_servers`, and `skills.config`. Do not copy Claude aliases such as `sonnet` or `opus`, Claude `color`, or Claude `memory` fields into Codex TOML templates.

Codex hooks support `updatedInput`, but clean-room hook enforcement should stay fail-closed through exit status and explicit deny decisions. Do not rewrite clean-room tool calls in hooks; command mutation makes boundary behavior harder to review and test.

## Hook Modes And Doctor

Hook modes:

- `safe`: default. Copies hooks and registers a wrapper that no-ops until role sessions provide clean-room environment variables. `CLEAN_ROOM_HOOK_ENFORCE=1` remains available for explicit smoke tests.
- `strict`: fail-closed mode for dedicated Codex, Claude, or OpenCode clean-room homes.
- `copy-only`: copies hook files without runtime hook registration.

Smoke test generated hook registration:

```bash
clean-room-skill doctor --runtime codex --hooks=safe
clean-room-skill doctor --runtime codex --hooks=strict
clean-room-skill doctor --runtime codex --hooks=strict --coverage
clean-room-skill doctor --runtime opencode --hooks=strict --coverage
```

Use `--runtime claude` for Claude Code, and add `--config-dir <path>` when testing an alternate config root.

`doctor` checks that Codex or Claude hook config exists, or that the OpenCode local plugin exists. It verifies generated clean-room hooks or plugin wiring, absolute wrapper paths, the requested safe or strict mode, and smoke payload failures for missing environment, source reads, source writes, shell use, and malformed post-write JSON. Safe mode also verifies no-op behavior without clean-room env.

It does not prove legal sufficiency, full runtime hook event coverage, host-side feature enablement, or full JSON Schema conformance.

## Bootstrap CLI

`clean-room-skill init` prepares neutral external folders and a clean-safe repository stub. It does not install hooks and does not create active workflow artifacts.

Usage:

```bash
npx clean-room-skill@latest init
npx clean-room-skill@latest init --target-dir . --target-profile speckit-feature-folder
npx clean-room-skill@latest init --artifact-base ~/Documents/CleanRoom --task-id task-1234abcd
```

Options:

| Option | Description |
| --- | --- |
| `--target-dir <path>` | Repository to initialize; default is current directory. |
| `--artifact-base <path>` | External CleanRoom base; default is `~/Documents/CleanRoom`. |
| `--task-id <id>` | Neutral task id; default is generated `task-xxxxxxxx`. |
| `--target-profile <name>` | `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`. |
| `--dry-run` | Print actions without writing files. |
| `--force` | Overwrite existing bootstrap metadata and repo stub. |

By default, `init` creates:

- `contaminated/`
- `clean/`
- `implementation/`
- `quarantine/`
- `clean-room-bootstrap.json`
- `.clean-room/README.md` in the target repository

Do not commit source roots, contaminated artifact paths, private identifiers, source-derived names, `preflight-goal.json`, `init-config.json`, `task-manifest.json`, `controller-status.json`, `role-session-brief.json`, or `clean-run-context.json` into the clean implementation repository.

## Preflight CLI

`clean-room-skill preflight` creates or validates the Stage 0 goal contract.

Usage:

```bash
npx clean-room-skill@latest preflight --template --output ~/Documents/CleanRoom/task-1234abcd/contaminated/preflight-goal.json
npx clean-room-skill@latest preflight --input ./preflight-goal.json --output ~/Documents/CleanRoom/task-1234abcd/contaminated/preflight-goal.json
npx clean-room-skill@latest preflight --template --bootstrap ~/Documents/CleanRoom/task-1234abcd
```

Options:

| Option | Description |
| --- | --- |
| `--template` | Write an attended draft with blocking open questions. |
| `--input <path>` | Validate and normalize/copy a completed preflight goal. |
| `--output <path>` | Destination `preflight-goal.json`. |
| `--bootstrap <path>` | Generated task root or `clean-room-bootstrap.json`; writes to the generated contaminated artifact root after scaffold validation and requires completed input roots to match the bootstrap. |
| `--mode <mode>` | `attended` or `unattended`; template supports attended only. |
| `--dry-run` | Print actions without writing files. |
| `--force` | Overwrite output if it already exists. |

Unattended runs must use a completed input contract with `unattended_allowed_after_preflight: true`, finite `max_iterations`, and no `open_questions`.

## Inner Loop Runner

`clean-room-skill run` executes the bounded inner clean-room loop for one approved spec slice. It is not the outer spec-development loop.

Usage:

```bash
npx clean-room-skill@latest run \
  --task-manifest ~/Documents/CleanRoom/task-1234abcd/contaminated/task-manifest.json \
  --agent-runtime claude \
  --max-iterations 3
```

Options:

| Option | Description |
| --- | --- |
| `--task-manifest <path>` | Required path to `task-manifest.json`. |
| `--agent-commands <path>` | Role command adapter JSON unless `--agent-runtime` or `--dry-run` is set. |
| `--agent-runtime claude` | Use the built-in Claude Code adapter to launch plugin role agents. Mutually exclusive with `--agent-commands`. |
| `--agent-config-dir <path>` | Claude config directory for `--agent-runtime claude`; defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `--max-iterations <n>` | May only lower the manifest and `loop_context` cap. |
| `--once` | Run at most one inner-loop iteration. |
| `--dry-run` | Validate and print the selected unit without writing or spawning agents. |
| `--schema-dir <path>` | Override bundled schema directory. |
| `--python <path>` | Python executable for validation hooks; default is `python3`. |

The task manifest must already include preflight references, the required handoff sequence, unattended controller policy, finite iteration bounds, `loop_context.foundation_unit_ref`, and `loop_context.approved_scope_refs`.

Unattended code-development manifests must include exactly one `unit_kind: "foundation"` unit. The runner rejects non-foundation approved slices until that unit is covered.

`coverage-ledger.json` may record contaminated-only `source_units[].discovery_leads` for authorized related surfaces that were detected but not analyzed in the assigned unit. The runner rejects a `covered` unit while any high-priority discovery lead remains open or deferred. It does not add follow-up units or expand `loop_context.approved_scope_refs`; Agent 0 must return an abstract delta, mark coverage partial or blocked, or pause for attended approval.

Completion is valid only when canonical durable artifacts prove the gate. A completed behavior unit or `spec-slice-complete` result must have a matching clean behavior spec, implementation-plan work item mapping, terminal implementation report, passed QC report, valid contaminated evidence refs, and required public-surface mappings across the behavior spec, coverage ledger, implementation plan, and terminal report. Manual summaries or synthetic result files are not completion evidence.

Minimal agent command adapter shape for advisory or disabled context management:

```json
{
  "version": 1,
  "stages": [
    {
      "phase": "contaminated-analysis",
      "role": "contaminated-source-analyst",
      "cwd": "/absolute/contaminated/workspace",
      "argv": ["agent-cli", "--fresh-session", "--role", "source-analyst"],
      "timeout_ms": 600000
    },
    {
      "phase": "contaminated-coverage-verify",
      "role": "contaminated-manager-verifier",
      "cwd": "/absolute/contaminated/workspace",
      "argv": ["agent-cli", "--fresh-session", "--role", "manager"]
    }
  ]
}
```

Supported phases are `contaminated-manager-prepare`, `contaminated-analysis`, `sanitize-handoff`, `clean-plan`, `clean-implement-qc`, optional `clean-polish-review`, and `contaminated-coverage-verify`. The coverage verification phase is required. The built-in Claude adapter includes `contaminated-manager-prepare` so Agent 0 can prepare controller state before downstream role agents run. When present, `clean-polish-review` must run after `clean-implement-qc` and before `contaminated-coverage-verify`.

When `task-manifest.json` sets `context_management.mode` to `role-session-briefs` and `context_management.enforcement` to `strict`, every configured worker stage after `contaminated-manager-prepare` must include `context.fresh_session: true` and `context.brief_path`. The runner validates the brief before spawn, passes only the brief path plus environment facts in the stage prompt, and records the brief ref/hash in `controller-run-ledger.json`.

Strict context-management adapter example:

```json
{
  "version": 1,
  "stages": [
    {
      "phase": "contaminated-analysis",
      "role": "contaminated-source-analyst",
      "cwd": "/tmp/clean-room/task-1234abcd/contaminated",
      "argv": ["agent-cli", "--fresh-session", "--role", "source-analyst"],
      "timeout_ms": 600000,
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/contaminated/session-briefs/iter-001-agent-1.json"
      }
    },
    {
      "phase": "sanitize-handoff",
      "role": "contaminated-handoff-sanitizer",
      "cwd": "/tmp/clean-room/task-1234abcd/contaminated",
      "argv": ["agent-cli", "--fresh-session", "--role", "handoff-sanitizer"],
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/contaminated/session-briefs/iter-001-agent-1-5.json"
      }
    },
    {
      "phase": "clean-plan",
      "role": "clean-architect",
      "cwd": "/tmp/clean-room/task-1234abcd/clean",
      "argv": ["agent-cli", "--fresh-session", "--role", "clean-architect"],
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/clean/session-briefs/iter-001-agent-2.json"
      }
    },
    {
      "phase": "clean-implement-qc",
      "role": "clean-qa-editor",
      "cwd": "/tmp/clean-room/task-1234abcd/implementation",
      "argv": ["agent-cli", "--fresh-session", "--role", "clean-qa-editor"],
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/clean/session-briefs/iter-001-agent-3.json"
      }
    },
    {
      "phase": "clean-polish-review",
      "role": "clean-polish-reviewer",
      "cwd": "/tmp/clean-room/task-1234abcd/implementation",
      "argv": ["agent-cli", "--fresh-session", "--role", "clean-polish-reviewer"],
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/clean/session-briefs/iter-001-agent-4.json"
      }
    },
    {
      "phase": "contaminated-coverage-verify",
      "role": "contaminated-manager-verifier",
      "cwd": "/tmp/clean-room/task-1234abcd/contaminated",
      "argv": ["agent-cli", "--fresh-session", "--role", "manager-verifier"],
      "context": {
        "fresh_session": true,
        "brief_path": "/tmp/clean-room/task-1234abcd/contaminated/session-briefs/iter-001-agent-0-verify.json"
      }
    }
  ]
}
```

Relative `context.brief_path` values resolve relative to the `agent-commands.json` directory. Contaminated phases must point to briefs under the contaminated artifact root. Clean phases must point to briefs under the clean artifact root. A clean-stage brief may reference allowed clean artifacts, implementation artifacts, and approved public references, but not source indexes, visual indexes, raw screenshots, contaminated ledgers, full manifests, controller status, or prior chat state.

The runner exports `CLEAN_ROOM_SESSION_BRIEF_PATH`, `CLEAN_ROOM_ROLE_SESSION_ID`, and `CLEAN_ROOM_FRESH_CONTEXT_REQUIRED=1` for strict stages. The adapter still owns the actual fresh-context behavior: it must open a new model session, profile, or thread for that stage. Setting `fresh_session` while reusing one long chat is not a clean-room boundary.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `python3 is required to install clean-room hooks` | Python missing or not on `PATH` | Install Python 3 or use `--hooks=copy-only`. |
| `safe hooks are installed; clean-room init/onboarding must set role environment variables` | Safe mode default | Start the clean-room init/onboarding flow, or use strict hooks in a dedicated profile. |
| `install lock is held` | Another install or uninstall is mutating the same target root | Wait for the other process to finish; stale locks are handled conservatively. |
| Hook config write failed after files copied | Partial installer state | Fix the filesystem error, then re-run the same installer command. |
| Install manifest remains `installing` | The previous install did not complete | Re-run the same installer command for that runtime and target root. |
| `clean-room run` rejects the manifest | Invalid or incomplete unattended loop metadata | Fix `controller_policy`, `loop_context.foundation_unit_ref`, and `approved_scope_refs`, then retry `--dry-run`. |
| `clean-room run` rejects a covered unit with `discovery_leads` | A high-priority contaminated discovery lead is still unresolved | Analyze the lead in an authorized follow-up unit, mark it resolved, or keep coverage partial/blocked and return an abstract delta. |
| `clean-room run` rejects an agent command stage in strict context mode | The stage is missing `context.fresh_session: true`, missing `context.brief_path`, or points the brief outside the allowed artifact root | Fix the stage context and regenerate the role-session brief for the selected unit. |
| `clean-room run` reports no progress | Configured stages exited without durable artifact changes | Check role command cwd/argv, selected unit, and artifact write roots. |
| `clean-room run` reports repeated unit selection | Same unit selected after a no-progress iteration | Resolve the blocker or update durable artifacts before retrying. |
| Hook reports `could not read` or `could not stat` | Artifact disappeared, permissions changed, or path was replaced during validation | Restore readable artifact state and retry. |
| `source-index.json` is missing files | Limits, unreadable directories, ignored directories, binary files, changed files, or outside-root symlinks | Inspect `skipped_entries` and adjust limits or permissions if omissions matter. |
| `visual-index.json` is missing screenshots | Limits, unsupported formats, unreadable directories, changed files, invalid image headers, or outside-root symlinks | Inspect `skipped_entries`, keep visual roots in the contaminated/source domain, and rerun `build_visual_index.py` only as fallback evidence preflight. |

## Local Verification

Install dependencies:

```bash
npm ci --ignore-scripts
```

Run all Node tests:

```bash
npm test
```

Run installer tests only:

```bash
npm run test:install
```

Run full local checks:

```bash
npm run verify
```

JS changes:

```bash
node --check bin/install.js
npm test
```

Runner changes:

```bash
node --check lib/run.cjs bin/install.js
node --test tests/run.test.js
npm test
```

Installer/runtime layout changes:

```bash
npm run test:install
npm run verify
```

Python hook or script changes:

```bash
python3 -m py_compile hooks/*.py skills/clean-room/scripts/*.py skills/clean-room/scripts/source_index/*.py
```

Schema or example changes:

```bash
.venv/bin/python tests/validate_jsonschema.py
```

If `.venv` does not exist, use a Python environment with `jsonschema[format]>=4.18,<5`.

Package or release-facing changes:

```bash
npm pack --dry-run
```

Documentation-only changes usually need review plus link/path checks, not the full test suite.
