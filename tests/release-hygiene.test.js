'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.py',
  '.sh',
  '.svg',
  '.toml',
  '.txt',
  '.yml',
]);
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

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath));
}

describe('release hygiene', () => {
  test('research memo is not included in npm package contents', () => {
    assert.equal(packagedFiles().includes('docs/research-skill-spec.md'), false);
  });

  test('packaged text does not include local paths, secrets, or stale citation tokens', () => {
    const offenders = [];
    for (const filePath of packagedFiles()) {
      if (!isTextFile(filePath)) continue;
      const content = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
      for (const { name, pattern } of BLOCKED_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${filePath}: ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
