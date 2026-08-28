'use strict';

/* eslint-disable complexity -- fail-closed policy normalization validates the complete saved record */

// @ts-check

const { randomUUID } = require('node:crypto');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');

const DRIVER_LOGIN_POLICY_PATH = 'driver_login_policy/v1';
const DRIVER_LOGIN_POLICY_LOCK_PATH = 'driver_login_policy_locks/v1';
const DRIVER_LOGIN_POLICY_SCHEMA_VERSION = 1;
const DRIVER_LOGIN_POLICY_LOCK_TTL_MS = 60 * 1000;
const DRIVER_LOGIN_CLAIM_RESERVATION_TTL_MS = 5 * 60 * 1000;
const DRIVER_LOGIN_ADMISSION_TTL_MS = 5 * 60 * 1000;
const DRIVER_POLICY_TRANSITION_PHASES = new Set(['stable', 'draining', 'cleanup']);

const defaultDriverLoginPolicy = () => ({
  schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
  enforceSingleDevice: false,
  generation: 0,
  revision: 0,
  updatedAtMs: null,
});

/** @param {any} value */
const readDriverPolicyTransition = (value) => ({
  phase: DRIVER_POLICY_TRANSITION_PHASES.has(value?.transitionPhase)
    ? value.transitionPhase
    : 'stable',
  transitionId: typeof value?.transitionId === 'string' ? value.transitionId : null,
  targetEnforceSingleDevice: typeof value?.targetEnforceSingleDevice === 'boolean'
    ? value.targetEnforceSingleDevice
    : null,
  sessionCursor: typeof value?.transitionSessionCursor === 'string'
    ? value.transitionSessionCursor
    : null,
  driverCursor: typeof value?.transitionDriverCursor === 'string'
    ? value.transitionDriverCursor
    : null,
  sessionsScanned: Number.isSafeInteger(value?.transitionSessionsScanned)
    ? value.transitionSessionsScanned
    : 0,
  sessionsQueued: Number.isSafeInteger(value?.transitionSessionsQueued)
    ? value.transitionSessionsQueued
    : 0,
  driversScanned: Number.isSafeInteger(value?.transitionDriversScanned)
    ? value.transitionDriversScanned
    : 0,
});

/** @param {unknown} value */
const normalizeDriverLoginPolicy = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, isDefault: true, policy: defaultDriverLoginPolicy() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, isDefault: false, policy: null };
  }
  const record = /** @type {Record<string, any>} */ (value);
  const transitionPhase = record.transitionPhase === undefined ? 'stable' : record.transitionPhase;
  const transitionShapeValid = DRIVER_POLICY_TRANSITION_PHASES.has(transitionPhase)
    && (transitionPhase === 'stable' || (
      typeof record.transitionId === 'string' && record.transitionId.length > 0
      && record.targetEnforceSingleDevice === true
      && (transitionPhase !== 'cleanup' || ['sessions', 'drivers'].includes(record.transitionStage))
    ));
  const valid = record.schemaVersion === DRIVER_LOGIN_POLICY_SCHEMA_VERSION
    && typeof record.enforceSingleDevice === 'boolean'
    && Number.isSafeInteger(record.generation) && record.generation >= 0
    && Number.isSafeInteger(record.revision) && record.revision >= 1
    && Number.isSafeInteger(record.updatedAtMs) && record.updatedAtMs > 0
    && transitionShapeValid;
  return { valid, isDefault: false, policy: valid ? {
    schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
    enforceSingleDevice: record.enforceSingleDevice,
    generation: record.generation,
    revision: record.revision,
    updatedAtMs: record.updatedAtMs,
  } : null };
};

/** @param {{ db: any }} input */
const readDriverLoginPolicy = async ({ db }) => {
  const snapshot = await db.ref(DRIVER_LOGIN_POLICY_PATH).once('value');
  const raw = snapshot.val();
  const normalized = normalizeDriverLoginPolicy(raw);
  if (!normalized.valid) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Driver login policy is malformed'));
    error.code = 'POLICY_CONFIGURATION_INVALID';
    throw error;
  }
  return { ...normalized, transition: readDriverPolicyTransition(raw) };
};

