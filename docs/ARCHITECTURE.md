# Clean Room Architecture

This document provides a comprehensive technical overview of the spec-first Clean Room workflow. The architecture enforces separation of concerns between contaminated source analysis and clean behavioral specification.

---

## High-Level Overview

The Clean Room workflow acts as an engineering risk-reduction process by establishing a unidirectional boundary (the "clean-room wall"). It isolates agents with access to source code from agents responsible for producing clean, target-agnostic behavioral specifications.

![Clean Room Architecture](../assets/clean-room-arch.svg)

---

## Operating Model

To maintain compliance and mitigate leakage risks, the workflow utilizes strictly separated workspaces, worktrees, repositories, or profiles for contaminated and clean work:

*   **Contaminated Source Workspace**: Source-readable, read-only where practical. Contains the codebase under analysis.
*   **Contaminated Artifact Workspace**: Holds intermediate outputs like init configs, source indexes, task manifests, coverage ledgers, evidence ledgers, draft specs, and abstract delta tickets. Configure via `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
*   **Clean Spec Workspace**: Houses sanitized clean run contexts, approved behavioral specifications, handoff packages, skeleton manifests, QC reports, and test plans. Configure via `CLEAN_ROOM_CLEAN_ROOTS`.
*   **Clean Allowed Reference Workspace**: Public documentation, specifications, or destination constraints explicitly approved for clean and source-denied role reads. Configure via `CLEAN_ROOM_ALLOWED_READ_ROOTS`.

> [!IMPORTANT]
> Prompt instructions alone do not form a boundary. The system enforces safety using OS-level path separation, role-specific sessions, Git hook checks, JSON schema validation, and strict artifact quarantine.

### Path Naming Guards

Artifact roots must not disclose private source names. New runs default to `~/Documents/CleanRoom/<task-id>/`; when no explicitly approved neutral task ID is provided, the controller generates `task-` plus 8 lowercase hex characters instead of using the source folder name.

The initialization wizard and `require-clean-room-env.py` audit clean and contaminated artifact root names. They fail closed when a path contains a source root basename or meaningful non-generic tokens from that basename, while filtering generic terms such as `src`, `app`, `test`, `repo`, and `workspace`.

### Contaminated Preflight Tooling

To assist in logical unit decomposition, the workflow supports an optional preflight indexing stage using `build_source_index.py` and `clean_room_tool_manager.py`.

*   **Execution Boundary**: This tooling runs exclusively in the contaminated domain before clean-room role sessions are initialized.
*   **Tool Trust Policy**: By default, tool discovery operates in `stat-only` mode and does not execute third-party binaries. It will only query version strings when explicitly invoked with `--probe-tools`. Project-local directories (such as `.bin` or `node_modules/.bin`) are ignored unless the environment variable `RE_SKILLS_TRUST_PROJECT_TOOLS=1` or the flag `--allow-working-project-tools` is supplied.

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
    publicrefs["Allowed public refs<br/>CLEAN_ROOM_ALLOWED_READ_ROOTS"]
    architect["Agent 2: clean-architect<br/>Read clean-run-context<br/>manage schema base and skeleton manifest"]
    qa["Agent 3: clean-qa-editor<br/>Validate schema, leakage, coverage, testability"]
    outputs["Clean outputs<br/>skeleton-manifest.json<br/>qc-report.json<br/>test plan notes"]
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
  publicrefs --> architect
  architect --> outputs
  outputs --> qa
  qa --> outputs
  qa -. abstract delta tickets only .-> manager

  blocked -. quarantine do not hand off .-> ledgers
  env -. required for every role session .-> manager
  env -. required for every role session .-> architect
  denyread -. clean and source-denied roles cannot read source roots .-> cleanroots
  denyread -. Agent 1.5 cannot read source roots, clean roots, or source-index.json .-> sanitizer
  denywrite -. contaminated writes only to contaminated artifact roots .-> ledgers
  denywrite -. clean writes only to clean roots .-> cleanroots
  denyshell -. no shell-style tools in role sessions .-> manager
  denyshell -. no shell-style tools in role sessions .-> architect
  scan -. post-write checks .-> outputs
  scan -. Agent 1.5 staged-output checks .-> staged

  classDef contaminatedDomain fill:#fff7ed,stroke:#c2410c,color:#111827;
  classDef cleanDomain fill:#ecfeff,stroke:#0e7490,color:#111827;
  classDef wallClass fill:#f8fafc,stroke:#475569,color:#111827;
  classDef guardClass fill:#f0fdf4,stroke:#15803d,color:#111827;
  class source,manager,analyst,sanitizer,brief,ledgers,drafts,staged contaminatedDomain;
  class cleanroots,publicrefs,architect,qa,outputs cleanDomain;
  class handoff,blocked wallClass;
  class env,denyread,denywrite,denyshell,scan guardClass;
```

---

## Agent Roles

The architecture delegates work across five distinct custom role agents to enforce separation between source reading, independent sanitization, and clean specification authoring.

