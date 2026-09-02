'use strict';

// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { NOTIFICATION_RETENTION_PATHS, RETENTION_MS } = require('./constants');
const { ensureNotificationRetentionScheduled, readNotificationRetentionRollout } = require('./state');
const { compiledRetentionProtocol, protocolEvidenceMatches } = require('./protocol');

const fixtureIdentity = (rollout) => {
  const fixtureFingerprint = createHash('sha256').update(JSON.stringify([
    'notification_retention_canary_v1',
    Number(rollout?.revision || 0),
    rollout?.evidenceDigest || '',
    rollout?.shadowEvidenceFingerprint || '',
    rollout?.expectedEngineProtocolId || '',
  ])).digest('hex');
  return {
    fixtureFingerprint,
    jobId: `retention_canary_v1_${fixtureFingerprint.slice(0, 40)}`,
    attemptId: `retention_canary_attempt_v1_${fixtureFingerprint.slice(0, 40)}`,
  };
};

const exactFixtureRecord = (value, fingerprint) => !value
  || value.canaryFixtureFingerprint === fingerprint;

const compareCreate = async ({ ref, candidate, fingerprint }) => {
  let accepted = false;
  const result = await ref.transaction((current) => {
    if (!exactFixtureRecord(current, fingerprint)) return undefined;
    accepted = true;
    return current || candidate;
  }, undefined, false);
  return Boolean(accepted && result?.committed);
};

const buildFixtureJob = ({ identity, nowMs }) => {
  const completedAtMs = nowMs - RETENTION_MS - 1_000;
  return {
    schemaVersion: 2,
    jobId: identity.jobId,
    sourceType: 'notification_retention_canary_fixture',
    audienceType: 'notification_retention_canary_fixture',
    status: 'expired',
    completedAtMs,
    retentionDueAtMs: completedAtMs + RETENTION_MS,
    retentionGeneration: 0,
    createdAtMs: completedAtMs,
    updatedAtMs: completedAtMs,
    expiresAtMs: nowMs + RETENTION_MS,
    canaryFixtureFingerprint: identity.fixtureFingerprint,
    queueKind: null,
    queueKey: null,
    queueVersion: 0,
  };
};

const buildFixtureAttempt = ({ identity, job }) => ({
  schemaVersion: 2,
  attemptId: identity.attemptId,
  jobId: identity.jobId,
  generation: 1,
  status: 'expired',
  ticketStatus: 'expired',
  receiptStatus: 'not_requested',
  retryable: false,
  createdAtMs: job.completedAtMs,
  updatedAtMs: job.completedAtMs,
  retentionDueAtMs: job.retentionDueAtMs,
  canaryFixtureFingerprint: identity.fixtureFingerprint,
  queueKind: null,
  queueKey: null,
  queueVersion: 0,
});

const controlMatches = (current, expected) => current && expected
  && protocolEvidenceMatches(current)
  && current.fixtureFingerprint === expected.fixtureFingerprint
  && Number(current.rolloutRevision) === Number(expected.rolloutRevision)
  && current.evidenceDigest === expected.evidenceDigest
  && current.status === expected.status
  && current.queueKey === expected.queueKey
  && Number(current.updatedAtMs) === Number(expected.updatedAtMs);

const rolloutStillMatches = async ({ db, rollout }) => {
  const current = await readNotificationRetentionRollout({ db });
  return current.valid && current.phase === 'compactor' && current.canaryPassed === false
    && protocolEvidenceMatches(current) && protocolEvidenceMatches(rollout)
    && current.revision === rollout.revision && current.evidenceDigest === rollout.evidenceDigest;
};

