'use strict';

/**
 * Build a default attended preflight goal template object.
 * @param {string} [mode='attended'] - Controller mode.
 * @returns {object} The preflight goal template object.
 */
function buildTemplate(mode = 'attended') {
  if (mode !== 'attended') {
    throw new Error('preflight --template supports attended mode only');
  }
  return {
    goal_id: 'goal-task-xxxxxxxx',
    created_at: new Date().toISOString(),
    end_goal: {
      intent: 'clean-room-reimplementation',
      success_definition: 'TBD: define the observable result the clean implementation must achieve.',
      destination_kind: 'new-project',
      existing_destination_policy: 'inspect-and-preserve',
    },
    target_stack: {
      language: 'TBD',
      runtime: null,
      framework: null,
      package_manager: null,
      test_framework: null,
    },
    license_policy: {
      source_license_notes: 'unknown',
      destination_license: 'TBD',
      dependency_license_allowlist: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause'],
      dependency_license_blocklist: ['GPL-3.0', 'AGPL-3.0'],
    },
    dependency_policy: {
      allow_new_dependencies: true,
      prefer_stdlib: true,
      require_user_approval_for_native_deps: true,
      blocked_dependencies: [],
    },
    compatibility_policy: {
      mirror_public_behavior: true,
      mirror_public_api_names: true,
      mirror_private_structure: false,
      mirror_comments_or_internal_names: false,
      allowed_exactness: [
        'public API names',
        'CLI flags',
        'serialized outputs',
        'documented protocol behavior',
        'public error codes',
      ],
    },
    feature_policy: {
      preserve_features: [],
      remove_features: [],
      add_features: [],
      non_goals: [],
    },
    code_hygiene_policy: {
      max_lines_per_code_file: 500,
      max_lines_per_test_file: 800,
      max_files_per_iteration: 12,
      split_large_files_by: ['module boundary', 'public type', 'feature area'],
      exceptions: ['generated files', 'fixtures', 'snapshots'],
      forbidden_patterns: ['god file', 'source-shaped layout'],
    },
    output_policy: {
      artifact_base_root: '~/Documents/CleanRoom/<task-id>/',
      implementation_root: '~/Documents/CleanRoom/<task-id>/implementation/',
      assumed_output_directory: 'implementation/',
      write_mode: 'create-or-preserve-existing',
    },
    execution_policy: {
      backend: 'host',
      preferred_container_profile: 'node22',
      network_policy: 'off',
      dependency_install_policy: 'locked',
      allow_native_toolchain: false,
      resource_limits: {
        cpus: 2,
        memory_mb: 2048,
        timeout_seconds: 300,
      },
    },
    controller_policy: {
      mode: 'attended',
      unattended_allowed_after_preflight: false,
      max_iterations: 10,
    },
    open_questions: [
      {
        question_id: 'goal-end-state',
        question: 'Define the end goal, target stack, compatibility exactness, dependency policy, license policy, and output root before execution.',
        blocking: true,
        default_assumption: 'Do not start source analysis until this is answered.',
      },
    ],
  };
}

module.exports = {
  buildTemplate,
};
