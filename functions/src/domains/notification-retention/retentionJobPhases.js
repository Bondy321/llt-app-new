'use strict';

// @ts-check

const {
  NOTIFICATION_RETENTION_PATHS,
  RETENTION_MS,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
} = require('./constants');
const {
  commitIrreversibleWork,
  jobMatchesState,
  markRequiresAttention,
  ownsExactFence,
  readActiveRequeue,
  transitionStatePhase,
  verifyAndRenewFence,
} = require('./retentionContext');
const {
  maxMetric,
  orderedEntries,
  QUEUE_ROOTS,
  safeInteger,
  transactionWithAuthoritativeExistingValue,
} = require('./retentionEngineRuntime');
const { recordCanaryFinalizationProof } = require('./canaryFixture');
const { compiledRetentionProtocol } = require('./protocol');

const loadAttemptPage = async ({ context, limit, metrics }) => {
  const snapshot = await context.db.ref('notification_delivery_attempts').orderByChild('jobId')
    .equalTo(context.jobId).limitToFirst(limit + 1).once('value');
  metrics.queries += 1;
  metrics.attemptPagesQueried += 1;
  const entries = orderedEntries(snapshot);
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  return {
    selected: entries.slice(0, limit),
    hasMore: entries.length > limit,
  };
};

const attemptPageLimit = ({ context, metrics }) => {
  const globalRemaining = context.budgets.maxAttempts - metrics.attemptsDeleted;
  const jobRemaining = context.budgets.maxAttemptsPerJob
    - safeInteger(context.invocationAttemptsDeleted);
  const updateBound = Math.max(1, Math.floor(context.budgets.maxUpdatePaths / 2));
  return Math.max(0, Math.min(
    context.budgets.pageSize,
    globalRemaining,
    jobRemaining,
    updateBound,
  ));
};

const buildAttemptDeletionUpdate = async ({ context, attempts, metrics, nowMs }) => {
  const updates = {};
  let retryPointers = 0;
  let receiptPointers = 0;
  for (const [attemptId, attempt] of attempts) {
    updates[`notification_delivery_attempts/${attemptId}`] = null;
    const root = QUEUE_ROOTS[attempt.queueKind];
    if (root && typeof attempt.queueKey === 'string' && attempt.queueKey) {
      const pointer = (await context.db.ref(`${root}/${attempt.queueKey}`).once('value')).val();
      metrics.queries += 1;
      maxMetric(metrics, 'maxRecordsInMemory', Number(Boolean(pointer)));
      if (pointer?.targetId === attemptId
        && Number(pointer.version) === Number(attempt.queueVersion)) {
        updates[`${root}/${attempt.queueKey}`] = null;
        retryPointers += Number(attempt.queueKind === 'retry');
        receiptPointers += Number(attempt.queueKind === 'receipt');
      }
    }
  }
  const canaryFingerprint = context.job?.canaryFixtureFingerprint;
  if (context.allowPausedCanary && attempts.length === 1
    && typeof canaryFingerprint === 'string' && canaryFingerprint
    && attempts[0][1]?.canaryFixtureFingerprint === canaryFingerprint) {
    updates[`${NOTIFICATION_RETENTION_PATHS.evidence}/canary_attempt_proofs/${canaryFingerprint}`] = {
      schemaVersion: 1,
      ...compiledRetentionProtocol(),
      rolloutRevision: context.expectedRolloutRevision,
      fixtureFingerprint: canaryFingerprint,
      generation: context.state.generation,
      leaseRevision: context.state.leaseRevision,
      attemptsDeleted: 1,
      recordedAtMs: nowMs,
    };
  }
  return { updates, retryPointers, receiptPointers, pathCount: Object.keys(updates).length };
};

