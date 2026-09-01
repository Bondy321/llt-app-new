'use strict';

// @ts-check

const { removeClaimedQueueEntry, releaseClaimedQueueEntry } = require('./notificationQueues');
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
  const result = await jobRef.transaction((current) => {
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
  return Boolean(renewed && result?.committed);
};

const clearCompletedFanoutPointer = (jobRef, queueKey, nowMs) => jobRef.transaction((current) => {
  if (!current || current.queueKey !== queueKey || !current.fanoutCompletedAtMs
    || isNotificationLifecycleRetentionFenced(current, nowMs)) return undefined;
  return { ...current, queueKind: null, queueKey: null, queueVersion: Number(current.queueVersion || 0) + 1 };
});

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
  finalizeAndScheduleCompletedFanout,
  renewNotificationJobSubmissionFence,
  settleCompletedFanoutQueue,
};
