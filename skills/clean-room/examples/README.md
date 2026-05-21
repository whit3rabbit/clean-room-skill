# Clean-Room Examples

These examples show artifact shape only. They are not outputs from a real source review and contain no source-derived content.

The `minimal-spec-package` directory validates schema shape only. Its handoff package is not a handoff-integrity fixture because it uses a placeholder checksum and a non-existent artifact path.

The `valid-handoff-package` directory is the positive handoff-integrity fixture. It references an existing clean artifact with its real SHA-256 checksum.

The minimal `task-manifest.json` uses `speckit-feature-folder` as a non-normative example. Real tasks must record the user's actual `format_selection.target_profile` from OpenSpec, GSD, Spec Kit, or Kiro before agents start work.

The minimal `source-index.json` is a contaminated-side shape example. Real source indexes may contain source paths and private import/export names, so they must stay out of clean handoff packages.

Use them to seed tests, docs, or dry runs:

- `minimal-spec-package/task-manifest.json`
- `minimal-spec-package/source-index.json`
- `minimal-spec-package/evidence-ledger.json`
- `minimal-spec-package/coverage-ledger.json`
- `minimal-spec-package/behavior-spec.json`
- `minimal-spec-package/handoff-package.json`
- `minimal-spec-package/skeleton-manifest.json`
- `minimal-spec-package/qc-report.json`
- `minimal-spec-package/contamination-incident.json`
- `valid-handoff-package/behavior-spec.json`
- `valid-handoff-package/handoff-package.json`