const processAttemptPage = async ({ context, nowMs, metrics }) => {
  if (!(await verifyAndRenewFence({ context, nowMs, metrics }))) {
    return { stopped: true, reason: 'lease_lost' };
  }
  const limit = attemptPageLimit({ context, metrics });
  if (limit === 0) return { stopped: true, reason: 'attempt_budget' };
  const page = await loadAttemptPage({ context, limit, metrics });
  if (!page.selected.length) {
    const phaseAdvanced = await transitionStatePhase({
      context,
      expectedPhase: 'attempts',
      nextPhase: 'job_children',
      nowMs,
      patch: { destructiveCommit: null },
      metrics,
    });
    return { pageProcessed: false, phaseAdvanced };
  }
  metrics.attemptsScanned += page.selected.length;
  const blocked = page.selected.some(([, attempt]) => !attempt
    || attempt.jobId !== context.jobId
    || !TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(attempt.status));
  if (blocked) {
    await markRequiresAttention({ context, reason: 'nonterminal_attempt', nowMs, metrics });
    return { stopped: true, reason: 'requires_attention' };
  }
  const deletion = await buildAttemptDeletionUpdate({
    context, attempts: page.selected, metrics, nowMs,
  });
  if (deletion.pathCount > context.budgets.maxUpdatePaths) {
    await markRequiresAttention({ context, reason: 'update_path_budget', nowMs, metrics });
    return { stopped: true, reason: 'update_path_budget' };
  }
  if (!(await verifyAndRenewFence({
    context,
    nowMs,
    metrics,
    leaseMs: context.budgets.destructiveCommitLeaseMs,
  }))) return { stopped: true, reason: 'lease_lost_before_attempt_commit' };
  await context.db.ref().update(deletion.updates);
  if (!(await commitIrreversibleWork({
    context, nowMs, deleted: page.selected.length, metrics,
  }))) return { stopped: true, reason: 'irreversible_boundary_conflict' };
  if (!(await verifyAndRenewFence({ context, nowMs, metrics }))) {
    return { stopped: true, reason: 'lease_lost_after_idempotent_update' };
  }
  metrics.attemptsDeleted += page.selected.length;
  context.invocationAttemptsDeleted = safeInteger(context.invocationAttemptsDeleted)
    + page.selected.length;
  metrics.retryPointersDeleted += deletion.retryPointers;
  metrics.receiptPointersDeleted += deletion.receiptPointers;
  metrics.updatePaths += deletion.pathCount;
  maxMetric(metrics, 'maxUpdatePaths', deletion.pathCount);
  const patch = {
    attemptPagesProcessed: safeInteger(context.state.attemptPagesProcessed) + 1,
    attemptsScanned: safeInteger(context.state.attemptsScanned) + page.selected.length,
    attemptsDeleted: safeInteger(context.state.attemptsDeleted) + page.selected.length,
    deletionCount: safeInteger(context.state.deletionCount) + page.selected.length,
    irreversibleWorkStarted: true,
    firstDestructiveCommitAtMs: context.state.firstDestructiveCommitAtMs,
    committedDeletionCount: context.state.committedDeletionCount,
    destructiveCommit: null,
  };
  const phaseAdvanced = await transitionStatePhase({
    context,
    expectedPhase: 'attempts',
    nextPhase: page.hasMore ? 'attempts' : 'job_children',
    nowMs,
    patch,
    metrics,
  });
  return { pageProcessed: true, phaseAdvanced: Boolean(phaseAdvanced && !page.hasMore), deleted: page.selected.length };
};

const deleteExpiredRequeueState = async ({ context, nowMs, metrics }) => {
  let active = false;
  let deleted = false;
  const result = await context.db.ref(`notification_requeue_jobs/${context.jobId}`)
    .transaction((current) => {
      if (!current) return current;
      if (current.status === 'processing') {
        active = true;
        return undefined;
      }
      if (Number(current.expiresAtMs || 0) > nowMs) return undefined;
      deleted = true;
      return null;
    }, undefined, false);
  metrics.transactions += 1;
  if (deleted && result?.committed) {
    metrics.requeueJobsDeleted += 1;
    metrics.updatePaths += 1;
    maxMetric(metrics, 'maxUpdatePaths', 1);
  }
  return { safe: !active, deleted: Number(deleted && result?.committed) };
};

