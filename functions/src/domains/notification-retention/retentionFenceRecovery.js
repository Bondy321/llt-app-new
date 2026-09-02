'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { transactionWithAuthoritativeExistingValue } = require('./retentionEngineRuntime');
const {
  normalizeNotificationRetentionRollout,
} = require('./state');

const fenceIdFor = (jobId, generation) => `retention_fence_v1_${createHash('sha256')
  .update(`${jobId}:${generation}`).digest('hex').slice(0, 32)}`;

const jobMatchesState = (job, state, jobId) => Boolean(job && job.jobId === jobId
  && job.status === state.targetStatus
  && Number(job.completedAtMs || 0) === Number(state.targetCompletedAtMs || 0));

const readRolloutRecoveryIdentity = async (db) => {
  const raw = (await db.ref(NOTIFICATION_RETENTION_PATHS.rollout).once('value')).val();
  return {
    rollout: normalizeNotificationRetentionRollout(raw),
    rawFingerprint: createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex'),
  };
};

const persistTransferredDestructiveState = async ({
  stateRef, state, replacementState, fence, nowMs,
}) => {
  if (fence.commitStatus !== 'destructive') return { state, destructive: false };
  if (!replacementState) return { state, destructive: true };
  let persisted = null;
  const result = await transactionWithAuthoritativeExistingValue(stateRef, (current) => {
    if (!current || current.lease?.ownerId !== replacementState.lease?.ownerId
      || Number(current.leaseRevision) !== Number(replacementState.leaseRevision)
      || Number(current.generation) !== Number(replacementState.generation)) return undefined;
    persisted = {
      ...current,
      destructiveCommit: current.destructiveCommit || {
        phase: current.phase,
        generation: current.generation,
        leaseRevision: current.leaseRevision,
        startedAtMs: nowMs,
      },
    };
    return persisted;
  });
  if (!result?.committed || !persisted) return null;
  Object.assign(replacementState, persisted);
  return { state: persisted, destructive: true };
};

