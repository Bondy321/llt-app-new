'use strict';

// @ts-check

const { isNotificationRetentionFenced } = require('./eligibility');
const { ensureNotificationRetentionScheduled } = require('./state');

const REQUEUEABLE_STATUSES = new Set([
  'ticket_rejected', 'provider_rejected', 'partial', 'expired',
]);

const recoverZeroResultRequeue = async ({ db, jobId, state, nowMs }) => {
  if (state?.status !== 'complete' || Number(state.requeued || 0) !== 0) {
    return (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  }
  let restored = null;
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  await jobRef.transaction((current) => {
    if (!current || current.status !== 'retrying'
      || isNotificationRetentionFenced(current)) return undefined;
    restored = {
      ...current,
      status: REQUEUEABLE_STATUSES.has(state.sourceStatus)
        ? state.sourceStatus : 'provider_rejected',
      completedAtMs: Number(current.completedAtMs || state.sourceCompletedAtMs || nowMs),
      updatedAtMs: nowMs,
    };
    return restored;
  }, undefined, false);
  if (!restored) return (await jobRef.once('value')).val();
  const retention = await ensureNotificationRetentionScheduled({
    db, jobId, job: restored, nowMs,
  });
  if (!['scheduled', 'already_scheduled', 'queue_repaired'].includes(retention?.reason)) {
    throw new Error('Notification requeue retention was not durably scheduled');
  }
  return restored;
};

const exactRequeueIdentity = (current, expected) => current
  && current.requeueId === expected?.requeueId
  && current.status === expected.status
  && Number(current.sourceCompletedAtMs || 0) === Number(expected.sourceCompletedAtMs || 0)
  && Number(current.expiresAtMs || 0) === Number(expected.expiresAtMs || 0);

const preserveExpiredState = async ({ db, jobId, expected, nowMs, malformed = false }) => {
  let preserved = false;
  const result = await db.ref(`notification_requeue_jobs/${jobId}`).transaction((current) => {
    if (!exactRequeueIdentity(current, expected)) return undefined;
    preserved = true;
    const liveLease = !malformed && current.lease
      && Number(current.lease.expiresAtMs || 0) > nowMs;
    return {
      ...current,
      lease: liveLease ? current.lease : null,
      expiresAtMs: null,
      recoveryDueAtMs: liveLease ? current.lease.expiresAtMs : nowMs,
      ...(malformed ? { safeErrorCode: 'REQUEUE_STATE_MALFORMED' } : {}),
      updatedAtMs: liveLease ? current.updatedAtMs : nowMs,
    };
  }, undefined, false);
  return { deleted: false, preserved: Boolean(preserved && result?.committed) };
};

const cleanupExpiredNotificationRequeueState = async ({
  db, jobId, expected, nowMs,
}) => {
  if (!expected || !Number.isSafeInteger(expected.expiresAtMs)
    || expected.expiresAtMs > nowMs) return { deleted: false, preserved: false };
  if (expected.status === 'processing') {
    return preserveExpiredState({ db, jobId, expected, nowMs });
  }
  if (expected.status !== 'complete') {
    return preserveExpiredState({ db, jobId, expected, nowMs, malformed: true });
  }
  if (Number(expected.requeued || 0) === 0) {
    const recovered = await recoverZeroResultRequeue({ db, jobId, state: expected, nowMs });
    if (recovered?.status === 'retrying') return { deleted: false, preserved: true };
  }
  let deleted = false;
  const result = await db.ref(`notification_requeue_jobs/${jobId}`).transaction((current) => {
    if (!exactRequeueIdentity(current, expected)) return undefined;
    deleted = true;
    return null;
  }, undefined, false);
  return { deleted: Boolean(deleted && result?.committed), preserved: false };
};

module.exports = {
  REQUEUEABLE_STATUSES,
  cleanupExpiredNotificationRequeueState,
  recoverZeroResultRequeue,
};
