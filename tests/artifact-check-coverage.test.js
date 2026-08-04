'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { copyExample, tempDir } = require('./helpers/hook-policy.cjs');
const { runArtifact } = require('../lib/artifact.cjs');
const { validateSpecPlanPublicSurfaceJoin } = require('../lib/run-coverage.cjs');

const OBLIGATION_REF = 'public_surface:spec-example-flow:command-line-option:--example-flag';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

describe('artifact check-coverage: post-plan public_surface join', () => {
  test('passes when the plan carries the spec-id-based ref the spec itself lists', () => {
    const dir = tempDir('check-coverage-pass');
    const specPath = copyExample('behavior-spec.json', dir);
    const planPath = copyExample('implementation-plan.json', dir);

    const result = runArtifact(['check-coverage', '--spec', specPath, '--plan', planPath]);
    assert.equal(result.mode, 'plan-join');
    assert.equal(result.obligations, 1);
  });

  test('fails when the plan ref is built from unit_id instead of spec_id (the run-1/2/3 regression)', () => {
    const dir = tempDir('check-coverage-unit-id-mismatch');
    const specPath = copyExample('behavior-spec.json', dir);
    const planPath = copyExample('implementation-plan.json', dir);
    const plan = readJson(planPath);
    plan.work_items[0].public_contract_refs = ['public_surface:unit-example-flow:command-line-option:--example-flag'];
    writeJson(planPath, plan);

    assert.throws(
      () => runArtifact(['check-coverage', '--spec', specPath, '--plan', planPath]),
      /public_surface obligation missing from implementation plan public_contract_refs.*spec-example-flow/,
    );
  });

  test('fails when the spec never lists the ref in any test_scenarios coverage', () => {
    const dir = tempDir('check-coverage-spec-side-gap');
    const specPath = copyExample('behavior-spec.json', dir);
    const planPath = copyExample('implementation-plan.json', dir);
    const spec = readJson(specPath);
    spec.test_scenarios[0].coverage = ['claim-001'];
    writeJson(specPath, spec);

    assert.throws(
      () => runArtifact(['check-coverage', '--spec', specPath, '--plan', planPath]),
      /public_surface obligation missing from behavior spec test coverage/,
    );
  });

  test('is a no-op for a spec with no public_surface items', () => {
    const dir = tempDir('check-coverage-empty-surface');
    const specPath = copyExample('behavior-spec.json', dir);
    const planPath = copyExample('implementation-plan.json', dir);
    const spec = readJson(specPath);
    spec.public_surface = [];
    writeJson(specPath, spec);
    const plan = readJson(planPath);
    plan.work_items[0].public_contract_refs = [];
    writeJson(planPath, plan);

    const result = runArtifact(['check-coverage', '--spec', specPath, '--plan', planPath]);
    assert.equal(result.obligations, 0);
  });

  test('requires both --spec and --plan together', () => {
    const dir = tempDir('check-coverage-missing-args');
    const specPath = copyExample('behavior-spec.json', dir);

    assert.throws(
      () => runArtifact(['check-coverage', '--spec', specPath]),
      /requires at least one --spec and --plan/,
    );
  });

  test('errors with neither plan-join nor task-manifest inputs', () => {
    assert.throws(
      () => runArtifact(['check-coverage']),
      /requires either \(--spec \+ --plan\) or \(--task-manifest/,
    );
  });
});

describe('validateSpecPlanPublicSurfaceJoin (unit-level)', () => {
  test('reports the obligation count it checked', () => {
    const dir = tempDir('validate-spec-plan-unit');
    const specPath = copyExample('behavior-spec.json', dir);
    const planPath = copyExample('implementation-plan.json', dir);
    const spec = readJson(specPath);
    const plan = readJson(planPath);

    const result = validateSpecPlanPublicSurfaceJoin(specPath, spec, plan);
    assert.deepEqual(result, { obligationCount: 1 });
  });

  test('throws naming the exact unmatched ref, not a generic failure', () => {
    const dir = tempDir('validate-spec-plan-unit-fail');
    const specPath = copyExample('behavior-spec.json', dir);
    const plan = { work_items: [{ work_item_id: 'work-example-flow', public_contract_refs: [] }] };
    const spec = readJson(specPath);

    assert.throws(
      () => validateSpecPlanPublicSurfaceJoin(specPath, spec, plan),
      new RegExp(OBLIGATION_REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});
