'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../../infrastructure/database/operationLock');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { readDriverLoginPolicy } = require('../driver-auth/public');
const {
  DRIVER_TRACKING_SESSIONS_ROOT, isValidTrackingIntent, sameTrackingIdentity,
  sourceMatchesIntent, trackingSourceKey,
} = require('./driverTrackingSessions');

const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { reconcileDriverLocationProjection } = loadLegacyLibrary('driverLocationProjection');
const { MAX_SESSION_TTL_MS } = loadLegacyLibrary('appSession');

/** @param {any} ref */
const readValue = async (ref) => (await (typeof ref.get === 'function' ? ref.get() : ref.once('value'))).val();
/** @param {number} status @param {string} reason */
const denied = (status, reason) => ({ status, payload: { success: false, reason } });
/** @param {any} value */
const isValidStopTime = (value) => Number.isSafeInteger(value) && value > 0;
/** @param {any} body */
const parseTrackingStopInput = (body) => {
  if (!body || body.status !== 'stopped' || !isValidTrackingIntent(body, trackingSourceKey(body))) return null;
  return { ...body };
};

/** Creation can retire an old start, but must not relax current driver authority.
 * Missing policy is deliberately rejected before the compatibility session helper.
 * @param {any} options
 */
async function verifyTrackingRetirementCreationAuthority({ db, authUid, input, nowMs }) {
  try {
    const policyContext = await readDriverLoginPolicy({ db });
    if (!isMaterializedStablePolicy(policyContext)) return { allowed: false, reason: 'POLICY_CONFIGURATION_INVALID' };
    const access = await verifyActiveAppSession({ db, authUid, expectedRole: 'driver',
      expectedSessionId: input.appSessionId, expectedTourId: input.tourId, nowMs });
    if (!access.allowed) return access;
    const [driver, transition, latestPolicy] = await Promise.all([
      readValue(db.ref(`drivers/${input.driverId}`)),
      readValue(db.ref(`driver_assignment_active/v1/${input.driverId}/transitionId`)),
      readDriverLoginPolicy({ db }),
    ]);
    if (!isMaterializedStablePolicy(latestPolicy)) return { allowed: false, reason: 'POLICY_CONFIGURATION_INVALID' };
    if (!driver || transition !== null || access.driverId !== input.driverId
      || access.session.expiresAtMs !== input.expiresAtMs
      || access.session.driverLoginPolicyGeneration !== latestPolicy.policy.generation
      || !matchesDriverClaim(driver, latestPolicy.policy, authUid)) {
      return { allowed: false, reason: 'TRACKING_IDENTITY_MISMATCH' };
    }
    return { allowed: true };
  } catch (error) {
    if (error?.code === 'POLICY_CONFIGURATION_INVALID') return { allowed: false, reason: error.code };
    throw error;
  }
}

/** @param {any} context */
const isMaterializedStablePolicy = (context) => !context.isDefault && context.transition?.phase === 'stable';
/** @param {any} driver @param {any} policy @param {string} authUid */
const matchesDriverClaim = (driver, policy, authUid) => policy.enforceSingleDevice === false || driver.authUid === authUid;

/** @param {any} session @param {any} input @param {number} nowMs */
const isRetiredSession = (session, input, nowMs) => !session
  || session.sessionId !== input.appSessionId || session.status !== 'active'
  || (Number.isSafeInteger(session.expiresAtMs) && session.expiresAtMs <= nowMs);

/** @param {any} options */
async function readStopEvidence({ db, intentRef, sourceRef, input, authUid, sourceKey, nowMs }) {
  const [existingIntent, existingSource, session] = await Promise.all([
    readValue(intentRef), readValue(sourceRef), readValue(db.ref(`app_sessions/${authUid}`)),
  ]);
  if (existingIntent && existingIntent.authUid !== authUid) return { error: denied(403, 'NOT_AUTHORIZED') };
  if (existingIntent && (!isValidTrackingIntent(existingIntent, sourceKey) || !sameTrackingIdentity(existingIntent, input))) {
    return { error: denied(409, 'TRACKING_IDENTITY_MISMATCH') };
  }
  if (existingSource && existingSource.authUid !== authUid) return { error: denied(403, 'NOT_AUTHORIZED') };
  if (existingSource && !sourceMatchesIntent(existingSource, input)) return { error: denied(409, 'TRACKING_IDENTITY_MISMATCH') };
  if (!existingIntent && input.expiresAtMs > nowMs + MAX_SESSION_TTL_MS) return { error: denied(400, 'INVALID_INPUT') };
  return { existingIntent, existingSource, session };
}

/** @param {any} options */
async function admitStopFence({ db, input, authUid, evidence, nowMs, owner, assignmentLocks }) {
  if (evidence.existingIntent || evidence.existingSource) return { createMissingFence: true };
  if (isRetiredSession(evidence.session, input, nowMs)) return { createMissingFence: false };
  for (const lockPath of [`driver_assignment_locks/drivers/${input.driverId}`, `driver_assignment_locks/tours/${input.tourId}`].sort()) {
    if (!await acquireManualBookingLock({ db, path: lockPath, owner, nowMs, ttlMs: 60_000 })) {
      return { error: denied(409, 'ASSIGNMENT_IN_PROGRESS') };
    }
    assignmentLocks.push(lockPath);
  }
  const access = await verifyTrackingRetirementCreationAuthority({ db, authUid, input, nowMs });
  if (!access.allowed) return { error: denied(access.reason === 'POLICY_CONFIGURATION_INVALID' ? 503 : 409,
    access.reason === 'POLICY_CONFIGURATION_INVALID' ? access.reason : 'TRACKING_IDENTITY_MISMATCH') };
  return { createMissingFence: true };
}

