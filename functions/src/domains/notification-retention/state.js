'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const {
  NOTIFICATION_RETENTION_PATHS,
  NOTIFICATION_RETENTION_ROLLOUT_PHASES,
  NOTIFICATION_RETENTION_SCHEMA_VERSION,
} = require('./constants');
const {
  RETENTION_ENGINE_PROTOCOL_ID,
  classifyRetentionHeartbeat,
  compiledRetentionProtocol,
  protocolEvidenceMatches,
  readRetentionDeploymentHeartbeat,
} = require('./protocol');
const {
  classifyRetentionDeploymentAttestation,
  readRetentionDeploymentAttestation,
} = require('./deploymentAttestation');
const STATE_SCHEMA_VERSION = NOTIFICATION_RETENTION_SCHEMA_VERSION;
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
  value?.retentionEngineProtocolId,
  value?.engineSourceDigest,
  value?.engineRulesDigest,
  value?.engineTriggerDigest,
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
  value?.retentionEngineProtocolId,
  value?.engineSourceDigest,
  value?.engineRulesDigest,
  value?.engineTriggerDigest,
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
  const phaseEvidenceValid = ['legacy', 'paused'].includes(value?.phase)
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
      expectedEngineProtocolId: null,
      retentionEngineProtocolId: null,
      engineSourceDigest: null,
      engineRulesDigest: null,
      engineTriggerDigest: null,
      updatedAtMs: null,
      protocolValid: false,
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
    expectedEngineProtocolId: boundedText(
      value.expectedEngineProtocolId || value.retentionEngineProtocolId,
    ) || null,
    retentionEngineProtocolId: boundedText(
      value.retentionEngineProtocolId || value.expectedEngineProtocolId,
    ) || null,
    engineSourceDigest: boundedText(value.engineSourceDigest) || null,
    engineRulesDigest: boundedText(value.engineRulesDigest) || null,
    engineTriggerDigest: boundedText(value.engineTriggerDigest) || null,
    updatedAtMs: Number.isSafeInteger(value.updatedAtMs) ? value.updatedAtMs : null,
    protocolValid: protocolEvidenceMatches(value),
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
  if (next === 'paused') return true;
  if (next === 'legacy') return true;
  if (current === 'compactor' && next === 'shadow') return true;
  return (['legacy', 'paused'].includes(current) && next === 'shadow')
    || (current === 'shadow' && next === 'compactor');
};

const invalidRolloutTransitionInput = ({ expectedPhase, expectedRevision, nextPhase, nowMs }) => (
  !NOTIFICATION_RETENTION_ROLLOUT_PHASES.has(expectedPhase)
  || !NOTIFICATION_RETENTION_ROLLOUT_PHASES.has(nextPhase)
  || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
  || !Number.isSafeInteger(nowMs) || nowMs <= 0
);

const isForwardRolloutTransition = (expectedPhase, nextPhase) => (
  !['legacy', 'paused'].includes(nextPhase)
  && !(expectedPhase === 'compactor' && nextPhase === 'shadow')
  && nextPhase !== expectedPhase
);

const completedPreparationEvidence = (prepared) => Boolean(prepared?.status === 'complete'
  && prepared?.preparationComplete === true
  && protocolEvidenceMatches(prepared)
  && Number(prepared?.cumulative?.requiresAttention || prepared?.requiresAttention || 0) === 0);

const activationEvidenceAccepted = ({
  forward, preparationComplete, prepared, expectedPhase, nextPhase, digest,
  currentRollout, shadowEvidence, canaryEvidence, expectedRevision,
// eslint-disable-next-line complexity -- activation deliberately checks every independent proof field
}) => {
  const expectedPreparationRolloutRevision = expectedPhase === 'legacy'
    ? expectedRevision
    : currentRollout?.preparationRolloutRevision;
  if (forward && (!protocolEvidenceMatches(currentRollout)
    || !preparationComplete || !completedPreparationEvidence(prepared)
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
      && protocolEvidenceMatches(canaryEvidence)
      && canaryEvidence.phase === 'canary'
      && canaryEvidenceProvesCompletedJobs(canaryEvidence)
      && Number(canaryEvidence.rolloutRevision) === Number(expectedRevision)
      && canaryEvidence.evidenceDigest === digest
      && canaryEvidence.shadowEvidenceFingerprint === currentRollout.shadowEvidenceFingerprint
      && validEvidenceFingerprint(canaryEvidence.evidenceFingerprint)
      && canaryEvidence.evidenceFingerprint === buildCanaryEvidenceFingerprint(canaryEvidence);
  }
  return shadowEvidence?.schemaVersion === STATE_SCHEMA_VERSION
    && protocolEvidenceMatches(shadowEvidence)
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
  && protocolEvidenceMatches(current)
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
  && protocolEvidenceMatches(current)
  && protocolEvidenceMatches(rollout)
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
      preparationComplete: ['legacy', 'paused'].includes(nextPhase)
        ? false : Boolean(preparationComplete || current.preparationComplete),
      preparationRolloutRevision: ['legacy', 'paused'].includes(nextPhase)
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
      ...compiledRetentionProtocol(),
      expectedEngineProtocolId: RETENTION_ENGINE_PROTOCOL_ID,
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
  if (forward || (expectedPhase === 'compactor' && nextPhase === 'compactor')) {
    const heartbeat = await readRetentionDeploymentHeartbeat({ db });
    const heartbeatStatus = classifyRetentionHeartbeat({ heartbeat, nowMs });
    if (!heartbeatStatus.valid) return rejectedRolloutTransition(db, heartbeatStatus.reason);
    const attestation = await readRetentionDeploymentAttestation({ db });
    const attestationStatus = classifyRetentionDeploymentAttestation({
      attestation, heartbeat, nowMs,
    });
    if (!attestationStatus.valid) {
      return rejectedRolloutTransition(db, attestationStatus.reason);
    }
  }
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
    nextPhase: 'paused',
    preparationComplete: false,
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

const pauseNotificationRetentionRollout = async ({
  db, expectedPhase, expectedRevision, actor = 'automatic-protocol-pause', nowMs = Date.now(),
}) => transitionNotificationRetentionRollout({
  db,
  expectedPhase,
  expectedRevision,
  nextPhase: 'paused',
  actor,
  nowMs,
});

const activeRequeueState = (state) => require('./retentionScheduling').activeRequeueState(state);
const buildRetentionQueueKey = (...args) => require('./retentionScheduling').buildRetentionQueueKey(...args);
const ensureNotificationRetentionScheduled = (options) => require('./retentionScheduling')
  .ensureNotificationRetentionScheduled(options);

module.exports = {
  STATE_SCHEMA_VERSION,
  activeRequeueState,
  buildCanaryEvidenceFingerprint,
  buildRetentionQueueKey,
  buildShadowEvidenceFingerprint,
  canaryEvidenceProvesCompletedJobs,
  ensureNotificationRetentionScheduled,
  normalizeNotificationRetentionRollout,
  pauseNotificationRetentionRollout,
  readNotificationRetentionRollout,
  shadowEvidenceStillMatches,
  canaryEvidenceStillMatches,
  transitionNotificationRetentionRollout,
};