### [Agent 0: Contaminated Manager Verifier](../agents/contaminated-manager-verifier.md)
*   **Domain**: Contaminated (Source-readable)
*   **Write Target**: Contaminated artifact workspace (`CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`)
*   **Responsibilities**:
    *   Validates authorization bounds, scope, and prohibited actions in `task-manifest.json`.
    *   Decomposes source scope into stable, neutral units that do not mirror private source layout.
    *   Controls execution flow and iteration loop state.
    *   Provides Agent 1.5 only a neutral sanitizer brief containing domain purpose, target profile, unit intent, public compatibility allowlist, and blocked categories.
    *   Produces `clean-run-context.json` for Agent 2 and Agent 3 instead of handing over the full `task-manifest.json`.
    *   Performs final verification of clean specification coverage against the source scope.
    *   Sends only abstract delta tickets across the clean-room wall (no source leakage).

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
*   **Write Target**: Clean workspace (`CLEAN_ROOM_CLEAN_ROOTS`)
*   **Responsibilities**:
    *   Starts from the clean workspace and reads `clean-run-context.json` for target profile, clean-safe rules, clean artifact paths, and clean-side model preferences.
    *   Manages the selected clean specification schema base.
    *   Merges approved handoff artifacts into the clean workspace.
    *   Organizes behavioral specifications into a target-neutral `skeleton-manifest.json`.
    *   Records target-language constraints and public contract references.

### [Agent 3: Clean QA Editor](../agents/clean-qa-editor.md)
*   **Domain**: Clean (Source-denied)
*   **Write Target**: Clean workspace (`CLEAN_ROOM_CLEAN_ROOTS`)
*   **Responsibilities**:
    *   Starts from the clean workspace and validates `clean-run-context.json`.
    *   Validates clean specification files against the schema directory (`CLEAN_ROOM_SCHEMA_DIR`).
    *   Performs leakage reviews using guidelines in [LEAKAGE-RULES.md](../skills/clean-room/references/LEAKAGE-RULES.md).
    *   Drafts the final `qc-report.json`.
    *   Communicates findings and coverage gaps back to Agent 0 using abstract delta tickets only.

---

## Operating Boundaries & Environment

Every clean-room role session requires a populated environment block before any tool execution:

*   `CLEAN_ROOM_ROLE`: Defines the active role (e.g. `clean-architect`).
*   `CLEAN_ROOM_SOURCE_ROOTS`: Source roots (only readable by source-reading contaminated roles, not Agent 1.5).
*   `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`: Target write directory for contaminated roles.
*   `CLEAN_ROOM_CLEAN_ROOTS`: Target write directory for clean roles.
*   `CLEAN_ROOM_ALLOWED_READ_ROOTS`: Approved reference docs or constraints readable by clean and source-denied roles.
*   `CLEAN_ROOM_SCHEMA_DIR`: Path to the directory containing JSON schema assets.

Note: Even though clean and source-denied roles (such as Agent 1.5, 2, and 3) are restricted from accessing contaminated or source workspaces, they must still be configured with the full environment block (including `CLEAN_ROOM_SOURCE_ROOTS` and `CLEAN_ROOM_CLEAN_ROOTS`). The hook guardrails require these paths to validate that tool inputs do not cross-pollinate or violate boundary constraints.

---

## Guardrails and Hooks

The architecture relies on Git hook scaffolding located in `hooks/` to enforce boundary rules dynamically during agent sessions. Use strict hooks for dedicated Codex or Claude clean-room homes; safe hooks are compatibility-only until `CLEAN_ROOM_HOOK_ENFORCE=1` or clean-room environment variables are present.

Matcher coverage depends on the host runtime emitting hook events for the tool invocation. Hosts that do not emit a pre/post tool event for a file, terminal, or resource tool are not protected by adding that tool name to `hooks.json`.

*   [clean-room-hook.py](../hooks/clean-room-hook.py): The main safe/strict dispatch wrapper for the policy checks.
*   [require-clean-room-env.py](../hooks/require-clean-room-env.py): Fails closed if the required role and root environment variables are missing, if trust-domain roots overlap, or if clean or contaminated artifact root names appear source-derived.
*   [deny-clean-room-shell.py](../hooks/deny-clean-room-shell.py): Denies shell-style tool execution inside clean-room role sessions to prevent command-based read/write bypasses.
*   [deny-clean-source-read.py](../hooks/deny-clean-source-read.py): Enforces that clean roles and Agent 1.5 cannot read source roots or unapproved paths; Agent 1.5 is also denied clean roots and direct `source-index.json` reads.
*   [deny-contaminated-clean-write.py](../hooks/deny-contaminated-clean-write.py): Enforces role write roots (Clean roles write only to `CLEAN_ROOM_CLEAN_ROOTS`; contaminated roles write only to `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`).
*   [check-artifact-leakage.py](../hooks/check-artifact-leakage.py): Scans clean artifacts and Agent 1.5 staged contaminated artifacts for high-risk leakage markers, source-like identifiers, and private identifier denylist terms. The private identifier denylist (loaded via `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST`) is subject to hard limits to protect hook execution performance: a maximum of 1,000,000 bytes per file, 20,000 total terms, and 512 characters per individual term.
*   [validate-json-schema.py](../hooks/validate-json-schema.py): Verifies JSON syntax and structural conformance against schemas under `CLEAN_ROOM_SCHEMA_DIR`. Under clean roots, any unrecognized JSON files that do not conform to canonical schemas will trigger a failure unless they are explicitly registered in the path-separated `CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST` environment variable.
*   [validate-handoff-package.py](../hooks/validate-handoff-package.py): Verifies that handoff packages stay within clean roots, do not reference contaminated paths, `task-manifest.json`, or `source-index.json`, and match declared `sha256` checksums.

For detailed guidelines on the clean-room process, refer to:
*   [PROCESS.md](../skills/clean-room/references/PROCESS.md)
*   [LEAKAGE-RULES.md](../skills/clean-room/references/LEAKAGE-RULES.md)
*   [SPEC-SCHEMA.md](../skills/clean-room/references/SPEC-SCHEMA.md)
*   [TARGET-LANGUAGE-GUIDE.md](../skills/clean-room/references/TARGET-LANGUAGE-GUIDE.md)
