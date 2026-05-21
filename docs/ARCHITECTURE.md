# Clean Room Architecture

This document provides a comprehensive technical overview of the Clean Room workflow for clean specs and clean implementation. The architecture enforces separation of concerns between contaminated source analysis, clean planning, and clean code development.

---

## High-Level Overview

The Clean Room workflow acts as an engineering risk-reduction process by establishing a unidirectional boundary (the "clean-room wall"). It isolates agents with access to source code from agents responsible for producing clean behavioral specifications, implementation plans, and clean destination code.

![Clean Room Architecture](../assets/clean-room-arch.svg)

---

## Operating Model

To maintain compliance and mitigate leakage risks, the workflow utilizes strictly separated workspaces, worktrees, repositories, or profiles for contaminated and clean work:

*   **Contaminated Source Workspace**: Source-readable, read-only where practical. Contains the codebase under analysis.
*   **Contaminated Artifact Workspace**: Holds intermediate outputs like init configs, source indexes, task manifests, coverage ledgers, evidence ledgers, draft specs, and abstract delta tickets. Configure via `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
*   **Clean Artifact Workspace**: Houses sanitized clean run contexts, approved behavioral specifications, handoff packages, skeleton manifests, implementation plans, implementation reports, QC reports, and test plans. Configure via `CLEAN_ROOM_CLEAN_ROOTS`.
*   **Clean Implementation Workspace**: Houses clean destination code and tests. Configure via `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
*   **Clean Allowed Reference Workspace**: Public documentation, specifications, or destination constraints explicitly approved for clean and source-denied role reads. Configure via `CLEAN_ROOM_ALLOWED_READ_ROOTS`.

> [!IMPORTANT]
> Prompt instructions alone do not form a boundary. The system enforces safety using OS-level path separation, role-specific sessions, agent/tool hook checks, JSON schema validation, and strict artifact quarantine.

### Path Naming Guards

Artifact roots must not disclose private source names. New runs default to `~/Documents/CleanRoom/<task-id>/`; when no explicitly approved neutral task ID is provided, the controller generates `task-` plus 8 lowercase hex characters instead of using the source folder name.

The initialization wizard and `require-clean-room-env.py` audit clean, implementation, and contaminated artifact root names. They fail closed when a path contains a source root basename or meaningful non-generic tokens from that basename, while filtering generic terms such as `src`, `app`, `test`, `repo`, and `workspace`.

### Contaminated Preflight Tooling

To assist in logical unit decomposition, the workflow supports an optional preflight indexing stage using `build_source_index.py` and `clean_room_tool_manager.py`.

*   **Execution Boundary**: This tooling runs exclusively in the contaminated domain before clean-room role sessions are initialized.
*   **Tool Trust Policy**: By default, tool discovery operates in `stat-only` mode and does not execute third-party binaries. It queries version strings only when explicitly invoked with `--probe-tools`. Tools discovered under `/opt/homebrew` or `/usr/local` remain stat-only unless `--allow-user-toolchain-probes` is also supplied. Project-local directories (such as `.bin` or `node_modules/.bin`) are ignored unless the environment variable `RE_SKILLS_TRUST_PROJECT_TOOLS=1` or the flag `--allow-working-project-tools` is supplied.

---

## Separation & Flow Diagrams

### Flowchart Representation

The following diagram illustrates how the agents, workspace roots, and guardrails interact across the Clean-Room Wall:

