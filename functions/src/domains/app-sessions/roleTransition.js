'use strict';

/* eslint-disable complexity -- reconciliation keeps every exact-session and claim fence explicit */

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const {
  releaseDriverLoginClaim,
  reserveDriverLoginClaim,
} = require('../driver-auth/public');

const { isValidAppSessionId } = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = loadLegacyLibrary('appSessionLock');
const {
  boundedWarningCode,
  terminalizeOperationJob,
} = loadLegacyLibrary('operationsTerminalWarnings');

const PRINCIPAL_TYPES = new Set(['passenger', 'driver']);
const ROLE_TRANSITION_CLAIM_ROOT = 'app_session_role_claim_jobs/v1';
const ROLE_TRANSITION_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLE_TRANSITION_LOCK_TTL_MS = 180 * 1000;

/**
 * Builds the profile cleanup that must be committed in the same root update as
 * the replacement app session. Durable passenger identity and canonical driver
 * assignment records deliberately sit outside this helper.
 *
 * @param {{ authUid: string, targetPrincipalType: 'passenger' | 'driver' }} input
 * @returns {Record<string, null>}
 */
const buildRoleTransitionCleanupUpdates = ({ authUid, targetPrincipalType }) => {
  if (!isValidFirebaseKey(authUid) || !PRINCIPAL_TYPES.has(targetPrincipalType)) {
    throw new Error('Invalid app-session role transition');
  }
  if (targetPrincipalType !== 'passenger') return {};
  return {
    [`users/${authUid}/driverId`]: null,
    [`users/${authUid}/driverPrincipalId`]: null,
    [`users/${authUid}/driverAssignedTourId`]: null,
  };
};

const buildPassengerRoleClaimJob = ({
  authUid,
  session,
  replacedSession = null,
  privatePhotoOwnerKey,
  nowMs = Date.now(),
}) => {
  if (!isValidFirebaseKey(authUid)
    || session?.authUid !== authUid
    || session?.principalType !== 'passenger'
    || typeof session?.sessionId !== 'string'
    || !session.sessionId
    || typeof privatePhotoOwnerKey !== 'string'
    || !privatePhotoOwnerKey) {
    throw new Error('Invalid passenger role-claim transition');
  }
  const formerDriver = replacedSession?.principalType === 'driver'
    && replacedSession?.authUid === authUid
    && isValidFirebaseKey(replacedSession?.driverId)
    && isValidAppSessionId(replacedSession?.sessionId)
    ? {
      formerDriverId: replacedSession.driverId,
      replacedAppSessionId: replacedSession.sessionId,
    }
    : {};
  return {
    schemaVersion: 2,
    authUid,
    appSessionId: session.sessionId,
    privatePhotoOwnerKey,
    ...formerDriver,
    attemptCount: 0,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ROLE_TRANSITION_CLAIM_TTL_MS,
  };
};

const snapshotValue = (snapshot) => (typeof snapshot?.val === 'function' ? snapshot.val() : null);

const isCurrentPassengerRoleClaim = ({ job, session, authUid }) => Boolean(
  job?.authUid === authUid
  && session?.authUid === authUid
  && session?.principalType === 'passenger'
  && session?.sessionId === job?.appSessionId,
);

const roleClaimIdentity = (job) => ({
  appSessionId: job?.appSessionId,
  expiresAtMs: job?.expiresAtMs,
});

/** @type {(...args: any[]) => Promise<boolean>} */
const recordPassengerRoleClaimFailure = async ({
  db, authUid, appSessionId, nowMs, reason,
}) => {
  const result = await db.ref(`${ROLE_TRANSITION_CLAIM_ROOT}/${authUid}`).transaction((current) => {
    if (!current || current.appSessionId !== appSessionId || current.terminalWarningId) return undefined;
    const attemptCount = Number.isSafeInteger(current.attemptCount) ? current.attemptCount + 1 : 1;
    return {
      ...current,
      attemptCount,
      firstAttemptAtMs: Number.isSafeInteger(current.firstAttemptAtMs) ? current.firstAttemptAtMs : nowMs,
      lastAttemptAtMs: nowMs,
      lastFailureReason: boundedWarningCode(reason, 'claim_retry'),
    };
  }, undefined, false);
  return result?.committed === true;
};

/** @type {(...args: any[]) => Promise<any>} */
const terminalizeExpiredPassengerRoleClaim = ({ db, authUid, job, nowMs }) => terminalizeOperationJob({
  db,
  sourcePath: `${ROLE_TRANSITION_CLAIM_ROOT}/${authUid}`,
  observedJob: job,
  sourceIdentity: roleClaimIdentity(job),
  jobType: 'passenger_role_claim',
  reason: 'retention_expired',
  identifiers: {
    authUid,
    appSessionId: job.appSessionId,
    ...(job.formerDriverId ? { driverId: job.formerDriverId } : {}),
    ...(job.replacedAppSessionId ? { replacedAppSessionId: job.replacedAppSessionId } : {}),
  },
  nowMs,
});

/** @type {(...args: any[]) => Promise<boolean>} */
const releaseFormerDriverScalarClaim = async ({ db, job, authUid }) => {
  if (!isValidFirebaseKey(job?.formerDriverId)
    || !isValidAppSessionId(job?.replacedAppSessionId)) return false;
  const result = await db.ref(`drivers/${job.formerDriverId}/authUid`).transaction((current) => (
    current === authUid ? null : undefined
  ), undefined, false);
  return result?.committed === true;
};

