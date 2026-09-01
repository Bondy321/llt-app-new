'use strict';

// @ts-check

const {
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
} = require('./constants');

const MAX_GENERATION = Number.MAX_SAFE_INTEGER - 1;

/** @param {unknown} value */
const readPositiveSafeInteger = (value) => (
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
);

/** @param {unknown} value */
const readNonNegativeSafeInteger = (value) => (
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
);

/** @param {unknown} value */
const readFenceGeneration = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  return readNonNegativeSafeInteger(value.generation);
};

/**
 * Returns the next bounded generation for a canonical notification job. The
 * generation is monotonic across both the canonical scalar and a durable fence.
 * @param {any} job
 */
const nextNotificationRetentionGeneration = (job) => {
  const current = Math.max(
    readNonNegativeSafeInteger(job?.retentionGeneration),
    readFenceGeneration(job?.retentionFence),
  );
  return current >= MAX_GENERATION ? MAX_GENERATION : current + 1;
};

/**
 * A new fence is a bounded object. Legacy scalar fences remain fail-closed so a
 * mixed-version rollout cannot make an already-fenced job mutable again.
 * @param {any} job
 * @param {{ nowMs?: number, fenceId?: string }} [options]
 */
// eslint-disable-next-line complexity -- mixed-version scalar/object fences intentionally fail closed
const isNotificationRetentionFenced = (job, { fenceId } = {}) => {
  const legacyFenceId = typeof job?.retentionFenceId === 'string'
    ? job.retentionFenceId.trim()
    : '';
  if (legacyFenceId) return !fenceId || legacyFenceId !== fenceId;

  const fence = job?.retentionFence;
  if (typeof fence === 'string' && fence.trim()) return !fenceId || fence.trim() !== fenceId;
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) return false;
  if (typeof fence.fenceId !== 'string' || !fence.fenceId.trim()) return false;
  if (fenceId && fence.fenceId === fenceId) return false;
  if (fence.status === 'released' || fence.status === 'cancelled') return false;
  // Lease expiry permits another retention worker to reclaim the fence. It does
  // not reopen the canonical notification lifecycle to ordinary work.
  return true;
};

/** @param {object} input */
const buildResult = ({
  eligible,
  reason,
  kind = null,
  retentionDueAtMs = null,
  privacyTombstone = false,
  generation,
}) => ({
  eligible: Boolean(eligible),
  reason,
  kind,
  retentionDueAtMs,
  dueAtMs: retentionDueAtMs,
  privacyTombstone: Boolean(privacyTombstone),
  generation,
});

const classifyCommonIneligibility = ({ job, nowMs, activeRequeue, generation }) => {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return buildResult({ eligible: false, reason: 'missing_job', generation });
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return buildResult({ eligible: false, reason: 'invalid_now', generation });
  }
  if (activeRequeue) return buildResult({ eligible: false, reason: 'active_requeue', generation });
  if (job.retentionHold === true) {
    return buildResult({ eligible: false, reason: 'retention_hold', generation });
  }
  if (isNotificationRetentionFenced(job)) {
    return buildResult({ eligible: false, reason: 'already_fenced', generation });
  }
  if (job.lease && Number(job.lease.expiresAtMs || 0) > nowMs) {
    return buildResult({ eligible: false, reason: 'active_delivery_lease', generation });
  }
  return null;
};

const classifyPrivacyTombstone = ({ job, nowMs, generation }) => {
  const retentionDueAtMs = readPositiveSafeInteger(job.expiresAtMs);
  if (retentionDueAtMs === null) {
    return buildResult({
      eligible: false,
      reason: 'privacy_expiry_missing',
      kind: 'privacy_tombstone',
      privacyTombstone: true,
      generation,
    });
  }
  const eligible = retentionDueAtMs <= nowMs;
  return buildResult({
    eligible,
    reason: eligible ? 'eligible' : 'privacy_not_due',
    kind: 'privacy_tombstone',
    retentionDueAtMs,
    privacyTombstone: true,
    generation,
  });
};

const classifyOrdinaryJob = ({ job, nowMs, generation }) => {
  if (!ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES.has(job.status)) {
    return buildResult({ eligible: false, reason: 'non_terminal', generation });
  }
  const completedAtMs = readPositiveSafeInteger(job.completedAtMs);
  if (completedAtMs === null) {
    return buildResult({ eligible: false, reason: 'completed_at_missing', kind: 'ordinary', generation });
  }
  const retentionDueAtMs = readPositiveSafeInteger(job.retentionDueAtMs);
  if (retentionDueAtMs === null) {
    return buildResult({ eligible: false, reason: 'retention_due_missing', kind: 'ordinary', generation });
  }
  const expectedDueAtMs = completedAtMs + RETENTION_MS;
  if (!Number.isSafeInteger(expectedDueAtMs) || retentionDueAtMs !== expectedDueAtMs) {
    return buildResult({ eligible: false, reason: 'retention_due_invalid', kind: 'ordinary', generation });
  }
  const eligible = retentionDueAtMs <= nowMs;
  return buildResult({
    eligible,
    reason: eligible ? 'eligible' : 'not_due',
    kind: 'ordinary',
    retentionDueAtMs,
    generation,
  });
};

/**
 * Central job-retention eligibility. Ordinary terminal records require their
 * once-written completedAtMs and retentionDueAtMs. Privacy tombstones use only
 * their explicit expiry and never inherit an ordinary delivery timestamp.
 * @param {{ job: any, nowMs?: number, activeRequeue?: boolean }} input
 */
const classifyNotificationRetentionEligibility = ({
  job,
  nowMs = Date.now(),
  activeRequeue = false,
}) => {
  const generation = nextNotificationRetentionGeneration(job);
  const common = classifyCommonIneligibility({ job, nowMs, activeRequeue, generation });
  if (common) return common;
  if (job.status === 'privacy_deleted') return classifyPrivacyTombstone({ job, nowMs, generation });
  return classifyOrdinaryJob({ job, nowMs, generation });
};

module.exports = {
  classifyNotificationRetentionEligibility,
  isNotificationRetentionFenced,
  nextNotificationRetentionGeneration,
  readNonNegativeSafeInteger,
  readPositiveSafeInteger,
};
