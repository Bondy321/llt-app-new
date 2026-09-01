'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  NOTIFICATION_RETENTION_PATHS,
  NOTIFICATION_RETENTION_ROLLOUT_PHASES,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
} = require('./constants');
const {
  classifyNotificationRetentionEligibility,
} = require('./eligibility');
const STATE_SCHEMA_VERSION = 1;
const QUEUE_KEY_WIDTH = 13;
const QUEUE_GENERATION_WIDTH = 16;
const MAX_BOUNDED_TEXT = 80;
const EVIDENCE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
/** @param {unknown} value */
const boundedText = (value) => typeof value === 'string'
  ? value.trim().slice(0, MAX_BOUNDED_TEXT)
  : '';
/** @param {unknown} value */
const hashBoundedValue = (value) => {
  const text = boundedText(value);
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 24) : null;
};
/** @param {any} value */
// eslint-disable-next-line complexity -- every bounded shadow proof field is intentionally fingerprinted
const buildShadowEvidenceFingerprint = (value) => createHash('sha256').update(JSON.stringify([
  Number(value?.schemaVersion || 0),
  boundedText(value?.phase),
  Number(value?.rolloutRevision || 0),
  boundedText(value?.status),
  Number(value?.shadowEligible || 0),
  Number(value?.shadowLegacyEligible || 0),
  Number(value?.shadowMismatches || 0),
  Number(value?.compactorScanned || 0),
  Number(value?.legacyScanned || 0),
  Number(value?.progressRevision || 0),
  Number(value?.evaluationNowMs || 0),
  value?.hasMore === true,
])).digest('hex');
/** @param {any} value */
// eslint-disable-next-line complexity -- the fingerprint binds every bounded canary proof field
const buildCanaryEvidenceFingerprint = (value) => createHash('sha256').update(JSON.stringify([
  Number(value?.schemaVersion || 0),
  boundedText(value?.phase),
  Number(value?.rolloutRevision || 0),
  boundedText(value?.status),
  boundedText(value?.evidenceDigest),
  boundedText(value?.shadowEvidenceFingerprint),
  Number(value?.jobsDiscovered || 0),
  Number(value?.jobsClaimed || 0),
  Number(value?.jobsCompleted || 0),
  Number(value?.attemptsDeleted || 0),
  Number(value?.failures || 0),
  boundedText(value?.fixtureFingerprint),
  value?.fixtureCompleted === true,
])).digest('hex');
/** @param {unknown} value */
const validEvidenceFingerprint = (value) => typeof value === 'string'
  && EVIDENCE_FINGERPRINT_PATTERN.test(value);

/** @param {any} value */
const canaryEvidenceProvesCompletedJobs = (value) => Boolean(
  value?.status === 'passed'
  && value.fixtureCompleted === true
  && validEvidenceFingerprint(value.fixtureFingerprint)
  && Number.isSafeInteger(value.jobsClaimed)
  && value.jobsClaimed === 1
  && Number.isSafeInteger(value.jobsCompleted)
  && value.jobsCompleted === value.jobsClaimed
  && Number.isSafeInteger(value.failures)
  && value.failures === 0,
);

/** @param {string} jobId @param {number} dueAtMs @param {number} generation */
const buildRetentionQueueKey = (jobId, dueAtMs, generation) => {
  const digest = createHash('sha256').update(jobId).digest('hex').slice(0, 32);
  return `${String(dueAtMs).padStart(QUEUE_KEY_WIDTH, '0')}~${digest}~${String(generation).padStart(QUEUE_GENERATION_WIDTH, '0')}`;
};

