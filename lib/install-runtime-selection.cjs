'use strict';

const path = require('node:path');

const { RUNTIMES } = require('./runtime-layout.cjs');

function displayPath(filePath) {
  const home = process.env.HOME;
  if (home && filePath === home) {
    return '~';
  }
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, filePath)}`;
  }
  return filePath;
}

function printRuntimeChoices(statuses) {
  console.log('Runtime choices:');
  statuses.forEach((status, index) => {
    const number = String(index + 1).padStart(2, ' ');
    const runtime = status.runtime.padEnd(12, ' ');
    console.log(`  ${number}. ${runtime} ${status.detail} (${displayPath(status.targetRoot)})`);
  });
}

function defaultRuntimeSelectionLabel(statuses, action) {
  if ((action === 'uninstall' || action === 'update') && defaultRuntimeSelections(statuses, action).length > 0) {
    return 'installed';
  }
  return 'codex';
}

function defaultRuntimeSelections(statuses, action = 'install') {
  if (action === 'uninstall') {
    return statuses.filter((status) => isInstalledStatus(status)).map((status) => status.runtime);
  }
  if (action === 'update') {
    return selectableRuntimeSelections(statuses, action);
  }
  if (action === 'status') {
    return statuses.map((status) => status.runtime);
  }
  return ['codex'];
}

function detectedRuntimeSelections(statuses, action = 'install') {
  if (action === 'update') {
    return selectableRuntimeSelections(statuses, action);
  }
  return statuses.filter((status) => isInstalledStatus(status)).map((status) => status.runtime);
}

function isUpdateTargetStatus(status) {
  return status?.state === 'installed' || status?.state === 'update-available';
}

function isSelectableRuntimeStatus(status, action = 'install') {
  if (action === 'update') {
    return isUpdateTargetStatus(status);
  }
  return true;
}

function selectableRuntimeSelections(statuses, action = 'install') {
  return statuses
    .filter((status) => isSelectableRuntimeStatus(status, action))
    .map((status) => status.runtime);
}

function statusForRuntime(statuses, runtime) {
  return statuses.find((status) => status.runtime === runtime) || {
    runtime,
    state: 'not-installed',
  };
}

function unavailableRuntimeSelectionMessage(status, action) {
  if (action === 'update') {
    return `${status.runtime} is not installed in this scope; choose Install to add it.`;
  }
  return `${status.runtime} cannot be selected for ${action}.`;
}

function emptyRuntimeSelectionMessage(statuses, action) {
  if (action === 'update' && selectableRuntimeSelections(statuses, action).length === 0) {
    return 'No installed runtimes detected for update. Choose Install instead.';
  }
  return 'Select at least one runtime.';
}

function addRuntimeSelection(selected, runtime, statuses, action) {
  const status = statusForRuntime(statuses, runtime);
  if (!isSelectableRuntimeStatus(status, action)) {
    throw new Error(unavailableRuntimeSelectionMessage(status, action));
  }
  selected.push(runtime);
}

function parseRuntimeSelection(answer, statuses, action = 'install') {
  const text = answer.trim().toLowerCase();
  if (text === '') {
    if (action === 'uninstall' || action === 'update') {
      const installed = defaultRuntimeSelections(statuses, action);
      if (installed.length === 0) {
        throw new Error('no installed runtimes detected; select a runtime explicitly');
      }
      return installed;
    }
    return ['codex'];
  }

  const selected = [];
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    if (token === 'all') {
      selected.push(...(action === 'update' ? selectableRuntimeSelections(statuses, action) : RUNTIMES));
      continue;
    }
    if (token === 'installed') {
      selected.push(...detectedRuntimeSelections(statuses, action));
      continue;
    }
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) {
        throw new Error(`invalid runtime range: ${token}`);
      }
      for (let index = start; index <= end; index += 1) {
        addRuntimeSelection(selected, runtimeForSelectionIndex(statuses, index), statuses, action);
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      addRuntimeSelection(selected, runtimeForSelectionIndex(statuses, Number(token)), statuses, action);
      continue;
    }
    if (RUNTIMES.includes(token)) {
      addRuntimeSelection(selected, token, statuses, action);
      continue;
    }
    throw new Error(`unsupported runtime selection: ${token}`);
  }
  const unique = [...new Set(selected)];
  if (unique.length === 0) {
    throw new Error('no runtimes selected');
  }
  return unique;
}

function runtimeForSelectionIndex(statuses, index) {
  if (!Number.isInteger(index) || index < 1 || index > statuses.length) {
    throw new Error(`runtime selection out of range: ${index}`);
  }
  return statuses[index - 1].runtime;
}

function isInstalledStatus(status) {
  return status.state === 'installed' || status.state === 'hooks-only';
}

module.exports = {
  addRuntimeSelection,
  defaultRuntimeSelectionLabel,
  defaultRuntimeSelections,
  detectedRuntimeSelections,
  displayPath,
  emptyRuntimeSelectionMessage,
  isInstalledStatus,
  isSelectableRuntimeStatus,
  isUpdateTargetStatus,
  parseRuntimeSelection,
  printRuntimeChoices,
  runtimeForSelectionIndex,
  selectableRuntimeSelections,
  statusForRuntime,
  unavailableRuntimeSelectionMessage,
};
