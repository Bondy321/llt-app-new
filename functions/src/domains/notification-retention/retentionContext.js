'use strict';

// @ts-check

const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const {
  classifyNotificationRetentionEligibility,
  isNotificationRetentionFenced,
} = require('./eligibility');
const {
  safeInteger,
  transactionWithAuthoritativeExistingValue,
} = require('./retentionEngineRuntime');
const {
  canaryEvidenceStillMatches,
  readNotificationRetentionRollout,
  shadowEvidenceStillMatches,
} = require('./state');
const {
  fenceIdFor,
  jobMatchesState,
  recoverInactiveCompactorFence,
  recoverInactiveLegacyFence,
} = require('./retentionFenceRecovery');

const {
  cancelCanonicalFence,
  cumulativeFenceFields,
  firstDestructiveCommitAtMs,
  hasCommittedIrreversibleWork,
  readActiveRequeue,
  removeRetentionQueueEntry,
  releaseStateLease,
} = require('./retentionOwnership');

const persistRetentionWarning = (options) => require('./attentionTransition')
  .persistRetentionWarning(options);
const markRequiresAttention = (options) => require('./attentionTransition')
  .markRequiresAttention(options);
const repairAttentionProjection = (options) => require('./attentionTransition')
  .repairAttentionProjection(options);

const claimStateLease = async ({ db, queueKey, entry, nowMs, ownerId, budgets, metrics }) => {
  const jobId = entry?.jobId;
  if (typeof jobId !== 'string' || !jobId) return { stale: true };
  const stateRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`);
  const observed = (await stateRef.once('value')).val();
  metrics.queries += 1;
  if (!observed || observed.queueKey !== queueKey
    || Number(observed.generation) !== Number(entry.generation)
    || observed.status === 'completed') {
    return { stale: true, jobId };
  }
  if (observed.status === 'requires_attention') {
    return { attention: true, state: observed, jobId };
  }
  let claimed = false;
  let blockedByLease = false;
  const result = await transactionWithAuthoritativeExistingValue(stateRef, (current) => {
    if (!current || current.queueKey !== queueKey
      || Number(current.generation) !== Number(entry.generation)
      || current.status === 'completed' || current.status === 'requires_attention') return undefined;
    if (current.lease && current.lease.ownerId !== ownerId
      && Number(current.lease.expiresAtMs || 0) > nowMs) {
      blockedByLease = true;
      return undefined;
    }
    claimed = true;
    const leaseRevision = safeInteger(current.leaseRevision) + 1;
    // A destructiveCommit is written before each destructive unit and cleared
    // only after its cumulative outcome is recorded. If the previous worker
    // died between the external mutation and that promotion, recovery cannot
    // prove that the mutation did not commit. Promote the marker
    // conservatively while claiming the next lease so rollout revocation,
    // attention handling and manual recovery all remain fail-closed.
    const recoveringAmbiguousCommit = Boolean(current.destructiveCommit)
      && !hasCommittedIrreversibleWork(current);
    return {
      ...current,
      ...(recoveringAmbiguousCommit ? {
        irreversibleWorkStarted: true,
        firstDestructiveCommitAtMs: firstDestructiveCommitAtMs(current, nowMs),
        committedDeletionCount: safeInteger(current.committedDeletionCount),
      } : {}),
      status: 'processing',
      leaseRevision,
      lease: { ownerId, revision: leaseRevision, expiresAtMs: nowMs + budgets.leaseMs },
      leaseExpiresAtMs: nowMs + budgets.leaseMs,
      firstAttemptAtMs: safeInteger(current.firstAttemptAtMs, nowMs) || nowMs,
      lastAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  });
  metrics.transactions += 1;
  if (!claimed || !result?.committed) return { deferred: blockedByLease, stale: !blockedByLease, jobId };
  return { state: result.snapshot.val(), jobId };
};
const ownsExactFence = (job, state, fenceId) => Boolean(
  job?.retentionFence?.fenceId === fenceId
  && job.retentionFence.status === 'active'
  && Number(job.retentionFence.generation) === Number(state.generation)
  && Number(job.retentionGeneration) === Number(state.generation),
);

const installOrReclaimCanonicalFence = async ({
  db, jobId, state, fenceId, activeRequeue, nowMs, metrics,
}) => {
  let fencedJob = null;
  let missing = false;
  let reason = 'canonical_changed';
  const result = await transactionWithAuthoritativeExistingValue(
    db.ref(`notification_jobs/${jobId}`), (current) => {
    if (!current) {
      missing = true;
      reason = 'canonical_missing';
      return undefined;
    }
    if (!jobMatchesState(current, state, jobId)) return undefined;
    if (activeRequeue) {
      reason = 'active_requeue';
      return undefined;
    }
    if (ownsExactFence(current, state, fenceId)) {
      fencedJob = {
        ...current,
        retentionFence: {
          ...current.retentionFence,
          leaseRevision: state.leaseRevision,
          leaseExpiresAtMs: state.lease?.expiresAtMs || state.leaseExpiresAtMs,
          ...cumulativeFenceFields(state, nowMs),
        },
      };
      return fencedJob;
    }
    if (isNotificationRetentionFenced(current, { fenceId })) {
      reason = 'foreign_retention_fence';
      return undefined;
    }
    const classification = classifyNotificationRetentionEligibility({
      job: { ...current, retentionFence: null, retentionFenceId: null },
      nowMs,
      activeRequeue: false,
    });
    if (!classification.eligible || Number(classification.generation) !== Number(state.generation)) {
      reason = classification.reason || 'canonical_changed';
      return undefined;
    }
    fencedJob = {
      ...current,
      retentionGeneration: state.generation,
      retentionFence: {
        fenceId,
        status: 'active',
        completedAtMs: Number(current.completedAtMs || 0),
        generation: state.generation,
        leaseRevision: state.leaseRevision,
        leaseExpiresAtMs: state.lease?.expiresAtMs || state.leaseExpiresAtMs,
        ...cumulativeFenceFields(state, nowMs),
      },
    };
    return fencedJob;
    },
  );
  metrics.transactions += 1;
  if (!result?.snapshot?.exists?.()) {
    missing = true;
    reason = 'canonical_missing';
  }
  if (result?.committed && fencedJob) return { job: fencedJob, reason: 'fenced' };
  if (missing && state.phase === 'finalize' && !activeRequeue) {
    return { job: null, canonicalDeleted: true, reason: 'finalize_recovery' };
  }
  return { job: null, canonicalDeleted: false, reason };
};

const abandonMissingCanonicalRetention = async ({
  db, jobId, queueKey, entry, state, ownerId, metrics,
}) => {
  const parent = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parent) return false;
  let removed = false;
  const result = await transactionWithAuthoritativeExistingValue(
    db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`), (current) => {
      if (!current || current.lease?.ownerId !== ownerId
        || current.queueKey !== queueKey
        || Number(current.generation) !== Number(entry?.generation)
        || current.targetStatus !== state.targetStatus
        || Number(current.targetCompletedAtMs || 0) !== Number(state.targetCompletedAtMs || 0)) {
        return undefined;
      }
      removed = true;
      return null;
    },
  );
  metrics.transactions += 1;
  if (!removed || !result?.committed) return false;
  await removeRetentionQueueEntry({ db, queueKey, entry, metrics });
  return true;
};

