'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { NOTIFICATION_RETENTION_PATHS } = require('./constants');
const { runAuxiliarySweeps } = require('./retentionAuxiliarySweeps');
const {
  acquireRetentionContext,
  cancelCanonicalFence,
  releaseStateLease,
} = require('./retentionContext');
const {
  PHASES,
  createMetrics,
  normalizeBudgets,
  orderedEntries,
  safeInteger,
} = require('./retentionEngineRuntime');
const {
  loadDueRetentionQueue,
  loadExactCanaryDue,
  persistSchedulerCursor,
  readSchedulerCursor,
} = require('./retentionDueQueue');
const { runOneJobStep } = require('./retentionJobPhases');
const { runDurableShadowPlan } = require('./shadow');
const {
  readExactCanaryFixture,
  verifyAndCompleteCanaryFixture,
} = require('./canaryFixture');
const {
  buildCanaryEvidenceFingerprint,
  buildShadowEvidenceFingerprint,
  canaryEvidenceProvesCompletedJobs,
  readNotificationRetentionRollout,
} = require('./state');

const buildResult = ({ mode, rollout, hasMore, budgetExhaustionReason, metrics }) => ({
  mode,
  phase: rollout.phase,
  rolloutRevision: rollout.revision,
  hasMore: Boolean(hasMore),
  budgetExhaustionReason: budgetExhaustionReason || null,
  metrics,
});