const processJobChildren = async ({ context, nowMs, metrics }) => {
  if (!(await verifyAndRenewFence({
    context,
    nowMs,
    metrics,
    leaseMs: context.budgets.destructiveCommitLeaseMs,
  }))) return false;
  const requeueDeletion = await deleteExpiredRequeueState({ context, nowMs, metrics });
  if (!requeueDeletion.safe) {
    await markRequiresAttention({ context, reason: 'active_requeue_after_fence', nowMs, metrics });
    return false;
  }
  if (requeueDeletion.deleted > 0 && !(await commitIrreversibleWork({
    context, nowMs, deleted: requeueDeletion.deleted, metrics,
  }))) return false;
  const updates = {
    [`notification_job_token_claims/${context.jobId}`]: null,
    [`notification_job_recipients/${context.jobId}`]: null,
    [`notification_job_audience_claims/${context.jobId}`]: null,
    [`notification_delivery_warnings/${context.jobId}`]: null,
  };
  if (context.job.queueKind === 'fanout' && typeof context.job.queueKey === 'string' && context.job.queueKey) {
    updates[`${QUEUE_ROOTS.fanout}/${context.job.queueKey}`] = null;
    metrics.fanoutPointersDeleted += 1;
  }
  const pathCount = Object.keys(updates).length;
  if (pathCount > context.budgets.maxUpdatePaths) return false;
  await context.db.ref().update(updates);
  if (!(await commitIrreversibleWork({
    context, nowMs, deleted: pathCount, metrics,
  }))) return false;
  metrics.updatePaths += pathCount;
  maxMetric(metrics, 'maxUpdatePaths', pathCount);
  return transitionStatePhase({
    context,
    expectedPhase: 'job_children',
    nextPhase: 'source_records',
    nowMs,
    patch: {
      deletionCount: safeInteger(context.state.deletionCount) + pathCount + requeueDeletion.deleted,
      irreversibleWorkStarted: true,
      firstDestructiveCommitAtMs: context.state.firstDestructiveCommitAtMs,
      committedDeletionCount: context.state.committedDeletionCount,
      destructiveCommit: null,
    },
    metrics,
  });
};

const compareDeleteSource = async ({
  ref, jobId, expectedCreatedAtMs = null, dueAtMs = null, nowMs, metrics,
}) => {
  let matched = false;
  const result = await ref.transaction((current) => {
    if (!current) return current;
    const owner = current.deliveryJobId || current.notificationDeliveryJobId;
    if (owner !== jobId) return undefined;
    if (expectedCreatedAtMs !== null
      && Number(current.createdAtMs || 0) !== Number(expectedCreatedAtMs)) return undefined;
    if (dueAtMs !== null && (Number(current.retentionDueAtMs || 0) !== Number(dueAtMs)
      || Number(dueAtMs) > nowMs)) return undefined;
    matched = true;
    return null;
  }, undefined, false);
  metrics.transactions += 1;
  return Boolean(matched && result?.committed);
};

const reconcileCoalescing = async ({ context, metrics }) => {
  const key = context.job.coalescingKey;
  if (typeof key !== 'string' || !key) return 0;
  let changed = false;
  const result = await context.db.ref(`notification_job_coalescing/${key}`)
    .transaction((current) => {
      if (!current) return current;
      if (current.jobId === context.jobId) {
        changed = true;
        return null;
      }
      if (current.previousJobId === context.jobId) {
        changed = true;
        return { ...current, previousJobId: null };
      }
      return current;
    }, undefined, false);
  metrics.transactions += 1;
  return Number(changed && result?.committed);
};

const validMarketingDueAtMs = (job) => {
  const dueAtMs = Number(job?.expiresAtMs || 0) + RETENTION_MS;
  return Number.isSafeInteger(dueAtMs) && dueAtMs > 0 ? dueAtMs : null;
};

