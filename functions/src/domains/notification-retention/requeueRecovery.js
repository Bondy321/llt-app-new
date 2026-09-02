'use strict';

// @ts-check

const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { isNotificationRetentionFenced } = require('./eligibility');
const {
  cancelCanonicalFence,
  hasCommittedIrreversibleWork,
  persistRetentionWarning,
} = require('./retentionContext');
const { fenceIdFor } = require('./retentionFenceRecovery');
const { ensureNotificationRetentionScheduled } = require('./state');

const REQUEUEABLE_STATUSES = new Set([
  'ticket_rejected', 'provider_rejected', 'partial', 'expired',
]);
const ATTENTION_FINGERPRINT_PATTERN = /^attention_v1_[a-f0-9]{32}$/u;
const ACCEPTED_RETENTION_SCHEDULE_REASONS = new Set([
  'scheduled', 'already_scheduled', 'queue_repaired',
]);

const retentionStateBlocksManualRequeue = (state) => Boolean(
  state?.status === 'requires_attention'
  || state?.attention
  || state?.destructiveCommit
  || hasCommittedIrreversibleWork(state)
);

const stateTargetsCanonical = (state, jobId, job) => Boolean(
  state?.jobId === jobId
  && Number(state.targetCompletedAtMs || 0) === Number(job?.completedAtMs || 0)
);

const readRetentionState = async (db, jobId) => (
  (await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`).once('value')).val()
);

const readAttentionPointer = async (db, jobId) => (
  (await db.ref(`${NOTIFICATION_RETENTION_PATHS.attention}/${jobId}`).once('value')).val()
);

const readEffectiveAttention = async (db, jobId, state = null) => {
  const projection = await readAttentionPointer(db, jobId);
  const embedded = state?.attention;
  if (embedded?.jobId === jobId && (!projection
    || projection.attentionFingerprint !== embedded.attentionFingerprint)) return embedded;
  return projection || embedded || null;
};

const isManualRequeueBlockedByRetentionState = async ({ db, jobId, job = null }) => {
  const canonical = job || (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  const state = await readRetentionState(db, jobId);
  if (stateTargetsCanonical(state, jobId, canonical)
    && retentionStateBlocksManualRequeue(state)) return true;
  const attention = await readEffectiveAttention(db, jobId, state);
  return Boolean(attention?.jobId === jobId
    && Number(attention.targetCompletedAtMs || 0) === Number(canonical?.completedAtMs || 0)
    && attention.irreversibleWorkStarted === true);
};

const exactAttentionIdentity = (attention, state, jobId) => Boolean(
  attention?.jobId === jobId
  && state?.jobId === jobId
  && Number(attention.generation) === Number(state.generation)
  && attention.queueKey === state.queueKey
  && Number(attention.queueVersion) === Number(state.queueVersion)
  && attention.targetStatus === state.targetStatus
  && Number(attention.targetCompletedAtMs || 0) === Number(state.targetCompletedAtMs || 0)
);

const expectedAttentionMatches = (attention, expected) => Boolean(
  Number.isSafeInteger(expected?.generation)
  && Number(expected.generation) === Number(attention?.generation)
  && ATTENTION_FINGERPRINT_PATTERN.test(expected?.attentionFingerprint || '')
  && expected.attentionFingerprint === attention?.attentionFingerprint
);

const exactQueueEntry = (current, attention) => Boolean(current
  && current.jobId === attention.jobId
  && Number(current.generation) === Number(attention.generation));

const upsertExactDueQueueEntry = async ({ db, attention }) => {
  let written = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${attention.queueKey}`)
    .transaction((current) => {
      if (current && !exactQueueEntry(current, attention)) return undefined;
      written = true;
      return {
        jobId: attention.jobId,
        generation: attention.generation,
        dueAtMs: attention.retentionDueAtMs,
      };
    }, undefined, false);
  return Boolean(written && result?.committed);
};

