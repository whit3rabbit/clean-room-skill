'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

const CLAUDE_AGENT_METADATA = {
  'contaminated-manager-verifier.md': { model: 'opus', effort: 'high', color: 'purple' },
  'clean-architect.md': { model: 'opus', effort: 'high', color: 'blue' },
  'contaminated-source-analyst.md': { model: 'sonnet', effort: 'medium', color: 'orange' },
  'contaminated-handoff-sanitizer.md': { model: 'sonnet', effort: 'high', color: 'yellow' },
  'clean-qa-editor.md': { model: 'sonnet', effort: 'high', color: 'green' },
  'clean-implementer-verifier-shell.md': { model: 'sonnet', effort: 'high', color: 'cyan' },
  'clean-polish-reviewer.md': { model: 'sonnet', effort: 'high', color: 'pink' },
};

const CODEX_AGENT_METADATA = {
  'contaminated-manager-verifier.toml': { model: 'gpt-5.5', effort: 'high' },
  'clean-architect.toml': { model: 'gpt-5.5', effort: 'high' },
  'contaminated-source-analyst.toml': { model: 'gpt-5.4-mini', effort: 'medium' },
  'contaminated-handoff-sanitizer.toml': { model: 'gpt-5.4-mini', effort: 'high' },
  'clean-qa-editor.toml': { model: 'gpt-5.4-mini', effort: 'high' },
  'clean-polish-reviewer.toml': { model: 'gpt-5.4-mini', effort: 'high' },
};

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
}

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(match, 'expected YAML frontmatter');
  return Object.fromEntries(match[1]
    .split('\n')
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/))
    .filter(Boolean)
    .map((matchLine) => [matchLine[1], matchLine[2]]));
}

function tomlString(content, key) {
  const match = new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(content);
  assert.ok(match, `expected ${key}`);
  return match[1];
}

describe('runtime agent metadata', () => {
  test('Claude role agents declare documented model, effort, and color metadata', () => {
    for (const [fileName, expected] of Object.entries(CLAUDE_AGENT_METADATA)) {
      const frontmatter = parseFrontmatter(readRepoFile('agents', fileName));
      assert.equal(frontmatter.model, expected.model, fileName);
      assert.equal(frontmatter.effort, expected.effort, fileName);
      assert.equal(frontmatter.color, expected.color, fileName);
      assert.equal(frontmatter.memory, undefined, fileName);
    }
  });

  test('Codex role agents use Codex-compatible model metadata only', () => {
    for (const [fileName, expected] of Object.entries(CODEX_AGENT_METADATA)) {
      const content = readRepoFile('examples', 'codex', '.codex', 'agents', fileName);
      assert.equal(tomlString(content, 'model'), expected.model, fileName);
      assert.equal(tomlString(content, 'model_reasoning_effort'), expected.effort, fileName);
      assert.match(content, /^developer_instructions = """$/m, fileName);
      assert.doesNotMatch(content, /^instructions = /m, fileName);
      assert.doesNotMatch(content, /^enabled_skills = /m, fileName);
      assert.doesNotMatch(content, /\b(?:sonnet|opus)\b/i, fileName);
      assert.doesNotMatch(content, /^color = /m, fileName);
      assert.doesNotMatch(content, /^memory = /m, fileName);
    }
  });
});
