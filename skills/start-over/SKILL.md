---
name: start-over
description: Archives or quarantines current Clean Room artifacts and restarts from the scope gate with a fresh task id.
argument-hint: [existing artifact roots and restart confirmation]
disable-model-invocation: true
---

# Clean Room Start Over

Start a clean-room run over without overwriting or deleting existing artifacts in place.

Use the canonical `clean-room` skill workflow and references in this plugin. Preserve the same spec-only boundary, role separation, artifact schemas, leakage rules, and hook expectations.

## Archive First

Require explicit user confirmation before changing artifact locations. Stop if confirmation is absent, authorization is unclear, the requested output includes replacement implementation code, or the archive target overlaps a source root in a way that would make provenance unclear.

Archive or quarantine previous artifacts before creating new ones:

- Prefer the `task-manifest.json` `artifact_paths.quarantine` path.
- Use a user-supplied quarantine path only when it is separated from source roots, contaminated artifact roots, and clean roots.
- Keep contaminated artifacts only under a contaminated-domain archive or quarantine directory.
- Keep clean artifacts only under a clean-domain archive or quarantine directory.
- Do not mix contaminated and clean archives.
- Do not delete artifacts.
- Do not overwrite an existing archive path; create a unique archive directory.
- Preserve existing `task-manifest.json`, ledgers, handoff packages, behavior specs, skeleton manifests, QC reports, incident records, and open delta tickets.

If safe archive targets cannot be proven from `task-manifest.json`, root environment, or explicit user input, stop before moving anything.

## Restart Gate

Start from the scope gate, not from prior QC:

- Reconfirm requester authorization, source scope, allowed actions, prohibited actions, and evidence handling.
- Reconfirm source roots, contaminated artifact roots, clean roots, and clean allowed-read roots are separated.
- Preserve source roots and authorization only when they are still valid for the requested restart.
- Create a fresh `task_id` by default.
- Record `run_state.generation`, `run_state.started_at`, optional `run_state.previous_generation_ref`, and `run_state.restart_reason`.
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

Do not produce replacement implementation code.
