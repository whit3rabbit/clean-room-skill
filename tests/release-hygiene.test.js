'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_PATTERNS = [
  { name: 'macOS file URL', pattern: /file:\/\/\/Users\// },
  { name: 'macOS user path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'Linux user path', pattern: /\/home\/[A-Za-z0-9._-]+/ },
  { name: 'Windows user path', pattern: /[A-Za-z]:\\Users\\/ },
  { name: 'env file reference', pattern: /(^|[^A-Za-z0-9_])\.env(?:$|[^A-Za-z0-9_])/ },
  { name: 'OpenAI-style secret', pattern: /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'private key block', pattern: /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/ },
  { name: 'retained citation token', pattern: /cite|turn[0-9]+(?:view|search)[0-9]+/ },
];

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) {
    return nodeSpawnSync(command, { timeout: TEST_TIMEOUT_MS, ...(args || {}) });
  }
  return nodeSpawnSync(command, args, { timeout: TEST_TIMEOUT_MS, ...(options || {}) });
}

function packagedFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const packages = JSON.parse(result.stdout);
  assert.equal(packages.length, 1);
  return packages[0].files.map((file) => file.path);
}

function readUtf8IfText(filePath) {
  const data = fs.readFileSync(path.join(ROOT, filePath));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

describe('release hygiene', () => {
  test('publish workflow creates a GitHub release after npm publish', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    const publishIndex = workflow.indexOf('- name: Publish package');
    const releaseIndex = workflow.indexOf('- name: Create GitHub release');
    assert.match(workflow, /permissions:\n  contents: write\n  id-token: write/);
    assert.ok(publishIndex > -1, 'publish step missing');
    assert.ok(releaseIndex > publishIndex, 'release step must run after npm publish');
    assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
    assert.match(workflow, /--generate-notes/);
    assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME"/);
    assert.match(workflow, /--draft=false/);
    assert.match(workflow, /--prerelease=false/);
  });

  test('package manifest declares Pi package skills', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.keywords.includes('pi-package'), true);
    assert.deepEqual(manifest.pi?.skills, ['./skills']);
  });

  test('research memo is not included in npm package contents', () => {
    assert.equal(packagedFiles().includes('docs/research-skill-spec.md'), false);
    assert.equal(packagedFiles().includes('docs/research/archive/ARCHIVED-research-skill-spec.md'), false);
  });

  test('packaged text does not include local paths, secrets, or stale citation tokens', () => {
    const offenders = [];
    for (const filePath of packagedFiles()) {
      const content = readUtf8IfText(filePath);
      if (content === null) continue;
      for (const { name, pattern } of BLOCKED_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${filePath}: ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
