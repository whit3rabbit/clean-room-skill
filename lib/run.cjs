'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  atomicWriteFile,
  fileHash,
  listFiles,
  readJsonFile,
  writeJsonFile,
} = require('./fs-utils.cjs');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const RUN_LOCK_NAME = '.clean-room-run.lock';
const RUN_LOCK_WAIT_MS = 30_000;
const RUN_LOCK_POLL_MS = 100;
const LEDGER_NAME = 'controller-run-ledger.json';
const RESULT_NAME = 'clean-room-result.json';
const REQUIRED_COVERAGE_PHASE = 'contaminated-coverage-verify';
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
]);

const ROLE_BY_PHASE = Object.freeze({
  'contaminated-analysis': 'contaminated-source-analyst',
  'sanitize-handoff': 'contaminated-handoff-sanitizer',
  'clean-plan': 'clean-architect',
  'clean-implement-qc': 'clean-qa-editor',
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function printRunHelp() {
  console.log(`Usage: clean-room-skill run --task-manifest <path> --agent-commands <path> [options]

Run one bounded inner clean-room controller loop for an approved spec slice.

Options:
  --task-manifest <path>   Required task-manifest.json path
  --agent-commands <path>  Required role command adapter JSON unless --dry-run is set
  --max-iterations <n>     Lower the manifest/loop iteration cap
  --once                   Run at most one inner iteration
  --dry-run                Validate and print the selected unit without writing or spawning agents
  --schema-dir <path>      Schema directory override
  --python <path>          Python executable for bundled validation hooks (default: python3)
  -h, --help               Show this help
`);
}

function parseRunArgs(argv) {
  const options = {
    taskManifest: null,
    agentCommands: null,
    maxIterations: null,
    once: false,
    dryRun: false,
    schemaDir: null,
    python: 'python3',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--task-manifest') {
      index += 1;
      options.taskManifest = requiredValue(argv, index, '--task-manifest');
    } else if (arg.startsWith('--task-manifest=')) {
      options.taskManifest = arg.slice('--task-manifest='.length);
    } else if (arg === '--agent-commands') {
      index += 1;
      options.agentCommands = requiredValue(argv, index, '--agent-commands');
    } else if (arg.startsWith('--agent-commands=')) {
      options.agentCommands = arg.slice('--agent-commands='.length);
    } else if (arg === '--max-iterations') {
      index += 1;
      options.maxIterations = parsePositiveInteger(requiredValue(argv, index, '--max-iterations'), '--max-iterations');
    } else if (arg.startsWith('--max-iterations=')) {
      options.maxIterations = parsePositiveInteger(arg.slice('--max-iterations='.length), '--max-iterations');
    } else if (arg === '--schema-dir') {
      index += 1;
      options.schemaDir = requiredValue(argv, index, '--schema-dir');
    } else if (arg.startsWith('--schema-dir=')) {
      options.schemaDir = arg.slice('--schema-dir='.length);
    } else if (arg === '--python') {
      index += 1;
      options.python = requiredValue(argv, index, '--python');
    } else if (arg.startsWith('--python=')) {
      options.python = arg.slice('--python='.length);
    } else {
      throw new Error(`unknown run option: ${arg}`);
    }
  }

  return options;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === '') {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function defaultSchemaDir() {
  return path.join(packageRoot(), 'skills', 'clean-room', 'assets');
}

function hookPath(scriptName) {
  return path.join(packageRoot(), 'hooks', scriptName);
}

function resolvePath(value, baseDir) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('expected non-empty path value');
  }
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(baseDir, expanded);
}

function resolveManifestRoot(rawPath, manifestDir) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return null;
  }
  const expanded = rawPath === '~' ? os.homedir() : rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(manifestDir, expanded);
}

