---
name: resume
description: Continues an existing Clean Room run from durable artifacts without relying on prior chat history.
argument-hint: [existing task-manifest.json or artifact roots]
disable-model-invocation: true
---

# Clean Room Resume

Resume an existing clean-room run from durable artifacts. Never use prior chat history as the source of truth.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same spec-only boundary, role separation, artifact schemas, leakage rules, and hook expectations.

## Load Order

Load these artifacts from the paths recorded in `task-manifest.json` and the configured root environment. Treat missing optional artifacts as blockers only when the current gate requires them.

- `task-manifest.json`
- `source-index.json`, only when referenced by the task manifest and only on the contaminated side
- `coverage-ledger.json`
- `evidence-ledger.json`
- `handoff-package.json` and behavior specs when present
- `skeleton-manifest.json` when present
- latest valid `qc-report.json`
- open abstract delta tickets

If more than one `qc-report.json` is present, select the valid report with the newest `reviewed_at`. If reports tie, cannot be validated, or disagree about artifact hashes, stop and report a blocker.

## Required Checks

Before choosing work:

- Validate all loaded JSON artifacts against the bundled schemas.
- Validate handoff package paths and SHA-256 values before trusting clean artifacts.
- Confirm source roots, contaminated artifact roots, clean roots, and clean allowed-read roots remain separated.
- Confirm authorization still covers the recorded source scope and allowed actions.
- Report `run_state` when present; do not infer generation from chat history when it is missing.
- Preserve the existing `controller_policy`; missing policy means `attended`.
- Stop if clean roles appear to require source, contaminated ledgers, contaminated chat history, raw diffs, source excerpts, or `source-index.json`.

## Selection Rules

Pick exactly one next safe action:

- One pending, gap, or blocked unit from `task-manifest.json` and `coverage-ledger.json`.
- One blocked gate when a required artifact, schema validation, handoff hash, leakage review, authorization check, or root-separation check is missing or invalid.
- A final package closeout when coverage is complete and QC passed.

Do not batch units. Do not advance state from memory. Do not reinterpret the source scope.

## Output

Return only this structure:

```text
STATE: attended/unattended, current unit, latest QC status.
NEXT: one safe action.
BLOCKERS: missing artifacts or invalid checks.
DO NOT: no implementation, no source text crossing wall.
```

If no safe next action can be proven, set `NEXT` to `blocked` and explain the first blocking gate.
