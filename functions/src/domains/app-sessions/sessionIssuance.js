'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  acquirePassengerAccountDeletionLock,
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
  releasePassengerAccountDeletionLock,
  renewPassengerAccountDeletionLock,
} = require('../account-deletion/public');
const {
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
} = loadLegacyLibrary('appSession');
const { acquireAppSessionLock, releaseAppSessionLock, renewAppSessionLock } = loadLegacyLibrary('appSessionLock');
const { buildRoleTransitionCleanupUpdates } = require('./roleTransition');
const {
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupLiveStateForSession,
} = loadLegacyLibrary('appSessionCleanup');

const { captureInstallationAuthority, prepareSessionPublication, commitSessionPublication } = loadLegacyLibrary('sessionPublicationAuthority');

const VERIFIED_LOGIN_GRANT_TTL_MS = 30 * 60 * 1000;
const APP_SESSION_ISSUANCE_LOCK_TTL_MS = 3 * 60 * 1000;

/** @param {{ clock: () => number, expiresAtMs: number }} options */
const assertFreshIssuanceDispatch = ({ clock, expiresAtMs }) => {
  if (clock() < expiresAtMs) return;
  const error = /** @type {Error & { code?: string }} */ (new Error('App session issuance lease expired before dispatch'));
  error.code = 'SESSION_IN_PROGRESS';
  throw error;
};

/** @type {(...args: any[]) => any} */
const buildVerifiedLoginGrantUpdates = ({
  authUid,
  bookingRef,
  tourId,
  nowMs = Date.now(),
}) => {
  if (!isValidFirebaseKey(authUid) || !isValidFirebaseKey(bookingRef) || !isValidFirebaseKey(tourId)) {
    return null;
  }

  const grantedAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + VERIFIED_LOGIN_GRANT_TTL_MS;
  const grantPayload = {
    source: 'verifyPassengerLogin',
    bookingRef,
    tourId,
    grantedAt,
    grantedAtMs: nowMs,
    expiresAtMs,
  };

  return {
    [`tour_access_grants/${tourId}/${authUid}`]: grantPayload,
    [`booking_access_grants/${bookingRef}/${authUid}`]: grantPayload,
  };
};

/** @type {(...args: any[]) => any} */
const buildSafeAppSessionEvent = ({ session, eventType, reason, actorType, nowMs = Date.now() }) => ({
  ...buildAppSessionEvent({ session, eventType, reason, actorType, nowMs }),
  authUidHash: createHash('sha256').update(session.authUid).digest('hex').slice(0, 24),
});

/** @type {(...args: any[]) => Promise<void>} */
const cleanupReplacedSession = async ({ db, existingSession, nowMs }) => {
  if (!existingSession?.sessionId) return;
  await cleanupLiveStateForSession({ db, session: existingSession, nowMs });
};

