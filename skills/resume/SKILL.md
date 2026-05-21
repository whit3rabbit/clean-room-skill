---
name: resume
description: Continues an existing Clean Room run from durable artifacts without relying on prior chat history.
argument-hint: [existing task-manifest.json or artifact roots]
disable-model-invocation: true
---

# Clean Room Resume

Resume an existing clean-room run from durable artifacts. Never use prior chat history as the source of truth.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same clean-room boundary, role separation, artifact schemas, leakage rules, implementation-root rules, and hook expectations.

## Load Order

Load these artifacts from the paths recorded in `task-manifest.json` and the configured root environment. Treat missing optional artifacts as blockers only when the current gate requires them.

- `task-manifest.json`
- `init-config.json`, when present, only for drift comparison against `task-manifest.json` `initialization_snapshot`
- `clean-run-context.json`, when present, only on the clean side
- `source-index.json`, only when referenced by the task manifest and only on the contaminated side
- `coverage-ledger.json`
- `evidence-ledger.json`
- `handoff-package.json` and behavior specs when present
- `skeleton-manifest.json` when present
- `implementation-plan.json` when present
- `implementation-report.json` when present
- latest valid `qc-report.json`
- open abstract delta tickets

If more than one `qc-report.json` is present, select the valid report with the newest `reviewed_at`. If reports tie, cannot be validated, or disagree about artifact hashes, stop and report a blocker.

## Required Checks

Before choosing work:

- Validate all loaded JSON artifacts against the bundled schemas.
- Validate handoff package paths and SHA-256 values before trusting clean artifacts.
- Confirm source roots, contaminated artifact roots, clean roots, implementation roots, and clean allowed-read roots remain separated.
- Confirm authorization still covers the recorded source scope and allowed actions.
- Report `run_state` when present; do not infer generation from chat history when it is missing.
- Trust `initialization_snapshot` before any reusable `init-config.json`. If they differ, report drift and stop before changing roots, model policy, schema profile, or rule classification.
- Preserve the existing `controller_policy`; missing policy means `attended`.
- Stop if clean roles appear to require source, contaminated ledgers, contaminated chat history, raw diffs, source excerpts, `source-index.json`, or the full `task-manifest.json`.
- Stop if Agent 3 appears to require writing code outside `CLEAN_ROOM_IMPLEMENTATION_ROOTS` or running shell outside the bounded Agent 3 shell policy.
- Stop if `clean-run-context.json` exposes source roots, contaminated roots, source index refs, coverage ledgers, or evidence ledgers.
- Stop if Agent 0 appears to have steered Agent 2 or Agent 3 through direct chat, progress feedback, implementation hints, priority changes, or partial implementation reports instead of durable sanitized artifacts.
- Treat non-terminal Agent 3 `implementation-report.json` states as internal clean-side state, not Agent 0 feedback.
- Stop if Agent 1.5 appears to require source roots, `source-index.json` contents, contaminated evidence ledgers, private identifier denylist contents, raw diffs, source excerpts, or Agent 1 source-reading chat history.

## Selection Rules

Pick exactly one next safe action:

- One pending, gap, or blocked unit from `task-manifest.json` and `coverage-ledger.json`.
- One blocked gate when a required artifact, schema validation, handoff hash, leakage review, authorization check, or root-separation check is missing or invalid.
- A final package closeout when implementation is complete, coverage is complete, and QC passed.

Do not batch units. Do not advance state from memory. Do not reinterpret the source scope.

## Output

Return only this structure:

```text
STATE: attended/unattended, current unit, latest implementation and QC status.
NEXT: one safe action.
BLOCKERS: missing artifacts or invalid checks.
DO NOT: no source text crossing wall, no code writes outside implementation roots.
```

If no safe next action can be proven, set `NEXT` to `blocked` and explain the first blocking gate.