/** @param {any} options */
async function stopExactIntent({ intentRef, input, authUid, sourceKey, createMissingFence }) {
  let conflictReason = 'TRACKING_CHANGED';
  const stopped = await intentRef.transaction((/** @type {any} */ current) => {
    // A cold transaction cache is not proof that the server record is absent.
    // Null is an acknowledged no-op only when creation is not authorized.
    if (current === null) return createMissingFence ? input : null;
    if (current.authUid !== authUid) { conflictReason = 'NOT_AUTHORIZED'; return undefined; }
    if (!isValidTrackingIntent(current, sourceKey) || !sameTrackingIdentity(current, input)) {
      conflictReason = 'TRACKING_IDENTITY_MISMATCH'; return undefined;
    }
    return { ...current, status: 'stopped' };
  }, undefined, false);
  if (!stopped?.committed) return { error: denied(conflictReason === 'NOT_AUTHORIZED' ? 403 : 409, conflictReason) };
  const fence = stopped.snapshot.val();
  if (fence && (!sameTrackingIdentity(fence, input) || fence.status !== 'stopped')) return { error: denied(409, 'TRACKING_CHANGED') };
  return { fence };
}

/** @param {any} options */
async function removeExactStoppedSource({ sourceRef, input }) {
  let sourceRemoved = false;
  const removed = await sourceRef.transaction((/** @type {any} */ current) => {
    if (current === null) { sourceRemoved = false; return null; }
    if (!sourceMatchesIntent(current, input)) return undefined;
    sourceRemoved = true;
    return null;
  }, undefined, false);
  if (!removed?.committed || removed.snapshot.val() !== null) return { error: denied(409, 'TRACKING_CHANGED') };
  return { sourceRemoved };
}

/**
 * This is exclusively a capability-reducing operation. Existing exact intent or
 * source ownership proves an old publication without requiring an active role.
 * Missing state under an active session needs the same strict creation authority.
 * Session and assignment locks protect that missing-state admission decision.
 * @param {any} options
 */
async function performDriverTrackingStop({ db, authUid, input: rawInput,
  nowMs = Date.now(), reconcileProjection = reconcileDriverLocationProjection }) {
  const input = parseTrackingStopInput(rawInput);
  if (!input || !isValidStopTime(nowMs)) return denied(400, 'INVALID_INPUT');
  if (!isValidFirebaseKey(authUid) || input.authUid !== authUid) return denied(403, 'NOT_AUTHORIZED');
  const sourceKey = trackingSourceKey(input);
  const intentRef = db.ref(`${DRIVER_TRACKING_SESSIONS_ROOT}/${sourceKey}`);
  const sourceRef = db.ref(`driver_location_sessions/${sourceKey}`);
  const sessionLock = await acquireAppSessionLock({ db, authUid, operation: 'driver_tracking_stop', nowMs });
  if (!sessionLock.acquired) return denied(409, 'SESSION_IN_PROGRESS');
  const owner = randomUUID();
  const assignmentLocks = [];
  try {
    const evidence = await readStopEvidence({ db, intentRef, sourceRef, input, authUid, sourceKey, nowMs });
    if (evidence.error) return evidence.error;
    const admission = await admitStopFence({ db, input, authUid, evidence, nowMs, owner, assignmentLocks });
    if (admission.error) return admission.error;
    const stopped = await stopExactIntent({ intentRef, input, authUid, sourceKey, createMissingFence: admission.createMissingFence });
    if (stopped.error) return stopped.error;
    const removed = await removeExactStoppedSource({ sourceRef, input });
    if (removed.error) return removed.error;
    // Without any owned server evidence, a retired caller cannot select a tour
    // to reproject: that would permit clearing another driver's legacy point.
    if (stopped.fence || removed.sourceRemoved || admission.createMissingFence) {
      await reconcileProjection({ database: db, tourId: input.tourId, nowMs });
    }
    return { status: 200, payload: { success: true, withdrawalAcknowledged: true,
      reason: stopped.fence ? 'STOPPED' : 'ALREADY_RETIRED', sourceRemoved: removed.sourceRemoved,
      fencePersisted: Boolean(stopped.fence), stoppedAtMs: nowMs } };
  } catch {
    return denied(500, 'INTERNAL_ERROR');
  } finally {
    await Promise.all(assignmentLocks.map((lockPath) => releaseManualBookingLock({ db, path: lockPath, owner })));
    await releaseAppSessionLock({ db, authUid, owner: sessionLock.owner });
  }
}

module.exports = { parseTrackingStopInput, performDriverTrackingStop, verifyTrackingRetirementCreationAuthority };
