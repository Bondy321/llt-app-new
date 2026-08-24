'use strict';

const { createHash } = require('crypto');
const { isActiveSessionRecord, isValidAppSessionId } = require('./appSession');

const toRealtimeKeySegment = (value) => String(value || '')
  .replace(/%/g, '%25')
  .replace(/\./g, '%2E')
  .replace(/#/g, '%23')
  .replace(/\$/g, '%24')
  .replace(/\//g, '%2F')
  .replace(/\[/g, '%5B')
  .replace(/\]/g, '%5D');

const buildAppSessionCleanupUpdates = ({ session, userProfile = {}, nowMs = Date.now() } = {}) => {
  if (!session || !isValidAppSessionId(session.sessionId)) throw new Error('Valid app session required');
  const { authUid, tourId, principalId, principalType } = session;
  const actorKey = toRealtimeKeySegment(principalId);
  const updates = { [`app_sessions/${authUid}`]: null };
  if (userProfile !== null) {
    updates[`users/${authUid}/pushToken`] = null;
    updates[`users/${authUid}/pushTokenStatus`] = 'UNAVAILABLE';
    updates[`users/${authUid}/pushTokenInvalidReason`] = 'SESSION_ENDED';
    updates[`users/${authUid}/pushTokenUpdatedAt`] = new Date(nowMs).toISOString();
  }
  if (tourId) {
    updates[`tours/${tourId}/liveTracking/${authUid}`] = null;
    updates[`notification_read_state/${tourId}/${authUid}`] = null;
    updates[`notification_read_migration_requests/${tourId}/${authUid}`] = null;
    updates[`chats/${tourId}/typing/${actorKey}`] = null;
    updates[`chats/${tourId}/presence/${actorKey}`] = null;
    updates[`internal_chats/${tourId}/typing/${actorKey}`] = null;
    updates[`internal_chats/${tourId}/presence/${actorKey}`] = null;
  }
  if (principalType === 'passenger' && tourId) {
    updates[`tours/${tourId}/participants/${authUid}`] = null;
    updates[`tour_access_grants/${tourId}/${authUid}`] = null;
    if (userProfile?.bookingRef) updates[`booking_access_grants/${userProfile.bookingRef}/${authUid}`] = null;
  }
  return updates;
};

const buildAppSessionEvent = ({ session, eventType, reason, actorType, nowMs = Date.now() } = {}) => ({
  schemaVersion: 1,
  eventType,
  reason: String(reason || 'unspecified').slice(0, 80),
  actorType: String(actorType || 'system').slice(0, 40),
  authUidHash: session?.authUid
    ? createHash('sha256').update(session.authUid).digest('hex').slice(0, 24)
    : null,
  principalType: session?.principalType || null,
  tourId: session?.tourId || null,
  driverId: session?.driverId || null,
  sessionRevision: session?.sessionRevision || null,
  createdAtMs: nowMs,
  expiresAtMs: nowMs + (30 * 24 * 60 * 60 * 1000),
});

const cleanupDriverLocationForSession = async ({ db, session } = {}) => {
  if (!db || session?.principalType !== 'driver' || !session.tourId) return { removed: false };
  const ref = db.ref(`tours/${session.tourId}/driverLocation`);
  const result = await ref.transaction((current) => {
    if (!current || current.appSessionId !== session.sessionId || current.driverId !== session.driverId) {
      return undefined;
    }
    return null;
  }, undefined, false);
  return { removed: Boolean(result.committed && !result.snapshot.exists()) };
};

const cleanupAppSession = async ({
  db,
  session,
  expectedSessionId,
  eventType,
  reason,
  actorType,
  nowMs = Date.now(),
  createEventId,
} = {}) => {
  if (!db || !session || !isValidAppSessionId(expectedSessionId)) throw new Error('Invalid cleanup request');
  if (session.sessionId !== expectedSessionId) {
    const error = new Error('App session changed');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const userSnapshot = await db.ref(`users/${session.authUid}`).once('value');
  const updates = buildAppSessionCleanupUpdates({
    session,
    userProfile: userSnapshot.exists() ? (userSnapshot.val() || {}) : null,
    nowMs,
  });
  const eventId = typeof createEventId === 'function' ? createEventId() : null;
  if (eventId) {
    updates[`app_session_events/${eventId}`] = buildAppSessionEvent({ session, eventType, reason, actorType, nowMs });
  }
  await db.ref().update(updates);
  await cleanupDriverLocationForSession({ db, session });
  return { updates, eventId };
};

module.exports = {
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupDriverLocationForSession,
  cleanupAppSession,
  isActiveSessionRecord,
};