const recoverInactiveLegacyFence = async ({
  db, jobId, nowMs, allowDestructiveRecovery = false,
  replacementFence = null, replacementState = null,
// eslint-disable-next-line complexity -- recovery compare-checks the complete legacy fence and rollout identity
}) => {
  if (typeof jobId !== 'string' || !jobId) return null;
  const recoveryIdentityBefore = await readRolloutRecoveryIdentity(db);
  const rolloutBefore = recoveryIdentityBefore.rollout;
  const compatibleLegacyFallback = !rolloutBefore.valid
    && rolloutBefore.phase === 'legacy' && rolloutBefore.revision === 0;
  if (!rolloutBefore.valid && !compatibleLegacyFallback) return null;
  const canonicalRef = db.ref(`notification_jobs/${jobId}`);
  const observed = (await canonicalRef.once('value')).val();
  const fence = observed?.retentionFence;
  const fenceRolloutCompatible = ['legacy', 'shadow'].includes(fence?.rolloutPhase)
    && Number.isSafeInteger(fence?.rolloutRevision)
    && (rolloutBefore.valid
      ? fence.rolloutRevision <= rolloutBefore.revision
        && (rolloutBefore.phase !== 'compactor' || fence.rolloutRevision < rolloutBefore.revision)
      : fence.rolloutPhase === 'legacy' && fence.rolloutRevision === 0);
  if (!fence || fence.kind !== 'legacy' || fence.status !== 'active'
    || (!allowDestructiveRecovery && fence.commitStatus === 'destructive')
    || !String(fence.fenceId || '').startsWith('legacy_retention_fence_v2_')
    || !Number.isSafeInteger(fence.leaseExpiresAtMs) || fence.leaseExpiresAtMs > nowMs
    || !fenceRolloutCompatible) {
    return null;
  }
  const stateRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`);
  const state = (await stateRef.once('value')).val();
  const activeStateLease = state?.lease && Number(state.lease.expiresAtMs || 0) > nowMs;
  const replacementOwnsState = replacementFence && replacementState
    && state?.lease?.ownerId === replacementState.lease?.ownerId
    && Number(state?.leaseRevision) === Number(replacementState.leaseRevision)
    && Number(state?.generation) === Number(replacementState.generation);
  if (activeStateLease && !replacementOwnsState) return null;
  const transferred = await persistTransferredDestructiveState({
    stateRef,
    state,
    replacementState: replacementOwnsState ? replacementState : null,
    fence,
    nowMs,
  });
  if (!transferred) return null;
  const effectiveReplacementFence = replacementFence && transferred.destructive
    ? { ...replacementFence, commitStatus: 'destructive' }
    : replacementFence;
  let recoveredJob = null;
  const canonicalResult = await transactionWithAuthoritativeExistingValue(canonicalRef, (current) => {
    if (!current || current.jobId !== jobId
      || current.retentionFence?.fenceId !== fence.fenceId
      || current.retentionFence?.kind !== 'legacy'
      || Number(current.retentionFence?.leaseRevision) !== Number(fence.leaseRevision)
      || Number(current.retentionFence?.leaseExpiresAtMs) !== Number(fence.leaseExpiresAtMs)
      || Number(current.retentionGeneration) !== Number(fence.generation)
      || (state && !jobMatchesState(current, state, jobId))) return undefined;
    recoveredJob = {
      ...current,
      retentionGeneration: effectiveReplacementFence
        ? Number(effectiveReplacementFence.generation)
        : Math.max(0, Number(fence.generation) - 1),
      retentionFence: effectiveReplacementFence,
    };
    return recoveredJob;
  });
  if (!canonicalResult?.committed || !recoveredJob) return null;
  const recoveryIdentityAfter = await readRolloutRecoveryIdentity(db);
  const rolloutAfter = recoveryIdentityAfter.rollout;
  if (rolloutAfter.phase !== rolloutBefore.phase || rolloutAfter.revision !== rolloutBefore.revision
    || recoveryIdentityAfter.rawFingerprint !== recoveryIdentityBefore.rawFingerprint) {
    await transactionWithAuthoritativeExistingValue(canonicalRef, (current) => {
      const replacementStillOwned = effectiveReplacementFence
        ? current?.retentionFence?.fenceId === effectiveReplacementFence.fenceId
          && Number(current?.retentionFence?.generation)
            === Number(effectiveReplacementFence.generation)
        : !current?.retentionFence
          && Number(current?.retentionGeneration) === Math.max(0, Number(fence.generation) - 1);
      if (!current || current.jobId !== jobId || !replacementStillOwned) return undefined;
      return { ...current, retentionGeneration: fence.generation, retentionFence: fence };
    });
    return null;
  }
  return recoveredJob;
};

const recoverInactiveCompactorFence = async ({
  db, jobId, nowMs, allowDestructiveRecovery = false,
  replacementFence = null, replacementState = null,
// eslint-disable-next-line complexity -- recovery compare-checks state, fence and rollout ownership
}) => {
  const recoveredLegacy = await recoverInactiveLegacyFence({
    db, jobId, nowMs, allowDestructiveRecovery, replacementFence, replacementState,
  });
  if (recoveredLegacy) return recoveredLegacy;
  const recoveryIdentityBefore = await readRolloutRecoveryIdentity(db);
  const rolloutBefore = recoveryIdentityBefore.rollout;
  const compatibleLegacyFallback = !rolloutBefore.valid
    && rolloutBefore.phase === 'legacy' && rolloutBefore.revision === 0;
  if ((!rolloutBefore.valid && !compatibleLegacyFallback)
    || !['legacy', 'shadow'].includes(rolloutBefore.phase)) return null;
  const stateRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`);
  const state = (await stateRef.once('value')).val();
  if (!allowDestructiveRecovery && (state?.destructiveCommit
    || state?.retentionFence?.commitStatus === 'destructive')) return null;
  const expiredProcessing = state?.status === 'processing' && state.lease
    && Number(state.lease.expiresAtMs || 0) <= nowMs;
  const releasedQueued = state?.status === 'queued' && !state.lease;
  if (!state || (!expiredProcessing && !releasedQueued)) return null;
  const fenceId = fenceIdFor(jobId, state.generation);
  let recoveredJob = null;
  const canonicalResult = await transactionWithAuthoritativeExistingValue(
    db.ref(`notification_jobs/${jobId}`), (current) => {
    if (!jobMatchesState(current, state, jobId)
      || current.retentionFence?.fenceId !== fenceId
      || current.retentionFence.status !== 'active'
      || Number(current.retentionFence.generation) !== Number(state.generation)
      || Number(current.retentionFence.leaseRevision) !== Number(state.leaseRevision)
      || (current.retentionFence.commitStatus === 'destructive')
        !== Boolean(state.destructiveCommit)
      || Number(current.retentionGeneration) !== Number(state.generation)) return undefined;
    recoveredJob = {
      ...current,
      retentionGeneration: replacementFence
        ? Number(replacementFence.generation)
        : Math.max(0, Number(state.generation) - 1),
      retentionFence: replacementFence,
    };
    return recoveredJob;
    },
  );
  if (!canonicalResult?.committed || !recoveredJob) return null;
  const recoveryIdentityAfter = await readRolloutRecoveryIdentity(db);
  const rolloutAfter = recoveryIdentityAfter.rollout;
  if (rolloutAfter.phase !== rolloutBefore.phase || rolloutAfter.revision !== rolloutBefore.revision
    || recoveryIdentityAfter.rawFingerprint !== recoveryIdentityBefore.rawFingerprint) {
    await transactionWithAuthoritativeExistingValue(
      db.ref(`notification_jobs/${jobId}`), (current) => {
      const replacementStillOwned = replacementFence
        ? current?.retentionFence?.fenceId === replacementFence.fenceId
          && Number(current?.retentionFence?.generation) === Number(replacementFence.generation)
        : !current?.retentionFence;
      if (!jobMatchesState(current, state, jobId) || !replacementStillOwned) return undefined;
      return {
        ...current,
        retentionGeneration: state.generation,
        retentionFence: {
          fenceId,
          status: 'active',
          completedAtMs: Number(current.completedAtMs || 0),
          generation: state.generation,
          leaseRevision: state.leaseRevision,
          leaseExpiresAtMs: state.lease?.expiresAtMs || state.leaseExpiresAtMs,
          commitStatus: state.destructiveCommit ? 'destructive' : null,
        },
      };
      },
    );
    return null;
  }
  await transactionWithAuthoritativeExistingValue(stateRef, (current) => {
    if (!current || Number(current.leaseRevision) !== Number(state.leaseRevision)) return undefined;
    if (expiredProcessing && (current.status !== 'processing'
      || current.lease?.ownerId !== state.lease.ownerId
      || Number(current.lease?.expiresAtMs) !== Number(state.lease.expiresAtMs))) return undefined;
    if (releasedQueued && (current.status !== 'queued' || current.lease)) return undefined;
    return {
      ...current, status: 'queued', lease: null, leaseExpiresAtMs: null, updatedAtMs: nowMs,
    };
  });
  return recoveredJob;
};

module.exports = {
  fenceIdFor,
  jobMatchesState,
  readRolloutRecoveryIdentity,
  recoverInactiveCompactorFence,
  recoverInactiveLegacyFence,
};
