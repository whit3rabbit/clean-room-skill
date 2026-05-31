'use strict';

const { operationForOptions } = require('./install-options.cjs');
const {
  defaultRuntimeSelections,
  detectedRuntimeSelections,
  displayPath,
  emptyRuntimeSelectionMessage,
  isSelectableRuntimeStatus,
  selectableRuntimeSelections,
  unavailableRuntimeSelectionMessage,
} = require('./install-runtime-selection.cjs');
const { runtimeInstallStatuses } = require('./install-status.cjs');
const { RUNTIMES } = require('./runtime-layout.cjs');

async function resolveInteractiveOptions(options) {
  if (options.runtimes.length > 0 && options.scope) {
    return options;
  }
  if (!process.stdin.isTTY || options.yes) {
    throw new Error('specify runtime and scope flags when running non-interactively');
  }
  return runInstallerTui(options);
}

async function runInstallerTui(options) {
  const React = await import('react');
  const ink = await import('ink');
  const h = React.createElement;

  return new Promise((resolve, reject) => {
    let result = null;
    let error = null;

    function complete(nextOptions) {
      result = nextOptions;
    }

    function abort(err) {
      error = err;
    }

    function App() {
      return h(InstallerTui, {
        React,
        ink,
        h,
        initialOptions: options,
        onComplete: complete,
        onAbort: abort,
      });
    }

    const instance = ink.render(h(App), {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exitOnCtrlC: false,
    });

    instance.waitUntilExit().then(() => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result || options);
    }, reject);
  });
}

function InstallerTui({ React, ink, h, initialOptions, onComplete, onAbort }) {
  const { Box, Text, useApp, useInput } = ink;
  const { useMemo, useState } = React;
  const { exit } = useApp();
  const initialFlags = useMemo(() => ({
    actionResolved: !!initialOptions.operation ||
      !(initialOptions.runtimes.length === 0 && !initialOptions.uninstall),
    promptedRuntimes: false,
    uninstallConfirmed: true,
  }), [initialOptions]);
  const [draft, setDraft] = useState(() => ({
    ...initialOptions,
    runtimes: [...initialOptions.runtimes],
  }));
  const [flags, setFlags] = useState(initialFlags);
  const [stage, setStage] = useState(() => nextTuiStage(initialOptions, initialFlags));

  function fail(message) {
    onAbort(new Error(message));
    exit();
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      fail('aborted by user');
    }
  });

  function advance(nextDraft, nextFlags = {}) {
    const mergedFlags = { ...flags, ...nextFlags };
    const nextStage = nextTuiStage(nextDraft, mergedFlags);
    setDraft(nextDraft);
    setFlags(mergedFlags);
    if (nextStage === 'complete') {
      onComplete(nextDraft);
      exit();
      return;
    }
    setStage(nextStage);
  }

  const action = operationForOptions(draft);

  return h(Box, { flexDirection: 'column', gap: 1 },
    h(Box, { flexDirection: 'column' },
      h(Text, { bold: true }, 'clean-room-skill installer'),
      h(Text, { dimColor: true }, 'Use arrows or j/k to move. Enter selects. Ctrl+C cancels.')
    ),
    stage === 'action' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Action',
      initialIndex: defaultActionIndex(draft),
      items: [
        { label: 'Update', value: 'update', detail: 'refresh installed runtimes without onboarding' },
        { label: 'Install', value: 'install', detail: 'add or repair runtime files' },
        { label: 'Uninstall', value: 'uninstall', detail: 'remove managed files and generated hooks' },
        { label: 'Status', value: 'status', detail: 'inspect runtime installs without changing files' },
      ],
      onSubmit: (item) => advance({
        ...draft,
        operation: item.value,
        uninstall: item.value === 'uninstall',
      }, {
        actionResolved: true,
        uninstallConfirmed: item.value !== 'uninstall',
      }),
    }),
    stage === 'scope' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Scope',
      items: [
        { label: 'Global', value: 'global', detail: 'runtime user config' },
        { label: 'Local', value: 'local', detail: 'current project config' },
      ],
      onSubmit: (item) => advance({ ...draft, scope: item.value }),
    }),
    stage === 'runtimes' && h(RuntimeMultiSelect, {
      React,
      Box,
      Text,
      useInput,
      h,
      action,
      statuses: runtimeInstallStatuses(draft.scope, draft.configDir),
      onSubmit: (runtimes) => advance({ ...draft, runtimes }, {
        promptedRuntimes: true,
        uninstallConfirmed: operationForOptions(draft) !== 'uninstall',
      }),
    }),
    stage === 'confirm-uninstall' && h(ConfirmUninstall, {
      React,
      Box,
      Text,
      useInput,
      h,
      runtimes: draft.runtimes,
      onSubmit: () => advance(draft, { uninstallConfirmed: true }),
    }),
    stage === 'hooks' && h(SingleChoice, {
      React,
      Box,
      Text,
      useInput,
      h,
      title: 'Hook mode',
      items: [
        { label: 'Safe', value: 'safe', detail: 'enforces during clean-room role sessions' },
        { label: 'Copy-only', value: 'copy-only', detail: 'copy scripts without host hook registration' },
        { label: 'Strict', value: 'strict', detail: 'fail closed in dedicated Codex, Claude, or OpenCode homes' },
      ],
      onSubmit: (item) => advance({ ...draft, hookMode: item.value, hookModeSpecified: true }),
    })
  );
}