const processSources = async ({ context, nowMs, metrics }) => {
  if (!(await verifyAndRenewFence({
    context,
    nowMs,
    metrics,
    leaseMs: context.budgets.destructiveCommitLeaseMs,
  }))) return false;
  const job = context.job;
  let sourceDeletions = 0;
  if (job.sourceType === 'tour_announcement' && job.tourId && job.navigation?.messageId) {
    sourceDeletions += Number(await compareDeleteSource({
      ref: context.db.ref(`broadcasts/${job.tourId}/${job.navigation.messageId}`),
      jobId: context.jobId,
      expectedCreatedAtMs: job.sourceOrderMs,
      nowMs,
      metrics,
    }));
  }
  if (job.sourceType === 'future_tour_category_broadcast'
    && job.categoryKey && job.navigation?.broadcastId) {
    const marketingDueAtMs = validMarketingDueAtMs(job);
    if (marketingDueAtMs === null) {
      await markRequiresAttention({ context, reason: 'marketing_expiry_invalid', nowMs, metrics });
      return false;
    }
    sourceDeletions += Number(await compareDeleteSource({
      ref: context.db.ref(`category_broadcasts/${job.categoryKey}/${job.navigation.broadcastId}`),
      jobId: context.jobId,
      expectedCreatedAtMs: job.sourceOrderMs,
      nowMs,
      metrics,
    }));
    const deleted = await compareDeleteSource({
      ref: context.db.ref(`marketing_notification_details/${job.navigation.broadcastId}`),
      jobId: context.jobId,
      dueAtMs: marketingDueAtMs,
      nowMs,
      metrics,
    });
    metrics.marketingDetailsDeleted += Number(deleted);
    sourceDeletions += Number(deleted);
  }
  sourceDeletions += await reconcileCoalescing({ context, metrics });
  if (sourceDeletions > 0 && !(await commitIrreversibleWork({
    context, nowMs, deleted: sourceDeletions, metrics,
  }))) return false;
  return transitionStatePhase({
    context,
    expectedPhase: 'source_records',
    nextPhase: 'finalize',
    nowMs,
    patch: {
      ...(sourceDeletions > 0 ? {
        deletionCount: safeInteger(context.state.deletionCount) + sourceDeletions,
        irreversibleWorkStarted: true,
        firstDestructiveCommitAtMs: context.state.firstDestructiveCommitAtMs,
        committedDeletionCount: context.state.committedDeletionCount,
      } : {}),
      destructiveCommit: null,
    },
    metrics,
  });
};

const branchEmpty = async (ref, metrics) => {
  const snapshot = await ref.limitToFirst(1).once('value');
  metrics.queries += 1;
  return !snapshot.exists();
};

const verifyNoActiveCanonicalQueue = async ({ context, metrics }) => {
  if (context.canonicalDeleted || !context.job?.queueKind || !context.job?.queueKey) return true;
  const root = QUEUE_ROOTS[context.job.queueKind];
  if (!root) return true;
  const value = (await context.db.ref(`${root}/${context.job.queueKey}`).once('value')).val();
  metrics.queries += 1;
  return !value || value.targetId !== context.jobId
    || Number(value.version) !== Number(context.job.queueVersion);
};

const verifyFinalizationChildren = async ({ context, nowMs, metrics }) => {
  const attempts = await context.db.ref('notification_delivery_attempts').orderByChild('jobId')
    .equalTo(context.jobId).limitToFirst(1).once('value');
  metrics.queries += 1;
  if (attempts.exists()) return false;
  for (const root of [
    'notification_job_token_claims',
    'notification_job_recipients',
    'notification_job_audience_claims',
    'notification_delivery_warnings',
  ]) {
    if (!(await branchEmpty(context.db.ref(`${root}/${context.jobId}`), metrics))) return false;
  }
  if (!(await verifyNoActiveCanonicalQueue({ context, metrics }))) return false;
  return !await readActiveRequeue(context.db, context.jobId, nowMs, metrics);
};

