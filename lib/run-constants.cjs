'use strict';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const RUN_LOCK_NAME = '.clean-room-run.lock';
const RUN_LOCK_WAIT_MS = envPositiveInteger('CLEAN_ROOM_RUN_LOCK_WAIT_MS', 30_000);
const RUN_LOCK_POLL_MS = 100;
const IMPLEMENTATION_LOCK_NAME = '.clean-room-implementation.lock';
// Stale lock recovery renames the lock dir to <name>.stale.<ts>.<pid> rather than
// removing it, so the original can be inspected post-mortem. Filter these orphans
// out of implementation-root scans with IMPLEMENTATION_LOCK_STALE_PREFIX.
const IMPLEMENTATION_LOCK_STALE_PREFIX = `${IMPLEMENTATION_LOCK_NAME}.stale.`;
const IMPLEMENTATION_LOCK_WAIT_MS = envPositiveInteger('CLEAN_ROOM_IMPLEMENTATION_LOCK_WAIT_MS', 30_000);
const IMPLEMENTATION_LOCK_POLL_MS = 100;
const RUN_HOOK_TIMEOUT_MS = envPositiveInteger('CLEAN_ROOM_RUN_HOOK_TIMEOUT_MS', 30_000);
const LEDGER_NAME = 'controller-run-ledger.json';
const RESULT_NAME = 'clean-room-result.json';
const STATUS_NAME = 'controller-status.json';
const CLEAN_RUN_CONTEXT_NAME = 'clean-run-context.json';
const HANDOFF_PACKAGE_NAME = 'handoff-package.json';
const POLISH_REPORT_NAME = 'polish-report.json';
const MANAGER_PREPARE_PHASE = 'contaminated-manager-prepare';
const REQUIRED_COVERAGE_PHASE = 'contaminated-coverage-verify';
const POLISH_PHASE = 'clean-polish-review';
const PUBLIC_SURFACE_COMPLETION_LEVELS = new Set(['exact-public-contract', 'behavior-compatible']);
const MAX_LEDGER_ITERATIONS = 50;

const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
]);

const CI_ENV_ALLOWLIST = Object.freeze([
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_ID',
  'BUILD_NUMBER',
  'RUN_ID',
  'TEAMCITY_VERSION',
  'TF_BUILD',
  'GITHUB_ACTIONS',
  'GITHUB_ACTOR',
  'GITHUB_EVENT_NAME',
  'GITHUB_JOB',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITLAB_CI',
  'CI_COMMIT_REF_NAME',
  'CI_COMMIT_SHA',
  'CI_JOB_ID',
  'CI_PIPELINE_ID',
  'CI_PROJECT_PATH',
]);

const HOOK_ONLY_ENV_ALLOWLIST = Object.freeze([
  'CLEAN_ROOM_AUXILIARY_JSON_ALLOWLIST',
  'CLEAN_ROOM_PRIVATE_IDENTIFIER_DENYLIST',
  // Opt-in strict flag set only by `clean-room-skill artifact validate` so that a
  // file the schema hook cannot map to a canonical artifact kind fails closed
  // instead of passing vacuously. Off by default, so the PostToolUse hooks and the
  // controller runner keep their fail-open behavior for non-artifact JSON writes.
  'CLEAN_ROOM_REQUIRE_ARTIFACT_KIND',
]);

const DEFAULT_ROLE = 'contaminated-manager-verifier';
const SANITIZER_ROLE = 'contaminated-handoff-sanitizer';
const CLEAN_ROOM_ROLES = Object.freeze(new Set([
  'contaminated-manager-verifier',
  'contaminated-source-analyst',
  'contaminated-handoff-sanitizer',
  'clean-architect',
  'clean-qa-editor',
  'clean-polish-reviewer',
]));

const ROLE_BY_PHASE = Object.freeze({
  [MANAGER_PREPARE_PHASE]: 'contaminated-manager-verifier',
  'contaminated-analysis': 'contaminated-source-analyst',
  'sanitize-handoff': 'contaminated-handoff-sanitizer',
  'clean-plan': 'clean-architect',
  'clean-implement-qc': 'clean-qa-editor',
  [POLISH_PHASE]: 'clean-polish-reviewer',
  'contaminated-coverage-verify': 'contaminated-manager-verifier',
});

const TERMINAL_RESULTS = new Set([
  'spec-slice-complete',
  'spec-slice-blocked',
  'spec-delta-required',
  'contamination-suspected',
  'iteration-limit-reached',
  'no-progress-detected',
]);

const VOLATILE_PROGRESS_KEYS = new Set([
  'artifact_hashes',
  'created_at',
  'generated_at',
  'recorded_at',
  'returned_at',
  'reviewed_at',
  'started_at',
  'updated_at',
]);

const IMPLEMENTATION_IGNORE_NAMES = Object.freeze([
  '.git',
  IMPLEMENTATION_LOCK_NAME,
  'node_modules',
  'target',
]);

const SOURCE_DENIED_BRIEF_BLOCKED_NAMES = new Set([
  'source-index.json',
  'visual-index.json',
  'coverage-ledger.json',
  'evidence-ledger.json',
  'task-manifest.json',
  'init-config.json',
  'preflight-goal.json',
  'controller-status.json',
]);

const CLEAN_ROOM_ARTIFACT_PREFIXES = Object.freeze([
  'behavior-spec',
  'clean-room-result',
  'clean-run-context',
  'contamination-incident',
  'controller-status',
  'coverage-ledger',
  'evidence-ledger',
  'handoff-package',
  'implementation-plan',
  'implementation-report',
  'init-config',
  'polish-report',
  'preflight-goal',
  'qc-report',
  'role-session-brief',
  'skeleton-manifest',
  'source-index',
  'task-manifest',
  'visual-index',
]);

function envPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : fallback;
}

module.exports = {
  BASE_ENV_ALLOWLIST,
  CI_ENV_ALLOWLIST,
  CLEAN_ROOM_ARTIFACT_PREFIXES,
  CLEAN_ROOM_ROLES,
  CLEAN_RUN_CONTEXT_NAME,
  DEFAULT_ROLE,
  SANITIZER_ROLE,
  DEFAULT_TIMEOUT_MS,
  HANDOFF_PACKAGE_NAME,
  HOOK_ONLY_ENV_ALLOWLIST,
  IMPLEMENTATION_IGNORE_NAMES,
  IMPLEMENTATION_LOCK_NAME,
  IMPLEMENTATION_LOCK_POLL_MS,
  IMPLEMENTATION_LOCK_STALE_PREFIX,
  IMPLEMENTATION_LOCK_WAIT_MS,
  LEDGER_NAME,
  MAX_LEDGER_ITERATIONS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  MANAGER_PREPARE_PHASE,
  POLISH_PHASE,
  POLISH_REPORT_NAME,
  PUBLIC_SURFACE_COMPLETION_LEVELS,
  REQUIRED_COVERAGE_PHASE,
  RESULT_NAME,
  ROLE_BY_PHASE,
  RUN_HOOK_TIMEOUT_MS,
  RUN_LOCK_NAME,
  RUN_LOCK_POLL_MS,
  RUN_LOCK_WAIT_MS,
  SOURCE_DENIED_BRIEF_BLOCKED_NAMES,
  STATUS_NAME,
  TERMINAL_RESULTS,
  VOLATILE_PROGRESS_KEYS,
  envPositiveInteger,
};