/** @param {unknown} value */
const validJobId = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 128
  && !/[.#$\[\]/]/u.test(value);

/** @param {any} value */
// eslint-disable-next-line complexity -- strict fail-closed rollout schema validates all phase evidence
const normalizeNotificationRetentionRollout = (value) => {
  const structurallyValid = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === STATE_SCHEMA_VERSION
    && NOTIFICATION_RETENTION_ROLLOUT_PHASES.has(value.phase)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.preparationComplete === 'boolean');
  const evidenceDigest = boundedText(value?.evidenceDigest) || null;
  const shadowEvidenceFingerprint = validEvidenceFingerprint(value?.shadowEvidenceFingerprint)
    ? value.shadowEvidenceFingerprint
    : null;
  const canaryPassed = value?.canaryPassed === true;
  const canaryEvidenceFingerprint = validEvidenceFingerprint(value?.canaryEvidenceFingerprint)
    ? value.canaryEvidenceFingerprint
    : null;
  const shadowEvidenceRevision = Number.isSafeInteger(value?.shadowEvidenceRevision)
    ? value.shadowEvidenceRevision
    : null;
  const canaryEvidenceRevision = Number.isSafeInteger(value?.canaryEvidenceRevision)
    ? value.canaryEvidenceRevision
    : null;
  const preparationRolloutRevision = Number.isSafeInteger(value?.preparationRolloutRevision)
    && value.preparationRolloutRevision >= 0
    ? value.preparationRolloutRevision
    : null;
  const phaseEvidenceValid = value?.phase === 'legacy'
    || (value?.preparationComplete === true && Boolean(evidenceDigest)
      && preparationRolloutRevision !== null
      && (value?.phase !== 'compactor' || (Boolean(shadowEvidenceFingerprint)
        && shadowEvidenceRevision !== null
        && typeof value?.canaryPassed === 'boolean'
        && (!canaryPassed || (Boolean(canaryEvidenceFingerprint)
          && canaryEvidenceRevision !== null)))));
  if (!structurallyValid || !phaseEvidenceValid) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      phase: 'legacy',
      revision: 0,
      preparationComplete: false,
      evidenceDigest: null,
      preparationRolloutRevision: null,
      shadowEvidenceFingerprint: null,
      shadowEvidenceRevision: null,
      canaryPassed: false,
      canaryEvidenceFingerprint: null,
      canaryEvidenceRevision: null,
      updatedAtMs: null,
      valid: false,
    };
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    phase: value.phase,
    revision: value.revision,
    preparationComplete: value.preparationComplete,
    evidenceDigest: boundedText(value.evidenceDigest) || null,
    preparationRolloutRevision,
    shadowEvidenceFingerprint,
    shadowEvidenceRevision,
    canaryPassed,
    canaryEvidenceFingerprint,
    canaryEvidenceRevision,
    updatedAtMs: Number.isSafeInteger(value.updatedAtMs) ? value.updatedAtMs : null,
    valid: true,
  };
};

/** @param {{ db: any }} options */
const readNotificationRetentionRollout = async ({ db }) => {
  const snapshot = await db.ref(NOTIFICATION_RETENTION_PATHS.rollout).once('value');
  return normalizeNotificationRetentionRollout(snapshot.val());
};

const allowedRolloutTransition = (current, next) => {
  if (current === next) return true;
  if (next === 'legacy') return true;
  if (current === 'compactor' && next === 'shadow') return true;
  return (current === 'legacy' && next === 'shadow')
    || (current === 'shadow' && next === 'compactor');
};

const invalidRolloutTransitionInput = ({ expectedPhase, expectedRevision, nextPhase, nowMs }) => (
  !NOTIFICATION_RETENTION_ROLLOUT_PHASES.has(expectedPhase)
  || !NOTIFICATION_RETENTION_ROLLOUT_PHASES.has(nextPhase)
  || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
  || !Number.isSafeInteger(nowMs) || nowMs <= 0
);

const isForwardRolloutTransition = (expectedPhase, nextPhase) => (
  nextPhase !== 'legacy'
  && !(expectedPhase === 'compactor' && nextPhase === 'shadow')
  && nextPhase !== expectedPhase
);

const completedPreparationEvidence = (prepared) => Boolean(prepared?.status === 'complete'
  && prepared?.preparationComplete === true
  && Number(prepared?.cumulative?.requiresAttention || prepared?.requiresAttention || 0) === 0);

