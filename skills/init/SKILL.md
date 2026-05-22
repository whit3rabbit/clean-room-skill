---
name: init
description: Records Clean Room initialization preferences, separated artifact locations, model policy, schema profile, and clean-safe rule defaults before a clean-room run starts or resumes.
argument-hint: [new run preferences or existing init-config/task-manifest paths]
disable-model-invocation: true
---

# Clean Room Init

## Overview

Initialize or revise durable Clean Room run preferences before source analysis starts. The output is an `init-config.json` controller artifact and an `initialization_snapshot` copied into each new `task-manifest.json`.

## Preflight Goal Contract

Before creating active artifacts, collect or confirm `preflight-goal.json`. Do not start attended or unattended execution until the goal contract records end goal, target stack, license policy, dependency policy, compatibility/exactness policy, feature add/remove policy, code hygiene limits, output policy, existing destination policy, and controller mode.

Keep `preflight-goal.json` in the controller/contaminated artifact domain. Clean roles receive only the clean-safe `goal_contract` subset and `code_hygiene_policy` through `clean-run-context.json`.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the clean-room boundary, role separation, artifact schemas, leakage rules, implementation-root rules, and hook expectations.

The CLI command `clean-room-skill init` may have pre-created neutral external folders and a clean-safe `.clean-room/README.md` stub in the target repository. Treat that bootstrap output as convenience scaffolding only. It does not replace this skill's initialization workflow, and it must not be treated as an active `preflight-goal.json`, `init-config.json`, `task-manifest.json`, or `clean-run-context.json`.

## Gather

Collect only setup decisions that affect correctness, safety, resumability, or output shape:

- Requester authorization, allowed actions, prohibited actions, and evidence handling.
- Source roots, contaminated artifact root, clean artifact root, clean implementation roots, quarantine root, and approved public or destination reference roots.
- Artifact base root. Default to `~/Documents/CleanRoom/<task-id>/`, never to the source workspace or a temporary directory unless the user explicitly chooses it. If the user does not provide an explicitly approved neutral task ID, generate one as `task-` plus 8 lowercase hex characters. Do not derive task IDs or output directory names from source folder names.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Goal contract choices from `preflight-goal.json`, including target stack, dependency/license policy, exactness policy, feature policy, code hygiene, output policy, and controller mode.
- Default model plus optional overrides for contaminated roles, clean roles, or individual roles. Keep model ids as runtime-specific strings.
- Additional user rules split into `clean_safe` and `contaminated_only`. Put anything containing source paths, private identifiers, private dependency names, or source-derived specifics into `contaminated_only`.

## Validate

Before writing active artifacts:

- Confirm source roots, contaminated artifact roots, clean artifact roots, clean implementation roots, approved public reference roots, and schema directory are separated.
- Confirm contaminated artifact roots, clean artifact roots, and clean implementation roots do not contain source-derived path names. Treat matches against source root basenames or meaningful non-generic source-name tokens as contamination risk.
- Confirm Agent 2 and Agent 3 will launch in the clean domain, not from the source workspace.
- Set clean isolation to `clean-workspace`; Docker or other containers are out of scope for v1.
- Treat root changes, model policy changes, target profile changes, and rule reclassification as safety-sensitive. Require explicit confirmation before changing an existing run.
- Do not move or delete old artifacts in place. Root changes must start a new generation or use `start-over`.

## Record

Create or update these artifacts:

- `init-config.json`: reusable controller-side preferences. This may contain source roots and contaminated-only rules, so do not place it in clean-role readable roots.
- `preflight-goal.json`: controller-side intent contract. This may contain source license notes and output roots, so do not place it in clean-role readable roots.
- `task-manifest.json` `initialization_snapshot`: immutable per-run copy of the effective init choices used for resume and drift checks.
- `clean-run-context.json`: sanitized clean-side context for Agent 2 and Agent 3. It contains only clean artifact paths, implementation root environment references, the target profile, clean-safe goal contract fields, code hygiene policy, approved public refs, model preferences, and clean-safe rules. It must not include source roots, contaminated roots, source index refs, coverage ledgers, evidence ledgers, `preflight-goal.json`, or the full task manifest.

## Resume

On resume, trust `task-manifest.json` `initialization_snapshot` first. If a reusable `init-config.json` differs from the snapshot, report drift and stop before applying changes. Continue only after the user explicitly confirms whether to keep the snapshot, start a new generation, or run `start-over`.