const removeExactAttentionPointer = async ({ db, jobId, attention }) => {
  let removed = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.attention}/${jobId}`)
    .transaction((current) => {
      if (!current || current.attentionFingerprint !== attention.attentionFingerprint
        || Number(current.generation) !== Number(attention.generation)) return undefined;
      removed = true;
      return null;
    }, undefined, false);
  return Boolean(removed && result?.committed);
};

const retryNotificationRetentionAttention = async ({
  db, jobId, expected, nowMs = Date.now(),
}) => {
  const state = await readRetentionState(db, jobId);
  const attention = await readEffectiveAttention(db, jobId, state);
  if (!expectedAttentionMatches(attention, expected)) {
    return { retried: false, reason: 'attention_changed' };
  }
  if (!exactAttentionIdentity(attention, state, jobId)
    || state.status !== 'requires_attention' || state.lease) {
    return { retried: false, reason: 'state_changed' };
  }
  if (!Number.isSafeInteger(attention.retentionDueAtMs)
    || attention.retentionDueAtMs <= 0) {
    return { retried: false, reason: 'attention_due_invalid' };
  }
  if (!(await upsertExactDueQueueEntry({ db, attention }))) {
    return { retried: false, reason: 'queue_changed' };
  }
  let retried = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`)
    .transaction((current) => {
      if (!exactAttentionIdentity(attention, current, jobId)
        || current.status !== 'requires_attention' || current.lease
        || hasCommittedIrreversibleWork(current)
          !== Boolean(attention.irreversibleWorkStarted)) return undefined;
      retried = true;
      return {
        ...current,
        status: 'queued',
        attention: null,
        retentionDueAtMs: attention.retentionDueAtMs,
        lease: null,
        leaseExpiresAtMs: null,
        lastErrorCode: null,
        updatedAtMs: nowMs,
      };
    }, undefined, false);
  if (!retried || !result?.committed) {
    return { retried: false, reason: 'state_changed' };
  }
  // Repair the compatibility pointer once more after the state CAS. The
  // indexed state itself is the authoritative due queue.
  await upsertExactDueQueueEntry({ db, attention });
  const attentionRemoved = await removeExactAttentionPointer({ db, jobId, attention });
  return {
    retried: true,
    generation: attention.generation,
    attentionRemoved,
  };
};

const abandonNotificationRetentionAttention = async ({
  db, jobId, expected,
}) => {
  const state = await readRetentionState(db, jobId);
  const attention = await readEffectiveAttention(db, jobId, state);
  if (!expectedAttentionMatches(attention, expected)) {
    return { abandoned: false, reason: 'attention_changed' };
  }
  if (!exactAttentionIdentity(attention, state, jobId)
    || state.status !== 'requires_attention' || state.lease) {
    return { abandoned: false, reason: 'state_changed' };
  }
  if (attention.irreversibleWorkStarted === true
    || Number(attention.committedDeletionCount || 0) > 0
    || state.destructiveCommit
    || hasCommittedIrreversibleWork(state)) {
    return { abandoned: false, reason: 'irreversible_work_started' };
  }
  const canonical = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  const expectedFenceId = fenceIdFor(jobId, state.generation);
  if (canonical?.retentionFence) {
    if (canonical.retentionFence.fenceId !== expectedFenceId) {
      return { abandoned: false, reason: 'canonical_fence_changed' };
    }
    const cancelled = await cancelCanonicalFence({
      db,
      jobId,
      fenceId: expectedFenceId,
      metrics: null,
      allowPreparedCommitCancellation: true,
    });
    if (!cancelled) return { abandoned: false, reason: 'canonical_fence_changed' };
  }
  let abandoned = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`)
    .transaction((current) => {
      if (!exactAttentionIdentity(attention, current, jobId)
        || current.status !== 'requires_attention' || current.lease
        || current.destructiveCommit
        || hasCommittedIrreversibleWork(current)) return undefined;
      abandoned = true;
      return null;
    }, undefined, false);
  if (!abandoned || !result?.committed) {
    return { abandoned: false, reason: 'state_changed' };
  }
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${attention.queueKey}`)
    .transaction((current) => (exactQueueEntry(current, attention) ? null : undefined), undefined, false);
  const attentionRemoved = await removeExactAttentionPointer({ db, jobId, attention });
  return { abandoned: true, generation: attention.generation, attentionRemoved };
};