const activationEvidenceAccepted = ({
  forward, preparationComplete, prepared, expectedPhase, nextPhase, digest,
  currentRollout, shadowEvidence, canaryEvidence, expectedRevision,
// eslint-disable-next-line complexity -- activation deliberately checks every independent proof field
}) => {
  const expectedPreparationRolloutRevision = expectedPhase === 'legacy'
    ? expectedRevision
    : currentRollout?.preparationRolloutRevision;
  if (forward && (!preparationComplete || !completedPreparationEvidence(prepared)
    || !digest || prepared?.evidenceDigest !== digest
    || Number(prepared?.rolloutRevision) !== Number(expectedPreparationRolloutRevision))) return false;
  if (nextPhase !== 'compactor') return true;
  if (!digest) return false;
  if (expectedPhase === 'compactor') {
    return currentRollout?.phase === 'compactor'
      && currentRollout.canaryPassed === false
      && currentRollout.evidenceDigest === digest
      && shadowEvidenceStillMatches(
        shadowEvidence,
        currentRollout.shadowEvidenceRevision,
        currentRollout.shadowEvidenceFingerprint,
      )
      && canaryEvidence?.schemaVersion === STATE_SCHEMA_VERSION
      && canaryEvidence.phase === 'canary'
      && canaryEvidenceProvesCompletedJobs(canaryEvidence)
      && Number(canaryEvidence.rolloutRevision) === Number(expectedRevision)
      && canaryEvidence.evidenceDigest === digest
      && canaryEvidence.shadowEvidenceFingerprint === currentRollout.shadowEvidenceFingerprint
      && validEvidenceFingerprint(canaryEvidence.evidenceFingerprint)
      && canaryEvidence.evidenceFingerprint === buildCanaryEvidenceFingerprint(canaryEvidence);
  }
  return shadowEvidence?.schemaVersion === STATE_SCHEMA_VERSION
    && shadowEvidence?.phase === 'shadow'
    && shadowEvidence?.status === 'passed'
    && Number(shadowEvidence?.rolloutRevision) === Number(expectedRevision)
    && Number(shadowEvidence?.shadowMismatches) === 0
    && shadowEvidence?.hasMore === false
    && validEvidenceFingerprint(shadowEvidence?.evidenceFingerprint)
    && shadowEvidence.evidenceFingerprint === buildShadowEvidenceFingerprint(shadowEvidence);
};

const rejectedRolloutTransition = async (db, reason) => ({
  transitioned: false,
  reason,
  rollout: await readNotificationRetentionRollout({ db }),
});

const shadowEvidenceStillMatches = (current, expectedRevision, fingerprint) => Boolean(
  current?.schemaVersion === STATE_SCHEMA_VERSION
  && current.phase === 'shadow'
  && current.status === 'passed'
  && Number(current.rolloutRevision) === Number(expectedRevision)
  && Number(current.shadowMismatches) === 0
  && current.hasMore === false
  && current.evidenceFingerprint === fingerprint
  && buildShadowEvidenceFingerprint(current) === fingerprint,
);

const canaryEvidenceStillMatches = (current, rollout) => Boolean(
  current?.schemaVersion === STATE_SCHEMA_VERSION
  && current.phase === 'canary'
  && canaryEvidenceProvesCompletedJobs(current)
  && Number(current.rolloutRevision) === Number(rollout?.canaryEvidenceRevision)
  && current.evidenceDigest === rollout?.evidenceDigest
  && current.shadowEvidenceFingerprint === rollout?.shadowEvidenceFingerprint
  && current.evidenceFingerprint === rollout?.canaryEvidenceFingerprint
  && buildCanaryEvidenceFingerprint(current) === rollout?.canaryEvidenceFingerprint,
);