const rolloutAuthorizesCompactor = async ({
  db, expectedRolloutRevision, metrics, allowPausedCanary = false, expectedEvidenceDigest = null,
}) => {
  const rollout = await readNotificationRetentionRollout({ db });
  metrics.queries += 1;
  let authorized = rollout.valid
    && rollout.phase === 'compactor'
    && Number(rollout.revision) === Number(expectedRolloutRevision);
  if (authorized && rollout.evidenceDigest !== expectedEvidenceDigest) authorized = false;
  if (authorized) {
    const shadowEvidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/shadow`)
      .once('value')).val();
    metrics.queries += 1;
    authorized = shadowEvidenceStillMatches(
      shadowEvidence,
      rollout.shadowEvidenceRevision,
      rollout.shadowEvidenceFingerprint,
    );
  }
  if (authorized && rollout.canaryPassed) {
    const canaryEvidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary`)
      .once('value')).val();
    metrics.queries += 1;
    authorized = canaryEvidenceStillMatches(canaryEvidence, rollout);
  } else if (authorized) authorized = allowPausedCanary;
  if (!authorized) metrics.rolloutAuthorizationFailures += 1;
  return authorized;
};

const acquireRetentionContext = async ({
  db, queueKey, entry, nowMs, ownerId, budgets, metrics, expectedRolloutRevision,
  allowPausedCanary = false, expectedEvidenceDigest = null,
}) => {
  const claim = await claimStateLease({ db, queueKey, entry, nowMs, ownerId, budgets, metrics });
  if (claim.attention) {
    const repaired = await repairAttentionProjection({
      db, jobId: claim.jobId, state: claim.state, metrics,
    });
    if (repaired) await removeRetentionQueueEntry({ db, queueKey, entry, metrics });
    metrics.jobsDeferred += 1;
    return { deferred: true, attention: true };
  }
  if (!claim.state) {
    if (claim.stale) await removeRetentionQueueEntry({ db, queueKey, entry, metrics });
    if (claim.deferred) metrics.jobsDeferred += 1;
    return { deferred: Boolean(claim.deferred), stale: Boolean(claim.stale) };
  }
  const claimedFenceId = fenceIdFor(claim.jobId, claim.state.generation);
  await recoverInactiveLegacyFence({
    db,
    jobId: claim.jobId,
    nowMs,
    allowDestructiveRecovery: true,
    replacementState: claim.state,
    replacementFence: {
      fenceId: claimedFenceId,
      status: 'active',
      completedAtMs: Number(claim.state.targetCompletedAtMs || 0),
      generation: claim.state.generation,
      leaseRevision: claim.state.leaseRevision,
      leaseExpiresAtMs: claim.state.lease?.expiresAtMs || claim.state.leaseExpiresAtMs,
      ...cumulativeFenceFields(claim.state, nowMs),
    },
  });
  if (!(await rolloutAuthorizesCompactor({
    db, expectedRolloutRevision, metrics, allowPausedCanary, expectedEvidenceDigest,
  }))) {
    await releaseStateLease({ db, jobId: claim.jobId, ownerId, nowMs, metrics });
    return { rolloutChanged: true };
  }
  const activeRequeue = await readActiveRequeue(db, claim.jobId, nowMs, metrics);
  const fenceId = claimedFenceId;
  const canonical = await installOrReclaimCanonicalFence({
    db, jobId: claim.jobId, state: claim.state, fenceId, activeRequeue, nowMs, metrics,
  });
  if (!canonical.job && !canonical.canonicalDeleted) {
    if (canonical.reason === 'canonical_missing' && await abandonMissingCanonicalRetention({
      db,
      jobId: claim.jobId,
      queueKey,
      entry,
      state: claim.state,
      ownerId,
      metrics,
    })) return { stale: true, abandoned: true };
    await releaseStateLease({ db, jobId: claim.jobId, ownerId, nowMs, metrics });
    metrics.jobsDeferred += 1;
    return { deferred: true, reason: canonical.reason };
  }
  metrics.jobsClaimed += 1;
  return {
    db,
    jobId: claim.jobId,
    queueKey,
    entry,
    state: claim.state,
    job: canonical.job,
    canonicalDeleted: Boolean(canonical.canonicalDeleted),
    fenceId,
    ownerId,
    budgets,
    expectedRolloutRevision,
    allowPausedCanary,
    expectedEvidenceDigest,
  };
};