function defaultActionIndex(options) {
  if (operationForOptions(options) === 'status') return 3;
  if (operationForOptions(options) === 'uninstall') return 2;
  if (runtimeInstallStatuses(options.scope || 'global', options.configDir).some((status) => status.state === 'installed')) {
    return 0;
  }
  return 1;
}

function nextTuiStage(options, flags) {
  if (!options.scope) {
    return 'scope';
  }
  if (!flags.actionResolved) {
    return 'action';
  }
  if (operationForOptions(options) === 'status') {
    return 'complete';
  }
  if (options.runtimes.length === 0) {
    return 'runtimes';
  }
  if (operationForOptions(options) === 'uninstall' && flags.promptedRuntimes && !flags.uninstallConfirmed) {
    return 'confirm-uninstall';
  }
  if (operationForOptions(options) === 'install' && !options.hookModeSpecified) {
    return 'hooks';
  }
  return 'complete';
}

function SingleChoice({ React, Box, Text, useInput, h, title, items, initialIndex = 0, onSubmit }) {
  const [index, setIndex] = React.useState(initialIndex);
  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setIndex((current) => Math.max(0, current - 1));
    } else if (key.downArrow || input === 'j') {
      setIndex((current) => Math.min(items.length - 1, current + 1));
    } else if (key.home) {
      setIndex(0);
    } else if (key.end) {
      setIndex(items.length - 1);
    } else if (key.return || /[\r\n]/.test(input)) {
      onSubmit(items[index]);
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, title),
    ...items.map((item, itemIndex) => h(Text, {
      key: item.value,
      color: itemIndex === index ? 'cyan' : undefined,
    }, `${itemIndex === index ? '>' : ' '} ${item.label.padEnd(10)} ${item.detail}`))
  );
}

function RuntimeMultiSelect({ React, Box, Text, useInput, h, action, statuses, onSubmit }) {
  const initialSelected = React.useMemo(() => new Set(defaultRuntimeSelections(statuses, action)), [statuses, action]);
  const [index, setIndex] = React.useState(0);
  const [selected, setSelected] = React.useState(initialSelected);
  const [error, setError] = React.useState('');

  function toggle(status) {
    setError('');
    if (!isSelectableRuntimeStatus(status, action)) {
      setError(unavailableRuntimeSelectionMessage(status, action));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(status.runtime)) {
        next.delete(status.runtime);
      } else {
        next.add(status.runtime);
      }
      return next;
    });
  }

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setIndex((current) => Math.max(0, current - 1));
    } else if (key.downArrow || input === 'j') {
      setIndex((current) => Math.min(statuses.length - 1, current + 1));
    } else if (key.home) {
      setIndex(0);
    } else if (key.end) {
      setIndex(statuses.length - 1);
    } else if (input === ' ') {
      toggle(statuses[index]);
    } else if (input === 'a') {
      setError('');
      setSelected(new Set(action === 'update' ? selectableRuntimeSelections(statuses, action) : RUNTIMES));
    } else if (input === 'i') {
      setError('');
      setSelected(new Set(detectedRuntimeSelections(statuses, action)));
    } else if (key.return || /[\r\n]/.test(input)) {
      const runtimes = RUNTIMES.filter((runtime) => selected.has(runtime));
      if (runtimes.length === 0) {
        setError(emptyRuntimeSelectionMessage(statuses, action));
        return;
      }
      onSubmit(runtimes);
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, `Runtimes to ${action}`),
    h(Text, { dimColor: true }, `${action === 'update' ? 'Space toggles installed runtimes. a selects installed runtimes.' : 'Space toggles. a selects all.'} i selects detected installs. Enter continues.`),
    ...statuses.map((status, itemIndex) => {
      const checked = selected.has(status.runtime) ? '[x]' : '[ ]';
      const cursor = itemIndex === index ? '>' : ' ';
      return h(Text, {
        key: status.runtime,
        color: itemIndex === index ? 'cyan' : undefined,
      }, `${cursor} ${checked} ${status.runtime.padEnd(12)} ${status.detail} (${displayPath(status.targetRoot)})`);
    }),
    error ? h(Text, { color: 'red' }, error) : null
  );
}

function ConfirmUninstall({ React, Box, Text, useInput, h, runtimes, onSubmit }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');

  useInput((input, key) => {
    const submit = key.return || /[\r\n]/.test(input);
    if (submit) {
      const printable = input.replace(/[^\x20-\x7E]/g, '');
      const nextText = `${text}${printable}`;
      if (nextText.trim().toLowerCase() === 'uninstall') {
        onSubmit();
        return;
      }
      setError('Type uninstall to continue.');
    } else if (key.backspace || key.delete) {
      setError('');
      setText((current) => current.slice(0, -1));
    } else if (!key.ctrl && input) {
      const printable = input.replace(/[^\x20-\x7E]/g, '');
      if (printable) {
        setError('');
        setText((current) => `${current}${printable}`);
      }
    }
  });

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true, color: 'yellow' }, 'Confirm uninstall'),
    h(Text, null, `Selected runtimes: ${runtimes.join(', ')}`),
    h(Text, { dimColor: true }, 'Only manifest-managed files and generated clean-room hook entries are removed.'),
    h(Text, null, `Type uninstall: ${text}`),
    error ? h(Text, { color: 'red' }, error) : null
  );
}

module.exports = {
  ConfirmUninstall,
  InstallerTui,
  RuntimeMultiSelect,
  SingleChoice,
  defaultActionIndex,
  nextTuiStage,
  resolveInteractiveOptions,
  runInstallerTui,
};
