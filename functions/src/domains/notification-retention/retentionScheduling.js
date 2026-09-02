'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  NOTIFICATION_RETENTION_PATHS,
  NOTIFICATION_RETENTION_SCHEMA_VERSION,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  RETENTION_MS,
} = require('./constants');
const { classifyNotificationRetentionEligibility } = require('./eligibility');
const { transactionWithAuthoritativeExistingValue } = require('./retentionEngineRuntime');

const QUEUE_KEY_WIDTH = 13;
const QUEUE_GENERATION_WIDTH = 16;
const STATE_SCHEMA_VERSION = NOTIFICATION_RETENTION_SCHEMA_VERSION;

const buildRetentionQueueKey = (jobId, dueAtMs, generation) => {
  const digest = createHash('sha256').update(jobId).digest('hex').slice(0, 32);
  return `${String(dueAtMs).padStart(QUEUE_KEY_WIDTH, '0')}~${digest}~${String(generation).padStart(QUEUE_GENERATION_WIDTH, '0')}`;
};

const validJobId = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 128
  && !/[.#$\[\]/]/u.test(value);

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
  const boundary = await transactionWithAuthoritativeExistingValue(
    db.ref(`notification_jobs/${jobId}`), (current) => {
    if (!current || current.jobId !== jobId || current.status !== job.status
      || current.completedAtMs !== job.completedAtMs) return undefined;
    if (Number.isSafeInteger(current.retentionDueAtMs) && current.retentionDueAtMs > 0) {
      return current.retentionDueAtMs === retentionDueAtMs ? current : undefined;
    }
    return Number.isSafeInteger(retentionDueAtMs) ? { ...current, retentionDueAtMs } : undefined;
    },
  );
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
    await transactionWithAuthoritativeExistingValue(
      db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${priorCompatibility.queueKey}`),
      (current) => current?.jobId === jobId
        && Number(current.generation) === Number(priorCompatibility.generation)
        ? null : undefined,
    );
  }
  if (outcome === 'already_scheduled' && compatibilityRepaired) outcome = 'queue_repaired';
  return { committed: true, outcome, compatibilityRepaired };
};

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
    job: { ...job, lease: null },
    nowMs,
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
  activeRequeueState,
  buildRetentionQueueKey,
  ensureNotificationRetentionScheduled,
};