const commitRolloutTransition = async ({
  db, expectedPhase, expectedRevision, nextPhase, preparationComplete,
  digest, shadowEvidenceFingerprint, shadowEvidenceRevision,
  canaryPassed = false, canaryEvidenceFingerprint = null, canaryEvidenceRevision = null,
  actor, nowMs,
}) => {
  let transitioned = false;
  let reason = 'rollout_changed';
  // eslint-disable-next-line complexity -- the rollout record preserves every phase-specific proof field
  const result = await db.ref(NOTIFICATION_RETENTION_PATHS.rollout).transaction((currentValue) => {
    const current = normalizeNotificationRetentionRollout(currentValue);
    if (current.phase !== expectedPhase || current.revision !== expectedRevision) return undefined;
    transitioned = true;
    reason = current.phase === nextPhase ? 'already_current' : 'transitioned';
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      phase: nextPhase,
      revision: current.revision + 1,
      preparationComplete: nextPhase === 'legacy' ? false : Boolean(preparationComplete || current.preparationComplete),
      preparationRolloutRevision: nextPhase === 'legacy'
        ? null
        : (current.preparationRolloutRevision ?? current.revision),
      evidenceDigest: digest || current.evidenceDigest || null,
      shadowEvidenceFingerprint: nextPhase === 'compactor'
        ? (shadowEvidenceFingerprint || current.shadowEvidenceFingerprint)
        : null,
      shadowEvidenceRevision: nextPhase === 'compactor'
        ? (shadowEvidenceRevision ?? current.shadowEvidenceRevision)
        : null,
      canaryPassed: nextPhase === 'compactor' ? Boolean(canaryPassed) : false,
      canaryEvidenceFingerprint: nextPhase === 'compactor' && canaryPassed
        ? canaryEvidenceFingerprint
        : null,
      canaryEvidenceRevision: nextPhase === 'compactor' && canaryPassed
        ? canaryEvidenceRevision
        : null,
      actorHash: hashBoundedValue(actor),
      updatedAtMs: nowMs,
    };
  }, undefined, false);
  return {
    transitioned: Boolean(transitioned && result?.committed),
    reason,
    rollout: normalizeNotificationRetentionRollout(result?.snapshot?.val?.()),
  };
};

/**
 * Compare-safe rollout mutation. Backward transitions are intentionally not
 * blocked by forward evidence gates.
 * @param {object} options
 */
