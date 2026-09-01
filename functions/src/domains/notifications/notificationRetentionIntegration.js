'use strict';

// @ts-check

const { isTerminalNotificationJobStatus } = require('./notificationJobStatus');
const {
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
  ensureNotificationRetentionScheduled,
  isNotificationRetentionFenced,
  nextNotificationRetentionGeneration,
  recoverInactiveCompactorFence,
  recoverZeroResultRequeue,
} = require('../notification-retention/public');

const NOTIFICATION_RETENTION_MS = RETENTION_MS;
const NOTIFICATION_RETENTION_IN_PROGRESS = 'NOTIFICATION_RETENTION_IN_PROGRESS';
const ACCEPTED_RETENTION_SCHEDULE_REASONS = new Set([
  'scheduled',
  'already_scheduled',
  'queue_repaired',
]);

/**
 * Attempt retention is written once, at the first recognised terminal
 * transition. Active and malformed attempts never receive a derived boundary.
 * @param {any} current @param {any} patch @param {number} nowMs
 */
const withNotificationAttemptRetentionBoundary = (current, patch, nowMs) => {
  const status = patch?.status ?? current?.status;
  if (!TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(status)) return patch;
  const persistedDueAtMs = Number(current?.retentionDueAtMs || 0);
  return {
    ...patch,
    retentionDueAtMs: Number.isSafeInteger(persistedDueAtMs) && persistedDueAtMs > 0
      ? persistedDueAtMs
      : nowMs + NOTIFICATION_RETENTION_MS,
  };
};

/** @param {any} db @param {any} job @param {number} nowMs */
const scheduleNotificationRetentionIfEligible = async (db, job, nowMs) => {
  if (!job?.jobId || (job.status !== 'privacy_deleted' && !isTerminalNotificationJobStatus(job.status))) {
    return null;
  }
  const result = await ensureNotificationRetentionScheduled({ db, jobId: job.jobId, job, nowMs });
  if (ACCEPTED_RETENTION_SCHEDULE_REASONS.has(result?.reason)) return result;
  const error = /** @type {Error & { code?: string }} */ (
    new Error('Terminal notification retention was not durably scheduled')
  );
  error.code = 'NOTIFICATION_RETENTION_SCHEDULING_FAILED';
  throw error;
};

/** @param {any} job @param {number} nowMs */
const isNotificationLifecycleRetentionFenced = (job, nowMs) => (
  isNotificationRetentionFenced(job, { nowMs })
);

const recoverNotificationRetentionFenceIfInactive = async (db, jobId, nowMs) => (
  recoverInactiveCompactorFence({ db, jobId, nowMs })
);
const recoverZeroResultNotificationRequeue = (options) => recoverZeroResultRequeue(options);

module.exports = {
  NOTIFICATION_RETENTION_IN_PROGRESS,
  NOTIFICATION_RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
  isNotificationLifecycleRetentionFenced,
  nextNotificationRetentionGeneration,
  recoverNotificationRetentionFenceIfInactive,
  recoverZeroResultNotificationRequeue,
  scheduleNotificationRetentionIfEligible,
  withNotificationAttemptRetentionBoundary,
};
