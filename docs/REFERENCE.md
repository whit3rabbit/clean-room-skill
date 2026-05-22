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

## Runtime Support

Verified:

- Codex
- Claude Code

Layout-only or experimental:

- Antigravity
- Gemini CLI
- OpenCode
- Kilo
- Cursor
- GitHub Copilot
- Windsurf
- Augment
- Trae
- Qwen Code
- Hermes Agent
- CodeBuddy

Layout-only installs write files to expected runtime locations, but this repository does not verify that those hosts load the files or emit all hook events needed for clean-room enforcement.

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

## Hook Modes And Doctor

Hook modes:

- `safe`: default. Copies hooks and registers a wrapper that no-ops until role sessions provide clean-room environment variables. `CLEAN_ROOM_HOOK_ENFORCE=1` remains available for explicit smoke tests.
- `strict`: fail-closed mode for dedicated Codex or Claude clean-room homes.
- `copy-only`: copies hook files without runtime hook registration.

Smoke test generated hook registration:

```bash
clean-room-skill doctor --runtime codex --hooks=safe
clean-room-skill doctor --runtime codex --hooks=strict
clean-room-skill doctor --runtime codex --hooks=strict --coverage
```

Use `--runtime claude` for Claude Code, and add `--config-dir <path>` when testing an alternate config root.

`doctor` checks that Codex or Claude hook config exists, contains generated clean-room hooks, uses absolute wrapper paths, uses the requested safe or strict mode, and that smoke payloads fail for missing environment, source reads, source writes, shell use, and malformed post-write JSON. Safe mode also verifies no-op behavior without clean-room env.

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
  --agent-commands ./agent-commands.json \
  --max-iterations 3
```

Options:

| Option | Description |
| --- | --- |
| `--task-manifest <path>` | Required path to `task-manifest.json`. |
| `--agent-commands <path>` | Required role command adapter JSON unless `--dry-run` is set. |
| `--max-iterations <n>` | May only lower the manifest and `loop_context` cap. |
| `--once` | Run at most one inner-loop iteration. |
| `--dry-run` | Validate and print the selected unit without writing or spawning agents. |
| `--schema-dir <path>` | Override bundled schema directory. |
| `--python <path>` | Python executable for validation hooks; default is `python3`. |

The task manifest must already include preflight references, the required handoff sequence, unattended controller policy, finite iteration bounds, and `loop_context.approved_scope_refs`.

Minimal agent command adapter shape:

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

Supported phases are `contaminated-analysis`, `sanitize-handoff`, `clean-plan`, `clean-implement-qc`, and `contaminated-coverage-verify`. The coverage verification phase is required.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `python3 is required to install clean-room hooks` | Python missing or not on `PATH` | Install Python 3 or use `--hooks=copy-only`. |
| `safe hooks are installed; clean-room init/onboarding must set role environment variables` | Safe mode default | Start the clean-room init/onboarding flow, or use strict hooks in a dedicated profile. |
| `install lock is held` | Another install or uninstall is mutating the same target root | Wait for the other process to finish; stale locks are handled conservatively. |
| Hook config write failed after files copied | Partial installer state | Fix the filesystem error, then re-run the same installer command. |
| Install manifest remains `installing` | The previous install did not complete | Re-run the same installer command for that runtime and target root. |
| `clean-room run` rejects the manifest | Invalid or incomplete unattended loop metadata | Fix `controller_policy`, `loop_context`, and `approved_scope_refs`, then retry `--dry-run`. |
| `clean-room run` reports no progress | Configured stages exited without durable artifact changes | Check role command cwd/argv, selected unit, and artifact write roots. |
| `clean-room run` reports repeated unit selection | Same unit selected after a no-progress iteration | Resolve the blocker or update durable artifacts before retrying. |
| Hook reports `could not read` or `could not stat` | Artifact disappeared, permissions changed, or path was replaced during validation | Restore readable artifact state and retry. |
| `source-index.json` is missing files | Limits, unreadable directories, ignored directories, binary files, changed files, or outside-root symlinks | Inspect `skipped_entries` and adjust limits or permissions if omissions matter. |

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