const transitionNotificationRetentionRollout = async ({
  db,
  expectedPhase,
  expectedRevision,
  nextPhase,
  actor,
  nowMs = Date.now(),
  preparationComplete = false,
  evidenceDigest = null,
// eslint-disable-next-line complexity -- rollout CAS checks every fail-closed evidence and rollback branch
}) => {
  if (invalidRolloutTransitionInput({ expectedPhase, expectedRevision, nextPhase, nowMs })) {
    return rejectedRolloutTransition(db, 'invalid_transition');
  }
  if (!allowedRolloutTransition(expectedPhase, nextPhase)) {
    return rejectedRolloutTransition(db, 'transition_not_allowed');
  }
  const currentRollout = await readNotificationRetentionRollout({ db });
  if (currentRollout.phase !== expectedPhase || currentRollout.revision !== expectedRevision) {
    return rejectedRolloutTransition(db, 'rollout_changed');
  }
  const digest = boundedText(evidenceDigest);
  const forward = isForwardRolloutTransition(expectedPhase, nextPhase);
  const prepared = forward
    ? (await db.ref(NOTIFICATION_RETENTION_PATHS.preparation).once('value')).val()
    : null;
  const shadowEvidence = nextPhase === 'compactor'
    ? (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/shadow`).once('value')).val()
    : null;
  const canaryEvidence = nextPhase === 'compactor' && expectedPhase === 'compactor'
    ? (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary`).once('value')).val()
    : null;
  if (!activationEvidenceAccepted({
    forward,
    preparationComplete,
    prepared,
    expectedPhase,
    nextPhase,
    digest,
    currentRollout,
    shadowEvidence,
    canaryEvidence,
    expectedRevision,
  })) {
    return rejectedRolloutTransition(db, 'activation_evidence_required');
  }
  const committed = await commitRolloutTransition({
    db, expectedPhase, expectedRevision, nextPhase, preparationComplete,
    digest,
    shadowEvidenceFingerprint: shadowEvidence?.evidenceFingerprint || null,
    shadowEvidenceRevision: shadowEvidence?.rolloutRevision ?? null,
    canaryPassed: expectedPhase === 'compactor' && nextPhase === 'compactor',
    canaryEvidenceFingerprint: canaryEvidence?.evidenceFingerprint || null,
    canaryEvidenceRevision: canaryEvidence?.rolloutRevision ?? null,
    actor,
    nowMs,
  });
  if (!committed.transitioned || nextPhase !== 'compactor') return committed;
  if (expectedPhase === 'compactor') {
    const currentCanaryEvidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary`)
      .once('value')).val();
    const currentShadowEvidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/shadow`)
      .once('value')).val();
    if (canaryEvidenceStillMatches(currentCanaryEvidence, committed.rollout)
      && shadowEvidenceStillMatches(
        currentShadowEvidence,
        committed.rollout.shadowEvidenceRevision,
        committed.rollout.shadowEvidenceFingerprint,
      )) return committed;
  } else {
    const currentEvidence = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/shadow`)
      .once('value')).val();
    if (shadowEvidenceStillMatches(
      currentEvidence,
      expectedRevision,
      committed.rollout.shadowEvidenceFingerprint,
    )) return committed;
  }
  const rolledBack = await commitRolloutTransition({
    db,
    expectedPhase: 'compactor',
    expectedRevision: committed.rollout.revision,
    nextPhase: 'shadow',
    preparationComplete: true,
    digest,
    shadowEvidenceFingerprint: null,
    shadowEvidenceRevision: null,
    actor: 'automatic-evidence-revocation',
    nowMs,
  });
  return {
    transitioned: false,
    reason: 'activation_evidence_changed',
    rollout: rolledBack.rollout,
  };
};

/** @param {any} state */
const activeRequeueState = (state) => Boolean(state
  && state.status === 'processing');

const scheduleResult = (scheduled, reason, dueAtMs = null, generation = 0) => ({
  scheduled, reason, dueAtMs, generation,
});

const materializeCanonicalRetentionBoundary = async ({ db, jobId, job }) => {
  if (!ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES.has(job.status)
    || !Number.isSafeInteger(job.completedAtMs) || job.completedAtMs <= 0
    || (Number.isSafeInteger(job.retentionDueAtMs) && job.retentionDueAtMs > 0)) return job;
  const retentionDueAtMs = job.completedAtMs + RETENTION_MS;
  const boundary = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.jobId !== jobId || current.status !== job.status
      || current.completedAtMs !== job.completedAtMs) return undefined;
    if (Number.isSafeInteger(current.retentionDueAtMs) && current.retentionDueAtMs > 0) {
      return current.retentionDueAtMs === retentionDueAtMs ? current : undefined;
    }
    return Number.isSafeInteger(retentionDueAtMs) ? { ...current, retentionDueAtMs } : undefined;
  }, undefined, false);
  return boundary?.committed ? boundary.snapshot.val() : null;
};

const schedulableClassification = (classification) => classification.eligible
  || classification.reason === 'not_due'
  || classification.reason === 'privacy_not_due';

const buildRetentionState = ({ jobId, job, classification, queueKey, nowMs }) => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  jobId,
  generation: classification.generation,
  status: 'queued',
  phase: 'attempts',
  targetStatus: job.status,
  targetCompletedAtMs: Number(job.completedAtMs || 0),
  retentionDueAtMs: classification.dueAtMs,
  privacyTombstone: classification.privacyTombstone,
  queueKey,
  queueVersion: classification.generation,
  attemptCursor: null,
  attemptPagesProcessed: 0,
  attemptsScanned: 0,
  attemptsDeleted: 0,
  warnings: 0,
  lease: null,
  leaseExpiresAtMs: null,
  leaseRevision: 0,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
});

const persistRetentionScheduling = async ({ db, jobId, job, classification, queueKey, nowMs }) => {
  let outcome = 'conflict';
  let persistedState = null;
  let priorCompatibility = null;
  // The per-job state is the authoritative indexed due queue. This transaction
  // remains O(1) as the number of retained jobs grows.
  const result = await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`)
    // eslint-disable-next-line complexity -- one bounded transaction owns every generation conflict case
    .transaction((current) => {
    outcome = 'conflict';
    if (current?.status === 'requires_attention'
      && current.targetStatus === job.status
      && Number(current.targetCompletedAtMs || 0) === Number(job.completedAtMs || 0)) {
      outcome = 'requires_attention';
      return undefined;
    }
    if (current && Number(current.generation || 0) > classification.generation) {
      outcome = 'newer_generation';
      return undefined;
    }
    if (current && Number(current.generation || 0) === classification.generation
      && current.status === 'requires_attention') {
      outcome = 'requires_attention';
      return undefined;
    }
    if (current && Number(current.generation || 0) === classification.generation
      && current.status === 'completed') {
      outcome = 'already_completed';
      return undefined;
    }
    const sameGeneration = current
      && Number(current.generation || 0) === classification.generation
      && current.targetCompletedAtMs === Number(job.completedAtMs || 0);
    if (!sameGeneration && current?.queueKey && current.queueKey !== queueKey) {
      priorCompatibility = { queueKey: current.queueKey, generation: current.generation };
    }
    persistedState = sameGeneration ? {
      ...current,
      targetStatus: job.status,
      retentionDueAtMs: classification.dueAtMs,
      privacyTombstone: classification.privacyTombstone,
      queueKey,
      queueVersion: classification.generation,
      updatedAtMs: nowMs,
    } : buildRetentionState({ jobId, job, classification, queueKey, nowMs });
    outcome = !sameGeneration ? 'scheduled' : 'already_scheduled';
    return persistedState;
  }, undefined, false);
  if (!result?.committed || !persistedState) return { committed: false, outcome };

  // Keep the old queue as a non-authoritative rollback projection for the
  // previously deployed worker. New workers never grant deletion authority
  // from this record.
  let compatibilityRepaired = false;
  const queueResult = await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${queueKey}`)
    .transaction((current) => {
    if (current && (current.jobId !== jobId
      || Number(current.generation) !== Number(persistedState.generation))) return undefined;
    compatibilityRepaired = !current;
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: 'notification_job_retention',
      jobId,
      generation: persistedState.generation,
      dueAtMs: persistedState.retentionDueAtMs,
      createdAtMs: Number(current?.createdAtMs || nowMs),
    };
  }, undefined, false);
  if (queueResult?.committed && priorCompatibility) {
    await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${priorCompatibility.queueKey}`)
      .transaction((current) => current?.jobId === jobId
        && Number(current.generation) === Number(priorCompatibility.generation)
        ? null : undefined, undefined, false);
  }
  if (outcome === 'already_scheduled' && compatibilityRepaired) outcome = 'queue_repaired';
  return { committed: true, outcome, compatibilityRepaired };
};

