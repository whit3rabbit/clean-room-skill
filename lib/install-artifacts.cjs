'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  listFiles,
  readJsonFile,
} = require('./fs-utils.cjs');
const { OPENCODE_PLUGIN_MARKER } = require('./hooks.cjs');
const { resolveRuntimeLayout } = require('./runtime-layout.cjs');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const IGNORE_NAMES = new Set(['.DS_Store', '__pycache__', 'node_modules', '.syntext']);

function packageVersion() {
  const pkg = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'), null);
  return pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

function sourceFile(relPath) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relPath));
}

function addFile(desired, sourceRel, destRel) {
  desired.set(destRel.replace(/\\/g, '/'), sourceFile(sourceRel));
}

function addTree(desired, sourceRel, destRel, options = {}) {
  const sourceRoot = path.join(PACKAGE_ROOT, sourceRel);
  for (const rel of listFiles(sourceRoot, { ignoreNames: IGNORE_NAMES })) {
    if (options.filter && !options.filter(rel)) continue;
    const sourcePath = `${sourceRel}/${rel}`.replace(/\\/g, '/');
    const destPath = destRel ? `${destRel}/${rel}` : rel;
    addFile(desired, sourcePath, destPath);
  }
}

function splitSkillFile(content) {
  if (!content.startsWith('---\n')) {
    return { frontmatter: '', body: content };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: '', body: content };
  }
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + '\n---\n'.length),
  };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function yamlString(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

function generateCommandWrapper(skillName) {
  const skillPath = path.join(PACKAGE_ROOT, 'skills', skillName, 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read skill file for command wrapper ${skillName}: ${err.message}`);
  }
  const { frontmatter, body } = splitSkillFile(content);
  const description = frontmatterValue(frontmatter, 'description') ||
    `Run the ${skillName} clean-room workflow.`;
  const argumentHint = frontmatterValue(frontmatter, 'argument-hint');
  const lines = [
    '---',
    `description: ${yamlString(description)}`,
  ];
  if (argumentHint) {
    lines.push(`argument-hint: ${yamlString(argumentHint)}`);
  }
  lines.push(
    '---',
    '',
    `# ${skillName}`,
    '',
    `Run the bundled \`${skillName}\` clean-room workflow using the user's command arguments.`,
    '',
    body.trimStart()
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function generatePluginManifest() {
  const source = readJsonFile(path.join(PACKAGE_ROOT, 'plugin.json'), {});
  const manifest = {
    name: 'clean-room',
    version: packageVersion(),
    description: 'Spec-first clean-room workflow for authorized source analysis without replacement code.',
    ...source,
    skills: './skills/',
    agents: './agents/',
  };
  delete manifest.hooks;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function generateOpenCodePlugin(layout, hookMode) {
  const wrapperPath = path.join(layout.targetRoot, 'hooks', 'clean-room', 'clean-room-hook.py');
  const mode = hookMode === 'strict' ? 'strict' : 'safe';
  return `import { spawn } from "node:child_process"

const CLEAN_ROOM_OPENCODE_PLUGIN_MARKER = ${JSON.stringify(OPENCODE_PLUGIN_MARKER)}
const CLEAN_ROOM_HOOK_MODE = ${JSON.stringify(mode)}
const CLEAN_ROOM_HOOK_WRAPPER = ${JSON.stringify(wrapperPath)}
const CLEAN_ROOM_HOOK_PYTHON = process.env.CLEAN_ROOM_HOOK_PYTHON || "python3"
const CLEAN_ROOM_HOOK_TIMEOUT_MS = 30_000
const MAX_HOOK_OUTPUT_CHARS = 256 * 1024

const CHECKS = {
  shell: ["require-clean-room-env.py", "deny-clean-room-shell.py"],
  read: ["require-clean-room-env.py", "deny-clean-source-read.py"],
  write: ["require-clean-room-env.py", "deny-contaminated-clean-write.py"],
  postWrite: [
    "require-clean-room-env.py",
    "check-artifact-leakage.py",
    "validate-json-schema.py",
    "validate-handoff-package.py",
  ],
}

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "powershell",
  "terminal",
  "exec_command",
  "shell_command",
  "writestdin",
  "write_stdin",
])

const READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "lsp",
  "notebookread",
  "viewimage",
  "view_image",
])

const DIRECTORY_READ_TOOLS = new Set(["glob", "grep", "list", "ls", "lsp"])
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "applypatch", "apply_patch"])
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"]

function normalizeTool(tool) {
  return String(tool || "").toLowerCase().replace(/[^a-z0-9_]/g, "")
}

function objectArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return { ...value }
}

function cwdFor(args, directory, worktree) {
  if (typeof args.cwd === "string" && args.cwd) return args.cwd
  if (typeof directory === "string" && directory) return directory
  if (typeof worktree === "string" && worktree) return worktree
  return process.cwd()
}

function withDirectoryFallbackPath(tool, args, cwd) {
  if (!DIRECTORY_READ_TOOLS.has(tool)) return args
  if (PATH_KEYS.some((key) => typeof args[key] === "string" && args[key])) return args
  return { ...args, path: cwd }
}

function hookPayload(input, args, directory, worktree) {
  const tool = input?.tool
  const normalized = normalizeTool(tool)
  const cwd = cwdFor(args, directory, worktree)
  return {
    tool_name: tool,
    tool,
    tool_input: withDirectoryFallbackPath(normalized, args, cwd),
    cwd,
    opencode: {
      sessionID: input?.sessionID,
      callID: input?.callID,
    },
  }
}

function hookArgs(checks) {
  const args = [CLEAN_ROOM_HOOK_WRAPPER, "--mode", CLEAN_ROOM_HOOK_MODE]
  for (const check of checks) args.push("--check", check)
  return args
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_HOOK_OUTPUT_CHARS) return current
  return (current + String(chunk)).slice(0, MAX_HOOK_OUTPUT_CHARS)
}

function runHook(label, checks, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLEAN_ROOM_HOOK_PYTHON, hookArgs(checks), {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill("SIGTERM")
      reject(new Error(\`clean-room \${label} hook timed out after \${CLEAN_ROOM_HOOK_TIMEOUT_MS}ms\`))
    }, CLEAN_ROOM_HOOK_TIMEOUT_MS)
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (status === 0) {
        resolve()
        return
      }
      const detail = (stderr || stdout || \`status \${status}\${signal ? \`, signal \${signal}\` : ""}\`).trim()
      reject(new Error(\`clean-room \${label} hook denied tool use: \${detail}\`))
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export const CleanRoomPlugin = async ({ directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = normalizeTool(input?.tool)
      const payload = hookPayload(input, objectArgs(output?.args), directory, worktree)
      if (SHELL_TOOLS.has(tool)) await runHook("shell", CHECKS.shell, payload)
      if (READ_TOOLS.has(tool)) await runHook("read", CHECKS.read, payload)
      if (WRITE_TOOLS.has(tool)) await runHook("write", CHECKS.write, payload)
    },
    "tool.execute.after": async (input) => {
      const tool = normalizeTool(input?.tool)
      if (!WRITE_TOOLS.has(tool)) return
      const payload = hookPayload(input, objectArgs(input?.args), directory, worktree)
      await runHook("post-write", CHECKS.postWrite, payload)
    },
  }
}
`;
}

function addCommandWrappers(desired, artifact) {
  const skillsRoot = path.join(PACKAGE_ROOT, artifact.source);
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const destName = `${artifact.commandPrefix || ''}${entry.name}.md`;
    const destRel = `${artifact.destSubpath}/${destName}`.replace(/\\/g, '/');
    desired.set(destRel, Buffer.from(generateCommandWrapper(entry.name), 'utf8'));
  }
}

function shouldInstallArtifact(artifact, hookMode) {
  if (!Array.isArray(artifact.hookModes)) return true;
  return artifact.hookModes.includes(hookMode);
}

function addArtifact(desired, artifact, layout, hookMode) {
  if (!shouldInstallArtifact(artifact, hookMode)) {
    return;
  }
  if (artifact.kind === 'skills' || artifact.kind === 'agents') {
    addTree(desired, artifact.source, artifact.destSubpath);
    return;
  }
  if (artifact.kind === 'hooks') {
    addTree(desired, artifact.source, artifact.destSubpath, {
      filter: (rel) => rel.endsWith('.py'),
    });
    return;
  }
  if (artifact.kind === 'commands') {
    addCommandWrappers(desired, artifact);
    return;
  }
  if (artifact.kind === 'plugin-manifest') {
    desired.set(artifact.destSubpath, Buffer.from(generatePluginManifest(), 'utf8'));
    return;
  }
  if (artifact.kind === 'opencode-plugin') {
    desired.set(artifact.destSubpath, Buffer.from(generateOpenCodePlugin(layout, hookMode), 'utf8'));
    return;
  }
  throw new Error(`unsupported artifact kind: ${artifact.kind}`);
}

function layoutFromInput(runtimeOrLayout, scope, configDir) {
  if (runtimeOrLayout && typeof runtimeOrLayout === 'object') {
    return runtimeOrLayout;
  }
  return resolveRuntimeLayout(runtimeOrLayout, scope, { configDir });
}

function buildDesiredFiles(runtimeOrLayout, hookMode, scope = 'global', configDir = null) {
  hookMode = hookMode || 'safe';
  const layout = layoutFromInput(runtimeOrLayout, scope, configDir);
  const desired = new Map();
  for (const artifact of layout.artifacts) {
    addArtifact(desired, artifact, layout, hookMode);
  }
  return desired;
}

module.exports = {
  buildDesiredFiles,
  packageVersion,
};