const renewStateLease = async ({ context, nowMs, metrics, leaseMs = context.budgets.leaseMs }) => {
  const desiredExpiryMs = nowMs + leaseMs;
  const extendedCommitLease = leaseMs > context.budgets.leaseMs;
  if (context.state?.lease?.ownerId === context.ownerId
    && Number(context.state.lease.expiresAtMs || 0) - nowMs
      > context.budgets.leaseRenewThresholdMs
    && (!extendedCommitLease
      || (Number(context.state.lease.expiresAtMs || 0) >= desiredExpiryMs
        && context.state.destructiveCommit))) {
    return context.state;
  }
  let renewed = null;
  const result = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`), (current) => {
      if (!current || current.lease?.ownerId !== context.ownerId
        || current.queueKey !== context.queueKey
        || Number(current.generation) !== Number(context.entry.generation)) return undefined;
      const leaseRevision = safeInteger(current.leaseRevision) + 1;
      const leaseExpiresAtMs = Math.max(
        Number(current.lease?.expiresAtMs || 0), desiredExpiryMs,
      );
      renewed = {
        ...current,
        leaseRevision,
        lease: {
          ownerId: context.ownerId,
          revision: leaseRevision,
          expiresAtMs: leaseExpiresAtMs,
        },
        leaseExpiresAtMs,
        lastAttemptAtMs: nowMs,
        updatedAtMs: nowMs,
        ...(extendedCommitLease ? {
          destructiveCommit: {
            phase: current.phase,
            generation: current.generation,
            leaseRevision,
            startedAtMs: Number(current.destructiveCommit?.startedAtMs || nowMs),
          },
        } : {}),
      };
      return renewed;
    },
  );
  metrics.transactions += 1;
  if (!result?.committed || !renewed) return null;
  context.state = renewed;
  return renewed;
};

const removeLegacyRetentionOwnership = async ({ db, jobId, job }) => {
  let queueKey = null;
  let generation = null;
  let removed = false;
  await transactionWithAuthoritativeExistingValue(
    db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`), (current) => {
    if (!current || current.status === 'processing' || current.lease
      || current.targetStatus !== job.status
      || Number(current.targetCompletedAtMs || 0) !== Number(job.completedAtMs || 0)) return undefined;
    queueKey = current.queueKey;
    generation = current.generation;
    removed = true;
    return null;
    },
  );
  if (removed && queueKey) {
    await transactionWithAuthoritativeExistingValue(
      db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${queueKey}`),
      (current) => current?.jobId === jobId && Number(current.generation) === Number(generation)
        ? null : undefined,
    );
  }
  return removed;
};

const verifyAndRenewFence = async ({ context, nowMs, metrics, leaseMs = context.budgets.leaseMs }) => {
  if (!(await rolloutAuthorizesCompactor({
    db: context.db,
    expectedRolloutRevision: context.expectedRolloutRevision,
    metrics,
    allowPausedCanary: context.allowPausedCanary,
    expectedEvidenceDigest: context.expectedEvidenceDigest,
  }))) {
    context.rolloutRevoked = true;
    return false;
  }
  const state = await renewStateLease({ context, nowMs, metrics, leaseMs });
  if (!state) return false;
  if (context.canonicalDeleted) {
    const parent = (await context.db.ref(`notification_jobs/${context.jobId}`).once('value')).val();
    metrics.queries += 1;
    return !parent && state.phase === 'finalize';
  }
  let renewedJob = null;
  const result = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`notification_jobs/${context.jobId}`), (current) => {
    if (!jobMatchesState(current, state, context.jobId)
      || !ownsExactFence(current, state, context.fenceId)) return undefined;
    renewedJob = {
      ...current,
      retentionFence: {
        ...current.retentionFence,
        leaseRevision: state.leaseRevision,
        leaseExpiresAtMs: state.lease?.expiresAtMs || state.leaseExpiresAtMs,
        ...cumulativeFenceFields(state, nowMs),
      },
    };
    return renewedJob;
    },
  );
  metrics.transactions += 1;
  if (!result?.committed || !renewedJob) return false;
  context.job = renewedJob;
  return true;
};

const transitionStatePhase = async ({ context, expectedPhase, nextPhase, nowMs, patch = {}, metrics }) => {
  let next = null;
  const result = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`), (current) => {
      if (!current || current.lease?.ownerId !== context.ownerId
        || current.phase !== expectedPhase) return undefined;
      next = { ...current, ...patch, phase: nextPhase, updatedAtMs: nowMs };
      return next;
    },
  );
  metrics.transactions += 1;
  if (result?.committed && next) {
    context.state = next;
    if (!context.canonicalDeleted) {
      await transactionWithAuthoritativeExistingValue(
        context.db.ref(`notification_jobs/${context.jobId}`), (current) => {
        if (!jobMatchesState(current, next, context.jobId)
          || !ownsExactFence(current, next, context.fenceId)) return undefined;
        return {
          ...current,
          retentionFence: {
            ...current.retentionFence,
            ...cumulativeFenceFields(next, nowMs),
          },
        };
        },
      );
      metrics.transactions += 1;
    }
  }
  return Boolean(result?.committed && next);
};