const reconcilePassengerRoleClaimJob = async ({
  db,
  auth,
  authUid,
  buildClaims,
  nowMs = Date.now(),
}) => {
  if (!db?.ref || !auth?.getUser || !auth?.setCustomUserClaims
    || !isValidFirebaseKey(authUid) || typeof buildClaims !== 'function') {
    throw new Error('Invalid passenger role-claim reconciliation request');
  }
  const jobRef = db.ref(`${ROLE_TRANSITION_CLAIM_ROOT}/${authUid}`);
  const observedJob = snapshotValue(await jobRef.once('value'));
  if (!observedJob) return { status: 'missing', completed: false };
  if (!Number.isFinite(observedJob.expiresAtMs) || observedJob.expiresAtMs <= nowMs) {
    const terminal = await terminalizeExpiredPassengerRoleClaim({
      db, authUid, job: observedJob, nowMs,
    });
    return {
      status: terminal.terminalized ? 'expired' : 'replaced',
      completed: false,
      terminalWarning: terminal.terminalized === true,
    };
  }

  const claimOwner = `role_claim:${observedJob.appSessionId}`;
  let claimReservation = null;
  let sessionLock = null;
  try {
    if (isValidFirebaseKey(observedJob.formerDriverId)
      && isValidAppSessionId(observedJob.replacedAppSessionId)) {
      claimReservation = await reserveDriverLoginClaim({
        db,
        driverId: observedJob.formerDriverId,
        admissionId: claimOwner,
        nowMs,
      });
      if (!claimReservation.acquired) {
        await recordPassengerRoleClaimFailure({
          db, authUid, appSessionId: observedJob.appSessionId, nowMs, reason: 'claim_coordination_busy',
        });
        return { status: 'retry', completed: false, errorCode: 'CLAIM_COORDINATION_BUSY' };
      }
    }
    sessionLock = await acquireAppSessionLock({
      db,
      authUid,
      operation: 'role_claim_cleanup',
      owner: claimOwner,
      nowMs,
      ttlMs: ROLE_TRANSITION_LOCK_TTL_MS,
    });
    if (!sessionLock.acquired) {
      await recordPassengerRoleClaimFailure({
        db, authUid, appSessionId: observedJob.appSessionId, nowMs, reason: 'app_session_busy',
      });
      return { status: 'retry', completed: false, errorCode: 'APP_SESSION_BUSY' };
    }

    const [currentJobSnapshot, sessionSnapshot] = await Promise.all([
      jobRef.once('value'),
      db.ref(`app_sessions/${authUid}`).once('value'),
    ]);
    const job = snapshotValue(currentJobSnapshot);
    const session = snapshotValue(sessionSnapshot);
    if (!job || job.appSessionId !== observedJob.appSessionId) {
      return { status: 'replaced', completed: false };
    }
    if (!Number.isFinite(job.expiresAtMs) || job.expiresAtMs <= nowMs) {
      const terminal = await terminalizeExpiredPassengerRoleClaim({ db, authUid, job, nowMs });
      return {
        status: terminal.terminalized ? 'expired' : 'replaced',
        completed: false,
        terminalWarning: terminal.terminalized === true,
      };
    }
    if (!isCurrentPassengerRoleClaim({ job, session, authUid })) {
      await jobRef.transaction((current) => (
        current?.appSessionId === job.appSessionId ? null : undefined
      ), undefined, false);
      return { status: 'stale', completed: false };
    }
    const driverClaimReleased = await releaseFormerDriverScalarClaim({ db, job, authUid });
    const authUser = await auth.getUser(authUid);
    await auth.setCustomUserClaims(
      authUid,
      buildClaims(authUser.customClaims || {}, job.privatePhotoOwnerKey),
    );
    const completion = await jobRef.transaction((current) => (
      current?.appSessionId === job.appSessionId ? null : undefined
    ), undefined, false);
    return {
      status: 'completed',
      completed: completion?.committed === true,
      ...(job.formerDriverId ? { driverClaimReleased } : {}),
    };
  } catch (error) {
    await recordPassengerRoleClaimFailure({
      db,
      authUid,
      appSessionId: observedJob.appSessionId,
      nowMs,
      reason: error?.code || 'claim_retry',
    });
    throw error;
  } finally {
    if (sessionLock?.acquired) {
      await releaseAppSessionLock({ db, authUid, owner: sessionLock.owner });
    }
    if (claimReservation?.acquired) {
      await releaseDriverLoginClaim({
        db, driverId: observedJob.formerDriverId, admissionId: claimOwner,
      });
    }
  }
};

const processPassengerRoleClaimJobs = async ({
  db,
  auth,
  buildClaims,
  limit = 50,
  nowMs = Date.now(),
} = {}) => {
  const snapshot = await db.ref(ROLE_TRANSITION_CLAIM_ROOT)
    .orderByChild('createdAtMs')
    .limitToFirst(limit)
    .once('value');
  const entries = Object.keys(snapshotValue(snapshot) || {}).sort();
  const results = [];
  for (const authUid of entries) {
    try {
      results.push(await reconcilePassengerRoleClaimJob({
        db, auth, authUid, buildClaims, nowMs,
      }));
    } catch (error) {
      results.push({ status: 'retry', completed: false, errorCode: error?.code || 'CLAIM_RETRY' });
    }
  }
  return {
    scanned: entries.length,
    completed: results.filter((result) => result.completed).length,
    retryable: results.filter((result) => result.status === 'retry').length,
    stale: results.filter((result) => result.status === 'stale').length,
    expired: results.filter((result) => result.status === 'expired').length,
    terminalWarnings: results.filter((result) => result.terminalWarning === true).length,
  };
};

module.exports = {
  ROLE_TRANSITION_CLAIM_ROOT,
  buildPassengerRoleClaimJob,
  buildRoleTransitionCleanupUpdates,
  recordPassengerRoleClaimFailure,
  processPassengerRoleClaimJobs,
  reconcilePassengerRoleClaimJob,
};
