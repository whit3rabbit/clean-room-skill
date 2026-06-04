'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  readJsonFile,
  writeJsonFile,
} = require('./fs-utils.cjs');
const {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  POLISH_REPORT_NAME,
} = require('./run-constants.cjs');
const {
  readCleanCompletionArtifact,
  readCleanRunContext,
} = require('./run-clean-artifacts.cjs');
const {
  envFromAllowlist,
  hookPath,
} = require('./run-roots.cjs');

const COMMIT_HASH_RE = /^[a-fA-F0-9]{40,64}$/;

function normalizeCommitPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('polish commit paths must be non-empty strings');
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.startsWith('~') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`polish commit path must be relative: ${rawPath}`);
  }
  const parts = normalized.split('/');
  if (parts.includes('..') || parts.includes('.git')) {
    throw new Error(`polish commit path must not contain '..' or '.git': ${rawPath}`);
  }
  return normalized;
}

function changedPathSet(entries, options = {}) {
  const paths = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (options.skipUnchanged && entry.action === 'unchanged') continue;
    paths.add(normalizeCommitPath(entry.path));
  }
  return paths;
}

function sortedPathSet(paths) {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function expectedPolishCommitPaths(implementationReport, polishReport) {
  return sortedPathSet(new Set([
    ...changedPathSet(implementationReport?.changed_paths),
    ...changedPathSet(polishReport?.changed_paths, { skipUnchanged: true }),
  ]));
}

function polishIncludePaths(polishReport) {
  return sortedPathSet(new Set((polishReport?.git?.include_paths || []).map((item) => normalizeCommitPath(item))));
}

function diffPaths(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function polishCommitPathGap(implementationReport, polishReport) {
  const expected = expectedPolishCommitPaths(implementationReport, polishReport);
  const included = polishIncludePaths(polishReport);
  const missing = diffPaths(expected, included);
  if (missing.length > 0) {
    return `Final clean polish commit is missing changed implementation path: ${missing[0]}`;
  }
  const unexpected = diffPaths(included, expected);
  if (unexpected.length > 0) {
    return `Final clean polish commit includes an unreported implementation path: ${unexpected[0]}`;
  }
  return null;
}

function polishCommitCompletionGap(implementationReport, polishReport) {
  if (!polishReport) return null;
  const git = polishReport.git || {};
  if (git.commit_required === true) {
    if (git.commit_status !== 'committed') {
      return 'Final clean polish commit has not completed.';
    }
    if (typeof git.commit_hash !== 'string' || !COMMIT_HASH_RE.test(git.commit_hash)) {
      return 'Final clean polish commit hash is missing.';
    }
    return polishCommitPathGap(implementationReport, polishReport);
  }
  if (git.commit_required === false) {
    if (git.commit_status !== 'not-needed') {
      return 'Final clean polish commit status does not match commit_required=false.';
    }
    if (git.commit_hash !== null) {
      return 'Final clean polish commit hash must be null when commit_required=false.';
    }
  }
  return null;
}

function unresolvedPolishItems(polishReport) {
  const unresolvedFinding = (polishReport.findings || []).find((item) => item?.status !== 'resolved');
  if (unresolvedFinding) {
    return 'polish-report has unresolved findings';
  }
  const unresolvedTicket = (polishReport.abstract_delta_tickets || []).find((item) => item?.status !== 'resolved');
  if (unresolvedTicket) {
    return 'polish-report has unresolved abstract delta tickets';
  }
  const unpassedVerification = (polishReport.verification_results || []).find((item) => item?.status !== 'passed');
  if (unpassedVerification) {
    return 'polish-report has verification results that did not pass';
  }
  return null;
}

function boundedOutput(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= 4096) {
    return text;
  }
  return `${text.slice(0, 4096)}\n[truncated]`;
}

function runnerEnv(roots, manifest, selectedUnit) {
  return {
    ...envFromAllowlist(),
    CLEAN_ROOM_ROLE: 'clean-polish-reviewer',
    CLEAN_ROOM_ALLOW_AGENT4_SHELL: '1',
    CLEAN_ROOM_SOURCE_ROOTS: roots.sourceRoots.join(path.delimiter),
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: roots.contaminatedRoot,
    CLEAN_ROOM_CLEAN_ROOTS: roots.cleanRoot,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: roots.implementationRoots.join(path.delimiter),
    CLEAN_ROOM_ALLOWED_READ_ROOTS: roots.allowedReadRoots.join(path.delimiter),
    CLEAN_ROOM_SCHEMA_DIR: roots.schemaDir,
    CLEAN_ROOM_SELECTED_UNIT_ID: selectedUnit.unit_id,
    CLEAN_ROOM_SPEC_SLICE_REF: manifest.loop_context.spec_slice_ref,
  };
}

function parseRunnerOutput(result) {
  if (result.error) {
    throw new Error(`Agent 4 polish commit runner failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = boundedOutput(result.stderr || result.stdout);
    throw new Error(`Agent 4 polish commit runner failed: ${output}`);
  }
  const parsed = JSON.parse(result.stdout || '{}');
  if (parsed?.commit?.commit_status !== 'committed' || typeof parsed.commit.commit_hash !== 'string') {
    throw new Error('Agent 4 polish commit runner did not report a committed result');
  }
  return parsed.commit;
}

function updatePolishReportAfterCommit(polishReportPath, commit) {
  const polishReport = readJsonFile(polishReportPath, null);
  const priorStatus = polishReport.git?.repository_status;
  polishReport.git = {
    ...polishReport.git,
    repository_status: priorStatus === 'existing' ? 'existing' : 'initialized',
    commit_required: true,
    commit_status: 'committed',
    include_paths: commit.staged_paths || polishReport.git.include_paths,
    commit_hash: commit.commit_hash,
    status_summary: 'Committed listed implementation-root paths only.',
  };
  polishReport.final_status = 'passed';
  writeJsonFile(polishReportPath, polishReport);
  return polishReport;
}

function finalizeAgent4PolishCommit(python, roots, manifest, selectedUnit) {
  const context = readCleanRunContext(roots);
  const policy = context?.implementation?.polish_commit || null;
  const polishReportPath = path.join(roots.cleanRoot, POLISH_REPORT_NAME);
  if (!fs.existsSync(polishReportPath)) {
    return { status: 'not-needed' };
  }
  const polishReport = readJsonFile(polishReportPath, null);
  const git = polishReport.git || {};

  if (git.commit_required !== true) {
    if (git.commit_required !== false) {
      throw new Error('polish-report git.commit_required must be true or false');
    }
    if (policy?.git_policy !== 'disabled') {
      throw new Error('polish-report sets commit_required=false, but clean-run-context does not disable Agent 4 commits');
    }
    const commitGap = polishCommitCompletionGap(null, polishReport);
    if (commitGap) {
      throw new Error(commitGap);
    }
    return { status: 'not-needed' };
  }
  const { artifact: implementationReport } = readCleanCompletionArtifact(
    roots,
    'implementation_report',
    'implementation-report.json',
    'clean-run-context implementation_report'
  );
  if (!implementationReport) {
    throw new Error('Agent 4 commit requires terminal implementation-report.json');
  }
  const pathGap = polishCommitPathGap(implementationReport, polishReport);
  if (pathGap) {
    throw new Error(pathGap);
  }
  if (git.commit_status === 'committed') {
    return { status: 'already-committed' };
  }
  if (git.commit_status !== 'not-run') {
    throw new Error(`polish-report git.commit_status must be not-run before controller commit, got ${git.commit_status}`);
  }
  if (policy?.git_policy !== 'local-init-and-commit-only') {
    throw new Error('clean-run-context does not allow Agent 4 local init-and-commit');
  }
  if (policy.agent4_shell_allowed !== true || policy.cwd_policy !== 'implementation-root') {
    throw new Error('clean-run-context Agent 4 commit policy does not allow the bounded polish runner');
  }
  if (polishReport.final_status !== 'blocked') {
    throw new Error('pre-commit polish-report final_status must be blocked');
  }
  const unresolved = unresolvedPolishItems(polishReport);
  if (unresolved) {
    throw new Error(unresolved);
  }

  const result = spawnSync(python, [hookPath('agent4-polish-runner.py'), '--report', polishReportPath, '--commit'], {
    cwd: roots.implementationRoots[0],
    env: runnerEnv(roots, manifest, selectedUnit),
    encoding: 'utf8',
    shell: false,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const commit = parseRunnerOutput(result);
  updatePolishReportAfterCommit(polishReportPath, commit);
  return { status: 'committed', commit_hash: commit.commit_hash };
}

module.exports = {
  expectedPolishCommitPaths,
  finalizeAgent4PolishCommit,
  polishCommitCompletionGap,
};