```mermaid
flowchart LR
  subgraph contaminated["Contaminated domain"]
    source["Authorized source roots<br/>CLEAN_ROOM_SOURCE_ROOTS"]
    manager["Agent 0: contaminated-manager-verifier<br/>Scope, decompose, track coverage, verify"]
    analyst["Agent 1: contaminated-source-analyst<br/>Read source, write draft specs"]
    sanitizer["Agent 1.5: contaminated-handoff-sanitizer<br/>Source-denied, scrub identifying material"]
    brief["Neutral sanitizer brief<br/>domain, target profile, unit intent,<br/>public allowlist, blocked categories"]
    ledgers["Contaminated artifacts<br/>CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS<br/>init-config.json<br/>source-index.json<br/>task-manifest.json<br/>coverage-ledger.json<br/>evidence-ledger.json"]
    drafts["Agent 1 draft specs<br/>assigned paths only for Agent 1.5"]
    staged["Sanitized handoff candidates<br/>Agent 1.5-reviewed behavior-spec.json"]
  end

  subgraph wall["Clean-room wall"]
    handoff["Approved handoff only<br/>clean-run-context.json<br/>handoff-package.json<br/>Agent 1.5-passed behavior-spec.json"]
    blocked["Blocked from crossing<br/>source excerpts, raw diffs, copied comments,<br/>private identifiers, source-shaped pseudocode"]
  end

  subgraph clean["Clean domain: source-denied"]
    cleanroots["Clean artifact roots<br/>CLEAN_ROOM_CLEAN_ROOTS"]
    implroots["Clean implementation roots<br/>CLEAN_ROOM_IMPLEMENTATION_ROOTS"]
    publicrefs["Allowed public refs<br/>CLEAN_ROOM_ALLOWED_READ_ROOTS"]
    architect["Agent 2: clean-architect<br/>Plan implementation from clean specs and foundation"]
    qa["Agent 3: clean-qa-editor<br/>Implement, record verification, terminal report"]
    outputs["Clean artifacts<br/>implementation-plan.json<br/>qc-report.json<br/>test plan notes"]
    imploutputs["Implementation outputs<br/>code and tests<br/>implementation-report.json"]
  end

  subgraph guardrails["Guardrails and audit"]
    env["require-clean-room-env.py"]
    denyread["deny-clean-source-read.py"]
    denywrite["deny-contaminated-clean-write.py<br/>write root policy"]
    denyshell["deny-clean-room-shell.py"]
    scan["check-artifact-leakage.py<br/>validate-json-schema.py"]
  end

  source --> manager
  manager --> analyst
  manager --> brief
  manager --> ledgers
  analyst --> ledgers
  analyst --> drafts
  brief --> sanitizer
  drafts --> sanitizer
  sanitizer --> staged
  sanitizer --> ledgers
  staged --> handoff
  handoff --> cleanroots
  cleanroots --> architect
  implroots --> architect
  publicrefs --> architect
  architect --> outputs
  architect --> imploutputs
  outputs --> qa
  implroots --> qa
  qa --> imploutputs
  qa --> outputs
  qa -. terminal report only<br/>abstract delta tickets .-> manager

  blocked -. quarantine do not hand off .-> ledgers
  env -. required for every role session .-> manager
  env -. required for every role session .-> architect
  denyread -. clean and source-denied roles cannot read source roots .-> cleanroots
  denyread -. clean roles may read implementation roots .-> implroots
  denyread -. Agent 1.5 cannot read source roots, clean roots, implementation roots, or source-index.json .-> sanitizer
  denywrite -. contaminated writes only to contaminated artifact roots .-> ledgers
  denywrite -. Agent 2 writes clean artifacts only; Agent 3 writes implementation roots .-> cleanroots
  denywrite -. Agent 3 writes code and tests only here .-> implroots
  denyshell -. no shell-style tools in role sessions .-> manager
  denyshell -. no shell for Agent 2; explicit Agent 3 verification runner only .-> architect
  scan -. post-write checks .-> outputs
  scan -. Agent 1.5 staged-output checks .-> staged

  classDef contaminatedDomain fill:#fff7ed,stroke:#c2410c,color:#111827;
  classDef cleanDomain fill:#ecfeff,stroke:#0e7490,color:#111827;
  classDef wallClass fill:#f8fafc,stroke:#475569,color:#111827;
  classDef guardClass fill:#f0fdf4,stroke:#15803d,color:#111827;
  class source,manager,analyst,sanitizer,brief,ledgers,drafts,staged contaminatedDomain;
  class cleanroots,implroots,publicrefs,architect,qa,outputs,imploutputs cleanDomain;
  class handoff,blocked wallClass;
  class env,denyread,denywrite,denyshell,scan guardClass;
```

---

## Agent Roles

The architecture delegates work across five distinct custom role agents to enforce separation between source reading, independent sanitization, clean planning, and clean implementation.

