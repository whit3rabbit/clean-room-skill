'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCAN_TARGETS = ['README.md', 'AGENTS.md', 'docs', 'skills', 'agents'];
const BLOCKED_PATTERNS = [/file:\/\/\/Users/, /\/Users\/whit3rabbit/];

function walkFiles(target) {
  const fullPath = path.join(ROOT, target);
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return [fullPath];

  const files = [];
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(child));
    } else if (entry.isFile()) {
      files.push(path.join(ROOT, child));
    }
  }
  return files;
}

describe('release hygiene', () => {
  test('docs and bundled text do not include local file URLs or user paths', () => {
    const offenders = [];
    for (const target of SCAN_TARGETS) {
      for (const filePath of walkFiles(target)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (BLOCKED_PATTERNS.some((pattern) => pattern.test(content))) {
          offenders.push(path.relative(ROOT, filePath));
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