// eslint-disable-next-line complexity -- superseded fixture cleanup validates every exact private path
const reconcileSupersededPriorControl = async ({ db, current, rollout, nowMs }) => {
  if (!current || !['creating', 'ready', 'completed'].includes(current.status)
    || !Number.isSafeInteger(Number(current.rolloutRevision))
    || Number(current.rolloutRevision) >= Number(rollout.revision)
    || typeof current.fixtureFingerprint !== 'string' || !current.fixtureFingerprint
    || (current.status === 'creating' && Number(current.leaseExpiresAtMs || 0) > nowMs)) return null;
  const suffix = current.fixtureFingerprint.slice(0, 40);
  const jobId = `retention_canary_v1_${suffix}`;
  const attemptId = `retention_canary_attempt_v1_${suffix}`;
  const stateRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${jobId}`);
  const observedState = (await stateRef.once('value')).val();
  if (observedState?.lease && Number(observedState.lease.expiresAtMs || 0) > nowMs) return null;
  const queueKey = observedState?.queueKey || current.queueKey || null;
  if (!(await rolloutStillMatches({ db, rollout }))) return null;
  let jobSafe = false;
  await db.ref(`notification_jobs/${jobId}`).transaction((value) => {
    if (!value) { jobSafe = true; return value; }
    if (value.canaryFixtureFingerprint !== current.fixtureFingerprint) return undefined;
    jobSafe = true;
    return null;
  }, undefined, false);
  if (!jobSafe || !(await rolloutStillMatches({ db, rollout }))) return null;
  let attemptSafe = false;
  await db.ref(`notification_delivery_attempts/${attemptId}`).transaction((value) => {
    if (!value) { attemptSafe = true; return value; }
    if (value.canaryFixtureFingerprint !== current.fixtureFingerprint) return undefined;
    attemptSafe = true;
    return null;
  }, undefined, false);
  if (!attemptSafe || !(await rolloutStillMatches({ db, rollout }))) return null;
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary_attempt_proofs/${current.fixtureFingerprint}`)
    .transaction((value) => (!value || value.fixtureFingerprint === current.fixtureFingerprint
      ? null : undefined), undefined, false);
  if (!(await rolloutStillMatches({ db, rollout }))) return null;
  let stateSafe = false;
  await stateRef.transaction((value) => {
    if (!value) { stateSafe = true; return value; }
    if (value.jobId !== jobId || value.queueKey !== queueKey
      || (value.lease && Number(value.lease.expiresAtMs || 0) > nowMs)) return undefined;
    stateSafe = true;
    return null;
  }, undefined, false);
  if (!stateSafe || !(await rolloutStillMatches({ db, rollout }))) return null;
  if (queueKey) {
    let queueSafe = false;
    await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${queueKey}`).transaction((value) => {
      if (!value) { queueSafe = true; return value; }
      if (value.jobId !== jobId) return undefined;
      queueSafe = true;
      return null;
    }, undefined, false);
    if (!queueSafe || !(await rolloutStillMatches({ db, rollout }))) return null;
  }
  return current;
};

const validFinalizationProof = (control, rollout, fixture) => Boolean(
  control?.finalizationProof?.schemaVersion === 1
  && Number(control.finalizationProof.rolloutRevision) === Number(rollout.revision)
  && control.finalizationProof.fixtureFingerprint === fixture.fixtureFingerprint
  && Number.isSafeInteger(control.finalizationProof.generation)
  && control.finalizationProof.generation > 0
  && Number.isSafeInteger(control.finalizationProof.leaseRevision)
  && control.finalizationProof.leaseRevision > 0
  && control.finalizationProof.attemptsDeleted === 1,
);

const recordCanaryFinalizationProof = async ({ context, nowMs }) => {
  const fingerprint = context.job?.canaryFixtureFingerprint;
  if (!context.allowPausedCanary || typeof fingerprint !== 'string' || !fingerprint) return true;
  const attemptProof = (await context.db
    .ref(`${NOTIFICATION_RETENTION_PATHS.evidence}/canary_attempt_proofs/${fingerprint}`)
    .once('value')).val();
  if (!attemptProof || attemptProof.schemaVersion !== 1
    || !protocolEvidenceMatches(attemptProof)
    || attemptProof.fixtureFingerprint !== fingerprint
    || Number(attemptProof.rolloutRevision) !== Number(context.expectedRolloutRevision)
    || Number(attemptProof.generation) !== Number(context.state.generation)
    || attemptProof.attemptsDeleted !== 1) return false;
  let recorded = false;
  const result = await context.db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture)
    .transaction((current) => {
      if (!current || current.status !== 'ready'
        || current.fixtureFingerprint !== fingerprint
        || Number(current.rolloutRevision) !== Number(context.expectedRolloutRevision)
        || current.evidenceDigest !== context.expectedEvidenceDigest) return undefined;
      recorded = true;
      return {
        ...current,
        finalizationProof: {
          schemaVersion: 1,
          rolloutRevision: context.expectedRolloutRevision,
          fixtureFingerprint: fingerprint,
          generation: context.state.generation,
          leaseRevision: context.state.leaseRevision,
          attemptsDeleted: 1,
          recordedAtMs: nowMs,
        },
        updatedAtMs: nowMs,
      };
    }, undefined, false);
  return Boolean(recorded && result?.committed);
};

// eslint-disable-next-line complexity -- fixture reservation validates every resumable collision state
const ensureNotificationRetentionCanaryFixture = async ({ db, rollout, nowMs = Date.now() }) => {
  if (!rollout?.valid || !protocolEvidenceMatches(rollout)
    || rollout.phase !== 'compactor' || rollout.canaryPassed !== false) {
    return { ready: false, reason: 'canary_rollout_mismatch' };
  }
  const identity = fixtureIdentity(rollout);
  const ownerId = `canary_fixture_${randomUUID().replace(/-/gu, '')}`;
  const controlRef = db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture);
  const observedControl = (await controlRef.once('value')).val();
  const controlDiffers = observedControl && (observedControl.fixtureFingerprint !== identity.fixtureFingerprint
    || Number(observedControl.rolloutRevision) !== Number(rollout.revision)
    || observedControl.evidenceDigest !== rollout.evidenceDigest);
  const replaceablePrior = controlDiffers
    ? await reconcileSupersededPriorControl({
      db, current: observedControl, rollout, nowMs,
    }) : null;
  let reserved = false;
  let owned = false;
  const reservation = await controlRef
    .transaction((current) => {
      const differs = current && (current.fixtureFingerprint !== identity.fixtureFingerprint
        || Number(current.rolloutRevision) !== Number(rollout.revision)
        || current.evidenceDigest !== rollout.evidenceDigest);
      if (differs && !controlMatches(current, replaceablePrior)) return undefined;
      const activeCurrent = differs ? null : current;
      reserved = true;
      if (activeCurrent?.status === 'creating'
        && Number(activeCurrent.leaseExpiresAtMs || 0) <= nowMs) {
        owned = true;
        return {
          ...activeCurrent, ownerId, leaseExpiresAtMs: nowMs + 120_000, updatedAtMs: nowMs,
        };
      }
      if (activeCurrent) return activeCurrent;
      owned = true;
      return {
        schemaVersion: 1,
        ...compiledRetentionProtocol(),
        rolloutRevision: rollout.revision,
        evidenceDigest: rollout.evidenceDigest,
        fixtureFingerprint: identity.fixtureFingerprint,
        fixtureJobHash: createHash('sha256').update(identity.jobId).digest('hex').slice(0, 24),
        status: 'creating',
        ownerId,
        leaseExpiresAtMs: nowMs + 120_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    }, undefined, false);
  if (!reserved || !reservation?.committed) return { ready: false, reason: 'fixture_conflict' };
  const control = reservation.snapshot.val();
  if (control.status === 'completed') return { ready: false, completed: true, ...identity };
  if (control.status === 'ready') return { ready: true, ...identity };
  if (!owned && control.status === 'creating' && control.ownerId !== ownerId) {
    return { ready: false, reason: 'fixture_creation_in_progress' };
  }

  const job = buildFixtureJob({ identity, nowMs });
  const attempt = buildFixtureAttempt({ identity, job });
  if (!(await compareCreate({
    ref: db.ref(`notification_jobs/${identity.jobId}`),
    candidate: job,
    fingerprint: identity.fixtureFingerprint,
  })) || !(await compareCreate({
    ref: db.ref(`notification_delivery_attempts/${identity.attemptId}`),
    candidate: attempt,
    fingerprint: identity.fixtureFingerprint,
  }))) return { ready: false, reason: 'fixture_path_conflict' };

  const scheduled = await ensureNotificationRetentionScheduled({
    db, jobId: identity.jobId, job, nowMs,
  });
  if (!['scheduled', 'already_scheduled', 'queue_repaired'].includes(scheduled.reason)) {
    return { ready: false, reason: 'fixture_schedule_failed' };
  }
  const retentionState = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.jobs}/${identity.jobId}`)
    .once('value')).val();
  if (!retentionState?.queueKey) return { ready: false, reason: 'fixture_state_missing' };
  let ready = false;
  await db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture).transaction((current) => {
    if (!current || current.ownerId !== ownerId
      || current.fixtureFingerprint !== identity.fixtureFingerprint) return undefined;
    ready = true;
    return {
      ...current,
      status: 'ready',
      ownerId: null,
      leaseExpiresAtMs: null,
      queueKey: retentionState.queueKey,
      updatedAtMs: nowMs,
    };
  }, undefined, false);
  return ready ? { ready: true, ...identity } : { ready: false, reason: 'fixture_control_changed' };
};