/** @type {(...args: any[]) => Promise<any>} */
const issuePassengerAppSession = async ({
  db,
  authUid,
  principalId,
  tourId,
  bookingRef: _bookingRef,
  identityUpdates,
  grantUpdates,
  buildRoleClaimUpdates = () => ({}),
  nowMs = Date.now(),
  clock = Date.now,
  existingAppSessionLock = null,
  existingPassengerDeletionLock = null,
  capturedAuthority = null,
  createIssuer,
  // eslint-disable-next-line complexity -- issuance coordinates two renewable locks and one atomic authority write
}) => {
  capturedAuthority ||= await captureInstallationAuthority({ db, authUid });
  const ownsAppSessionLock = !existingAppSessionLock;
  const lock = existingAppSessionLock || await acquireAppSessionLock({
    db, authUid, operation: 'issue', nowMs: clock(), clock, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
  });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('App session operation is already in progress')
    );
    error.code = 'SESSION_IN_PROGRESS';
    throw error;
  }
  let passengerDeletionLock = existingPassengerDeletionLock;
  let ownsPassengerDeletionLock = false;
  let committed = false;
  try {
    await ensureNoActiveAccountDeletion({ db, authUid });
    if (_bookingRef) {
      if (!passengerDeletionLock) {
        passengerDeletionLock = await acquirePassengerAccountDeletionLock({
          db, bookingRef: _bookingRef, ownerId: lock.owner, nowMs,
        });
        ownsPassengerDeletionLock = true;
      }
      if (!passengerDeletionLock.acquired || passengerDeletionLock.bookingRef !== _bookingRef) {
        const error = /** @type {Error & { code?: string }} */ (new Error('Passenger login operation is in progress'));
        error.code = 'SESSION_IN_PROGRESS';
        throw error;
      }
      await ensureNoActivePassengerAccountDeletion({ db, bookingRef: _bookingRef });
    }
    const [existingSnapshot, userSnapshot, notificationDeviceSnapshot] = await Promise.all([
      db.ref(`app_sessions/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
      db.ref(`notification_devices/${authUid}`).once('value'),
    ]);
    const existingSession = existingSnapshot.val();
    const session = buildPassengerSessionRecord({ authUid, principalId, tourId, nowMs });
    const participant = buildPassengerParticipantRecord({ session });
    const roleClaimUpdates = await buildRoleClaimUpdates(session, existingSession || null);
    if (!roleClaimUpdates || typeof roleClaimUpdates !== 'object' || Array.isArray(roleClaimUpdates)) {
      throw new Error('buildRoleClaimUpdates must return an update map');
    }
    const updates = existingSession?.sessionId
      ? buildAppSessionCleanupUpdates({
          session: existingSession,
          userProfile: userSnapshot.val() || {},
          notificationDevice: notificationDeviceSnapshot.val() || null,
          nowMs,
        })
      : {};
    const eventId = db.ref('app_session_events').push().key;
    Object.assign(updates, grantUpdates, identityUpdates, roleClaimUpdates, buildRoleTransitionCleanupUpdates({
      authUid,
      targetPrincipalType: 'passenger',
    }), {
      [`users/${authUid}/principalType`]: 'passenger',
      [`users/${authUid}/appSessionId`]: session.sessionId,
      [`app_sessions/${authUid}`]: session,
      [`tours/${tourId}/participants/${authUid}`]: participant,
      [`app_session_events/${eventId}`]: buildSafeAppSessionEvent({
        session,
        eventType: existingSession ? 'refreshed' : 'issued',
        reason: existingSession ? 'credential_reverification' : 'credential_verification',
        actorType: 'passenger',
        nowMs,
      }),
    });
    for (const [path, value] of Object.entries(grantUpdates || {})) {
      updates[path] = { ...value, sessionId: session.sessionId };
    }
    if (notificationDeviceSnapshot.exists()) {
      updates[`notification_devices/${authUid}/authoritySessionId`] = session.sessionId;
    }
    await cleanupReplacedSession({ db, existingSession, nowMs });
    const commitNowMs = clock();
    if (!(await renewAppSessionLock({
      db, authUid, owner: lock.owner, nowMs: commitNowMs, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
    }))) {
      const error = /** @type {Error & { code?: string }} */ (new Error('App session issuance lease changed'));
      error.code = 'SESSION_IN_PROGRESS';
      throw error;
    }
    if (_bookingRef && !(await renewPassengerAccountDeletionLock({
      lock: passengerDeletionLock, nowMs: commitNowMs,
    }))) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Passenger login lease changed'));
      error.code = 'SESSION_IN_PROGRESS';
      throw error;
    }
    await ensureNoActiveAccountDeletion({ db, authUid });
    if (_bookingRef) await ensureNoActivePassengerAccountDeletion({ db, bookingRef: _bookingRef });
    const finalCommitNowMs = clock();
    if (!(await renewAppSessionLock({ db, authUid, owner: lock.owner, nowMs: finalCommitNowMs,
      ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS }))) {
      const error = /** @type {Error & { code?: string }} */ (new Error('App session issuance lease changed'));
      error.code = 'SESSION_IN_PROGRESS';
      throw error;
    }
    updates[`app_session_locks/${authUid}`] = { ...lock.lock, owner: lock.owner,
      operation: 'issue', expiresAtMs: finalCommitNowMs + APP_SESSION_ISSUANCE_LOCK_TTL_MS,
      sessionId: session.sessionId, sessionRevision: session.sessionRevision };
    assertFreshIssuanceDispatch({ clock, expiresAtMs: finalCommitNowMs + APP_SESSION_ISSUANCE_LOCK_TTL_MS });
    const authority = await prepareSessionPublication({ db, authUid, capturedAuthority, session, updates,
      previousSessionId: existingSession?.sessionId || null, nowMs: finalCommitNowMs });
    await commitSessionPublication({ db, authUid, authority, session, updates, createIssuer });
    committed = true;
    return session;
  } finally {
    if (ownsPassengerDeletionLock && passengerDeletionLock?.acquired) {
      await releasePassengerAccountDeletionLock({ lock: passengerDeletionLock });
    }
    if (ownsAppSessionLock) {
      try {
        await releaseAppSessionLock({ db, authUid, owner: lock.owner });
      } catch (error) {
        if (!committed) throw error;
        log.error('Post-commit app-session lock release failed', error, { principalType: 'passenger' });
      }
    }
  }
};

const recoverStaffPublication = async ({ db, authUid, capturedAuthority, staffAuthorization, lock, clock, createIssuer }) => {
  const recovery = capturedAuthority.value;
  if (recovery?.staff?.redemptionId !== staffAuthorization.redemptionId
    || !['prepared', 'committed'].includes(recovery.state)) return null;
  if (recovery.state === 'prepared') {
    const { session, updatesJson } = recovery.publication || {};
    if (!session || session.sessionId !== recovery.sessionId || typeof updatesJson !== 'string') {
      throw new Error('Incomplete staff publication receipt');
    }
    const updates = JSON.parse(updatesJson);
    updates[`app_session_locks/${authUid}`] = { ...lock.lock, owner: lock.owner,
      operation: 'issue', expiresAtMs: clock() + APP_SESSION_ISSUANCE_LOCK_TTL_MS,
      sessionId: session.sessionId, sessionRevision: session.sessionRevision };
    const resumed = await prepareSessionPublication({ db, authUid, capturedAuthority,
      session, updates, staff: staffAuthorization,
      previousSessionId: recovery.previousSessionId || null, nowMs: clock() });
    await commitSessionPublication({ db, authUid, authority: resumed, session, updates, createIssuer });
  }
  const canonical = (await db.ref(`app_sessions/${authUid}`).once('value')).val();
  const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');
  if (!canonical || canonical.sessionId !== recovery.sessionId
    || !(await verifyActiveAppSession({ db, authUid, expectedRole: 'driver',
      expectedSessionId: recovery.sessionId, allowUnassignedDriver: true,
      driverLoginAdmission: staffAuthorization, nowMs: clock() })).allowed) {
    throw Object.assign(new Error('Staff recovery superseded'), { code: 'SESSION_CHANGED' });
  }
  return canonical;
};

const buildPreviousSessionCleanup = ({ existingSession, userSnapshot, notificationDeviceSnapshot, nowMs }) => (
  existingSession?.sessionId ? buildAppSessionCleanupUpdates({
    session: existingSession, userProfile: userSnapshot.val() || {},
    notificationDevice: notificationDeviceSnapshot.val() || null, nowMs,
  }) : {}
);

/** @type {(...args: any[]) => Promise<any>} */
const issueDriverAppSession = async ({
  db,
  authUid,
  driverId,
  tourId,
  driverLoginPolicyGeneration,
  staffAuthorization,
  capturedAuthority = null,
  createIssuer,
  profileUpdates,
  nowMs = Date.now(),
  clock = Date.now,
}) => {
  capturedAuthority ||= await captureInstallationAuthority({ db, authUid });
  if (!staffAuthorization) throw Object.assign(new Error('Staff enrolment required'), { code: 'STAFF_ENROLMENT_REQUIRED' });
  const lock = await acquireAppSessionLock({
    db, authUid, operation: 'issue', nowMs: clock(), clock, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
  });
  if (!lock.acquired) {
    const error = /** @type {Error & { code?: string }} */ (
      new Error('App session operation is already in progress')
    );
    error.code = 'SESSION_IN_PROGRESS';
    throw error;
  }
  let committed = false;
  try {
    await ensureNoActiveAccountDeletion({ db, authUid });
    const recovered = await recoverStaffPublication({ db, authUid, capturedAuthority, staffAuthorization, lock, clock, createIssuer });
    if (recovered) { committed = true; return recovered; }
    const [existingSnapshot, userSnapshot, notificationDeviceSnapshot] = await Promise.all([
      db.ref(`app_sessions/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
      db.ref(`notification_devices/${authUid}`).once('value'),
    ]);
    const existingSession = existingSnapshot.val();
    const session = buildDriverSessionRecord({
      authUid, driverId, tourId, driverLoginPolicyGeneration, nowMs,
    });
    const updates = buildPreviousSessionCleanup({ existingSession, userSnapshot, notificationDeviceSnapshot, nowMs });
    const eventId = db.ref('app_session_events').push().key;
    Object.assign(updates, buildRoleTransitionCleanupUpdates({
      authUid,
      targetPrincipalType: 'driver',
    }), profileUpdates, {
      [`users/${authUid}/appSessionId`]: session.sessionId,
      [`app_sessions/${authUid}`]: session,
      [`app_session_events/${eventId}`]: buildSafeAppSessionEvent({
        session,
        eventType: existingSession ? 'refreshed' : 'issued',
        reason: existingSession ? 'driver_reverification' : 'driver_verification',
        actorType: 'driver',
        nowMs,
      }),
    });
    if (notificationDeviceSnapshot.exists()) {
      updates[`notification_devices/${authUid}/authoritySessionId`] = session.sessionId;
    }
    await cleanupReplacedSession({ db, existingSession, nowMs });
    const commitNowMs = clock();
    if (!(await renewAppSessionLock({
      db, authUid, owner: lock.owner, nowMs: commitNowMs, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
    }))) {
      const error = /** @type {Error & { code?: string }} */ (new Error('App session issuance lease changed'));
      error.code = 'SESSION_IN_PROGRESS';
      throw error;
    }
    await ensureNoActiveAccountDeletion({ db, authUid });
    const finalCommitNowMs = clock();
    if (!(await renewAppSessionLock({ db, authUid, owner: lock.owner, nowMs: finalCommitNowMs,
      ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS }))) {
      const error = /** @type {Error & { code?: string }} */ (new Error('App session issuance lease changed'));
      error.code = 'SESSION_IN_PROGRESS';
      throw error;
    }
    updates[`app_session_locks/${authUid}`] = { ...lock.lock, owner: lock.owner,
      operation: 'issue', expiresAtMs: finalCommitNowMs + APP_SESSION_ISSUANCE_LOCK_TTL_MS,
      sessionId: session.sessionId, sessionRevision: session.sessionRevision };
    assertFreshIssuanceDispatch({ clock, expiresAtMs: finalCommitNowMs + APP_SESSION_ISSUANCE_LOCK_TTL_MS });
    updates[`driver_device_authorizations/${authUid}`] = { schemaVersion: 1, driverId,
      generation: staffAuthorization.generation, redemptionId: staffAuthorization.redemptionId,
      sessionId: session.sessionId, state: 'active', issuedAtMs: finalCommitNowMs };
    const authority = await prepareSessionPublication({ db, authUid, capturedAuthority, session, updates,
      previousSessionId: existingSession?.sessionId || null, staff: staffAuthorization, nowMs: finalCommitNowMs });
    await commitSessionPublication({ db, authUid, authority, session, updates, createIssuer });
    committed = true;
    return session;
  } finally {
    try {
      await releaseAppSessionLock({ db, authUid, owner: lock.owner });
    } catch (error) {
      if (!committed) throw error;
      log.error('Post-commit app-session lock release failed', error, { principalType: 'driver' });
    }
  }
};


module.exports = {
  APP_SESSION_ISSUANCE_LOCK_TTL_MS,
  buildSafeAppSessionEvent,
  buildVerifiedLoginGrantUpdates,
  issueDriverAppSession,
  issuePassengerAppSession,
};