/**
 * Creates or repairs one deterministic durable retention job and due queue
 * entry. The returned result contains aggregates and opaque identifiers only.
 * @param {{ db: any, jobId: string, job?: any, nowMs?: number }} options
 */
const ensureNotificationRetentionScheduled = async ({
  db,
  jobId,
  job: suppliedJob,
  nowMs = Date.now(),
}) => {
  if (!validJobId(jobId)) return scheduleResult(false, 'invalid_job_id');
  const canonicalJob = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  if (!canonicalJob || canonicalJob.jobId !== jobId) return scheduleResult(false, 'missing_job');
  if (suppliedJob && suppliedJob.jobId !== jobId) {
    return scheduleResult(false, 'job_identity_changed');
  }
  const job = await materializeCanonicalRetentionBoundary({ db, jobId, job: canonicalJob });
  if (!job) return scheduleResult(false, 'retention_due_conflict');
  const classification = classifyNotificationRetentionEligibility({
    // Scheduling is only a durable candidate index. A live delivery lease is
    // rechecked by the destructive compactor and must not make work disappear.
    job: { ...job, lease: null },
    nowMs,
    // Scheduling is non-destructive. A requeue is rechecked by the compactor's
    // canonical fence and defers execution without losing this durable due item.
    activeRequeue: false,
  });
  if (!schedulableClassification(classification)) return scheduleResult(
    false, classification.reason, classification.dueAtMs, classification.generation,
  );

  const queueKey = buildRetentionQueueKey(jobId, classification.dueAtMs, classification.generation);
  const persisted = await persistRetentionScheduling({
    db, jobId, job, classification, queueKey, nowMs,
  });
  if (!persisted.committed) return scheduleResult(
    false, persisted.outcome, classification.dueAtMs, classification.generation,
  );
  return scheduleResult(
    ['scheduled', 'queue_repaired'].includes(persisted.outcome),
    persisted.outcome,
    classification.dueAtMs,
    classification.generation,
  );
};

module.exports = {
  STATE_SCHEMA_VERSION,
  activeRequeueState,
  buildCanaryEvidenceFingerprint,
  buildRetentionQueueKey,
  buildShadowEvidenceFingerprint,
  canaryEvidenceProvesCompletedJobs,
  ensureNotificationRetentionScheduled,
  normalizeNotificationRetentionRollout,
  readNotificationRetentionRollout,
  shadowEvidenceStillMatches,
  canaryEvidenceStillMatches,
  transitionNotificationRetentionRollout,
};
