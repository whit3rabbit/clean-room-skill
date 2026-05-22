---
name: unattended
description: Starts the Clean Room startup wizard in bounded unattended controller mode for authorized source-to-implementation work with finite loop limits and safety stops.
argument-hint: [authorized source scope, separated output roots, optional max iterations]
disable-model-invocation: true
---

# Clean Room Unattended

Start the clean-room startup wizard with `controller_policy.mode` fixed to `unattended`.

Use the canonical `clean-room` skill workflow and references in this plugin. Read `skills/clean-room/references/CONTROLLER-LOOP.md` before defining unattended loop behavior. Preserve the same clean-room boundary, role separation, artifact schemas, leakage rules, implementation-root rules, and hook expectations.

Before asking setup or preflight questions, use the canonical `clean-room` "Run State Discovery Before Wizard" rules. Resolve explicit artifact paths first, then configured clean-room roots, then bounded `~/Documents/CleanRoom/task-*` candidates. If a valid `task-manifest.json` exists, route to `resume`. If a valid canonical `preflight-goal.json` exists without a manifest, continue at source/destination discovery and manifest creation. If a preflight artifact exists but is invalid, stop with schema errors instead of restarting preflight. If multiple candidates are found without an explicit path, list them and stop for selection.

Load or create `preflight-goal.json` first. Unattended mode requires a complete goal contract with no blocking or non-blocking `open_questions`, `controller_policy.unattended_allowed_after_preflight: true`, and a finite `controller_policy.max_iterations`.

Do not assume target language, license policy, dependency policy, exactness policy, output directory, or feature add/remove policy during the unattended loop. Stop on ambiguity instead of inventing product decisions.

Gather only required setup facts:

- Authorization statement, requester, allowed actions, prohibited actions, and evidence handling.
- Artifact base root, defaulting to `~/Documents/CleanRoom/<task-id>/`. If the user does not provide an explicitly approved neutral task ID, generate one as `task-` plus 8 lowercase hex characters. Do not derive task IDs or output directory names from source folder names.
- Source roots, contaminated artifact root, clean artifact root, clean implementation root, quarantine root, and optional public or destination reference roots.
- Target stack, destination constraints, dependency/license policy, exactness policy, feature policy, code hygiene policy, and output policy from `preflight-goal.json`.
- Target schema profile: `openspec-delta`, `gsd-planning-package`, `speckit-feature-folder`, or `kiro-spec-folder`.
- Default model plus optional clean, contaminated, or per-role overrides.
- Finite maximum iteration count for the inner clean-room loop from `preflight-goal.json`.
- Loop context for the selected spec slice: parent loop ref, spec slice ref, approved scope refs, acceptance refs, and public surface refs.

Before indexing or artifact generation, confirm that source roots, contaminated artifact roots, clean artifact roots, clean implementation roots, approved public reference roots, and schema directory are separate paths, and that clean/contaminated/implementation root names are not source-derived. Stop if authorization is unclear, if clean and contaminated roots overlap, if implementation roots overlap another trust-domain root, or if root paths contain source root basenames or meaningful non-generic source-name tokens. Clean roles must receive `clean-run-context.json`, not the full `task-manifest.json`, and Agent 0 must influence clean roles only through durable sanitized artifacts.

Record `preflight_goal_ref`, `preflight_goal_sha256`, required `handoff_sequence`, `controller_policy.mode` as `unattended`, `max_units_per_iteration` as `1`, and `max_iterations` as the selected finite value. Record `loop_context` with `parent_loop_kind: "spec-development"`, `child_loop_kind: "clean-room"`, `return_to: "outer-spec-loop"`, the selected `spec_slice_ref`, and bounded approved scope refs. Include these stop conditions: `authorization-missing`, `scope-change`, `contamination-suspected`, `schema-validation-failed`, `leakage-scan-failed`, `unit-blocked`, `implementation-complete`, `coverage-complete`, `iteration-limit-reached`, `spec-slice-complete`, `spec-slice-blocked`, `spec-delta-required`, `no-progress-detected`, `repeated-unit-selection`, and `clean-room-returned`.

The inner loop returns only after Agent 0 consumes the terminal Agent 3 report and completes contaminated-side coverage verification. Write `clean-room-result.json` before returning control to the outer spec loop.

For multi-file source scope, guide agent zero/controller to run `skills/clean-room/scripts/build_source_index.py` as preflight outside clean-room role sessions. Store `source-index.json` only under the contaminated artifact root and never include it in clean handoff packages.
