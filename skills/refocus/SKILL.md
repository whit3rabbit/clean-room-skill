---
name: refocus
description: Audits an existing Clean Room run and steers it back to missed gates without expanding declared scope.
argument-hint: [existing task-manifest.json or artifact roots]
disable-model-invocation: true
---

# Clean Room Refocus

Refocus realigns the current run to the declared scope, controller policy, artifact schemas, and clean-room boundary.

Refocus does not optimize, expand, or reinterpret the task. It does not invent new requirements or add behavior beyond `task-manifest.json`, ledgers, QC, and abstract delta tickets.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same spec-only boundary, role separation, artifact schemas, leakage rules, and hook expectations.

## Audit

Compare current artifacts to the canonical gate checklist:

- Scope gate recorded authorization, roots, boundaries, prohibited actions, evidence handling, selected target profile, and Agent 0-3 pipeline.
- Source index preflight exists when required and remains contaminated-only.
- Decomposition produced neutral `task-manifest.json` units.
- Contaminated analysis wrote behavior specs without implementation code.
- Leakage review ran before handoff.
- Handoff package excludes `source-index.json`, source paths, raw diffs, copied comments, private identifiers, source-shaped pseudocode, and contaminated ledgers.
- Clean organization produced clean-only `skeleton-manifest.json` when the run reached that gate.
- QC produced `qc-report.json` with schema, leakage, coverage, and abstract delta ticket status when the run reached that gate.
- Contaminated verification returned only abstract delta tickets.

Validate schemas and handoff hashes before trusting the artifacts. Use `source-index.json` only on the contaminated side and only when referenced by the task manifest.

## Findings

Emit missed-gate findings only:

- Missing required artifact.
- Invalid schema.
- Failed or missing leakage review.
- Invalid or stale handoff hash.
- Boundary violation or unproven root separation.
- Stale handoff compared with latest QC or ledger state.
- Controller policy not preserved.

Do not suggest speculative improvements. Do not change source scope, target profile, public API, or implementation plan.
If the user asks to add scope, stop and route to a new scope gate instead of silently expanding the run.

## Output

Return a bounded next-action plan containing:

- Current verified gate.
- Missed gate findings.
- One to three process corrections, ordered by safety.
- The single next action the controller should take.

If root separation, authorization, or clean/contaminated boundary cannot be proven, the single next action is to stop and repair that gate.
