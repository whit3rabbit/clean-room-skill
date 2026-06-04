# Clean Room Hooks

This page documents the hook guardrails installed by `clean-room-skill`: where they are installed, which runtime hook entries are generated, and what each hook script checks.

The hooks are engineering guardrails. They reduce accidental cross-domain reads and writes, but they are not legal advice, a sandbox boundary, or proof that a host runtime emits every event needed for enforcement.

## Install Locations

The installer copies the Python hook files for every supported runtime layout. Runtime hook registration is verified for Codex, Claude Code, and OpenCode.

| Runtime | Hook files copied to | Active hook config |
| --- | --- | --- |
| Codex | `<targetRoot>/hooks/clean-room/*.py` | `<targetRoot>/hooks.json` |
| Claude Code | `<targetRoot>/hooks/clean-room/*.py` | `<targetRoot>/settings.json` |
| Antigravity | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Gemini CLI | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| OpenCode | `<targetRoot>/hooks/clean-room/*.py` | `<targetRoot>/plugins/clean-room.ts` |
| Pi | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Kilo | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Cursor | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| GitHub Copilot | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Windsurf | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Augment | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Trae | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Qwen Code | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| Hermes Agent | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |
| CodeBuddy | `<targetRoot>/hooks/clean-room/*.py` | Unsupported, copy only |