const readExactCanaryFixture = async ({ db, rollout, fixtureFingerprint, jobId }) => {
  const control = (await db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture).once('value')).val();
  const identity = fixtureIdentity(rollout);
  return control?.schemaVersion === 1
    && protocolEvidenceMatches(control)
    && protocolEvidenceMatches(rollout)
    && ['ready', 'completed'].includes(control.status)
    && control.fixtureFingerprint === identity.fixtureFingerprint
    && control.fixtureFingerprint === fixtureFingerprint
    && identity.jobId === jobId
    && Number(control.rolloutRevision) === Number(rollout.revision)
    && control.evidenceDigest === rollout.evidenceDigest
    && typeof control.queueKey === 'string' && control.queueKey
    ? { ...identity, control }
    : null;
};

const verifyAndCompleteCanaryFixture = async ({
  db, rollout, fixture, nowMs = Date.now(), metrics = null,
}) => {
  const currentControl = (await db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture)
    .once('value')).val();
  if (!validFinalizationProof(currentControl, rollout, fixture)) return false;
  const requiredAbsentPaths = [
    `notification_jobs/${fixture.jobId}`,
    `notification_delivery_attempts/${fixture.attemptId}`,
    `${NOTIFICATION_RETENTION_PATHS.jobs}/${fixture.jobId}`,
  ];
  for (const path of requiredAbsentPaths) {
    if ((await db.ref(path).once('value')).exists()) return false;
  }
  const proof = currentControl.finalizationProof;
  let queueRemoved = false;
  let queueAlreadyAbsent = false;
  const queueResult = await db.ref(`${NOTIFICATION_RETENTION_PATHS.queue}/${currentControl.queueKey}`)
    .transaction((current) => {
      if (!current) {
        queueRemoved = true;
        queueAlreadyAbsent = true;
        return undefined;
      }
      if (current.jobId !== fixture.jobId
        || Number(current.generation) !== Number(proof.generation)) return undefined;
      queueRemoved = true;
      return null;
    }, undefined, false);
  if (!queueRemoved || (!queueAlreadyAbsent && !queueResult?.committed)) return false;
  let completionProof = null;
  const result = await db.ref(NOTIFICATION_RETENTION_PATHS.canaryFixture)
    .transaction((current) => {
      if (!current || current.fixtureFingerprint !== fixture.fixtureFingerprint
        || Number(current.rolloutRevision) !== Number(rollout.revision)
        || !validFinalizationProof(current, rollout, fixture)) return undefined;
      if (current.status === 'completed' && current.fixtureCompleted === true
        && current.jobsClaimed === 1 && current.jobsCompleted === 1) {
        completionProof = current;
        return current;
      }
      if (current.status !== 'ready') return undefined;
      completionProof = {
        ...current,
        status: 'completed',
        fixtureCompleted: true,
        jobsClaimed: 1,
        jobsCompleted: 1,
        attemptsDeleted: 1,
        completionProof: 'exact_fixture_paths_absent',
        recoveredAfterFinalization: Number(metrics?.jobsCompleted || 0) !== 1,
        completedAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      return completionProof;
    }, undefined, false);
  if (!completionProof || !result?.committed) return false;
  if (metrics) {
    metrics.jobsDiscovered = 1;
    metrics.jobsClaimed = 1;
    metrics.jobsCompleted = 1;
    metrics.attemptsDeleted = Math.max(
      Number(metrics.attemptsDeleted || 0), completionProof.attemptsDeleted,
    );
  }
  return true;
};

module.exports = {
  ensureNotificationRetentionCanaryFixture,
  fixtureIdentity,
  readExactCanaryFixture,
  recordCanaryFinalizationProof,
  verifyAndCompleteCanaryFixture,
};
