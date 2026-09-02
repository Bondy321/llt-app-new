'use strict';

// @ts-check

const {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
} = require('./constants');
const {
  classifyNotificationRetentionEligibility,
  isNotificationRetentionFenced,
  nextNotificationRetentionGeneration,
} = require('./eligibility');
const { RETENTION_ENGINE_PROTOCOL_MANIFEST } = require('./protocol');

// These narrow delegates keep this lifecycle-owned public boundary stable while
// the state machine remains split into focused, acyclic implementation modules.
const ensureNotificationRetentionScheduled = (options) => require('./state')
  .ensureNotificationRetentionScheduled(options);
const buildShadowEvidenceFingerprint = (value) => require('./state')
  .buildShadowEvidenceFingerprint(value);
const buildCanaryEvidenceFingerprint = (value) => require('./state')
  .buildCanaryEvidenceFingerprint(value);
const readNotificationRetentionRollout = (options) => require('./state')
  .readNotificationRetentionRollout(options);
const transitionNotificationRetentionRollout = (options) => require('./state')
  .transitionNotificationRetentionRollout(options);
const runNotificationRetentionCycle = (options) => require('./engine')
  .runNotificationRetentionCycle(options);
const runNotificationRetentionPreflight = (options) => require('./preparation')
  .runNotificationRetentionPreflight(options);
const runNotificationRetentionPreflightAll = (options) => require('./preparation')
  .runNotificationRetentionPreflightAll(options);
const runNotificationRetentionPreparation = (options) => require('./preparation')
  .runNotificationRetentionPreparation(options);
const ensureNotificationRetentionCanaryFixture = (options) => require('./canaryFixture')
  .ensureNotificationRetentionCanaryFixture(options);
const recoverInactiveCompactorFence = (options) => require('./retentionContext')
  .recoverInactiveCompactorFence(options);
const removeLegacyRetentionOwnership = (options) => require('./retentionContext')
  .removeLegacyRetentionOwnership(options);
const recoverZeroResultRequeue = (options) => require('./requeueRecovery')
  .recoverZeroResultRequeue(options);
const cleanupExpiredNotificationRequeueState = (options) => require('./requeueRecovery')
  .cleanupExpiredNotificationRequeueState(options);
const isManualRequeueBlockedByRetentionState = (options) => require('./requeueRecovery')
  .isManualRequeueBlockedByRetentionState(options);
const retryNotificationRetentionAttention = (options) => require('./requeueRecovery')
  .retryNotificationRetentionAttention(options);
const abandonNotificationRetentionAttention = (options) => require('./requeueRecovery')
  .abandonNotificationRetentionAttention(options);
const readEffectiveNotificationRetentionAttention = (db, jobId, state) => (
  require('./requeueRecovery').readEffectiveAttention(db, jobId, state)
);
const writeRetentionDeploymentHeartbeat = (options) => require('./protocol')
  .writeRetentionDeploymentHeartbeat(options);
const readRetentionDeploymentHeartbeat = (options) => require('./protocol')
  .readRetentionDeploymentHeartbeat(options);
const classifyRetentionHeartbeat = (options) => require('./protocol')
  .classifyRetentionHeartbeat(options);
const buildRetentionDeploymentProof = (options) => require('./deploymentAttestation')
  .buildRetentionDeploymentAttestation(options);
const classifyRetentionDeploymentProof = (options) => require('./deploymentAttestation')
  .classifyRetentionDeploymentAttestation(options);
const readRetentionDeploymentProof = (options) => require('./deploymentAttestation')
  .readRetentionDeploymentAttestation(options);
const writeRetentionDeploymentProof = (options) => require('./deploymentAttestation')
  .writeRetentionDeploymentAttestation(options);
const compiledRetentionProtocol = () => require('./protocol').compiledRetentionProtocol();

module.exports = {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
  classifyNotificationRetentionEligibility,
  abandonNotificationRetentionAttention,
  classifyRetentionHeartbeat,
  classifyRetentionDeploymentProof,
  compiledRetentionProtocol,
  buildCanaryEvidenceFingerprint,
  buildRetentionDeploymentProof,
  buildShadowEvidenceFingerprint,
  cleanupExpiredNotificationRequeueState,
  ensureNotificationRetentionCanaryFixture,
  ensureNotificationRetentionScheduled,
  isNotificationRetentionFenced,
  isManualRequeueBlockedByRetentionState,
  nextNotificationRetentionGeneration,
  recoverInactiveCompactorFence,
  recoverZeroResultRequeue,
  readNotificationRetentionRollout,
  readRetentionDeploymentHeartbeat,
  readRetentionDeploymentProof,
  readEffectiveNotificationRetentionAttention,
  removeLegacyRetentionOwnership,
  runNotificationRetentionCycle,
  runNotificationRetentionPreflight,
  runNotificationRetentionPreflightAll,
  runNotificationRetentionPreparation,
  retryNotificationRetentionAttention,
  transitionNotificationRetentionRollout,
  writeRetentionDeploymentHeartbeat,
  writeRetentionDeploymentProof,
};
