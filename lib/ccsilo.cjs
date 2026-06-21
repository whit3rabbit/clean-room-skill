'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAUDE_EXECUTABLE_ENV,
  assertClaudeExecutable,
} = require('./install-claude-plugin.cjs');

const CCSILO_REL_ROOT = path.join('Library', 'Application Support', 'ccsilo');

function variantNameIsSafe(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function requiredCcsiloVariantName(value) {
  if (!variantNameIsSafe(value)) {
    throw new Error('--ccsilo variant name must contain only letters, numbers, dots, underscores, or hyphens');
  }
  return value;
}

function ccsiloBaseRoot(env = process.env, homeDir = os.homedir()) {
  return env.CCSILO_ROOT
    ? path.resolve(env.CCSILO_ROOT)
    : path.join(homeDir, CCSILO_REL_ROOT);
}

function inferVariantRootFromConfigDir(configDir, homeDir = os.homedir()) {
  if (!configDir) return null;
  const resolved = path.resolve(configDir);
  if (path.basename(resolved) !== 'config') return null;
  const variantRoot = path.dirname(resolved);
  const variantsRoot = path.dirname(variantRoot);
  if (path.basename(variantsRoot) !== 'variants') return null;
  const ccsiloRoot = path.dirname(variantsRoot);
  if (path.basename(ccsiloRoot) !== 'ccsilo') return null;
  const variant = path.basename(variantRoot);
  if (!variantNameIsSafe(variant)) return null;
  const defaultRoot = path.resolve(ccsiloBaseRoot({}, homeDir));
  const resolvedRoot = path.resolve(ccsiloRoot);
  if (resolvedRoot !== defaultRoot && !resolvedRoot.endsWith(`${path.sep}ccsilo`)) return null;
  return { variant, variantRoot };
}

function readVariantJson(variantRoot) {
  const variantPath = path.join(variantRoot, 'variant.json');
  if (!fs.existsSync(variantPath)) {
    throw new Error(`ccsilo variant.json not found: ${variantPath}`);
  }
  try {
    return { variantPath, variant: JSON.parse(fs.readFileSync(variantPath, 'utf8')) };
  } catch (err) {
    throw new Error(`ccsilo variant.json is invalid: ${variantPath}; ${err.message}`);
  }
}

function resolveVariantPath(variantRoot, value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`ccsilo variant ${label} is missing`);
  }
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(variantRoot, value);
}

function wrapperFromVariant(variant) {
  if (typeof variant?.paths?.wrapper === 'string' && variant.paths.wrapper !== '') {
    return variant.paths.wrapper;
  }
  const installs = Array.isArray(variant?.installs) ? variant.installs : [];
  const installed = installs.find((item) => typeof item?.path === 'string' && item.path !== '');
  return installed?.path || null;
}

function resolveCcsiloVariant(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  let variant = options.variant || null;
  let variantRoot;

  if (variant) {
    variant = requiredCcsiloVariantName(variant);
    variantRoot = path.join(ccsiloBaseRoot(env, homeDir), 'variants', variant);
  } else {
    const inferred = inferVariantRootFromConfigDir(env.CLAUDE_CONFIG_DIR, homeDir);
    if (!inferred) {
      throw new Error('--ccsilo requires a variant name unless CLAUDE_CONFIG_DIR points inside a ccsilo variant config directory');
    }
    variant = inferred.variant;
    variantRoot = inferred.variantRoot;
  }

  const { variantPath, variant: manifest } = readVariantJson(variantRoot);
  const configDir = resolveVariantPath(variantRoot, manifest?.paths?.configDir, 'paths.configDir');
  const wrapper = assertClaudeExecutable(
    resolveVariantPath(variantRoot, wrapperFromVariant(manifest), 'paths.wrapper or installs[].path'),
    'ccsilo wrapper'
  );

  return {
    variant,
    variantRoot,
    variantPath,
    configDir,
    wrapper,
    env: manifest?.['env'] && typeof manifest['env'] === 'object' && !Array.isArray(manifest['env']) ? manifest['env'] : {},
    credential: manifest?.credential && typeof manifest.credential === 'object' && !Array.isArray(manifest.credential)
      ? manifest.credential
      : null,
  };
}

function readCcsiloVariantArg(argv, index) {
  const next = argv[index + 1];
  if (next && !next.startsWith('--')) {
    return { value: next, nextIndex: index + 1 };
  }
  return { value: true, nextIndex: index };
}

function applyCcsiloInstallOptions(options) {
  if (!options.ccsilo) return options;
  if (options.configDir) {
    throw new Error('--ccsilo conflicts with --config-dir');
  }
  if (options.scope && options.scope !== 'global') {
    throw new Error('--ccsilo supports only --global Claude installs');
  }
  if (options.runtimes.length > 0 && !(options.runtimes.length === 1 && options.runtimes[0] === 'claude')) {
    throw new Error('--ccsilo can only be used with Claude');
  }
  const resolved = resolveCcsiloVariant({
    variant: options.ccsiloVariant,
  });
  options.runtimes = ['claude'];
  options.scope = 'global';
  options.configDir = resolved.configDir;
  options.ccsiloResolved = resolved;
  process.env[CLAUDE_EXECUTABLE_ENV] = resolved.wrapper;
  return options;
}

function applyCcsiloDoctorOptions(options) {
  if (!options.ccsilo) return options;
  if (options.configDir) {
    throw new Error('--ccsilo conflicts with --config-dir');
  }
  if (options.scope && options.scope !== 'global') {
    throw new Error('--ccsilo supports only --global Claude installs');
  }
  if (options.runtime && options.runtime !== 'claude') {
    throw new Error('--ccsilo can only be used with Claude');
  }
  const resolved = resolveCcsiloVariant({
    variant: options.ccsiloVariant,
  });
  options.runtime = 'claude';
  options.scope = 'global';
  options.configDir = resolved.configDir;
  options.ccsiloResolved = resolved;
  process.env[CLAUDE_EXECUTABLE_ENV] = resolved.wrapper;
  return options;
}

function applyCcsiloRunOptions(options) {
  if (!options.ccsilo) return options;
  if (options.agentCommands) {
    throw new Error('--ccsilo can only be used with --agent-runtime claude');
  }
  if (options.agentConfigDir) {
    throw new Error('--ccsilo conflicts with --agent-config-dir');
  }
  if (options.agentRuntime && options.agentRuntime !== 'claude') {
    throw new Error('--ccsilo can only be used with Claude');
  }
  const resolved = resolveCcsiloVariant({
    variant: options.ccsiloVariant,
  });
  options.agentRuntime = 'claude';
  options.agentConfigDir = resolved.configDir;
  options.ccsiloResolved = resolved;
  process.env[CLAUDE_EXECUTABLE_ENV] = resolved.wrapper;
  return options;
}

module.exports = {
  applyCcsiloDoctorOptions,
  applyCcsiloInstallOptions,
  applyCcsiloRunOptions,
  ccsiloBaseRoot,
  inferVariantRootFromConfigDir,
  readCcsiloVariantArg,
  resolveCcsiloVariant,
};