Codex uses `CODEX_HOME` or `~/.codex` for global installs. Claude Code uses `CLAUDE_CONFIG_DIR` or `~/.claude`. Other runtime roots are listed in [REFERENCE.md](REFERENCE.md#runtime-support).

## Hook Modes

| Mode | Behavior |
| --- | --- |
| `safe` | Default. Registers hooks for Codex, Claude, or OpenCode, but `clean-room-hook.py` no-ops until a clean-room role environment is present or `CLEAN_ROOM_HOOK_ENFORCE` is truthy. |
| `strict` | Registers hooks for Codex, Claude, or OpenCode and fails closed even without clean-room role environment. Use only in dedicated clean-room runtime homes. |
| `copy-only` | Copies hook files without modifying runtime hook config. This is also the effective behavior for runtimes without verified hook registration support. |

`--no-hooks` is an alias for `--hooks=copy-only`.

## Generated Runtime Hooks

When hook mode is `safe` or `strict`, the installer registers four managed hook entries for Codex and Claude. Each entry invokes the installed `clean-room-hook.py` wrapper with an absolute Python path, an absolute wrapper path, the requested hook mode, and one or more `--check` scripts.

For OpenCode, the installer writes a generated local plugin at `<targetRoot>/plugins/clean-room.ts`. OpenCode auto-loads that plugin from its config directory. The plugin subscribes to `tool.execute.before` and `tool.execute.after`, translates OpenCode tool payloads into the existing clean-room hook payload shape, and invokes the installed Python wrapper with `shell: false`. `copy-only` omits this plugin.

| Event | Matcher | Checks |
| --- | --- | --- |
| `PreToolUse` | <code>Bash&#124;Shell&#124;PowerShell&#124;Monitor&#124;exec_command&#124;shell_command&#124;write_stdin</code> | `require-clean-room-env.py`, `deny-clean-room-shell.py` |
| `PreToolUse` | <code>Read&#124;Glob&#124;Grep&#124;LS&#124;LSP&#124;NotebookRead&#124;view_image&#124;list_dir&#124;ListMcpResourcesTool&#124;ReadMcpResourceTool&#124;ListMcpResourceTemplatesTool&#124;list_mcp_resources&#124;list_mcp_resource_templates&#124;read_mcp_resource</code> | `require-clean-room-env.py`, `deny-clean-source-read.py` |
| `PreToolUse` | <code>Write&#124;Edit&#124;MultiEdit&#124;NotebookEdit&#124;apply_patch</code> | `require-clean-room-env.py`, `deny-contaminated-clean-write.py` |
| `PostToolUse` | <code>Write&#124;Edit&#124;MultiEdit&#124;NotebookEdit&#124;apply_patch</code> | `require-clean-room-env.py`, `check-artifact-leakage.py`, `validate-json-schema.py`, `validate-handoff-package.py` |

Matcher names only matter if the host runtime emits the corresponding hook event. A host tool that reads files without a hook event is not protected by listing its name here.

## Required Environment

Role sessions must provide the full clean-room environment block so the hooks can validate boundaries:

| Variable | Use |
| --- | --- |
| `CLEAN_ROOM_ROLE` | Active role. Valid roles are `contaminated-manager-verifier`, `contaminated-source-analyst`, `contaminated-handoff-sanitizer`, `clean-architect`, and `clean-qa-editor`. |
| `CLEAN_ROOM_SOURCE_ROOTS` | Authorized source roots. Clean and source-denied roles must not read these. |
| `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS` | Write roots for contaminated roles. |
| `CLEAN_ROOM_CLEAN_ROOTS` | Write roots for clean artifacts and reports. |
| `CLEAN_ROOM_IMPLEMENTATION_ROOTS` | Write roots for Agent 3 implementation code and tests. |
| `CLEAN_ROOM_ALLOWED_READ_ROOTS` | Approved clean-safe reference roots for clean and source-denied roles. |
| `CLEAN_ROOM_SCHEMA_DIR` | JSON schema directory. Must exist. |
| `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` | Optional path-separated denylist files for leakage scanning. |
| `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST` | Optional path-separated allowlist for unrecognized auxiliary JSON files under clean roots. |
| `CLEAN_ROOM_ALLOW_AGENT3_SHELL` | Must be `1` before Agent 3 can invoke the verification runner through a shell-style tool. |
| `CLEAN_ROOM_ALLOW_AGENT4_SHELL` | Must be `1` before Agent 4 can invoke the polish runner through a shell-style tool. |
| `CLEAN_ROOM_HOOK_ENFORCE` | Forces enforcement in `safe` mode when truthy. |
| `CLEAN_ROOM_HOOK_CHECK_TIMEOUT_SECONDS` | Optional per-check wrapper timeout. Defaults to 10 seconds. |

Root variables may contain multiple paths separated by the platform path separator.

## Hook Scripts

### `clean-room-hook.py`

Dispatch wrapper used by generated runtime hook entries.

- Enforces immediately in `strict` mode.
- In `safe` mode, enforces only when `CLEAN_ROOM_HOOK_ENFORCE` is truthy or clean-room environment variables are present.
- Reads the hook payload once from stdin and passes the same payload to each configured check.
- Runs child checks with `sys.executable -I`, `PYTHONNOUSERSITE=1`, and `PYTHONDONTWRITEBYTECODE=1`.
- Rejects invalid check names and missing check scripts.
- Fails if any check fails or exceeds `CLEAN_ROOM_HOOK_CHECK_TIMEOUT_SECONDS`.

### `require-clean-room-env.py`

Precondition check for role sessions.

- Requires non-empty role, source, contaminated artifact, clean, implementation, and schema root variables.
- Requires `CLEAN_ROOM_ALLOWED_READ_ROOTS` for clean roles and the source-denied sanitizer role.
- Validates the role name.
- Resolves configured roots and requires `CLEAN_ROOM_SCHEMA_DIR` to exist.
- Rejects overlap between source, clean, implementation, contaminated artifact, allowed-read, and schema roots where overlap would break separation.
- Rejects clean, implementation, and contaminated artifact root names that appear source-derived from the source root basename.

### `deny-clean-room-shell.py`

Pre-tool shell policy.

- Denies shell-style tools for all clean-room roles by default.
- Allows Agent 3 (`clean-qa-editor`) only when `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`.
- Agent 3 shell use must run from an implementation root and must invoke the installed `agent3-verification-runner.py`.
- Rejects shell metacharacters, file URLs, unexpected runner flags, blocked source or contaminated roots, and runner plans outside clean roots.
- Allows runner selectors only through `--command-index <n>` or `--all`, with optional `--plan`, `--timeout`, and `--backend host|docker|podman`.

### `agent3-verification-runner.py`

Bounded verification runner for Agent 3. This is not a host runtime hook entry by itself; it is the only shell target that `deny-clean-room-shell.py` permits for Agent 3.

- Requires `CLEAN_ROOM_ROLE=clean-qa-editor` and `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`.
- Loads verification commands from `implementation-plan.json` in clean roots, or from `--plan`.
- Accepts argv-array commands only and executes with `shell=False`.
- Requires command cwd values to use `CLEAN_ROOM_IMPLEMENTATION_ROOTS[n]`.
- Allows a small command prefix set: npm, pnpm, yarn, bun, deno test commands; pytest directly or through Python; `cargo test`; `go test`; and `zig build test`.
- Rejects shell syntax, blocked root references, file URLs, paths resolving outside the implementation root, and source or contaminated root traversal.
- Runs with a sanitized environment and bounded stdout/stderr output.
- Supports optional Docker or Podman execution with read-only clean/schema/reference mounts, a writable implementation mount, no network by default, dropped capabilities, no-new-privileges, resource limits, and no source or contaminated mounts.

### `deny-clean-source-read.py`

Pre-tool read policy for source-denied roles.

- Applies to `clean-architect`, `clean-qa-editor`, and `contaminated-handoff-sanitizer`.
- Clean roles may read clean roots, implementation roots, allowed-read roots, and schema roots.
- The sanitizer may read contaminated artifact roots, allowed-read roots, and schema roots.
- Denies reads from source roots.
- Denies sanitizer reads from clean roots.
- Denies direct reads of `preflight-goal.json` for source-denied roles.
- Denies sanitizer reads of `source-index.json`.
- Denies MCP resource access because no MCP resource allowlist is configured.
- Fails closed when a path-required read tool has no resolvable path.

### `deny-contaminated-clean-write.py`

Pre-tool write policy for role-specific write roots.

- Applies to contaminated and clean roles.
- Clean roles cannot write source roots or read-only allowed-read roots.
- Agent 2 (`clean-architect`) writes only under clean roots and is denied implementation roots.
- Agent 3 (`clean-qa-editor`) may write under implementation roots and clean roots.
- Contaminated roles cannot write clean, implementation, or source roots.
- Contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- Fails closed for active clean-room roles when write paths cannot be resolved from the hook payload.

### `check-artifact-leakage.py`

Post-write leakage scanner.

- Scans `.json`, `.md`, `.yaml`, `.yml`, and `.txt` artifacts under clean roots.
- Also scans staged sanitizer artifacts under contaminated artifact roots.
- Does not scan contaminated source analyst drafts.
- Caps scanned artifact size at 1,000,000 bytes.
- Detects raw diffs, source code fences, decompiler/source excerpt markers, stack-source lines, package/module identifiers, source-like calls, source-like scoped identifiers, and configured private denylist terms.
- Loads denylist files from `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`, capped at 1,000,000 bytes per file, 20,000 terms total, and 512 characters per term.
- Treats selected JSON fields as unscanned, denylist-only, or light-scan fields to reduce false positives in path-like and metadata fields.
- Allows public names declared in `public_surface` and `public_contracts` records when marked with public/destination/protocol/user-required visibility.

### `validate-json-schema.py`

Post-write JSON artifact validator.

- Parses written `.json` files and validates recognized artifacts against schemas from `CLEAN_ROOM_SCHEMA_DIR`.
- Recognizes canonical clean-room artifact kinds by filename and conservative field heuristics.
- Fails closed for unrecognized JSON objects under clean roots unless the exact path is in `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST`.
- Rejects `source-index`, `init-config`, and `preflight-goal` artifacts under clean roots.
- Implements the lightweight schema keywords used by bundled schemas, including object and array constraints, required fields, enum/const, patterns, `format: date-time`, `$ref`, `allOf`, `anyOf`, `oneOf`, and `if`/`then`/`else`.
- Adds clean-run-context path checks so clean artifact paths stay relative, do not use `~`, do not contain `..`, and do not resolve into source or contaminated roots.
- Requires task manifest handoff stages to match the expected clean-room sequence when validating the task manifest schema.
- Performs semantic completion validation for `task-manifest.json`, `coverage-ledger.json`, and `clean-room-result*.json` post-write payloads.
- Rejects completion claims unless canonical durable artifacts prove the gate: matching clean behavior specs, implementation-plan work item mappings, terminal implementation reports, passed QC reports, valid evidence references, and required public-surface coverage mappings.

### `validate-handoff-package.py`

Post-write handoff integrity validator.

- Runs on written JSON files that look like handoff packages.
- Requires handoff `artifacts` to be an array of object entries with non-empty paths.
- Rejects `source-index.json`, `task-manifest.json`, and `preflight-goal.json` in clean handoff packages.
- Resolves relative artifact paths against clean roots and rejects ambiguous paths across multiple clean roots.
- Rejects artifact paths outside clean roots or inside source or contaminated roots.
- Requires referenced artifacts to exist and have a 64-character `sha256`.
- Hashes referenced files and fails on checksum mismatch.

### `clean_room_paths.py`

Shared helper module imported by the hook scripts.

- Loads and bounds hook JSON payloads at 10 MiB.
- Resolves candidate paths from common tool payload keys.
- Resolves `cwd` safely from payload data or the current process.
- Provides root parsing, path containment, root overlap checks, and active role detection.
- Redacts configured roots and source-derived private path tokens in errors for clean-room roles by default.
- Provides fail-closed written-file checks plus controlled `stat`, byte-read, and text-read helpers.

## Failure Behavior

The hook policy is deny-by-default during active clean-room role sessions.

- Malformed hook payloads fail.
- Oversized hook payloads fail.
- Missing paths for path-required write checks fail.
- Files that disappear, cannot be statted, cannot be read, or cannot be hashed fail with controlled errors.
- Expected filesystem validation failures are reported without Python tracebacks.
- Error output is redacted through root labels such as `source-root[0]`, `clean-root[0]`, and `contaminated-root[0]` for clean-room role contexts by default.

## Verification

Use `doctor` after installing Codex, Claude, or OpenCode hooks:

```bash
clean-room-skill doctor --runtime codex --hooks=safe
clean-room-skill doctor --runtime codex --hooks=strict
clean-room-skill doctor --runtime codex --hooks=strict --coverage
clean-room-skill doctor --runtime claude --hooks=strict --coverage
clean-room-skill doctor --runtime opencode --hooks=strict --coverage
```

Add `--config-dir <path>` when checking a non-default runtime config root.

`doctor` verifies that:

- The hook config or OpenCode local plugin exists.
- Exactly four managed clean-room hook entries are present for Codex and Claude.
- Managed Codex and Claude commands use absolute Python and wrapper paths.
- The OpenCode plugin declares `tool.execute.before`, `tool.execute.after`, an absolute wrapper path, and `shell: false`.
- The requested safe or strict mode is configured.
- Safe mode no-ops without clean-room environment.
- Strict mode and enforced safe mode fail without required environment.
- Smoke payloads fail for source reads, source writes, shell bypasses, and malformed post-write JSON.
- `--coverage` prints matcher and check coverage for generated hook config entries or OpenCode plugin coverage.

`doctor` is a smoke test. It does not prove host event coverage, legal sufficiency, or full runtime isolation. For OpenCode, it verifies the generated plugin bridge and Python guardrail checks, not every OpenCode tool surface.
