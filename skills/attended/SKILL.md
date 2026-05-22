---
name: attended
description: Starts the Clean Room startup wizard in attended controller mode for authorized source-to-implementation work with human review pauses at clean-room gates.
argument-hint: [authorized source scope and separated output roots]
disable-model-invocation: true
---

# Clean Room Attended

Start the clean-room startup wizard with `controller_policy.mode` fixed to `attended`.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same clean-room boundary, role separation, artifact schemas, leakage rules, implementation-root rules, and hook expectations.

Load or create `preflight-goal.json` first. Attended mode may continue with unresolved questions only when they are recorded as `open_questions`; blocking questions become pause gates before affected work starts.

Gather only required setup facts:

- Authorization statement, requester, allowed actions, prohibited actions, and evidence handling.
- Artifact base root, defaulting to `~/Documents/CleanRoom/<task-id>/`. If the user does not provide an explicitly approved neutral task ID, generate one as `task-` plus 8 lowercase hex characters. Do not derive task IDs or output directory names from source folder names.
- Source roots, contaminated artifact root, clean artifact root, clean implementation root, quarantine root, and optional public or destination reference roots.
- Target stack, destination constraints, dependency/license policy, exactness policy, feature policy, code hygiene policy, and output policy from `preflight-goal.json`.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Default model plus optional clean, contaminated, or per-role overrides.

Before indexing or artifact generation, confirm that source roots, contaminated artifact roots, clean artifact roots, clean implementation roots, approved public reference roots, and schema directory are separate paths, and that clean/contaminated/implementation root names are not source-derived. Stop if authorization is unclear, if clean and contaminated roots overlap, if implementation roots overlap another trust-domain root, or if root paths contain source root basenames or meaningful non-generic source-name tokens. Clean roles must receive `clean-run-context.json`, not the full `task-manifest.json`, and Agent 0 must influence clean roles only through durable sanitized artifacts.

Record `preflight_goal_ref`, `preflight_goal_sha256`, required `handoff_sequence`, and `controller_policy.mode` as `attended`. Pause for human review at preflight open questions, scope gate, clean handoff, terminal implementation deltas, blocked units, and final coverage. Include stop conditions for `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, `implementation-complete`, and `coverage-complete`; attended mode does not add an iteration-limit stop unless the user explicitly sets one.

For multi-file source scope, guide agent zero/controller to run `skills/clean-room/scripts/build_source_index.py` as preflight outside clean-room role sessions. Store `source-index.json` only under the contaminated artifact root and never include it in clean handoff packages.
