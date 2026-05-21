---
name: start-over
description: Archives or quarantines current Clean Room artifacts and restarts from the scope gate with a fresh task id.
argument-hint: [existing artifact roots and restart confirmation]
disable-model-invocation: true
---

# Clean Room Start Over

Start a clean-room run over without overwriting or deleting existing artifacts in place.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same clean-room boundary, role separation, artifact schemas, leakage rules, implementation-root rules, and hook expectations.

## Archive First

Require explicit user confirmation before changing artifact locations. Stop if confirmation is absent, authorization is unclear, or the archive target overlaps a source root in a way that would make provenance unclear.

Archive or quarantine previous artifacts before creating new ones:

- Prefer the `task-manifest.json` `artifact_paths.quarantine` path.
- Use a user-supplied quarantine path only when it is separated from source roots, contaminated artifact roots, clean roots, and implementation roots.
- Keep contaminated artifacts only under a contaminated-domain archive or quarantine directory.
- Keep clean artifacts only under a clean-domain archive or quarantine directory.
- Do not mix contaminated and clean archives.
- Do not delete artifacts.
- Do not overwrite an existing archive path; create a unique archive directory.
- Preserve existing `task-manifest.json`, ledgers, handoff packages, behavior specs, skeleton manifests, implementation plans, implementation reports, QC reports, incident records, and open delta tickets.

If safe archive targets cannot be proven from `task-manifest.json`, root environment, or explicit user input, stop before moving anything.

## Restart Gate

Start from the scope gate, not from prior QC:

- Reconfirm requester authorization, source scope, allowed actions, prohibited actions, and evidence handling.
- Reconfirm source roots, contaminated artifact roots, clean roots, implementation roots, and clean allowed-read roots are separated, and that root path names are not source-derived.
- Preserve source roots and authorization only when they are still valid for the requested restart.
- Create a fresh neutral `task_id` by default. Use `task-` plus 8 lowercase hex characters unless the user provides an explicitly approved neutral ID. Do not derive the new ID or output directory names from source folder names.
- Record `run_state.generation`, `run_state.started_at`, optional `run_state.previous_generation_ref`, and `run_state.restart_reason`.
- Recreate `clean-run-context.json` from the new effective initialization choices; do not carry forward an old clean context by default.
- Rebuild `source-index.json` unless the user explicitly says the source scope is unchanged and a recorded old index hash can still be validated.
- Preserve the selected controller mode only if the user reconfirms it or it is recorded in the still-valid manifest.

Do not carry forward prior chat history or unapproved clean artifacts. Treat archived artifacts as audit history, not active task state.

## Output

Return a concise restart summary:

- Archived artifact roots and archive targets.
- Authorization and root-separation status.
- New `task_id` or generation identifier.
- Whether `source-index.json` must be rebuilt.
- The next scope-gate action.

Do not carry forward unapproved implementation code as active task state.
