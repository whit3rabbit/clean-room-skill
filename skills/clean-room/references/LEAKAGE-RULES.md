# Leakage Rules

## Invariant

Only unprotected functional behavior and compatibility requirements should cross into the clean workspace. Source expression, source-shaped design, and contaminated context must stay out.

## Never Cross

Block these from clean artifacts:

- raw source files
- copied source excerpts
- raw diffs
- copied comments
- decompiled output
- private package, module, class, helper, method, function, variable, constant, or field names
- source-only file layout
- distinctive internal identifiers
- implementation-shaped pseudocode
- stack traces containing source lines
- unique log messages, UI copy, or strings not needed for compatibility
- formatting, ordering, or naming that mirrors source without public-contract need

## Allowed With Care

Allow these only when needed for compatibility or testing:

- public API names
- command names and flags
- documented config keys
- public protocol fields
- public file formats
- externally visible error codes
- interoperability-relevant strings

When keeping a public name, record why it is compatibility-relevant.

## Identifier Boundary

Treat implementation identifiers as contaminated by default. Package names, namespace names, module paths, class names, method names, function names, variable names, constants, fields, and internal event names must not appear in clean specs unless they are public compatibility surface.

Public compatibility surface means the name is externally documented, required by an existing integration, visible in a public protocol or file format, or explicitly required by the destination scope. If a name is retained, place it in `public_surface` or `public_contracts` with `name`, `kind`, `visibility`, and a concrete compatibility reason. Valid `visibility` values are `public`, `destination`, `protocol`, and `user-required`. Do not mention source-private names in summaries, claims, tests, open questions, skeleton areas, QC findings, or delta tickets.

The contaminated side should maintain a private identifier denylist for guardrail scanning when practical. The denylist is line-oriented, ignores blank lines and `#` comments, and is bounded to 1,000,000 bytes per file, 20,000 total terms, and 512 characters per term. Keep that list out of clean-role readable roots and do not paste its contents into clean artifacts or model-visible reports.

## Rewrite Pattern

Convert source-adjacent observations into neutral requirements:

- Bad: "Function `parseFooInternal` checks `if x == 7` then calls `retryLater`."
- Good: "When input mode is unsupported, the component rejects the request before persistence and exposes a retryable error."
- Bad: "Copy this loop structure."
- Good: "Process entries in input order and stop after the first validation failure."

## Review Checklist

Before clean handoff, confirm:

- No copied source text remains.
- No source code block remains.
- No private helper or file names remain unless justified as public compatibility.
- No private package, module, class, function, method, variable, constant, or field names remain.
- No algorithm description is more specific than required by observable behavior.
- No formatting, ordering, or naming mirrors source by default.
- Every claim has an evidence status.
- Every retained public name has a compatibility reason.
- Every uncertain behavior is marked as an open question.

## Contamination Response

If clean work receives blocked material:

1. Stop clean processing for the affected artifact.
2. Mark the artifact contaminated.
3. Remove it from the clean workspace or quarantine it outside the clean artifact set.
4. Regenerate a scrubbed artifact from the contaminated side.
5. Record the incident in `qc-report.json` and, when useful, a standalone `contamination-incident.json`.

Do not try to "forget" source material inside the same clean context and continue.

## Guardrail Scripts

Use hook scripts as audit and guardrail support, not as the only boundary:

- `hooks/deny-clean-source-read.py`: denies clean-role reads from `CLEAN_ROOM_SOURCE_ROOTS` and any path outside `CLEAN_ROOM_CLEAN_ROOTS` plus `CLEAN_ROOM_ALLOWED_READ_ROOTS`.
- `hooks/deny-contaminated-clean-write.py`: enforces write roots. Clean roles may write only under `CLEAN_ROOM_CLEAN_ROOTS`; contaminated roles may write only under `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`.
- `hooks/check-artifact-leakage.py`: scans clean artifacts for high-risk leakage markers, obvious source-like identifiers, and terms from optional `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` files.
- `hooks/validate-json-schema.py`: checks JSON syntax and common bundled schema constraints, including the conditional and bounded fields used by these schemas. It is not a full JSON Schema 2020-12 validator.
- `hooks/require-clean-room-env.py`: fails closed when the role, root, or schema environment block is missing.
- `hooks/deny-clean-room-shell.py`: denies shell-style tools for clean-room role sessions because shell reads can bypass path-aware hooks.

Set `CLEAN_ROOM_ROLE`, `CLEAN_ROOM_SOURCE_ROOTS`, `CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS`, `CLEAN_ROOM_CLEAN_ROOTS`, `CLEAN_ROOM_ALLOWED_READ_ROOTS`, and `CLEAN_ROOM_SCHEMA_DIR` explicitly before running hooks. Set `CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST` when the contaminated side has produced a private identifier list for hook-only scanning.