const deleteCanonicalJob = async ({ context, metrics }) => {
  if (context.canonicalDeleted) return true;
  let deleted = false;
  const result = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`notification_jobs/${context.jobId}`), (current) => {
    if (!jobMatchesState(current, context.state, context.jobId)
      || !ownsExactFence(current, context.state, context.fenceId)) return undefined;
    deleted = true;
    return null;
    },
  );
  metrics.transactions += 1;
  if (deleted && result?.committed) context.canonicalDeleted = true;
  return Boolean(deleted && result?.committed);
};

const cleanupCompletedRetentionOwnership = async ({ context, metrics }) => {
  let stateRemoved = false;
  const stateResult = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`), (current) => {
      if (!current || current.queueKey !== context.queueKey
        || Number(current.generation) !== Number(context.entry.generation)
        || current.lease?.ownerId !== context.ownerId
        || current.phase !== 'finalize'
        || current.targetStatus !== context.state.targetStatus
        || Number(current.targetCompletedAtMs || 0)
          !== Number(context.state.targetCompletedAtMs || 0)) return undefined;
      stateRemoved = true;
      return null;
    },
  );
  metrics.transactions += 1;
  let queueRemoved = false;
  const queueResult = await transactionWithAuthoritativeExistingValue(
    context.db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${context.queueKey}`), (current) => {
      if (!current || current.jobId !== context.jobId
        || Number(current.generation) !== Number(context.entry.generation)) return undefined;
      queueRemoved = true;
      return null;
    },
  );
  metrics.transactions += 1;
  const removedPaths = Number(stateRemoved && stateResult?.committed)
    + Number(queueRemoved && queueResult?.committed);
  metrics.updatePaths += removedPaths;
  metrics.queueEntriesRemoved += Number(queueRemoved && queueResult?.committed);
  maxMetric(metrics, 'maxUpdatePaths', Number(removedPaths > 0));
};

const finalizeJob = async ({ context, nowMs, metrics }) => {
  if (!(await verifyAndRenewFence({
    context, nowMs, metrics, leaseMs: context.budgets.destructiveCommitLeaseMs,
  }))) return false;
  if (!(await verifyFinalizationChildren({ context, nowMs, metrics }))) return false;
  if (!(await recordCanaryFinalizationProof({ context, nowMs }))) return false;
  if (!(await deleteCanonicalJob({ context, metrics }))) return false;
  if (!(await commitIrreversibleWork({ context, nowMs, deleted: 1, metrics }))) {
    const successorState = (await context.db.ref(
      `${NOTIFICATION_RETENTION_PATHS.jobs}/${context.jobId}`,
    ).once('value')).val();
    metrics.queries += 1;
    if (!successorState
      || Number(successorState.generation) <= Number(context.state.generation)) return false;
  }
  await cleanupCompletedRetentionOwnership({ context, metrics });
  metrics.jobsCompleted += 1;
  context.state = { ...context.state, status: 'completed', phase: 'completed', lease: null };
  return true;
};

const runOneJobStep = async ({ context, nowMs, metrics }) => {
  if (context.state.phase === 'attempts') return processAttemptPage({ context, nowMs, metrics });
  if (context.state.phase === 'job_children') {
    return { phaseAdvanced: await processJobChildren({ context, nowMs, metrics }) };
  }
  if (context.state.phase === 'source_records') {
    return { phaseAdvanced: await processSources({ context, nowMs, metrics }) };
  }
  if (context.state.phase === 'finalize') {
    return { completed: await finalizeJob({ context, nowMs, metrics }) };
  }
  await markRequiresAttention({ context, reason: 'unknown_phase', nowMs, metrics });
  return { stopped: true, reason: 'unknown_phase' };
};

module.exports = { runOneJobStep };