const persistShadowEvidence = async ({ db, nowMs, rollout, planned, metrics }) => {
  const status = metrics.shadowMismatches > 0 ? 'failed' : (planned.hasMore ? 'incomplete' : 'passed');
  const candidate = {
    schemaVersion: 1,
    phase: 'shadow',
    rolloutRevision: rollout.revision,
    status,
    shadowEligible: metrics.shadowEligible,
    shadowLegacyEligible: metrics.shadowLegacyEligible,
    shadowMismatches: metrics.shadowMismatches,
    compactorScanned: planned.compactorScanned,
    legacyScanned: planned.legacyScanned,
    progressRevision: planned.progressRevision,
    evaluationNowMs: planned.evaluationNowMs,
    hasMore: Boolean(planned.hasMore),
  };
  candidate.evidenceFingerprint = buildShadowEvidenceFingerprint(candidate);
  const authorizedRollout = await readNotificationRetentionRollout({ db });
  metrics.queries += 1;
  if (!authorizedRollout.valid || authorizedRollout.phase !== 'shadow'
    || authorizedRollout.revision !== rollout.revision) return false;
  let persisted = false;
  // eslint-disable-next-line complexity -- monotonic evidence CAS distinguishes stale, idempotent and conflicting writers
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/shadow`).transaction((current) => {
    if (current && Number(current.rolloutRevision || 0) > Number(rollout.revision)) return undefined;
    if (current && Number(current.rolloutRevision || 0) < Number(rollout.revision)) {
      persisted = { ...candidate, updatedAtMs: nowMs };
      return persisted;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && current.evidenceFingerprint === candidate.evidenceFingerprint) {
      persisted = true;
      return current;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && Number(current.progressRevision || 0) > Number(candidate.progressRevision || 0)) {
      persisted = true;
      return current;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && Number(current.progressRevision || 0) < Number(candidate.progressRevision || 0)
      && current.status === 'incomplete') {
      persisted = true;
      return { ...candidate, updatedAtMs: nowMs };
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)) {
      const conflict = {
        ...candidate,
        status: 'failed',
        shadowMismatches: Math.max(1, candidate.shadowMismatches),
        conflict: true,
      };
      conflict.evidenceFingerprint = buildShadowEvidenceFingerprint(conflict);
      persisted = true;
      return { ...conflict, updatedAtMs: nowMs };
    }
    persisted = true;
    return { ...candidate, updatedAtMs: nowMs };
  }, undefined, false);
  metrics.transactions += 1;
  return Boolean(persisted && result?.committed);
};

const collectRetentionContexts = async ({
  db, due, nowMs, budgets, metrics, ownerId, expectedRolloutRevision,
  expectedEvidenceDigest, allowPausedCanary,
}) => {
  const contexts = [];
  let deferred = 0;
  let rolloutChanged = false;
  for (const [queueKey, entry] of due.entries) {
    const context = await acquireRetentionContext({
      db, queueKey, entry, nowMs, ownerId, budgets, metrics, expectedRolloutRevision,
      expectedEvidenceDigest, allowPausedCanary,
    });
    if (context?.jobId) contexts.push(context);
    else deferred += Number(context?.deferred);
    if (context?.rolloutChanged) {
      rolloutChanged = true;
      break;
    }
  }
  return { contexts, deferred, rolloutChanged };
};

const contextFinished = (context) => context.state?.status === 'requires_attention'
  || context.state?.phase === 'completed';

const contextAttemptBudgetReached = ({ context, counters, budgets }) => {
  if (context.state.phase !== 'attempts') return false;
  const pages = counters.pagesByJob.get(context.jobId) || 0;
  const attempts = counters.attemptsByJob.get(context.jobId) || 0;
  return pages >= budgets.maxAttemptPagesPerJob || attempts >= budgets.maxAttemptsPerJob;
};

const recordContextAttemptProgress = ({ context, counters, newlyDeleted }) => {
  if (newlyDeleted <= 0) return;
  counters.pagesByJob.set(context.jobId, (counters.pagesByJob.get(context.jobId) || 0) + 1);
  counters.attemptsByJob.set(
    context.jobId,
    (counters.attemptsByJob.get(context.jobId) || 0) + newlyDeleted,
  );
};

const processContextRound = async ({
  contexts, counters, metrics, budgets, operationalNowMs, deadlineReached,
}) => {
  let madeProgress = false;
  let budgetReason = null;
  for (const context of contexts) {
    if (deadlineReached()) {
      budgetReason = 'internal_deadline';
      break;
    }
    if (contextFinished(context)) continue;
    if (contextAttemptBudgetReached({ context, counters, budgets })) continue;
    if (context.state.phase === 'attempts' && metrics.attemptsDeleted >= budgets.maxAttempts) {
      continue;
    }
    if (metrics.attemptPagesQueried >= budgets.maxAttemptPages
      && context.state.phase === 'attempts') {
      continue;
    }
    const beforeDeleted = metrics.attemptsDeleted;
    const result = await runOneJobStep({ context, nowMs: operationalNowMs(), metrics });
    if (context.rolloutRevoked) {
      budgetReason = 'rollout_changed';
      break;
    }
    const newlyDeleted = metrics.attemptsDeleted - beforeDeleted;
    recordContextAttemptProgress({ context, counters, newlyDeleted });
    madeProgress = madeProgress || Boolean(newlyDeleted || result?.phaseAdvanced || result?.completed);
    if (deadlineReached()) {
      budgetReason = 'internal_deadline';
      break;
    }
  }
  return { madeProgress, budgetReason };
};

const releaseContextLeases = async ({ contexts, ownerId, nowMs, metrics, cancelFences = false }) => {
  for (const context of contexts) {
    if (cancelFences && !context.canonicalDeleted && !context.state?.destructiveCommit) {
      await cancelCanonicalFence({
        db: context.db,
        jobId: context.jobId,
        fenceId: context.fenceId,
        nowMs,
        metrics,
      });
    }
    if (context.state?.status === 'processing') {
      await releaseStateLease({
        db: context.db, jobId: context.jobId, ownerId, nowMs, status: 'queued', metrics,
      });
      context.state = { ...context.state, status: 'queued', lease: null };
    }
  }
};

const runCompactor = async ({
  db, nowMs, budgets, metrics, ownerId, rollout, clock, useSchedulerCursor = true,
  allowPausedCanary = false, canaryFixture = null, resumeRequeue = null,
}) => { // eslint-disable-line complexity -- durable engine accounts for every bounded exit path
  const wallStartedAtMs = clock();
  const cursor = useSchedulerCursor ? await readSchedulerCursor({ db, metrics }) : null;
  const due = canaryFixture
    ? await loadExactCanaryDue({ db, nowMs, metrics, fixture: canaryFixture })
    : await loadDueRetentionQueue({ db, nowMs, limit: budgets.maxJobs, metrics, cursor });
  if (useSchedulerCursor) {
    await persistSchedulerCursor({ db, cursor: due.lastCursor, nowMs, metrics });
  }
  metrics.jobsDiscovered += due.entries.length;
  const dueTimes = due.entries.map(([, entry]) => entry?.retentionDueAtMs)
    .filter(Number.isSafeInteger);
  const oldestDueAtMs = dueTimes.length ? Math.min(...dueTimes) : null;
  metrics.oldestDueAgeMs = oldestDueAtMs === null ? 0 : Math.max(0, nowMs - oldestDueAtMs);
  const collected = await collectRetentionContexts({
    db,
    due,
    nowMs,
    budgets,
    metrics,
    ownerId,
    expectedRolloutRevision: rollout.revision,
    expectedEvidenceDigest: rollout.evidenceDigest,
    allowPausedCanary,
  });
  const counters = { pagesByJob: new Map(), attemptsByJob: new Map() };
  // Retention authority is the invocation's injected timestamp. Wall time is
  // used only for the internal deadline; replay and lease tests stay exact.
  const operationalNowMs = () => Math.max(nowMs, safeInteger(clock(), nowMs));
  const deadlineReached = () => safeInteger(clock(), wallStartedAtMs) - wallStartedAtMs
    >= budgets.internalDeadlineMs;
  let budgetReason = collected.rolloutChanged ? 'rollout_changed' : null;
  let madeProgress = true;
  while (madeProgress && !budgetReason) {
    const round = await processContextRound({
      contexts: collected.contexts,
      counters,
      metrics,
      budgets,
      operationalNowMs,
      deadlineReached,
    });
    madeProgress = round.madeProgress;
    budgetReason = round.budgetReason;
  }
  await releaseContextLeases({
    contexts: collected.contexts,
    ownerId,
    nowMs: operationalNowMs(),
    metrics,
    cancelFences: budgetReason === 'rollout_changed' || allowPausedCanary,
  });
  if (!budgetReason && deadlineReached()) budgetReason = 'internal_deadline';
  const auxiliary = allowPausedCanary
    ? { hasMore: false, rolloutChanged: false, deadlineExceeded: false }
    : ['rollout_changed', 'internal_deadline'].includes(budgetReason)
    ? {
      hasMore: true,
      rolloutChanged: budgetReason === 'rollout_changed',
      deadlineExceeded: budgetReason === 'internal_deadline',
    }
    : await runAuxiliarySweeps({
      db,
      nowMs,
      budgets,
      metrics,
      expectedRolloutRevision: rollout.revision,
      expectedEvidenceDigest: rollout.evidenceDigest,
      allowPausedCanary,
      deadlineReached,
      resumeRequeue,
    });
  if (auxiliary.rolloutChanged) budgetReason = 'rollout_changed';
  if (auxiliary.deadlineExceeded) budgetReason = 'internal_deadline';
  const unfinished = collected.contexts.some((context) => !['completed', 'requires_attention']
    .includes(context.state?.phase === 'completed' ? 'completed' : context.state?.status));
  return {
    hasMore: due.hasMore || auxiliary.hasMore || collected.deferred > 0 || unfinished,
    budgetExhaustionReason: budgetReason,
  };
};

const canaryRolloutMismatch = (canary, rollout) => Boolean(canary?.enabled
  && (rollout.phase !== 'compactor'
    || canary.expectedPhase !== 'compactor'
    || Number(canary.expectedRevision) !== Number(rollout.revision)
    || rollout.canaryPassed !== false
    || typeof canary.evidenceDigest !== 'string'
    || canary.evidenceDigest !== rollout.evidenceDigest));

const resolveExecutionMode = ({ modeOverride, rollout, canary }) => {
  if (rollout.phase === 'compactor' && rollout.canaryPassed === false) {
    return canary?.enabled && modeOverride === 'compactor' ? 'canary' : 'canary_paused';
  }
  const requestedMode = modeOverride || rollout.phase;
  if (requestedMode !== 'compactor' || rollout.phase !== 'compactor') return rollout.phase;
  return canary?.enabled ? 'canary' : 'compactor';
};

const validExistingCanaryEvidence = (value, rollout) => Boolean(
  value?.schemaVersion === 1
  && value.phase === 'canary'
  && canaryEvidenceProvesCompletedJobs(value)
  && Number(value.rolloutRevision) === Number(rollout.revision)
  && value.evidenceDigest === rollout.evidenceDigest
  && value.shadowEvidenceFingerprint === rollout.shadowEvidenceFingerprint
  && value.evidenceFingerprint === buildCanaryEvidenceFingerprint(value),
);

const persistCanaryEvidence = async ({
  db, nowMs, rollout, result, metrics, fixture, fixtureCompleted,
}) => {
  const candidate = {
    schemaVersion: 1,
    phase: 'canary',
    rolloutRevision: rollout.revision,
    status: metrics.failures === 0 && metrics.rolloutAuthorizationFailures === 0
      && !result.budgetExhaustionReason && metrics.jobsDiscovered === 1
      && metrics.jobsClaimed === 1 && metrics.jobsCompleted === 1 && fixtureCompleted
      ? 'passed' : 'failed',
    evidenceDigest: rollout.evidenceDigest,
    shadowEvidenceFingerprint: rollout.shadowEvidenceFingerprint,
    jobsDiscovered: metrics.jobsDiscovered,
    jobsClaimed: metrics.jobsClaimed,
    jobsCompleted: metrics.jobsCompleted,
    attemptsDeleted: metrics.attemptsDeleted,
    failures: metrics.failures + metrics.rolloutAuthorizationFailures,
    fixtureFingerprint: fixture?.fixtureFingerprint || null,
    fixtureCompleted: Boolean(fixtureCompleted),
  };
  candidate.evidenceFingerprint = buildCanaryEvidenceFingerprint(candidate);
  let persisted = null;
  // eslint-disable-next-line complexity -- canary evidence CAS preserves exact passed proof across retries and races
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary`).transaction((current) => {
    if (current && Number(current.rolloutRevision || 0) > Number(rollout.revision)) return undefined;
    if (current && Number(current.rolloutRevision || 0) < Number(rollout.revision)) {
      persisted = { ...candidate, updatedAtMs: nowMs };
      return persisted;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && validExistingCanaryEvidence(current, rollout) && candidate.status !== 'passed') {
      persisted = current;
      return current;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && current.status === 'failed' && candidate.status === 'passed'
      && current.fixtureFingerprint === candidate.fixtureFingerprint) {
      persisted = { ...candidate, updatedAtMs: nowMs };
      return persisted;
    }
    if (current && Number(current.rolloutRevision) === Number(rollout.revision)
      && current.evidenceFingerprint !== candidate.evidenceFingerprint) {
      persisted = {
        ...candidate,
        status: 'failed',
        failures: Math.max(1, candidate.failures),
        conflict: true,
      };
      persisted.evidenceFingerprint = buildCanaryEvidenceFingerprint(persisted);
      return { ...persisted, updatedAtMs: nowMs };
    }
    persisted = current || { ...candidate, updatedAtMs: nowMs };
    return persisted;
  }, undefined, false);
  metrics.transactions += 1;
  return persisted;
};