const zeroResultRecoveryConflicts = ({ retentionState, attention, jobId, job }) => (
  (stateTargetsCanonical(retentionState, jobId, job)
    && (retentionState.status === 'requires_attention'
      || retentionStateBlocksManualRequeue(retentionState)))
  || (attention?.jobId === jobId
    && Number(attention.targetCompletedAtMs || 0) === Number(job.completedAtMs || 0))
);

const exactRetryingRecoveryJob = ({ current, jobId, state, expectedGeneration }) => Boolean(
  current?.jobId === jobId
  && current.status === 'retrying'
  && Number(current.completedAtMs || 0) === Number(state.sourceCompletedAtMs || 0)
  && Number(current.retentionGeneration || 0) === expectedGeneration
  && !isNotificationRetentionFenced(current)
);

const exactRestoredRecoveryJob = ({
  current, jobId, restored, restoredStatus, expectedGeneration,
}) => Boolean(
  current?.jobId === jobId
  && current.status === restoredStatus
  && Number(current.completedAtMs || 0) === Number(restored.completedAtMs || 0)
  && Number(current.retentionGeneration || 0) === expectedGeneration
  && !isNotificationRetentionFenced(current)
);

const recoverZeroResultRequeue = async ({ db, jobId, state, nowMs }) => {
  if (state?.status !== 'complete' || Number(state.requeued || 0) !== 0) {
    return (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  }
  const jobRef = db.ref(`notification_jobs/${jobId}`);
  const observed = (await jobRef.once('value')).val();
  if (!observed || observed.status !== 'retrying') return observed;

  // Zero-result recovery is already an exceptional lifecycle repair. Its
  // durable warning must exist before any canonical state is changed.
  try {
    await persistRetentionWarning({
      db, jobId, reason: 'zero_result_requeue_recovery', nowMs,
    });
  } catch (_error) {
    return observed;
  }
  const retentionState = await readRetentionState(db, jobId);
  const attention = await readAttentionPointer(db, jobId);
  if (zeroResultRecoveryConflicts({ retentionState, attention, jobId, job: observed })) {
    return observed;
  }

  let restored = null;
  const expectedGeneration = Number(observed.retentionGeneration || 0);
  const restoredStatus = REQUEUEABLE_STATUSES.has(state.sourceStatus)
    ? state.sourceStatus : 'provider_rejected';
  await jobRef.transaction((current) => {
    if (!exactRetryingRecoveryJob({ current, jobId, state, expectedGeneration })) return undefined;
    restored = {
      ...current,
      status: restoredStatus,
      completedAtMs: Number(current.completedAtMs || state.sourceCompletedAtMs || nowMs),
      updatedAtMs: nowMs,
    };
    return restored;
  }, undefined, false);
  if (!restored) return (await jobRef.once('value')).val();
  const retention = await ensureNotificationRetentionScheduled({
    db, jobId, job: restored, nowMs,
  });
  if (ACCEPTED_RETENTION_SCHEDULE_REASONS.has(retention?.reason)) return restored;

  let rolledBack = null;
  await jobRef.transaction((current) => {
    if (!exactRestoredRecoveryJob({
      current, jobId, restored, restoredStatus, expectedGeneration,
    })) return undefined;
    rolledBack = { ...current, status: 'retrying', updatedAtMs: nowMs };
    return rolledBack;
  }, undefined, false);
  return rolledBack || (await jobRef.once('value')).val();
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
  abandonNotificationRetentionAttention,
  cleanupExpiredNotificationRequeueState,
  isManualRequeueBlockedByRetentionState,
  readEffectiveAttention,
  recoverZeroResultRequeue,
  retryNotificationRetentionAttention,
};
