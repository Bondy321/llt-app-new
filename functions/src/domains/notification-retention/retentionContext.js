'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  buildOperationsTerminalWarning,
  persistOperationsTerminalWarning,
} = require('../../../lib/operationsTerminalWarnings');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const {
  classifyNotificationRetentionEligibility,
  isNotificationRetentionFenced,
} = require('./eligibility');
const { maxMetric, safeInteger } = require('./retentionEngineRuntime');
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
  metrics.transactions += 1;
  if (removed && result?.committed) {
    metrics.queueEntriesRemoved += 1;
    metrics.updatePaths += 1;
    maxMetric(metrics, 'maxUpdatePaths', 1);
  }
  return Boolean(removed && result?.committed);
};

const releaseStateLease = async ({
  db, jobId, ownerId, nowMs, status = 'queued', errorCode = null, metrics = null,
}) => {
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`).transaction((current) => {
    if (!current || current.lease?.ownerId !== ownerId) return undefined;
    return {
      ...current,
      status,
      ...(status === 'requires_attention' ? { retentionDueAtMs: null } : {}),
      ...(errorCode ? { lastErrorCode: String(errorCode).slice(0, 80) } : {}),
      lease: null,
      leaseExpiresAtMs: null,
      updatedAtMs: nowMs,
    };
  }, undefined, false);
  if (metrics) metrics.transactions += 1;
};

const cancelCanonicalFence = async ({ db, jobId, fenceId, metrics }) => {
  await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.retentionFence?.fenceId !== fenceId) return undefined;
    const fenceGeneration = safeInteger(current.retentionFence.generation);
    return {
      ...current,
      retentionGeneration: Math.max(0, fenceGeneration - 1),
      retentionFence: null,
    };
  }, undefined, false);
  metrics.transactions += 1;
};

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

const markRequiresAttention = async ({ context, reason, nowMs, metrics }) => {
  metrics.jobsRequiresAttention += 1;
  metrics.failures += 1;
  try {
    await persistRetentionWarning({ db: context.db, jobId: context.jobId, reason, nowMs });
  } catch (_error) {
    metrics.failures += 1;
  }
  if (!context.canonicalDeleted) {
    await cancelCanonicalFence({
      db: context.db, jobId: context.jobId, fenceId: context.fenceId, nowMs, metrics,
    });
  }
  await releaseStateLease({
    db: context.db,
    jobId: context.jobId,
    ownerId: context.ownerId,
    nowMs,
    status: 'requires_attention',
    errorCode: reason,
    metrics,
  });
  context.state = { ...context.state, status: 'requires_attention', lease: null };
  await removeRetentionQueueEntry({
    db: context.db, queueKey: context.queueKey, entry: context.entry, metrics,
  });
};

const claimStateLease = async ({ db, queueKey, entry, nowMs, ownerId, budgets, metrics }) => {
  const jobId = entry?.jobId;
  if (typeof jobId !== 'string' || !jobId) return { stale: true };
  const stateRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`);
  const observed = (await stateRef.once('value')).val();
  metrics.queries += 1;
  if (!observed || observed.queueKey !== queueKey
    || Number(observed.generation) !== Number(entry.generation)
    || observed.status === 'completed' || observed.status === 'requires_attention') {
    return { stale: true, jobId };
  }
  let claimed = false;
  let blockedByLease = false;
  const result = await stateRef.transaction((current) => {
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
    return {
      ...current,
      status: 'processing',
      leaseRevision,
      lease: { ownerId, revision: leaseRevision, expiresAtMs: nowMs + budgets.leaseMs },
      leaseExpiresAtMs: nowMs + budgets.leaseMs,
      firstAttemptAtMs: safeInteger(current.firstAttemptAtMs, nowMs) || nowMs,
      lastAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }, undefined, false);
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
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
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
      },
    };
    return fencedJob;
  }, undefined, false);
  metrics.transactions += 1;
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
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`)
    .transaction((current) => {
      if (!current || current.lease?.ownerId !== ownerId
        || current.queueKey !== queueKey
        || Number(current.generation) !== Number(entry?.generation)
        || current.targetStatus !== state.targetStatus
        || Number(current.targetCompletedAtMs || 0) !== Number(state.targetCompletedAtMs || 0)) {
        return undefined;
      }
      removed = true;
      return null;
    }, undefined, false);
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
      commitStatus: claim.state.destructiveCommit ? 'destructive' : null,
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
      || Number(context.state.lease.expiresAtMs || 0) >= desiredExpiryMs)) {
    return context.state;
  }
  let renewed = null;
  const result = await context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`)
    .transaction((current) => {
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
    }, undefined, false);
  metrics.transactions += 1;
  if (!result?.committed || !renewed) return null;
  context.state = renewed;
  return renewed;
};

const removeLegacyRetentionOwnership = async ({ db, jobId, job }) => {
  let queueKey = null;
  let generation = null;
  let removed = false;
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`).transaction((current) => {
    if (!current || current.status === 'processing' || current.lease
      || current.targetStatus !== job.status
      || Number(current.targetCompletedAtMs || 0) !== Number(job.completedAtMs || 0)) return undefined;
    queueKey = current.queueKey;
    generation = current.generation;
    removed = true;
    return null;
  }, undefined, false);
  if (removed && queueKey) {
    await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${queueKey}`).transaction((current) => (
      current?.jobId === jobId && Number(current.generation) === Number(generation)
        ? null : undefined
    ), undefined, false);
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
  const result = await context.db.ref(`notification_jobs/${context.jobId}`).transaction((current) => {
    if (!jobMatchesState(current, state, context.jobId)
      || !ownsExactFence(current, state, context.fenceId)) return undefined;
    renewedJob = {
      ...current,
      retentionFence: {
        ...current.retentionFence,
        leaseRevision: state.leaseRevision,
        leaseExpiresAtMs: state.lease?.expiresAtMs || state.leaseExpiresAtMs,
        commitStatus: state.destructiveCommit ? 'destructive' : null,
      },
    };
    return renewedJob;
  }, undefined, false);
  metrics.transactions += 1;
  if (!result?.committed || !renewedJob) return false;
  context.job = renewedJob;
  return true;
};

const transitionStatePhase = async ({ context, expectedPhase, nextPhase, nowMs, patch = {}, metrics }) => {
  let next = null;
  const result = await context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`)
    .transaction((current) => {
      if (!current || current.lease?.ownerId !== context.ownerId
        || current.phase !== expectedPhase) return undefined;
      next = { ...current, ...patch, phase: nextPhase, updatedAtMs: nowMs };
      return next;
    }, undefined, false);
  metrics.transactions += 1;
  if (result?.committed && next) {
    context.state = next;
    if (!next.destructiveCommit && !context.canonicalDeleted) {
      await context.db.ref(`notification_jobs/${context.jobId}`).transaction((current) => {
        if (!jobMatchesState(current, next, context.jobId)
          || !ownsExactFence(current, next, context.fenceId)) return undefined;
        return {
          ...current,
          retentionFence: { ...current.retentionFence, commitStatus: null },
        };
      }, undefined, false);
      metrics.transactions += 1;
    }
  }
  return Boolean(result?.committed && next);
};

module.exports = {
  acquireRetentionContext,
  cancelCanonicalFence,
  jobMatchesState,
  markRequiresAttention,
  ownsExactFence,
  readActiveRequeue,
  recoverInactiveCompactorFence,
  recoverInactiveLegacyFence,
  removeLegacyRetentionOwnership,
  releaseStateLease,
  rolloutAuthorizesCompactor,
  transitionStatePhase,
  verifyAndRenewFence,
};