### [Agent 0: Contaminated Manager Verifier](../agents/contaminated-manager-verifier.md)
*   **Domain**: Contaminated (Source-readable)
*   **Write Target**: Contaminated artifact workspace (`CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`)
*   **Responsibilities**:
    *   Validates authorization bounds, scope, and prohibited actions in `task-manifest.json`.
    *   Decomposes source scope into stable, neutral units that do not mirror private source layout.
    *   Controls execution flow and iteration loop state.
    *   Provides Agent 1.5 only a neutral sanitizer brief containing domain purpose, target profile, unit intent, public compatibility allowlist, and blocked categories.
    *   Produces `clean-run-context.json` for Agent 2 and Agent 3 instead of handing over the full `task-manifest.json`.
    *   Influences Agent 2 and Agent 3 only through durable sanitized artifacts, never direct chat, progress feedback, implementation hints, or priority changes.
    *   Performs final verification of clean specification and implementation coverage against the source scope.
    *   Consumes Agent 3 reports only after Agent 3 reaches a terminal state, then sends only abstract delta tickets into a fresh clean artifact cycle.

### [Agent 1: Contaminated Source Analyst](../agents/contaminated-source-analyst.md)
*   **Domain**: Contaminated (Source-readable, Read-only access to source)
*   **Write Target**: Contaminated artifact workspace (`CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`)
*   **Responsibilities**:
    *   Analyzes the authorized source code within assigned units or batches.
    *   Writes neutral draft behavioral specifications based on observed behavior, public contracts, invariants, state transitions, and errors.
    *   Generates evidence references pointing to contaminated ledgers instead of copying raw source code or comments.
    *   Flags suspected leakage but does not approve its own work for clean handoff.

### [Agent 1.5: Contaminated Handoff Sanitizer](../agents/contaminated-handoff-sanitizer.md)
*   **Domain**: Contaminated (Source-denied, no source or Agent 1 source-reading chat history)
*   **Read Sources**: Neutral sanitizer brief, assigned draft artifacts under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`, schema assets, and explicit public or destination reference roots.
*   **Write Target**: Contaminated artifact workspace (`CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`)
*   **Responsibilities**:
    *   Scrubs identifying information before handoff, including source paths, import/export listings, private identifiers, distinctive strings, copied comments, raw diffs, source excerpts, and source-shaped pseudocode.
    *   Preserves public compatibility names only when recorded with concrete compatibility reasons.
    *   Records `leakage_review.reviewer_role` as `contaminated-handoff-sanitizer`.
    *   Quarantines failed artifacts and returns only abstract regeneration feedback to Agent 0.

### [Agent 2: Clean Architect](../agents/clean-architect.md)
*   **Domain**: Clean (Source-denied, no access to source or contaminated chat histories)
*   **Write Target**: Clean artifact workspace (`CLEAN_ROOM_CLEAN_ROOTS`)
*   **Responsibilities**:
    *   Starts from the clean artifact workspace and reads `clean-run-context.json` for target profile, clean-safe rules, clean artifact paths, implementation root refs, and clean-side model preferences.
    *   Accepts Agent 0 input only as schema-valid durable sanitized artifacts.
    *   Reads the clean destination foundation under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
    *   Merges approved handoff artifacts into the clean workspace.
    *   Writes `implementation-plan.json` with relative destination paths, tests, constraints, risks, and argv-array verification commands.
    *   Keeps `skeleton-manifest.json` valid when the target profile expects it.

### [Agent 3: Clean Implementer Verifier](../agents/clean-qa-editor.md)
*   **Domain**: Clean (Source-denied)
*   **Write Target**: Clean reports in `CLEAN_ROOM_CLEAN_ROOTS`; code and tests in `CLEAN_ROOM_IMPLEMENTATION_ROOTS`
*   **Responsibilities**:
    *   Starts from the clean domain and validates `clean-run-context.json`.
    *   Reads `implementation-plan.json` and implements unblocked work items.
    *   Writes code, tests, fixtures, and destination project files only under `CLEAN_ROOM_IMPLEMENTATION_ROOTS`.
    *   Runs bounded verification only through the installed Agent 3 verification runner, with `CLEAN_ROOM_ALLOW_AGENT3_SHELL=1`, strict hooks, and cwd under implementation roots.
    *   Writes `implementation-report.json` and maintains `qc-report.json`.
    *   Does not report progress or ask Agent 0 for guidance during implementation.
    *   Emits one terminal report for Agent 0 only when the assigned plan or task is complete, blocked, or quarantined.

---

## Operating Boundaries & Environment

Every clean-room role session requires a populated environment block before any tool execution:

*   `CLEAN_ROOM_ROLE`: Defines the active role (e.g. `clean-architect`).
*   `CLEAN_ROOM_SOURCE_ROOTS`: Source roots (only readable by source-reading contaminated roles, not Agent 1.5).
*   `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`: Target write directory for contaminated roles.
*   `CLEAN_ROOM_CLEAN_ROOTS`: Target write directory for clean artifacts and reports.
*   `CLEAN_ROOM_IMPLEMENTATION_ROOTS`: Target write directory for Agent 3 clean implementation code and tests.
*   `CLEAN_ROOM_ALLOWED_READ_ROOTS`: Approved reference docs or constraints readable by clean and source-denied roles.
*   `CLEAN_ROOM_SCHEMA_DIR`: Path to the directory containing JSON schema assets.

Note: Even though clean and source-denied roles (such as Agent 1.5, 2, and 3) are restricted from accessing contaminated or source workspaces, they must still be configured with the full environment block. The hook guardrails require these paths to validate that tool inputs do not cross-pollinate or violate boundary constraints.

---

## Guardrails and Hooks

The architecture relies on agent/tool hook scaffolding located in `hooks/` to enforce boundary rules dynamically during agent sessions. Use installer-generated Codex or Claude hook configs with absolute wrapper paths. Static cwd-relative plugin hook declarations are not treated as an enforcement boundary. Use strict hooks for dedicated Codex or Claude clean-room homes; safe hooks are compatibility-only until `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present.

