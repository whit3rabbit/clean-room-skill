'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  listFiles,
  readJsonFile,
} = require('./fs-utils.cjs');
const { resolveRuntimeLayout } = require('./runtime-layout.cjs');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const IGNORE_NAMES = new Set(['.DS_Store', '__pycache__', 'node_modules', '.syntext']);

function packageVersion() {
  const pkg = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'), null);
  return pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

function sourceFile(relPath, hookMode) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relPath));
}

function addFile(desired, sourceRel, destRel, hookMode) {
  desired.set(destRel.replace(/\\/g, '/'), sourceFile(sourceRel, hookMode));
}

function addTree(desired, sourceRel, destRel, hookMode, options = {}) {
  const sourceRoot = path.join(PACKAGE_ROOT, sourceRel);
  for (const rel of listFiles(sourceRoot, { ignoreNames: IGNORE_NAMES })) {
    if (options.filter && !options.filter(rel)) continue;
    const sourcePath = `${sourceRel}/${rel}`.replace(/\\/g, '/');
    const destPath = destRel ? `${destRel}/${rel}` : rel;
    addFile(desired, sourcePath, destPath, hookMode);
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

function addArtifact(desired, artifact, hookMode) {
  if (artifact.kind === 'skills' || artifact.kind === 'agents') {
    addTree(desired, artifact.source, artifact.destSubpath, hookMode);
    return;
  }
  if (artifact.kind === 'hooks') {
    addTree(desired, artifact.source, artifact.destSubpath, hookMode, {
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
  throw new Error(`unsupported artifact kind: ${artifact.kind}`);
}

function layoutFromInput(runtimeOrLayout, scope, configDir) {
  if (runtimeOrLayout && typeof runtimeOrLayout === 'object') {
    return runtimeOrLayout;
  }
  return resolveRuntimeLayout(runtimeOrLayout, scope, { configDir });
}

function buildDesiredFiles(runtimeOrLayout, hookMode, scope = 'global', configDir = null) {
  const layout = layoutFromInput(runtimeOrLayout, scope, configDir);
  const desired = new Map();
  for (const artifact of layout.artifacts) {
    addArtifact(desired, artifact, hookMode);
  }
  return desired;
}

module.exports = {
  buildDesiredFiles,
  packageVersion,
};