function resolveRoots(manifest, manifestDir, schemaDir) {
  const paths = manifest.artifact_paths || {};
  const contaminatedRoot = resolveManifestRoot(
    Array.isArray(paths.contaminated_artifact_roots) ? paths.contaminated_artifact_roots[0] : paths.contaminated_artifacts,
    manifestDir
  );
  const cleanRoot = resolveManifestRoot(paths.clean_artifacts, manifestDir);
  const implementationRoots = (paths.implementation_roots || [])
    .map((item) => resolveManifestRoot(item, manifestDir))
    .filter(Boolean);
  const sourceRoots = effectiveRoots(manifest, 'source_roots', manifestDir);
  const allowedReadRoots = effectiveRoots(manifest, 'approved_public_reference_roots', manifestDir);

  if (!contaminatedRoot) throw new Error('task manifest must provide a contaminated artifact root');
  if (!cleanRoot) throw new Error('task manifest must provide a clean artifact root');
  if (implementationRoots.length === 0) throw new Error('task manifest must provide at least one implementation root');

  return {
    sourceRoots,
    contaminatedRoot,
    cleanRoot,
    implementationRoots,
    allowedReadRoots,
    schemaDir,
  };
}

function effectiveRoots(manifest, field, manifestDir) {
  const values = manifest.initialization_snapshot?.effective_roots?.[field] || [];
  return values
    .map((item) => resolveManifestRoot(item, manifestDir))
    .filter(Boolean);
}

