'use strict';

const { createHash } = require('crypto');
const { isActiveSessionRecord, isValidAppSessionId } = require('./appSession');
const { cleanupChatStatusForAppSession } = require('./chatPresenceProjection');
const { cleanupDriverLocationsForAppSession } = require('./driverLocationProjection');
const { retireDriverTrackingIntentsForAppSession } = require('../src/domains/live-state/driverTrackingSessions');
const { cleanupOwnedSessionRecords, mutateCleanupSession } = require('./appSessionCleanupAuthority');

const NOTIFICATION_DEVICE_LOCK_TTL_MS = 30 * 1000;

const buildNotificationDeviceCleanupUpdates = ({
  session,
  notificationDevice,
  disableAllNotificationDelivery = false,
  nowMs,
}) => {
  if (!notificationDevice || typeof notificationDevice !== 'object') return {};
  const path = `notification_devices/${session.authUid}`;
  const registrationRevision = Number.isSafeInteger(Number(notificationDevice.registrationRevision))
    ? Number(notificationDevice.registrationRevision) + 1
    : 1;
  const updates = {
    [`${path}/operationalEligible`]: false,
    [`${path}/operationalTourId`]: null,
    [`${path}/operationalSessionId`]: null,
    [`${path}/operationalSessionRevision`]: null,
    [`${path}/lastEndedAppSessionId`]: session.sessionId,
    [`${path}/registrationRevision`]: registrationRevision,
    [`${path}/lastMutationAction`]: disableAllNotificationDelivery ? 'security_revoke' : 'session_cleanup',
    [`${path}/lastMutationSessionId`]: session.sessionId,
    [`${path}/authorityUpdatedAtMs`]: nowMs,
    [`${path}/updatedAtMs`]: nowMs,
  };
  if (disableAllNotificationDelivery) {
    updates[`${path}/pushToken`] = null;
    updates[`${path}/tokenHash`] = null;
    updates[`${path}/status`] = 'revoked';
    updates[`${path}/marketingEligible`] = false;
    updates[`${path}/revokedAtMs`] = nowMs;
  }
  return updates;
};

const buildAppSessionCleanupUpdates = ({
  session,
  userProfile = {},
  notificationDevice = null,
  disableAllNotificationDelivery = false,
  nowMs = Date.now(),
} = {}) => {
  if (!session || !isValidAppSessionId(session.sessionId)) throw new Error('Valid app session required');
  const { authUid, tourId, principalType } = session;
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
  }
  if (principalType === 'passenger' && tourId) {
    updates[`tours/${tourId}/participants/${authUid}`] = null;
    updates[`tour_access_grants/${tourId}/${authUid}`] = null;
    if (userProfile?.bookingRef) updates[`booking_access_grants/${userProfile.bookingRef}/${authUid}`] = null;
  }
  Object.assign(updates, buildNotificationDeviceCleanupUpdates({
    session,
    notificationDevice,
    disableAllNotificationDelivery,
    nowMs,
  }));
  return updates;
};

