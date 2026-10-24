'use strict';

// @ts-check

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');

const { removeClaimedQueueEntry, releaseClaimedQueueEntry, transitionQueuedRecord } = require('./notificationQueues');
const { finalizeCompletedFanout } = require('./notificationFanoutFinalization');
const {
  isNotificationLifecycleRetentionFenced,
  scheduleNotificationRetentionIfEligible,
} = require('./notificationRetentionIntegration');

const finalizeAndScheduleCompletedFanout = async (
  db, job, nowMs, syncSourceStatus, publishCriticalWarning,
) => {
  await finalizeCompletedFanout(db, job, nowMs, syncSourceStatus, publishCriticalWarning);
  await scheduleNotificationRetentionIfEligible(db, job, nowMs);
};

const renewNotificationJobSubmissionFence = async ({
  jobRef, leaseOwnerId, nowMs, ttlMs = 2 * 60 * 1000, requiredStatus = null,
}) => {
  if (!leaseOwnerId) return true;
  let renewed = false;
  const result = await transactExistingRecord(jobRef, (current) => {
    if (!current || (requiredStatus && current.status !== requiredStatus)
      || isNotificationLifecycleRetentionFenced(current, nowMs)
      || current.status === 'privacy_deleted' || current.status === 'expired'
      || current.supersededByJobId || current.lease?.ownerId !== leaseOwnerId
      || Number(current.lease.expiresAtMs || 0) <= nowMs) return undefined;
    renewed = true;
    return {
      ...current,
      updatedAtMs: nowMs,
      lease: { ...current.lease, expiresAtMs: nowMs + ttlMs },
    };
  });
  return Boolean(renewed && result?.applied);
};

const clearCompletedFanoutPointer = (jobRef, queueKey, nowMs) => transactExistingRecord(jobRef, (current) => {
  if (!current || current.queueKey !== queueKey || !current.fanoutCompletedAtMs
    || isNotificationLifecycleRetentionFenced(current, nowMs)) return undefined;
  return { ...current, queueKind: null, queueKey: null, queueVersion: Number(current.queueVersion || 0) + 1 };
});

const expireLeasedNotificationJob = async ({ db, jobRef, job, leaseOwnerId, nowMs, syncSourceStatus, publishCriticalWarning }) => {
  const fenced = { status: 'retention_fenced', fanoutComplete: false, replayed: true };
  if (!(await renewNotificationJobSubmissionFence({
    jobRef, leaseOwnerId, nowMs, requiredStatus: 'fanout_in_progress',
  }))) return fenced;
  const renewedJob = (await jobRef.once('value')).val();
  if (!renewedJob || renewedJob.status !== 'fanout_in_progress'
    || (leaseOwnerId && renewedJob.lease?.ownerId !== leaseOwnerId)
    || isNotificationLifecycleRetentionFenced(renewedJob, nowMs)) return fenced;
  const completedAtMs = Number(job.completedAtMs || nowMs);
  const patch = { status: 'expired', lease: null, completedAtMs, updatedAtMs: nowMs };
  await transitionQueuedRecord(db, { targetPath: `notification_jobs_v2/${job.jobId}`,
    current: renewedJob, patch, targetId: job.jobId });
  await finalizeAndScheduleCompletedFanout(db, { ...renewedJob, ...patch }, nowMs, syncSourceStatus, publishCriticalWarning);
  return { status: 'expired', fanoutComplete: true };
};

const settleCompletedFanoutQueue = async ({ jobRef, queueRef, queueKey, queueOwnerId, nowMs }) => {
  const current = (await jobRef.once('value')).val();
  if (isNotificationLifecycleRetentionFenced(current, nowMs)) {
    if (queueRef && queueOwnerId) {
      await releaseClaimedQueueEntry(queueRef, queueOwnerId, nowMs + 2 * 60 * 1000);
    }
    return false;
  }
  if (queueRef && queueOwnerId) await removeClaimedQueueEntry(queueRef, queueOwnerId);
  if (queueKey) await clearCompletedFanoutPointer(jobRef, queueKey, nowMs);
  return true;
};

module.exports = {
  expireLeasedNotificationJob,
  finalizeAndScheduleCompletedFanout,
  renewNotificationJobSubmissionFence,
  settleCompletedFanoutQueue,
};