Matcher coverage depends on the host runtime emitting hook events for the tool invocation. Hosts that do not emit a pre/post tool event for a file, terminal, or resource tool are not protected by adding that tool name to the generated hook config. Run `clean-room-skill doctor --runtime codex --hooks=strict` or the Claude equivalent after install.

*   [clean-room-hook.py](../hooks/clean-room-hook.py): The main safe/strict dispatch wrapper for the policy checks.
*   [agent3-verification-runner.py](../hooks/agent3-verification-runner.py): Runs Agent 3 argv-array verification commands with `shell=False`, a small allowlist, sanitized env, bounded output, timeout, and root traversal checks.
*   [require-clean-room-env.py](../hooks/require-clean-room-env.py): Fails closed if the required role and root environment variables are missing, if trust-domain roots overlap, or if clean, implementation, or contaminated artifact root names appear source-derived.
*   [deny-clean-room-shell.py](../hooks/deny-clean-room-shell.py): Denies shell-style tool execution inside clean-room role sessions except installed Agent 3 verification-runner invocations under implementation roots.
*   [deny-clean-source-read.py](../hooks/deny-clean-source-read.py): Enforces that clean roles and Agent 1.5 cannot read source roots or unapproved paths; clean roles may read implementation roots, and Agent 1.5 is denied clean roots, implementation roots, and direct `source-index.json` reads.
*   [deny-contaminated-clean-write.py](../hooks/deny-contaminated-clean-write.py): Enforces role write roots. Agent 2 writes clean artifacts only, Agent 3 writes implementation files and clean reports, and contaminated roles write only to `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
*   [check-artifact-leakage.py](../hooks/check-artifact-leakage.py): Scans clean artifacts and Agent 1.5 staged contaminated artifacts for high-risk leakage markers, source-like identifiers, and private identifier denylist terms. The private identifier denylist (loaded via `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`) is subject to hard limits to protect hook execution performance: a maximum of 1,000,000 bytes per file, 20,000 total terms, and 512 characters per individual term.
*   [validate-json-schema.py](../hooks/validate-json-schema.py): Verifies JSON syntax and structural conformance against schemas under `CLEAN_ROOM_SCHEMA_DIR`. Under clean roots, any unrecognized JSON files that do not conform to canonical schemas will trigger a failure unless they are explicitly registered in the path-separated `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST` environment variable.
*   [validate-handoff-package.py](../hooks/validate-handoff-package.py): Verifies that handoff packages stay within clean roots, do not reference contaminated paths, `task-manifest.json`, or `source-index.json`, and match declared `sha256` checksums.

For detailed guidelines on the clean-room process, refer to:
*   [PROCESS.md](../skills/clean-room/references/PROCESS.md)
*   [LEAKAGE-RULES.md](../skills/clean-room/references/LEAKAGE-RULES.md)
*   [SPEC-SCHEMA.md](../skills/clean-room/references/SPEC-SCHEMA.md)
*   [TARGET-LANGUAGE-GUIDE.md](../skills/clean-room/references/TARGET-LANGUAGE-GUIDE.md)
