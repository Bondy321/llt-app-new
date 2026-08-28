'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');

const PRINCIPAL_TYPES = new Set(['passenger', 'driver']);
const ROLE_TRANSITION_CLAIM_ROOT = 'app_session_role_claim_jobs/v1';
const ROLE_TRANSITION_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  return {
    schemaVersion: 1,
    authUid,
    appSessionId: session.sessionId,
    privatePhotoOwnerKey,
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
  const [jobSnapshot, sessionSnapshot] = await Promise.all([
    jobRef.once('value'),
    db.ref(`app_sessions/${authUid}`).once('value'),
  ]);
  const job = snapshotValue(jobSnapshot);
  const session = snapshotValue(sessionSnapshot);
  if (!job) return { status: 'missing', completed: false };
  if (!Number.isFinite(job.expiresAtMs) || job.expiresAtMs <= nowMs) {
    await jobRef.transaction((current) => (
      current?.appSessionId === job.appSessionId ? null : undefined
    ), undefined, false);
    return { status: 'expired', completed: false };
  }
  if (!isCurrentPassengerRoleClaim({ job, session, authUid })) {
    await jobRef.transaction((current) => (
      current?.appSessionId === job.appSessionId ? null : undefined
    ), undefined, false);
    return { status: 'stale', completed: false };
  }
  const authUser = await auth.getUser(authUid);
  await auth.setCustomUserClaims(
    authUid,
    buildClaims(authUser.customClaims || {}, job.privatePhotoOwnerKey),
  );
  const completion = await jobRef.transaction((current) => (
    current?.appSessionId === job.appSessionId ? null : undefined
  ), undefined, false);
  return { status: 'completed', completed: completion?.committed === true };
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
  };
};

module.exports = {
  ROLE_TRANSITION_CLAIM_ROOT,
  buildPassengerRoleClaimJob,
  buildRoleTransitionCleanupUpdates,
  processPassengerRoleClaimJobs,
  reconcilePassengerRoleClaimJob,
};
