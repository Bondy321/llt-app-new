'use strict';

// @ts-check

const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { maxMetric, safeInteger } = require('./retentionEngineRuntime');

const positiveSafeInteger = (value) => (
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
);

const hasCommittedIrreversibleWork = (state) => Boolean(
  state?.irreversibleWorkStarted === true
  || safeInteger(state?.committedDeletionCount) > 0
  || safeInteger(state?.deletionCount) > 0
  || safeInteger(state?.attemptsDeleted) > 0
);

const firstDestructiveCommitAtMs = (state, nowMs) => (
  positiveSafeInteger(state?.firstDestructiveCommitAtMs)
  || positiveSafeInteger(state?.destructiveCommit?.startedAtMs)
  || positiveSafeInteger(state?.updatedAtMs)
  || nowMs
);

const cumulativeFenceFields = (state, nowMs) => (
  hasCommittedIrreversibleWork(state) ? {
    irreversibleWorkStarted: true,
    firstDestructiveCommitAtMs: firstDestructiveCommitAtMs(state, nowMs),
    irreversibleGeneration: safeInteger(state?.generation),
    commitStatus: 'destructive',
  } : {
    irreversibleWorkStarted: false,
    firstDestructiveCommitAtMs: null,
    irreversibleGeneration: null,
    commitStatus: state?.destructiveCommit ? 'destructive' : null,
  }
);

const readActiveRequeue = async (db, jobId, nowMs, metrics) => {
  const value = (await db.ref(`notification_requeue_jobs/${jobId}`).once('value')).val();
  metrics.queries += 1;
  return Boolean(value && value.status === 'processing');
};

const removeRetentionQueueEntry = async ({ db, queueKey, entry, metrics }) => {
  let removed = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${queueKey}`)
    .transaction((current) => {
      if (!current || current.jobId !== entry?.jobId
        || Number(current.generation) !== Number(entry?.generation)) return undefined;
      removed = true;
      return null;
    }, undefined, false);
  if (metrics) metrics.transactions += 1;
  if (removed && result?.committed) {
    metrics.queueEntriesRemoved += 1;
    metrics.updatePaths += 1;
    maxMetric(metrics, 'maxUpdatePaths', 1);
  }
  return Boolean(removed && result?.committed);
};

const releaseStateLease = async ({
  db, jobId, ownerId, nowMs, status = 'queued', errorCode = null, metrics = null,
  clearDestructiveCommit = false,
}) => {
  let released = null;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`).transaction((current) => {
    if (!current || current.lease?.ownerId !== ownerId) return undefined;
    const irreversible = hasCommittedIrreversibleWork(current);
    released = {
      ...current,
      status,
      ...(status === 'requires_attention' && !irreversible ? { retentionDueAtMs: null } : {}),
      ...(errorCode ? { lastErrorCode: String(errorCode).slice(0, 80) } : {}),
      ...(clearDestructiveCommit ? { destructiveCommit: null } : {}),
      lease: null,
      leaseExpiresAtMs: null,
      updatedAtMs: nowMs,
    };
    return released;
  }, undefined, false);
  if (metrics) metrics.transactions += 1;
  return result?.committed ? released : null;
};

const cancelCanonicalFence = async ({
  db, jobId, fenceId, metrics, allowPreparedCommitCancellation = false,
}) => {
  let cancelled = false;
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.retentionFence?.fenceId !== fenceId) return undefined;
    if (current.retentionFence.irreversibleWorkStarted === true
      || (current.retentionFence.commitStatus === 'destructive'
        && !allowPreparedCommitCancellation)) return undefined;
    const fenceGeneration = safeInteger(current.retentionFence.generation);
    cancelled = true;
    return {
      ...current,
      retentionGeneration: Math.max(0, fenceGeneration - 1),
      retentionFence: null,
    };
  }, undefined, false);
  if (metrics) metrics.transactions += 1;
  return Boolean(cancelled && result?.committed);
};

module.exports = {
  cancelCanonicalFence,
  cumulativeFenceFields,
  firstDestructiveCommitAtMs,
  hasCommittedIrreversibleWork,
  readActiveRequeue,
  removeRetentionQueueEntry,
  releaseStateLease,
};