const acquireNotificationDeviceLock = async ({
  db,
  authUid,
  owner,
  nowMs = Date.now(),
  ttlMs = NOTIFICATION_DEVICE_LOCK_TTL_MS,
} = {}) => {
  if (!db || !authUid || !owner) throw new Error('Invalid notification device lock request');
  const lockRef = db.ref(`notification_device_locks/${authUid}`);
  const result = await lockRef.transaction((current) => {
    if (current && current.owner !== owner && Number(current.expiresAtMs || 0) > nowMs) return undefined;
    return { owner, createdAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
  }, undefined, false);
  return {
    acquired: Boolean(result?.committed && result.snapshot?.val?.()?.owner === owner),
    lockRef,
  };
};

const releaseNotificationDeviceLock = async ({ lockRef, owner } = {}) => {
  if (!lockRef || !owner) return false;
  let released = false;
  const result = await lockRef.transaction((current) => {
    if (current === null) return current;
    if (current?.owner !== owner) return undefined;
    released = true;
    return null;
  }, undefined, false);
  return Boolean(released && result?.committed);
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

const persistCleanupEvent = async ({ db, session, eventType, reason, actorType, nowMs, createEventId }) => {
  if (typeof createEventId !== 'function') return null;
  const key = `cleanup_v1_${createHash('sha256')
    .update(JSON.stringify([session.sessionId, eventType, reason])).digest('hex')}`;
  const eventId = createEventId(key);
  if (!eventId) return null;
  const event = buildAppSessionEvent({ session, eventType, reason, actorType, nowMs });
  const sameEvent = current => ['eventType', 'reason', 'actorType', 'authUidHash', 'principalType', 'tourId', 'driverId']
    .every(field => (current?.[field] ?? null) === (event[field] ?? null));
  const result = await db.ref(`app_session_events/${eventId}`).transaction(current => {
    if (current === null) return event;
    return sameEvent(current) ? current : undefined;
  }, undefined, false);
  if (!result?.committed || !sameEvent(result.snapshot.val())) {
    const error = new Error('App session cleanup audit changed');
    error.code = 'SESSION_CLEANUP_AUDIT_CHANGED';
    throw error;
  }
  return eventId;
};

const cleanupLiveStateForSession = async ({ db, session, nowMs = Date.now() } = {}) => {
  if (!db || !isValidAppSessionId(session?.sessionId)) {
    return { tracking: { retired: 0 }, location: { removed: 0 }, chat: { removed: 0 } };
  }
  const tracking = await retireDriverTrackingIntentsForAppSession({ database: db, session });
  const [location, chat] = await Promise.all([
    cleanupDriverLocationsForAppSession({
      database: db,
      appSessionId: session.sessionId,
      expectedTourId: session.principalType === 'driver' ? session.tourId : null,
      nowMs,
    }),
    cleanupChatStatusForAppSession({
      database: db,
      appSessionId: session.sessionId,
      expectedTourId: session.tourId,
      expectedActorKey: session.principalId,
      expectedPrincipalType: session.principalType,
      nowMs,
    }),
  ]);
  return { tracking, location, chat };
};

const cleanupDriverLocationForSession = cleanupLiveStateForSession;

const cleanupAppSession = async ({
  db,
  session,
  expectedSessionId,
  eventType,
  reason,
  actorType,
  nowMs = Date.now(),
  clock = Date.now,
  appSessionLock = null,
  createEventId,
  disableAllNotificationDelivery = eventType === 'ended_by_admin' || reason === 'account_deletion',
} = {}) => {
  if (!db || !session || !isValidAppSessionId(expectedSessionId)) throw new Error('Invalid cleanup request');
  if (session.sessionId !== expectedSessionId) {
    const error = new Error('App session changed');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const sessionLockOwner = appSessionLock?.owner;
  if (!sessionLockOwner) {
    const error = new Error('App session cleanup lease is required');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const lease = (await db.ref(`app_session_locks/${session.authUid}`).once('value')).val();
  if (!lease || lease.owner !== sessionLockOwner) {
    const error = new Error('App session cleanup lease changed');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const notificationLockOwner = `${sessionLockOwner}:notification_cleanup`;
  const notificationLock = await acquireNotificationDeviceLock({
    db,
    authUid: session.authUid,
    owner: notificationLockOwner,
    nowMs: clock(),
  });
  if (!notificationLock.acquired) {
    const error = new Error('Notification device mutation in progress');
    error.code = 'NOTIFICATION_DEVICE_BUSY';
    throw error;
  }
  try {
    await mutateCleanupSession({ db, session, lease, clock });
    const [userSnapshot, notificationDeviceSnapshot] = await Promise.all([
      db.ref(`users/${session.authUid}`).once('value'),
      db.ref(`notification_devices/${session.authUid}`).once('value'),
    ]);
    await cleanupLiveStateForSession({ db, session, nowMs });
    await cleanupOwnedSessionRecords({
      db,
      session,
      userProfile: userSnapshot.exists() ? (userSnapshot.val() || {}) : null,
      notificationDevice: notificationDeviceSnapshot.val() || null,
      disableAllNotificationDelivery,
      nowMs,
      buildNotificationDeviceCleanupUpdates,
    });
    // Persist the exact old-session event before deleting retry scope. Its stable
    // key retains the first timestamp across retries and never names a successor.
    const eventId = await persistCleanupEvent({ db, session, eventType, reason, actorType, nowMs, createEventId });
    const result = await mutateCleanupSession({ db, session, lease, clock, remove: true });
    return { eventId, ...result };
  } finally {
    await releaseNotificationDeviceLock({ lockRef: notificationLock.lockRef, owner: notificationLockOwner });
  }
};

module.exports = {
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  buildNotificationDeviceCleanupUpdates,
  acquireNotificationDeviceLock,
  cleanupDriverLocationForSession,
  cleanupLiveStateForSession,
  cleanupAppSession,
  isActiveSessionRecord,
  releaseNotificationDeviceLock,
};
