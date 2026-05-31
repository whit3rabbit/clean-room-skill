'use strict';

const VALID_MODES = new Set(['attended', 'unattended']);
const VALID_INTENTS = new Set([
  'clean-room-reimplementation',
  'behavior-compatible-port',
  'api-compatible-clone',
  'modernization',
  'partial-feature-extraction',
  'test-spec-generation-only',
  'other',
]);
const VALID_EXECUTION_BACKENDS = new Set(['host', 'docker', 'podman']);
const VALID_CONTAINER_PROFILES = new Set(['node22', 'python312', 'go126', 'rust-stable']);
const VALID_NETWORK_POLICIES = new Set(['off', 'deps-only', 'on']);
const VALID_DEPENDENCY_INSTALL_POLICIES = new Set(['offline', 'locked', 'allow-new']);

module.exports = {
  VALID_CONTAINER_PROFILES,
  VALID_DEPENDENCY_INSTALL_POLICIES,
  VALID_EXECUTION_BACKENDS,
  VALID_INTENTS,
  VALID_MODES,
  VALID_NETWORK_POLICIES,
};