const readPassedCanaryEvidence = async ({ db, rollout, metrics }) => {
  const evidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary`).once('value')).val();
  metrics.queries += 1;
  return validExistingCanaryEvidence(evidence, rollout) ? evidence : null;
};

const runLegacyMode = async ({
  db, nowMs, legacyCleanup, metrics, mode, rollout, resumeRequeue,
}) => {
  const legacy = typeof legacyCleanup === 'function'
    ? await legacyCleanup({
      db, nowMs, expectedRolloutPhase: rollout.phase,
      expectedRolloutRevision: rollout.revision, resumeRequeue,
    })
    : { deleted: 0 };
  metrics.legacyDeletionPaths = safeInteger(legacy?.deleted);
  const rolloutChanged = legacy?.rolloutChanged === true;
  return buildResult({
    mode,
    rollout,
    hasMore: rolloutChanged,
    budgetExhaustionReason: rolloutChanged ? 'rollout_changed' : null,
    metrics,
  });
};

const runShadowMode = async ({
  db, nowMs, budgets, legacyCleanup, metrics, mode, rollout, resumeRequeue,
}) => {
  const planned = await runDurableShadowPlan({ db, nowMs, budgets, metrics, rollout });
  const legacy = !planned.hasMore && typeof legacyCleanup === 'function'
    ? await legacyCleanup({
      db, nowMs, expectedRolloutPhase: rollout.phase,
      expectedRolloutRevision: rollout.revision, resumeRequeue,
    })
    : { deleted: 0 };
  metrics.legacyDeletionPaths = safeInteger(legacy?.deleted);
  const evidencePersisted = await persistShadowEvidence({ db, nowMs, rollout, planned, metrics });
  const rolloutChanged = legacy?.rolloutChanged === true || !evidencePersisted;
  return buildResult({
    mode,
    rollout,
    hasMore: planned.hasMore || rolloutChanged,
    budgetExhaustionReason: rolloutChanged
      ? 'rollout_changed'
      : (metrics.shadowMismatches ? 'shadow_mismatch' : null),
    metrics,
  });
};

/**
 * Production retention entrypoint. Missing or malformed rollout is normalized
 * to legacy. Shadow plans before the injected legacy mutation and performs no
 * compactor deletion. A canary is accepted only in the compactor phase.
 * @param {object} options
 */
const runNotificationRetentionCycle = async ({
  db,
  nowMs = Date.now(),
  ownerId = `retention_worker_${randomUUID().replace(/-/gu, '')}`,
  budgets: inputBudgets = {},
  legacyCleanup = null,
  modeOverride = null,
  canary = null,
  clock = Date.now,
  resumeRequeue = null,
  expectedPhase = null,
  expectedRevision = null,
}) => { // eslint-disable-line complexity -- rollout and canary recovery fail closed independently
  const metrics = createMetrics();
  const budgets = normalizeBudgets(inputBudgets);
  const rollout = await readNotificationRetentionRollout({ db });
  metrics.queries += 1;
  const guardedExecution = expectedPhase !== null || expectedRevision !== null;
  if (guardedExecution && (rollout.phase !== expectedPhase
    || rollout.revision !== expectedRevision)) {
    return buildResult({
      mode: 'guard_rejected',
      rollout,
      hasMore: true,
      budgetExhaustionReason: 'rollout_changed',
      metrics,
    });
  }
  if (canaryRolloutMismatch(canary, rollout)) {
    return buildResult({
      mode: 'canary_rejected',
      rollout,
      hasMore: false,
      budgetExhaustionReason: 'canary_rollout_mismatch',
      metrics,
    });
  }
  const mode = resolveExecutionMode({ modeOverride, rollout, canary });
  if (mode === 'legacy') return runLegacyMode({
    db, nowMs, legacyCleanup, metrics, mode, rollout, resumeRequeue,
  });
  if (mode === 'shadow') {
    return runShadowMode({
      db, nowMs, budgets, legacyCleanup, metrics, mode, rollout, resumeRequeue,
    });
  }
  if (mode === 'canary_paused') {
    return buildResult({
      mode, rollout, hasMore: true, budgetExhaustionReason: 'canary_required', metrics,
    });
  }
  if (mode === 'canary') {
    const existingCanary = await readPassedCanaryEvidence({ db, rollout, metrics });
    if (existingCanary) {
      return {
        ...buildResult({
          mode: 'canary_replay', rollout, hasMore: true,
          budgetExhaustionReason: null, metrics,
        }),
        canaryEvidenceStatus: 'passed',
      };
    }
  }
  let canaryFixture = null;
  if (mode === 'canary') {
    canaryFixture = await readExactCanaryFixture({
      db,
      rollout,
      fixtureFingerprint: canary?.fixtureFingerprint,
      jobId: canary?.fixtureJobId,
    });
    metrics.queries += 1;
    if (!canaryFixture) {
      return buildResult({
        mode: 'canary_rejected', rollout, hasMore: false,
        budgetExhaustionReason: 'canary_fixture_required', metrics,
      });
    }
  }
  let compacted;
  if (mode === 'canary' && canaryFixture.control.status === 'completed') {
    metrics.jobsDiscovered = 1;
    metrics.jobsClaimed = canaryFixture.control.jobsClaimed;
    metrics.jobsCompleted = canaryFixture.control.jobsCompleted;
    compacted = { hasMore: false, budgetExhaustionReason: null };
  } else compacted = await runCompactor({
    db,
    nowMs,
    budgets,
    metrics,
    ownerId,
    rollout,
    clock: typeof clock === 'function' ? clock : Date.now,
    useSchedulerCursor: mode !== 'canary',
    allowPausedCanary: mode === 'canary',
    canaryFixture,
    resumeRequeue,
  });
  if (mode === 'canary') {
    const fixtureCompleted = await verifyAndCompleteCanaryFixture({
      db, rollout, fixture: canaryFixture, nowMs, metrics,
    });
    const evidence = await persistCanaryEvidence({
      db, nowMs, rollout, result: compacted, metrics,
      fixture: canaryFixture,
      fixtureCompleted,
    });
    return {
      ...buildResult({ mode, rollout, ...compacted, metrics }),
      canaryEvidenceStatus: evidence?.status || 'failed',
    };
  }
  return buildResult({ mode, rollout, ...compacted, metrics });
};

module.exports = {
  PHASES,
  createMetrics,
  normalizeBudgets,
  orderedEntries,
  runNotificationRetentionCycle,
};
