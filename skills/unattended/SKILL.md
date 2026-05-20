---
name: unattended
description: Starts the Clean Room startup wizard in bounded unattended controller mode for authorized spec-only source-to-spec work with finite loop limits and safety stops.
argument-hint: [authorized source scope, separated output roots, optional max iterations]
disable-model-invocation: true
---

# Clean Room Unattended

Start the clean-room startup wizard with `controller_policy.mode` fixed to `unattended`.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same spec-only boundary, role separation, artifact schemas, leakage rules, and hook expectations.

Gather only required setup facts:

- Authorization statement, requester, allowed actions, prohibited actions, and evidence handling.
- Source roots, contaminated artifact root, clean root, and optional public or destination reference roots.
- Target language or destination constraints, if known.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Finite maximum iteration count. Use `10` when the user does not provide a value.

Before indexing or artifact generation, confirm that source roots, contaminated artifact roots, and clean roots are separate paths. Stop if authorization is unclear, if the requested output includes replacement implementation code, or if clean and contaminated roots overlap.

Record `controller_policy.mode` as `unattended`, `max_units_per_iteration` as `1`, and `max_iterations` as the selected finite value. Include these stop conditions: `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, `coverage-complete`, and `iteration-limit-reached`.

For multi-file source scope, guide agent zero/controller to run `skills/clean-room/scripts/build_source_index.py` as preflight outside clean-room role sessions. Store `source-index.json` only under the contaminated artifact root and never include it in clean handoff packages.