function envFromAllowlist(extraNames = []) {
  const env = {};
  for (const key of [...BASE_ENV_ALLOWLIST, ...CI_ENV_ALLOWLIST, ...extraNames]) {
    if (Object.hasOwn(process.env, key)) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function validateTaskManifestForRun(manifest) {
  if (typeof manifest.preflight_goal_ref !== 'string' || manifest.preflight_goal_ref === '') {
    throw new Error('clean-room run requires task-manifest preflight_goal_ref');
  }
  if (typeof manifest.preflight_goal_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(manifest.preflight_goal_sha256)) {
    throw new Error('clean-room run requires task-manifest preflight_goal_sha256');
  }
  if (!Array.isArray(manifest.handoff_sequence) || manifest.handoff_sequence.length === 0) {
    throw new Error('clean-room run requires task-manifest handoff_sequence');
  }
  if (!manifest.agent_pipeline?.agent_1_5) {
    throw new Error('clean-room run requires agent_pipeline.agent_1_5');
  }
  const policy = manifest.controller_policy || {};
  if (policy.mode !== 'unattended') {
    throw new Error('clean-room run requires controller_policy.mode to be "unattended"');
  }
  if (!Number.isInteger(policy.max_iterations) || policy.max_iterations < 1) {
    throw new Error('clean-room run requires controller_policy.max_iterations');
  }
  if (policy.max_units_per_iteration !== 1) {
    throw new Error('clean-room run requires controller_policy.max_units_per_iteration to be 1');
  }
  const loop = manifest.loop_context;
  if (!loop || typeof loop !== 'object') {
    throw new Error('clean-room run requires task-manifest loop_context');
  }
  if (loop.parent_loop_kind !== 'spec-development') {
    throw new Error('loop_context.parent_loop_kind must be "spec-development"');
  }
  if (loop.child_loop_kind !== 'clean-room') {
    throw new Error('loop_context.child_loop_kind must be "clean-room"');
  }
  if (loop.return_to !== 'outer-spec-loop') {
    throw new Error('loop_context.return_to must be "outer-spec-loop"');
  }
  if (!Array.isArray(loop.approved_scope_refs) || loop.approved_scope_refs.length === 0) {
    throw new Error('loop_context.approved_scope_refs must not be empty');
  }
  if (!Number.isInteger(loop.max_inner_iterations) || loop.max_inner_iterations < 1) {
    throw new Error('loop_context.max_inner_iterations must be a positive integer');
  }
}

function verifyPreflightGoal(manifest, manifestDir) {
  const preflightGoalPath = resolveManifestRoot(manifest.preflight_goal_ref, manifestDir);
  if (!preflightGoalPath) {
    throw new Error('clean-room run requires task-manifest preflight_goal_ref');
  }
  let stat;
  try {
    stat = fs.statSync(preflightGoalPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`preflight goal not found: ${preflightGoalPath}`);
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`preflight goal is not a file: ${preflightGoalPath}`);
  }
  const actual = fileHash(preflightGoalPath).toLowerCase();
  const expected = manifest.preflight_goal_sha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(`preflight goal sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function effectiveIterationCap(manifest, options) {
  const manifestCap = Math.min(
    manifest.controller_policy.max_iterations,
    manifest.loop_context.max_inner_iterations
  );
  if (options.maxIterations !== null) {
    if (options.maxIterations > manifestCap) {
      throw new Error('--max-iterations may only lower the manifest/loop cap');
    }
    return options.once ? 1 : options.maxIterations;
  }
  return options.once ? 1 : manifestCap;
}

function validateCommandConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('agent command config must be a JSON object');
  }
  if (config.version !== 1) {
    throw new Error('agent command config version must be 1');
  }
  if (!Array.isArray(config.stages) || config.stages.length === 0) {
    throw new Error('agent command config must include stages');
  }
  let hasCoveragePhase = false;
  for (const [index, stage] of config.stages.entries()) {
    if (!stage || typeof stage !== 'object') {
      throw new Error(`agent command stage ${index} must be an object`);
    }
    if (!Object.hasOwn(ROLE_BY_PHASE, stage.phase)) {
      throw new Error(`agent command stage ${index} has unsupported phase`);
    }
    if (stage.role !== ROLE_BY_PHASE[stage.phase]) {
      throw new Error(`agent command stage ${index} role does not match phase ${stage.phase}`);
    }
    if (!Array.isArray(stage.argv) || stage.argv.length === 0 || stage.argv.some((item) => typeof item !== 'string' || item === '')) {
      throw new Error(`agent command stage ${index} must provide non-empty argv strings`);
    }
    if (typeof stage.cwd !== 'string' || stage.cwd === '') {
      throw new Error(`agent command stage ${index} must provide cwd`);
    }
    if (stage.timeout_ms !== undefined) {
      if (!Number.isInteger(stage.timeout_ms) || stage.timeout_ms < 1 || stage.timeout_ms > MAX_TIMEOUT_MS) {
        throw new Error(`agent command stage ${index} timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`);
      }
    }
    if (stage.env !== undefined) {
      if (!stage.env || typeof stage.env !== 'object' || Array.isArray(stage.env)) {
        throw new Error(`agent command stage ${index} env must be an object`);
      }
      for (const [key, value] of Object.entries(stage.env)) {
        if (key.startsWith('CLEAN_ROOM_')) {
          throw new Error(`agent command stage ${index} env must not override CLEAN_ROOM_* values`);
        }
        if (typeof value !== 'string') {
          throw new Error(`agent command stage ${index} env values must be strings`);
        }
      }
    }
    if (stage.phase === REQUIRED_COVERAGE_PHASE) {
      hasCoveragePhase = true;
    }
  }
  if (!hasCoveragePhase) {
    throw new Error(`agent command config must include ${REQUIRED_COVERAGE_PHASE}`);
  }
}

function readOptionalJson(filePath) {
  return fs.existsSync(filePath) ? readJsonFile(filePath, null) : null;
}

function unitRefValues(unitId) {
  return new Set([unitId, `unit:${unitId}`, `task-manifest:${unitId}`]);
}

function approvedUnitIds(manifest) {
  const approved = new Set(manifest.loop_context.approved_scope_refs);
  const ids = new Set();
  for (const unit of manifest.units || []) {
    for (const candidate of unitRefValues(unit.unit_id)) {
      if (approved.has(candidate)) {
        ids.add(unit.unit_id);
      }
    }
  }
  return ids;
}

function coverageMap(coverageLedger) {
  const map = new Map();
  for (const unit of coverageLedger?.source_units || []) {
    if (typeof unit.unit_id === 'string') {
      map.set(unit.unit_id, unit.coverage_state);
    }
  }
  return map;
}

function selectUnit(manifest, coverageLedger) {
  const approved = approvedUnitIds(manifest);
  if (approved.size === 0) {
    throw new Error('loop_context.approved_scope_refs does not match any task-manifest unit');
  }
  const coverage = coverageMap(coverageLedger);
  for (const unit of manifest.units || []) {
    if (!approved.has(unit.unit_id)) continue;
    const coverageState = coverage.get(unit.unit_id);
    if (unit.status === 'pending' || coverageState === 'gap' || coverageState === 'not-started' || coverageState === 'in-progress') {
      return unit;
    }
  }
  return null;
}

function jsonFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  return listFiles(root)
    .filter((rel) => rel.endsWith('.json'))
    .filter((rel) => rel !== LEDGER_NAME)
    .map((rel) => path.join(root, rel));
}

function trackedArtifactPaths(manifestPath, roots) {
  const paths = new Set([manifestPath]);
  for (const root of [roots.contaminatedRoot, roots.cleanRoot]) {
    for (const filePath of jsonFiles(root)) {
      paths.add(filePath);
    }
  }
  return [...paths].sort();
}

function artifactSnapshot(manifestPath, roots) {
  const entries = {};
  for (const filePath of trackedArtifactPaths(manifestPath, roots)) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    entries[filePath] = fileHash(filePath);
  }
  return entries;
}

function snapshotsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
  }
  return true;
}

function hookEnv(roots, role = 'contaminated-manager-verifier') {
  return {
    ...envFromAllowlist(HOOK_ONLY_ENV_ALLOWLIST),
    CLEAN_ROOM_ROLE: role,
    CLEAN_ROOM_SOURCE_ROOTS: roots.sourceRoots.join(path.delimiter),
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: roots.contaminatedRoot,
    CLEAN_ROOM_CLEAN_ROOTS: roots.cleanRoot,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: roots.implementationRoots.join(path.delimiter),
    CLEAN_ROOM_ALLOWED_READ_ROOTS: roots.allowedReadRoots.join(path.delimiter),
    CLEAN_ROOM_SCHEMA_DIR: roots.schemaDir,
  };
}

function validationPayload(filePath) {
  return JSON.stringify({ tool_input: { file_path: filePath } });
}

function runHook(python, scriptName, filePath, roots, role = 'contaminated-manager-verifier') {
  const result = spawnSync(python, [hookPath(scriptName)], {
    cwd: packageRoot(),
    env: hookEnv(roots, role),
    input: validationPayload(filePath),
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(`${scriptName} failed for ${filePath}: ${stderr || stdout || `exit ${result.status}`}`);
  }
}

function validateArtifacts(python, manifestPath, roots) {
  for (const filePath of trackedArtifactPaths(manifestPath, roots)) {
    runHook(python, 'validate-json-schema.py', filePath, roots);
    runHook(python, 'check-artifact-leakage.py', filePath, roots);
    if (path.basename(filePath) === 'handoff-package.json') {
      runHook(python, 'validate-handoff-package.py', filePath, roots);
    }
  }
}

function stagePrompt(stage, manifest, unit, iteration) {
  return [
    `CLEAN_ROOM_CONTROLLER_PHASE=${stage.phase}`,
    `CLEAN_ROOM_CONTROLLER_ITERATION=${iteration}`,
    `CLEAN_ROOM_SELECTED_UNIT_ID=${unit.unit_id}`,
    `CLEAN_ROOM_SPEC_SLICE_REF=${manifest.loop_context.spec_slice_ref}`,
    '',
    'Run only this configured clean-room stage from durable artifacts.',
    'Do not use prior chat history as state.',
    '',
  ].join('\n');
}

function stageEnv(stage, roots, manifest, unit, iteration) {
  return {
    ...envFromAllowlist(),
    ...(stage.env || {}),
    CLEAN_ROOM_ROLE: stage.role,
    CLEAN_ROOM_SOURCE_ROOTS: roots.sourceRoots.join(path.delimiter),
    CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: roots.contaminatedRoot,
    CLEAN_ROOM_CLEAN_ROOTS: roots.cleanRoot,
    CLEAN_ROOM_IMPLEMENTATION_ROOTS: roots.implementationRoots.join(path.delimiter),
    CLEAN_ROOM_ALLOWED_READ_ROOTS: roots.allowedReadRoots.join(path.delimiter),
    CLEAN_ROOM_SCHEMA_DIR: roots.schemaDir,
    CLEAN_ROOM_SELECTED_UNIT_ID: unit.unit_id,
    CLEAN_ROOM_SPEC_SLICE_REF: manifest.loop_context.spec_slice_ref,
    CLEAN_ROOM_CONTROLLER_ITERATION: String(iteration),
    CLEAN_ROOM_CONTROLLER_PHASE: stage.phase,
  };
}

function runStage(stage, configDir, roots, manifest, unit, iteration) {
  const cwd = resolvePath(stage.cwd, configDir);
  const timeout = stage.timeout_ms || DEFAULT_TIMEOUT_MS;
  const result = spawnSync(stage.argv[0], stage.argv.slice(1), {
    cwd,
    env: stageEnv(stage, roots, manifest, unit, iteration),
    input: stagePrompt(stage, manifest, unit, iteration),
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    phase: stage.phase,
    role: stage.role,
    status: result.status === 0 ? 'passed' : 'failed',
    signal: result.signal || null,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr || result.error?.message || ''),
  };
}

function truncateOutput(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= 4096) {
    return text;
  }
  return `${text.slice(0, 4096)}\n[truncated]`;
}

function abstractTickets(...sources) {
  const tickets = [];
  for (const source of sources) {
    for (const ticket of source?.abstract_delta_tickets || []) {
      if (ticket && typeof ticket === 'object' && typeof ticket.summary === 'string') {
        tickets.push(sanitizeTicket(ticket));
      }
    }
  }
  return tickets;
}

function sanitizeTicket(ticket) {
  const clean = { summary: ticket.summary };
  for (const key of ['ticket_id', 'kind', 'requested_clean_change', 'status']) {
    if (typeof ticket[key] === 'string') {
      clean[key] = ticket[key];
    }
  }
  return clean;
}

function inferTerminalResult(manifest, roots, selectedUnit) {
  const report = readOptionalJson(path.join(roots.cleanRoot, 'implementation-report.json'));
  const qc = readOptionalJson(path.join(roots.cleanRoot, 'qc-report.json'));
  const coverage = readOptionalJson(path.join(roots.contaminatedRoot, 'coverage-ledger.json'));
  const state = coverageMap(coverage).get(selectedUnit.unit_id);
  const tickets = abstractTickets(report, qc, coverage);

  if (report?.final_status === 'quarantined' || qc?.final_status === 'quarantined' || qc?.leakage_status === 'failed') {
    return buildResult(manifest, 'contamination-suspected', coverageState(state, qc), report, qc, tickets);
  }
  if (tickets.some((ticket) => ticket.status !== 'resolved')) {
    return buildResult(manifest, 'spec-delta-required', coverageState(state, qc), report, qc, tickets);
  }
  if (report?.final_status === 'blocked' || qc?.final_status === 'blocked' || selectedUnit.status === 'blocked') {
    return buildResult(manifest, 'spec-slice-blocked', coverageState(state, qc), report, qc, tickets);
  }
  if (state === 'covered' || (qc?.coverage_status === 'complete' && qc?.final_status === 'passed')) {
    return buildResult(manifest, 'spec-slice-complete', 'complete', report, qc, tickets);
  }
  return null;
}

function coverageState(sourceState, qc) {
  if (sourceState === 'covered' || qc?.coverage_status === 'complete') return 'complete';
  if (sourceState === 'blocked' || qc?.coverage_status === 'blocked') return 'blocked';
  if (sourceState === 'gap' || qc?.coverage_status === 'partial') return 'partial';
  return 'not-run';
}

function buildResult(manifest, result, coverage_state, implementationReport, qcReport, tickets = []) {
  void implementationReport;
  void qcReport;
  return {
    task_id: manifest.task_id,
    result,
    spec_slice_ref: manifest.loop_context.spec_slice_ref,
    coverage_state,
    terminal_report_ref: manifest.implementation_status?.report_ref || 'implementation-report.json',
    qc_report_ref: 'qc-report.json',
    abstract_delta_tickets: tickets,
    returned_at: new Date().toISOString(),
  };
}

function noProgressResult(manifest) {
  return buildResult(manifest, 'no-progress-detected', 'partial', null, null, [
    {
      kind: 'other',
      summary: 'The inner clean-room loop produced no durable artifact changes.',
      status: 'open',
    },
  ]);
}

function iterationLimitResult(manifest) {
  return buildResult(manifest, 'iteration-limit-reached', 'partial', null, null, [
    {
      kind: 'other',
      summary: 'The inner clean-room loop reached its configured iteration limit.',
      status: 'open',
    },
  ]);
}

function stageFailureResult(manifest, stageResult) {
  return buildResult(manifest, 'spec-slice-blocked', 'blocked', null, null, [
    {
      kind: 'other',
      summary: `${stageResult.phase} failed before the selected spec slice reached a terminal clean-room result.`,
      status: 'open',
    },
  ]);
}

function validateResult(result) {
  if (!TERMINAL_RESULTS.has(result.result)) {
    throw new Error(`unsupported clean-room result: ${result.result}`);
  }
}

function writeResult(resultPath, result) {
  validateResult(result);
  writeJsonFile(resultPath, result);
}

function loadLedger(ledgerPath, manifest) {
  const existing = readOptionalJson(ledgerPath);
  if (existing && Array.isArray(existing.iterations)) {
    return existing;
  }
  return {
    ledger_id: 'controller-run-ledger',
    task_id: manifest.task_id,
    updated_at: new Date().toISOString(),
    loop_context: {
      parent_loop_ref: manifest.loop_context.parent_loop_ref,
      spec_slice_ref: manifest.loop_context.spec_slice_ref,
    },
    iterations: [],
  };
}

function writeLedger(ledgerPath, ledger) {
  if (ledger.iterations.length > MAX_LEDGER_ITERATIONS) {
    const pruned = ledger.iterations.length - MAX_LEDGER_ITERATIONS;
    const priorPruned = Number.isInteger(ledger.pruned_iteration_count) && ledger.pruned_iteration_count > 0
      ? ledger.pruned_iteration_count
      : 0;
    ledger.iterations = ledger.iterations.slice(-MAX_LEDGER_ITERATIONS);
    ledger.pruned_iteration_count = priorPruned + pruned;
  }
  ledger.updated_at = new Date().toISOString();
  writeJsonFile(ledgerPath, ledger);
}

async function withRunLock(contaminatedRoot, dryRun, fn) {
  if (dryRun) return fn();
  fs.mkdirSync(contaminatedRoot, { recursive: true });
  const lockPath = path.join(contaminatedRoot, RUN_LOCK_NAME);
  const deadline = Date.now() + RUN_LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      atomicWriteFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`,
        'utf8'
      );
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`clean-room run lock is held: ${lockPath}`);
      sleep(RUN_LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function previousIteration(ledger) {
  return ledger.iterations[ledger.iterations.length - 1] || null;
}

function repeatedUnitSelection(previous, selectedUnit) {
  return previous?.unit_id === selectedUnit.unit_id && previous?.stop_reason === 'no-progress-detected';
}

async function runCleanRoom(options, context = {}) {
  if (options.help) {
    printRunHelp();
    return null;
  }
  if (!options.taskManifest) {
    throw new Error('--task-manifest is required');
  }
  if (!options.dryRun && !options.agentCommands) {
    throw new Error('--agent-commands is required unless --dry-run is set');
  }

  const taskManifestPath = resolvePath(options.taskManifest, context.cwd || process.cwd());
  const manifestDir = path.dirname(taskManifestPath);
  const manifest = readJsonFile(taskManifestPath, null);
  validateTaskManifestForRun(manifest);
  verifyPreflightGoal(manifest, manifestDir);
  const schemaDir = options.schemaDir ? resolvePath(options.schemaDir, context.cwd || process.cwd()) : defaultSchemaDir();
  const roots = resolveRoots(manifest, manifestDir, schemaDir);
  const cap = effectiveIterationCap(manifest, options);
  const agentConfigPath = options.agentCommands ? resolvePath(options.agentCommands, context.cwd || process.cwd()) : null;
  const agentConfig = agentConfigPath ? readJsonFile(agentConfigPath, null) : null;
  const configDir = agentConfigPath ? path.dirname(agentConfigPath) : process.cwd();
  if (agentConfig) {
    validateCommandConfig(agentConfig);
  }

  return withRunLock(roots.contaminatedRoot, options.dryRun, async () => {
    validateArtifacts(options.python, taskManifestPath, roots);
    const coverageLedger = readOptionalJson(path.join(roots.contaminatedRoot, 'coverage-ledger.json'));
    const selectedUnit = selectUnit(manifest, coverageLedger);
    if (!selectedUnit) {
      const result = buildResult(manifest, 'spec-slice-complete', 'complete', null, null, []);
      if (!options.dryRun) writeResult(path.join(roots.contaminatedRoot, RESULT_NAME), result);
      console.log(`clean-room run: ${result.result}`);
      return result;
    }

    const ledgerPath = path.join(roots.contaminatedRoot, LEDGER_NAME);
    const resultPath = path.join(roots.contaminatedRoot, RESULT_NAME);
    const ledger = loadLedger(ledgerPath, manifest);
    const previous = previousIteration(ledger);
    if (repeatedUnitSelection(previous, selectedUnit)) {
      const result = buildResult(manifest, 'no-progress-detected', 'partial', null, null, [
        {
          kind: 'other',
          summary: 'The same unit was selected again after a no-progress iteration.',
          status: 'open',
        },
      ]);
      if (!options.dryRun) {
        writeResult(resultPath, result);
        ledger.iterations.push({
          iteration: ledger.iterations.length + 1,
          unit_id: selectedUnit.unit_id,
          stop_reason: 'repeated-unit-selection',
          phases: [],
        });
        writeLedger(ledgerPath, ledger);
      }
      console.log('clean-room run: repeated-unit-selection');
      return result;
    }

    if (options.dryRun) {
      console.log(`clean-room run dry-run: selected ${selectedUnit.unit_id}`);
      console.log(`clean-room run dry-run: spec slice ${manifest.loop_context.spec_slice_ref}`);
      console.log(`clean-room run dry-run: iteration cap ${cap}`);
      return {
        selected_unit_id: selectedUnit.unit_id,
        spec_slice_ref: manifest.loop_context.spec_slice_ref,
        iteration_cap: cap,
      };
    }

    let terminalResult = null;
    for (let offset = 0; offset < cap; offset += 1) {
      const iteration = (manifest.loop_context.inner_iteration || 0) + offset + 1;
      const before = artifactSnapshot(taskManifestPath, roots);
      const phaseResults = [];
      let coveragePhaseRan = false;
      let failedStage = null;

      for (const stage of agentConfig.stages) {
        const stageResult = runStage(stage, configDir, roots, manifest, selectedUnit, iteration);
        phaseResults.push(stageResult);
        validateArtifacts(options.python, taskManifestPath, roots);
        if (stage.phase === REQUIRED_COVERAGE_PHASE && stageResult.status === 'passed') {
          coveragePhaseRan = true;
        }
        if (stageResult.status !== 'passed') {
          failedStage = stageResult;
          break;
        }
      }

      const after = artifactSnapshot(taskManifestPath, roots);
      const progressDetected = !snapshotsEqual(before, after);
      const ledgerEntry = {
        iteration,
        unit_id: selectedUnit.unit_id,
        spec_slice_ref: manifest.loop_context.spec_slice_ref,
        phases: phaseResults,
        progress_detected: progressDetected,
      };

      if (failedStage) {
        terminalResult = stageFailureResult(manifest, failedStage);
        ledgerEntry.stop_reason = 'spec-slice-blocked';
      } else if (!progressDetected) {
        terminalResult = noProgressResult(manifest);
        ledgerEntry.stop_reason = 'no-progress-detected';
      } else if (coveragePhaseRan) {
        terminalResult = inferTerminalResult(manifest, roots, selectedUnit);
        if (terminalResult) {
          ledgerEntry.stop_reason = terminalResult.result;
        }
      }

      ledger.iterations.push(ledgerEntry);
      writeLedger(ledgerPath, ledger);
      if (terminalResult) {
        break;
      }
    }

    if (!terminalResult) {
      terminalResult = iterationLimitResult(manifest);
    }
    writeResult(resultPath, terminalResult);
    validateArtifacts(options.python, taskManifestPath, roots);
    console.log(`clean-room run: ${terminalResult.result}`);
    return terminalResult;
  });
}

module.exports = {
  parseRunArgs,
  printRunHelp,
  runCleanRoom,
  validateCommandConfig,
  validateTaskManifestForRun,
};
