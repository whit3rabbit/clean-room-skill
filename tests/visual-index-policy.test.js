'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const {
  mkdirs,
  ROOT,
  tempDir,
  VISUAL_INDEX,
} = require('./helpers/hook-policy.cjs');

const TEST_TIMEOUT_MS = 30_000;

function spawnSync(command, args, options) {
  if (!Array.isArray(args)) {
    return nodeSpawnSync(command, { timeout: TEST_TIMEOUT_MS, ...(args || {}) });
  }
  return nodeSpawnSync(command, args, { timeout: TEST_TIMEOUT_MS, ...(options || {}) });
}

function pngBytes(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  data[24] = 8;
  data[25] = 2;
  return data;
}

function gifBytes(width, height) {
  const data = Buffer.alloc(10);
  data.write('GIF89a', 0, 'ascii');
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runVisualIndex(args, env = process.env) {
  return spawnSync('python3', [VISUAL_INDEX, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('clean-room visual-index policy', () => {
  test('visual-index builder records supported image metadata and batches', () => {
    const root = tempDir('clean-room-visual-index-valid');
    const visual = path.join(root, 'screenshots');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(path.join(visual, 'flow'), contaminated);
    const png = pngBytes(1440, 900);
    const gif = gifBytes(320, 240);
    fs.writeFileSync(path.join(visual, 'flow', 'step-01.png'), png);
    fs.writeFileSync(path.join(visual, 'flow', 'step-02.gif'), gif);
    const output = path.join(contaminated, 'visual-index.json');

    const result = runVisualIndex([
      '--visual-root', visual,
      '--output', output,
      '--task-id', 'task-test',
      '--max-batch-items', '1',
    ], { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated });

    assert.equal(result.status, 0, result.stderr);
    const index = readJson(output);
    assert.equal(index.images.length, 2);
    assert.equal(index.recommended_batches.length, 2);
    assert.deepEqual(index.images.map((image) => image.path), ['flow/step-01.png', 'flow/step-02.gif']);
    assert.equal(index.images[0].media_type, 'image/png');
    assert.equal(index.images[0].width, 1440);
    assert.equal(index.images[0].height, 900);
    assert.equal(index.images[0].sha256, crypto.createHash('sha256').update(png).digest('hex'));
    assert.equal(index.images[1].media_type, 'image/gif');
    assert.deepEqual(index.aggregate_metrics.media_type_counts, { 'image/gif': 1, 'image/png': 1 });
  });

  test('visual-index builder refuses output outside contaminated artifact roots', () => {
    const root = tempDir('clean-room-visual-index-output');
    const visual = path.join(root, 'screenshots');
    const contaminated = path.join(root, 'contaminated');
    const outside = path.join(root, 'clean', 'visual-index.json');
    mkdirs(visual, contaminated, path.dirname(outside));
    fs.writeFileSync(path.join(visual, 'screen.png'), pngBytes(100, 80));

    const result = runVisualIndex([
      '--visual-root', visual,
      '--output', outside,
      '--task-id', 'task-test',
    ], { ...process.env, CLEAN_ROOM_CONTAMINATED_ARTIFACT_ROOTS: contaminated });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--output must be under a contaminated artifact root/);
    assert.equal(fs.existsSync(outside), false);
  });

  test('visual-index builder rejects overlapping visual and contaminated roots', () => {
    const root = tempDir('clean-room-visual-index-overlap');
    const visual = path.join(root, 'screenshots');
    const nested = path.join(visual, 'nested');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(nested, contaminated);
    fs.writeFileSync(path.join(visual, 'screen.png'), pngBytes(100, 80));

    const cases = [
      {
        name: 'visual-under-contaminated',
        visualRoots: [path.join(contaminated, 'screenshots')],
        contaminatedRoot: contaminated,
        output: path.join(contaminated, 'visual-index.json'),
        message: /visual roots and contaminated artifact roots must be separate/,
      },
      {
        name: 'contaminated-under-visual',
        visualRoots: [visual],
        contaminatedRoot: path.join(visual, 'contaminated'),
        output: path.join(visual, 'contaminated', 'visual-index.json'),
        message: /--output must not be under a visual root/,
      },
      {
        name: 'nested-visual-roots',
        visualRoots: [visual, nested],
        contaminatedRoot: contaminated,
        output: path.join(contaminated, 'visual-index.json'),
        message: /visual roots must not overlap/,
      },
    ];

    for (const item of cases) {
      for (const visualRoot of item.visualRoots) {
        mkdirs(visualRoot);
      }
      mkdirs(item.contaminatedRoot);
      const args = [
        '--output', item.output,
        '--contaminated-artifact-root', item.contaminatedRoot,
        '--task-id', `task-${item.name}`,
      ];
      for (const visualRoot of item.visualRoots) {
        args.push('--visual-root', visualRoot);
      }
      const result = runVisualIndex(args);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.message, item.name);
      assert.equal(fs.existsSync(item.output), false, item.name);
    }
  });

  test('visual-index builder records unsupported formats and file limits as skipped entries', () => {
    const root = tempDir('clean-room-visual-index-limits');
    const visual = path.join(root, 'screenshots');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(visual, contaminated);
    fs.writeFileSync(path.join(visual, 'a.png'), pngBytes(10, 10));
    fs.writeFileSync(path.join(visual, 'b.png'), pngBytes(20, 20));
    fs.writeFileSync(path.join(visual, 'notes.txt'), 'not an image\n');
    const output = path.join(contaminated, 'visual-index.json');

    const result = runVisualIndex([
      '--visual-root', visual,
      '--output', output,
      '--contaminated-artifact-root', contaminated,
      '--task-id', 'task-test',
      '--max-files', '1',
      '--max-file-bytes', '20',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const index = readJson(output);
    assert.equal(index.images.length, 0);
    assert.equal(index.skipped_entries.some((entry) => entry.path === 'a.png' && entry.reason === 'file-byte-limit'), true);
    assert.equal(index.skipped_entries.some((entry) => entry.path === 'b.png' && entry.reason === 'file-byte-limit'), true);
    assert.equal(index.skipped_entries.some((entry) => entry.path === 'notes.txt' && entry.reason === 'unsupported-format'), true);

    const countRoot = tempDir('clean-room-visual-index-file-count');
    const countVisual = path.join(countRoot, 'screenshots');
    const countContaminated = path.join(countRoot, 'contaminated');
    mkdirs(countVisual, countContaminated);
    fs.writeFileSync(path.join(countVisual, 'a.png'), pngBytes(10, 10));
    fs.writeFileSync(path.join(countVisual, 'b.png'), pngBytes(20, 20));
    const countOutput = path.join(countContaminated, 'visual-index.json');

    const countResult = runVisualIndex([
      '--visual-root', countVisual,
      '--output', countOutput,
      '--contaminated-artifact-root', countContaminated,
      '--task-id', 'task-test',
      '--max-files', '1',
    ]);

    assert.equal(countResult.status, 0, countResult.stderr);
    const countIndex = readJson(countOutput);
    assert.equal(countIndex.images.length, 1);
    assert.equal(
      countIndex.skipped_entries.some((entry) =>
        entry.kind === 'directory' && entry.reason === 'remaining-files-skipped-after-limit:file-count-limit'
      ),
      true
    );
  });

  test('visual-index builder skips symlinks outside visual roots', () => {
    const root = tempDir('clean-room-visual-index-symlink');
    const visual = path.join(root, 'screenshots');
    const outside = path.join(root, 'outside');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(visual, outside, contaminated);
    fs.writeFileSync(path.join(outside, 'external.png'), pngBytes(10, 10));
    fs.symlinkSync(path.join(outside, 'external.png'), path.join(visual, 'external.png'));
    const output = path.join(contaminated, 'visual-index.json');

    const result = runVisualIndex([
      '--visual-root', visual,
      '--output', output,
      '--contaminated-artifact-root', contaminated,
      '--task-id', 'task-test',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const index = readJson(output);
    assert.equal(index.images.length, 0);
    assert.equal(index.skipped_entries.some((entry) => entry.path === 'external.png' && entry.reason === 'symlink-outside-root'), true);
  });

  test('visual-index builder records files that change during read as skipped', () => {
    const root = tempDir('clean-room-visual-index-changed');
    const visual = path.join(root, 'screenshots');
    const contaminated = path.join(root, 'contaminated');
    mkdirs(visual, contaminated);
    fs.writeFileSync(path.join(visual, 'mutable.png'), pngBytes(10, 10));

    const script = `
import argparse
import importlib.util
import json
import pathlib
import sys

module_path = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(module_path.parent))
spec = importlib.util.spec_from_file_location("build_visual_index", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

visual = pathlib.Path(sys.argv[2]).resolve()
contaminated = pathlib.Path(sys.argv[3]).resolve()
target = visual / "mutable.png"
original_read_bytes = pathlib.Path.read_bytes

def patched_read_bytes(self):
    data = original_read_bytes(self)
    if self.resolve() == target:
        self.write_bytes(data + b"x")
    return data

pathlib.Path.read_bytes = patched_read_bytes
args = argparse.Namespace(
    visual_root=[str(visual)],
    output=str(contaminated / "visual-index.json"),
    contaminated_artifact_root=[str(contaminated)],
    task_id="task-test",
    max_files=10,
    max_file_bytes=1000,
    max_total_bytes=1000,
    max_batch_items=10,
    ignore_dir=[],
)
roots = module.visual_roots(args.visual_root)
images, skipped_entries, counters = module.collect_images(args, roots)
print(json.dumps({"images": images, "skipped_entries": skipped_entries, "counters": counters}))
`;

    const result = spawnSync('python3', ['-c', script, VISUAL_INDEX, visual, contaminated], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.images.length, 0);
    assert.equal(data.skipped_entries.some((entry) => entry.path === 'mutable.png' && entry.reason === 'changed-during-read'), true);
  });
});
