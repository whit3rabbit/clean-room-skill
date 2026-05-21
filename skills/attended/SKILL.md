---
name: attended
description: Starts the Clean Room startup wizard in attended controller mode for authorized spec-only source-to-spec work with human review pauses at clean-room gates.
argument-hint: [authorized source scope and separated output roots]
disable-model-invocation: true
---

# Clean Room Attended

Start the clean-room startup wizard with `controller_policy.mode` fixed to `attended`.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same spec-only boundary, role separation, artifact schemas, leakage rules, and hook expectations.

Gather only required setup facts:

- Authorization statement, requester, allowed actions, prohibited actions, and evidence handling.
- Artifact base root, defaulting to `~/Documents/CleanRoom/<task-id>/`.
- Source roots, contaminated artifact root, clean root, quarantine root, and optional public or destination reference roots.
- Target language or destination constraints, if known.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Default model plus optional clean, contaminated, or per-role overrides.

Before indexing or artifact generation, confirm that source roots, contaminated artifact roots, clean roots, approved public reference roots, and schema directory are separate paths. Stop if authorization is unclear, if the requested output includes replacement implementation code, or if clean and contaminated roots overlap. Clean roles must receive `clean-run-context.json`, not the full `task-manifest.json`.

Record `controller_policy.mode` as `attended`. Pause for human review at scope gate, clean handoff, QC deltas, blocked units, and final coverage. Include stop conditions for `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, and `coverage-complete`; attended mode does not add an iteration-limit stop unless the user explicitly sets one.

For multi-file source scope, guide agent zero/controller to run `skills/clean-room/scripts/build_source_index.py` as preflight outside clean-room role sessions. Store `source-index.json` only under the contaminated artifact root and never include it in clean handoff packages.
