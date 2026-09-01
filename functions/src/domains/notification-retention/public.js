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

module.exports = {
  DEFAULT_RETENTION_BUDGETS,
  NOTIFICATION_RETENTION_PATHS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
  classifyNotificationRetentionEligibility,
  buildCanaryEvidenceFingerprint,
  buildShadowEvidenceFingerprint,
  cleanupExpiredNotificationRequeueState,
  ensureNotificationRetentionCanaryFixture,
  ensureNotificationRetentionScheduled,
  isNotificationRetentionFenced,
  nextNotificationRetentionGeneration,
  recoverInactiveCompactorFence,
  recoverZeroResultRequeue,
  readNotificationRetentionRollout,
  removeLegacyRetentionOwnership,
  runNotificationRetentionCycle,
  runNotificationRetentionPreflight,
  runNotificationRetentionPreflightAll,
  runNotificationRetentionPreparation,
  transitionNotificationRetentionRollout,
};