const commitIrreversibleWork = async ({ context, nowMs, deleted = 0, metrics }) => {
  let committedState = null;
  const result = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`), (current) => {
      if (!current || current.lease?.ownerId !== context.ownerId
        || current.queueKey !== context.queueKey
        || Number(current.generation) !== Number(context.entry.generation)
        || !current.destructiveCommit
        || Number(current.destructiveCommit.generation) !== Number(current.generation)) {
        return undefined;
      }
      const existingCount = Math.max(
        safeInteger(current.committedDeletionCount),
        safeInteger(current.deletionCount),
        safeInteger(current.attemptsDeleted),
      );
      committedState = {
        ...current,
        irreversibleWorkStarted: true,
        firstDestructiveCommitAtMs: firstDestructiveCommitAtMs(current, nowMs),
        committedDeletionCount: existingCount + Math.max(0, safeInteger(deleted)),
        updatedAtMs: nowMs,
      };
      return committedState;
    },
  );
  metrics.transactions += 1;
  if (!result?.committed || !committedState) return false;
  context.state = committedState;
  if (!context.canonicalDeleted) {
    await transactionWithAuthoritativeExistingValue(
      context.db.ref(`notification_jobs/${context.jobId}`), (current) => {
      if (!jobMatchesState(current, committedState, context.jobId)
        || !ownsExactFence(current, committedState, context.fenceId)) return undefined;
      return {
        ...current,
        retentionFence: {
          ...current.retentionFence,
          ...cumulativeFenceFields(committedState, nowMs),
        },
      };
      },
    );
    metrics.transactions += 1;
  }
  return true;
};

module.exports = {
  acquireRetentionContext,
  cancelCanonicalFence,
  commitIrreversibleWork,
  hasCommittedIrreversibleWork,
  jobMatchesState,
  markRequiresAttention,
  ownsExactFence,
  persistRetentionWarning,
  readActiveRequeue,
  removeRetentionQueueEntry,
  recoverInactiveCompactorFence,
  recoverInactiveLegacyFence,
  removeLegacyRetentionOwnership,
  releaseStateLease,
  rolloutAuthorizesCompactor,
  transitionStatePhase,
  verifyAndRenewFence,
};
