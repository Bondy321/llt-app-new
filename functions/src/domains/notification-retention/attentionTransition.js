'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
} = require('../../../lib/operationsTerminalWarnings');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { safeInteger } = require('./retentionEngineRuntime');
const {
  cancelCanonicalFence,
  hasCommittedIrreversibleWork,
  removeRetentionQueueEntry,
} = require('./retentionOwnership');

const positiveSafeInteger = (value) => (
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
);

const firstDestructiveCommitAtMs = (state, nowMs) => (
  positiveSafeInteger(state?.firstDestructiveCommitAtMs)
  || positiveSafeInteger(state?.destructiveCommit?.startedAtMs)
  || positiveSafeInteger(state?.updatedAtMs)
  || nowMs
);

const persistRetentionWarning = async ({ db, jobId, reason, nowMs }) => {
  const warning = buildOperationsTerminalWarning({
    jobType: 'notification_retention',
    reason,
    identifiers: { retentionJobHash: createHash('sha256').update(jobId).digest('hex').slice(0, 24) },
    attemptCount: 1,
    firstAttemptAtMs: nowMs,
    lastAttemptAtMs: nowMs,
    expiresAtMs: nowMs,
    nowMs,
  });
  return persistOperationsTerminalWarning({ db, warning });
};

const boundedReasonCode = (reason) => String(reason || 'retention_attention')
  .trim().toLowerCase().replace(/[^a-z0-9_:-]+/gu, '_').slice(0, 80)
  || 'retention_attention';

const attentionFingerprintFor = (pointer) => `attention_v1_${createHash('sha256')
  .update(JSON.stringify({
    jobId: pointer.jobId,
    generation: pointer.generation,
    queueKey: pointer.queueKey,
    queueVersion: pointer.queueVersion,
    targetStatus: pointer.targetStatus,
    targetCompletedAtMs: pointer.targetCompletedAtMs,
    retentionDueAtMs: pointer.retentionDueAtMs,
    reasonCode: pointer.reasonCode,
    irreversibleWorkStarted: pointer.irreversibleWorkStarted,
    committedDeletionCount: pointer.committedDeletionCount,
    firstDestructiveCommitAtMs: pointer.firstDestructiveCommitAtMs,
    updatedAtMs: pointer.updatedAtMs,
  })).digest('hex').slice(0, 32)}`;

const buildAttentionPointer = ({ context, state, reason, nowMs }) => {
  const pointer = {
    schemaVersion: 1,
    jobId: context.jobId,
    generation: state.generation,
    queueKey: context.queueKey,
    queueVersion: Number(context.entry?.generation),
    targetStatus: state.targetStatus,
    targetCompletedAtMs: Number(state.targetCompletedAtMs || 0),
    retentionDueAtMs: positiveSafeInteger(state.retentionDueAtMs),
    reasonCode: boundedReasonCode(reason),
    irreversibleWorkStarted: hasCommittedIrreversibleWork(state),
    committedDeletionCount: Math.max(
      safeInteger(state.committedDeletionCount),
      safeInteger(state.deletionCount),
      safeInteger(state.attemptsDeleted),
    ),
    firstDestructiveCommitAtMs: hasCommittedIrreversibleWork(state)
      ? firstDestructiveCommitAtMs(state, nowMs) : null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  return { ...pointer, attentionFingerprint: attentionFingerprintFor(pointer) };
};

const persistAttentionPointer = async ({ db, jobId, attention, metrics = null }) => {
  if (!attention || attention.jobId !== jobId) return false;
  let persisted = false;
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.attention}/${jobId}`)
    .transaction((current) => {
      if (current && current.attentionFingerprint !== attention.attentionFingerprint) {
        return undefined;
      }
      persisted = true;
      return attention;
    }, undefined, false);
  if (metrics) metrics.transactions += 1;
  return Boolean(result?.committed && persisted);
};

const repairAttentionProjection = async ({ db, jobId, state, metrics = null }) => {
  if (state?.status !== 'requires_attention' || !state.attention) return false;
  return persistAttentionPointer({ db, jobId, attention: state.attention, metrics });
};

const commitRequiresAttentionState = async ({ context, reason, nowMs, metrics }) => {
  let committed = null;
  const result = await context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`)
    .transaction((current) => {
      if (!current || current.lease?.ownerId !== context.ownerId
        || current.queueKey !== context.queueKey
        || Number(current.generation) !== Number(context.entry?.generation)
        || current.targetStatus !== context.state.targetStatus
        || Number(current.targetCompletedAtMs || 0)
          !== Number(context.state.targetCompletedAtMs || 0)) return undefined;
      const attention = buildAttentionPointer({ context, state: current, reason, nowMs });
      committed = {
        ...current,
        status: 'requires_attention',
        attention,
        lastErrorCode: String(reason || 'retention_attention').slice(0, 80),
        destructiveCommit: null,
        lease: null,
        leaseExpiresAtMs: null,
        updatedAtMs: nowMs,
      };
      return committed;
    }, undefined, false);
  metrics.transactions += 1;
  return result?.committed ? committed : null;
};

const markRequiresAttention = async ({ context, reason, nowMs, metrics }) => {
  metrics.jobsRequiresAttention += 1;
  metrics.failures += 1;
  try {
    await persistRetentionWarning({ db: context.db, jobId: context.jobId, reason, nowMs });
  } catch (_error) {
    metrics.failures += 1;
    return false;
  }
  const committed = await commitRequiresAttentionState({ context, reason, nowMs, metrics });
  if (!committed) {
    metrics.failures += 1;
    return false;
  }
  context.state = committed;
  if (!(await repairAttentionProjection({
    db: context.db, jobId: context.jobId, state: committed, metrics,
  }))) {
    metrics.failures += 1;
    return false;
  }
  const irreversible = hasCommittedIrreversibleWork(committed);
  if (!irreversible && !context.canonicalDeleted) {
    const cancelled = await cancelCanonicalFence({
      db: context.db,
      jobId: context.jobId,
      fenceId: context.fenceId,
      metrics,
      allowPreparedCommitCancellation: true,
    });
    if (!cancelled) return false;
  }
  await removeRetentionQueueEntry({
    db: context.db, queueKey: context.queueKey, entry: context.entry, metrics,
  });
  return true;
};

module.exports = {
  markRequiresAttention,
  persistAttentionPointer,
  persistRetentionWarning,
  repairAttentionProjection,
};