/** @param {{ db: any, nowMs?: number }} input */
const ensureDriverLoginPolicy = async ({ db, nowMs = Date.now() }) => {
  const ref = db.ref(DRIVER_LOGIN_POLICY_PATH);
  const result = await ref.transaction((current) => current ?? {
    schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
    enforceSingleDevice: false,
    generation: 0,
    revision: 1,
    updatedAtMs: nowMs,
    transitionPhase: 'stable',
  }, undefined, false);
  const raw = result.snapshot.val();
  const normalized = normalizeDriverLoginPolicy(raw);
  if (!normalized.valid) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Driver login policy is malformed'));
    error.code = 'POLICY_CONFIGURATION_INVALID';
    throw error;
  }
  return { ...normalized, transition: readDriverPolicyTransition(raw) };
};

/** @param {string} value */
const hashPolicyIdentifier = (value) => require('node:crypto')
  .createHash('sha256')
  .update(String(value || ''))
  .digest('hex')
  .slice(0, 24);

/** @type {(...args: any[]) => Promise<any>} */
const acquireDriverLoginAdmission = async ({
  db,
  authUid,
  driverId,
  admissionId = `login_${randomUUID()}`,
  nowMs = Date.now(),
  durable = false,
}) => {
  let rejectionReason = null;
  let admittedPolicy = null;
  const result = await db.ref(DRIVER_LOGIN_POLICY_PATH).transaction((currentValue) => {
    const normalized = normalizeDriverLoginPolicy(currentValue);
    if (!normalized.valid) {
      rejectionReason = 'POLICY_CONFIGURATION_INVALID';
      return undefined;
    }
    const transition = readDriverPolicyTransition(currentValue);
    if (transition.phase !== 'stable') {
      rejectionReason = 'DRIVER_POLICY_CHANGE_IN_PROGRESS';
      return undefined;
    }
    admittedPolicy = normalized.policy;
    return {
      ...currentValue,
      transitionPhase: 'stable',
      loginAdmissions: {
        ...(currentValue?.loginAdmissions || {}),
        [admissionId]: {
          schemaVersion: 1,
          authUidHash: hashPolicyIdentifier(authUid),
          driverIdHash: hashPolicyIdentifier(driverId),
          generation: normalized.policy.generation,
          policyRevision: normalized.policy.revision,
          createdAtMs: nowMs,
          admissionType: durable ? 'assignment_transition' : 'driver_login',
          durableUntilExplicitRelease: durable === true,
          ...(durable ? {} : { expiresAtMs: nowMs + DRIVER_LOGIN_ADMISSION_TTL_MS }),
        },
      },
    };
  }, undefined, false);
  if (!result?.committed || !admittedPolicy) {
    return { acquired: false, reason: rejectionReason || 'DRIVER_POLICY_CHANGE_IN_PROGRESS' };
  }
  return { acquired: true, admissionId, policy: admittedPolicy };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseDriverLoginAdmission = async ({ db, admissionId }) => {
  if (!admissionId) return false;
  const result = await db.ref(`${DRIVER_LOGIN_POLICY_PATH}/loginAdmissions/${admissionId}`)
    .transaction((current) => current ? null : undefined, undefined, false);
  return Boolean(result?.committed);
};

/** @type {(...args: any[]) => any} */
const buildDriverLoginAdmissionCompletionUpdates = ({ admissionId }) => ({
  [`${DRIVER_LOGIN_POLICY_PATH}/loginAdmissions/${admissionId}`]: null,
});

/**
 * Removes the admission only while its admitted generation is still the live
 * generation. A draining transition may already exist: this transaction then
 * linearizes the admitted login before the drain barrier can advance.
 *
 * @type {(...args: any[]) => Promise<boolean>}
 */
const completeDriverLoginAdmission = async ({ db, admissionId, policy }) => {
  let completed = false;
  const result = await db.ref(DRIVER_LOGIN_POLICY_PATH).transaction((currentValue) => {
    const normalized = normalizeDriverLoginPolicy(currentValue);
    const transition = readDriverPolicyTransition(currentValue);
    const currentAdmission = currentValue?.loginAdmissions?.[admissionId];
    if (!normalized.valid || !currentAdmission
      || normalized.policy.generation !== policy?.generation
      || currentAdmission.generation !== policy?.generation
      || currentAdmission.policyRevision !== policy?.revision
      || !['stable', 'draining'].includes(transition.phase)) return undefined;
    const loginAdmissions = { ...(currentValue.loginAdmissions || {}) };
    delete loginAdmissions[admissionId];
    completed = true;
    return {
      ...currentValue,
      loginAdmissions: Object.keys(loginAdmissions).length ? loginAdmissions : null,
    };
  }, undefined, false);
  return Boolean(result?.committed && completed);
};

/** @type {(...args: any[]) => Promise<any>} */
const beginDriverPolicyTransition = async ({
  db,
  enforceSingleDevice,
  expectedRevision,
  actorHash,
  transitionId = `policy_${randomUUID()}`,
  nowMs = Date.now(),
}) => {
  let outcome = null;
  const result = await db.ref(DRIVER_LOGIN_POLICY_PATH).transaction((currentValue) => {
    const normalized = normalizeDriverLoginPolicy(currentValue);
    if (!normalized.valid) {
      outcome = { reason: 'POLICY_CONFIGURATION_INVALID' };
      return undefined;
    }
    const materializedValue = normalized.isDefault ? {
      schemaVersion: DRIVER_LOGIN_POLICY_SCHEMA_VERSION,
      enforceSingleDevice: false,
      generation: 0,
      revision: 1,
      updatedAtMs: nowMs,
      transitionPhase: 'stable',
    } : currentValue;
    const effectivePolicy = normalized.isDefault
      ? normalizeDriverLoginPolicy(materializedValue).policy
      : normalized.policy;
    const transition = readDriverPolicyTransition(materializedValue);
    if (transition.phase !== 'stable') {
      outcome = { reason: 'DRIVER_POLICY_CHANGE_IN_PROGRESS', transition };
      return undefined;
    }
    if (Object.values(materializedValue?.loginAdmissions || {})
      .some((admission) => admission?.durableUntilExplicitRelease === true)) {
      outcome = { reason: 'DRIVER_POLICY_CHANGE_IN_PROGRESS' };
      return undefined;
    }
    if (normalized.policy.revision !== expectedRevision) {
      outcome = { reason: 'POLICY_CHANGED' };
      return undefined;
    }
    if (normalized.policy.enforceSingleDevice === enforceSingleDevice) {
      outcome = { completed: true, changed: false, policy: effectivePolicy };
      return materializedValue;
    }
    const nextRevision = normalized.policy.revision + 1;
    if (!enforceSingleDevice) {
      const next = {
        ...materializedValue,
        enforceSingleDevice: false,
        revision: nextRevision,
        updatedAtMs: nowMs,
        updatedByHash: actorHash,
        transitionPhase: 'stable',
      };
      outcome = {
        completed: true,
        changed: true,
        policy: normalizeDriverLoginPolicy(next).policy,
      };
      return next;
    }
    const next = {
      ...materializedValue,
      revision: nextRevision,
      updatedAtMs: nowMs,
      updatedByHash: actorHash,
      transitionPhase: 'draining',
      transitionId,
      targetEnforceSingleDevice: true,
      transitionStartedAtMs: nowMs,
      transitionSessionCursor: null,
      transitionDriverCursor: null,
      transitionSessionsScanned: 0,
      transitionSessionsQueued: 0,
      transitionDriversScanned: 0,
    };
    outcome = { started: true, changed: true, transitionId, policy: normalizeDriverLoginPolicy(next).policy };
    return next;
  }, undefined, false);
  if (!result?.committed) return { started: false, ...(outcome || { reason: 'DRIVER_POLICY_CHANGE_IN_PROGRESS' }) };
  return outcome;
};

/** @type {(...args: any[]) => Promise<boolean>} */
const renewDriverLoginAdmission = async ({ db, admissionId, nowMs = Date.now() }) => {
  if (!admissionId) return false;
  const result = await db.ref(`${DRIVER_LOGIN_POLICY_PATH}/loginAdmissions/${admissionId}`)
    .transaction((current) => current ? {
      ...current,
      lastRenewedAtMs: nowMs,
      ...(current.durableUntilExplicitRelease === true
        ? { expiresAtMs: null }
        : { expiresAtMs: nowMs + DRIVER_LOGIN_ADMISSION_TTL_MS }),
    } : undefined, undefined, false);
  return Boolean(result?.committed);
};

/** @type {(...args: any[]) => Promise<any>} */
const reserveDriverLoginClaim = async ({
  db,
  driverId,
  admissionId,
  nowMs = Date.now(),
}) => {
  const path = `driver_login_claim_reservations/${driverId}`;
  const result = await db.ref(path).transaction((current) => {
    if (current && current.admissionId !== admissionId && Number(current.expiresAtMs) > nowMs) return undefined;
    return {
      schemaVersion: 1,
      admissionId,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + DRIVER_LOGIN_CLAIM_RESERVATION_TTL_MS,
    };
  }, undefined, false);
  return {
    acquired: Boolean(result?.committed && result.snapshot?.val?.()?.admissionId === admissionId),
    path,
  };
};

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseDriverLoginClaim = async ({ db, driverId, admissionId }) => {
  const result = await db.ref(`driver_login_claim_reservations/${driverId}`).transaction((current) => (
    current?.admissionId === admissionId ? null : undefined
  ), undefined, false);
  return Boolean(result?.committed);
};

/** @param {any} session @param {any} policy */
const driverSessionMatchesPolicyGeneration = (session, policy) => {
  const sessionGeneration = Number.isSafeInteger(session?.driverLoginPolicyGeneration)
    ? session.driverLoginPolicyGeneration
    : 0;
  return sessionGeneration === policy.generation;
};

/** @param {{ policy: any, authUid: string, claimedAuthUid?: unknown }} input */
const driverBindingAllowedByPolicy = ({ policy, authUid, claimedAuthUid }) => (
  policy.enforceSingleDevice !== true || String(claimedAuthUid || '').trim() === authUid
);

/** @param {{ db: any, owner?: string, nowMs?: number }} input */
const acquireDriverLoginPolicyLock = async ({ db, owner = randomUUID(), nowMs = Date.now() }) => ({
  acquired: await acquireManualBookingLock({
    db,
    path: DRIVER_LOGIN_POLICY_LOCK_PATH,
    owner,
    nowMs,
    ttlMs: DRIVER_LOGIN_POLICY_LOCK_TTL_MS,
  }),
  owner,
});

/** @param {{ db: any, owner: string }} input */
const releaseDriverLoginPolicyLock = ({ db, owner }) => releaseManualBookingLock({
  db, path: DRIVER_LOGIN_POLICY_LOCK_PATH, owner,
});

module.exports = {
  DRIVER_LOGIN_POLICY_LOCK_PATH,
  DRIVER_LOGIN_POLICY_PATH,
  acquireDriverLoginAdmission,
  acquireDriverLoginPolicyLock,
  beginDriverPolicyTransition,
  buildDriverLoginAdmissionCompletionUpdates,
  completeDriverLoginAdmission,
  defaultDriverLoginPolicy,
  driverBindingAllowedByPolicy,
  driverSessionMatchesPolicyGeneration,
  ensureDriverLoginPolicy,
  normalizeDriverLoginPolicy,
  readDriverLoginPolicy,
  readDriverPolicyTransition,
  renewDriverLoginAdmission,
  releaseDriverLoginAdmission,
  releaseDriverLoginClaim,
  releaseDriverLoginPolicyLock,
  reserveDriverLoginClaim,
};
