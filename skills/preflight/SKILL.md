---
name: preflight
description: Creates or reviews the required Clean Room preflight goal contract before source discovery, decomposition, attended execution, or unattended execution.
argument-hint: [new goal details or existing preflight-goal.json path]
disable-model-invocation: true
---

# Clean Room Preflight

Create or validate `preflight-goal.json` before active clean-room artifacts start.

Use the canonical `clean-room` workflow and read `skills/clean-room/references/PREFLIGHT.md` when collecting missing goal details. Preserve the clean-room boundary: `preflight-goal.json` is a controller/contaminated-side artifact and must not be placed in clean-role readable roots.

If the user provides output from CLI `clean-room-skill init`, check the generated bootstrap scaffold before creating or copying `preflight-goal.json`: `clean-room-bootstrap.json`, `contaminated/`, `clean/`, `implementation/`, `quarantine/`, and the target repo `.clean-room/README.md` must exist and agree. Treat that scaffold as convenience output only; it is not an active `preflight-goal.json`, `init-config.json`, `task-manifest.json`, or `clean-run-context.json`.

## Required Contract

Record these decisions:

- End goal, success definition, destination kind, and existing destination handling.
- Target stack: language, runtime, framework, package manager, and test framework.
- License and dependency policy, including blocked licenses, blocked dependencies, and native dependency approval.
- Compatibility policy: public behavior/API exactness only. Private structure, comments, and internal names must not be mirrored.
- Feature policy: preserve, remove, add, and non-goals.
- Code hygiene policy: file line caps, max files per iteration, split strategy, exceptions, and forbidden patterns.
- Output policy: artifact base root, implementation root, assumed output directory, and write mode.
- Controller policy: attended or unattended, iteration cap, and whether unattended is allowed after preflight.
- Open questions, with blocking questions clearly marked.

## Mode Rules

Attended runs may continue with recorded `open_questions`, but each blocking question becomes a pause gate before the affected work starts.

Unattended runs require a complete `preflight-goal.json` with:

- `controller_policy.mode: "unattended"`
- `controller_policy.unattended_allowed_after_preflight: true`
- finite `controller_policy.max_iterations`
- empty `open_questions`

Do not infer target language, license, dependency policy, exactness policy, output directory, or feature add/remove policy from source code.

## CLI Helper

Use the CLI only for template creation or validation/copying:

```bash
clean-room-skill preflight --template --output ~/Documents/CleanRoom/task-xxxxxxxx/contaminated/preflight-goal.json
clean-room-skill preflight --input ./preflight-goal.json --output ~/Documents/CleanRoom/task-xxxxxxxx/contaminated/preflight-goal.json
clean-room-skill preflight --template --bootstrap ~/Documents/CleanRoom/task-xxxxxxxx
```

`--template` writes an attended draft with blocking open questions. It does not support unattended mode. Use `--input` for completed contracts. `--bootstrap` accepts either the generated task root or `clean-room-bootstrap.json`, writes to the generated contaminated artifact root after scaffold validation, and requires completed input contracts to match the bootstrap artifact and implementation roots.

## Handoff

Agent 0 must record `preflight_goal_ref`, `preflight_goal_sha256`, and the required `handoff_sequence` in `task-manifest.json`.

Clean roles receive only the clean-safe goal subset through `clean-run-context.json` `goal_contract` plus `code_hygiene_policy`. Do not send the full `preflight-goal.json` to Agent 1.5, Agent 2, Agent 3, or clean handoff packages.
