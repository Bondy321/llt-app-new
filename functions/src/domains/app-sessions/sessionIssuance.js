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

const VERIFIED_LOGIN_GRANT_TTL_MS = 30 * 60 * 1000;
const APP_SESSION_ISSUANCE_LOCK_TTL_MS = 3 * 60 * 1000;

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
  // eslint-disable-next-line complexity -- issuance coordinates two renewable locks and one atomic authority write
}) => {
  const ownsAppSessionLock = !existingAppSessionLock;
  const lock = existingAppSessionLock || await acquireAppSessionLock({
    db, authUid, operation: 'issue', nowMs, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
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
    await db.ref().update(updates);
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

/** @type {(...args: any[]) => Promise<any>} */
const issueDriverAppSession = async ({
  db,
  authUid,
  driverId,
  tourId,
  driverLoginPolicyGeneration = 0,
  profileUpdates,
  nowMs = Date.now(),
  clock = Date.now,
}) => {
  const lock = await acquireAppSessionLock({
    db, authUid, operation: 'issue', nowMs, ttlMs: APP_SESSION_ISSUANCE_LOCK_TTL_MS,
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
    const [existingSnapshot, userSnapshot, notificationDeviceSnapshot] = await Promise.all([
      db.ref(`app_sessions/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
      db.ref(`notification_devices/${authUid}`).once('value'),
    ]);
    const existingSession = existingSnapshot.val();
    const session = buildDriverSessionRecord({
      authUid, driverId, tourId, driverLoginPolicyGeneration, nowMs,
    });
    const updates = existingSession?.sessionId
      ? buildAppSessionCleanupUpdates({
          session: existingSession,
          userProfile: userSnapshot.val() || {},
          notificationDevice: notificationDeviceSnapshot.val() || null,
          nowMs,
        })
      : {};
    const eventId = db.ref('app_session_events').push().key;
    Object.assign(updates, buildRoleTransitionCleanupUpdates({
      authUid,
      targetPrincipalType: 'driver',
    }), profileUpdates, {
      [`app_sessions/${authUid}`]: session,
      [`app_session_events/${eventId}`]: buildSafeAppSessionEvent({
        session,
        eventType: existingSession ? 'refreshed' : 'issued',
        reason: existingSession ? 'driver_reverification' : 'driver_verification',
        actorType: 'driver',
        nowMs,
      }),
    });
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
    await db.ref().update(updates);
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
  buildSafeAppSessionEvent,
  buildVerifiedLoginGrantUpdates,
  issueDriverAppSession,
  issuePassengerAppSession,
};
