'use strict';

const { createHash } = require('crypto');
const { isActiveSessionRecord, isValidAppSessionId } = require('./appSession');

const NOTIFICATION_DEVICE_LOCK_TTL_MS = 30 * 1000;

const toRealtimeKeySegment = (value) => String(value || '')
  .replace(/%/g, '%25')
  .replace(/\./g, '%2E')
  .replace(/#/g, '%23')
  .replace(/\$/g, '%24')
  .replace(/\//g, '%2F')
  .replace(/\[/g, '%5B')
  .replace(/\]/g, '%5D');

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
  disableAllNotificationDelivery = eventType === 'ended_by_admin' || reason === 'account_deletion',
} = {}) => {
  if (!db || !session || !isValidAppSessionId(expectedSessionId)) throw new Error('Invalid cleanup request');
  if (session.sessionId !== expectedSessionId) {
    const error = new Error('App session changed');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
  const notificationLockOwner = `session_cleanup:${session.sessionId}`;
  const notificationLock = await acquireNotificationDeviceLock({
    db,
    authUid: session.authUid,
    owner: notificationLockOwner,
    nowMs,
  });
  if (!notificationLock.acquired) {
    const error = new Error('Notification device mutation in progress');
    error.code = 'NOTIFICATION_DEVICE_BUSY';
    throw error;
  }
  try {
    const [userSnapshot, notificationDeviceSnapshot] = await Promise.all([
      db.ref(`users/${session.authUid}`).once('value'),
      db.ref(`notification_devices/${session.authUid}`).once('value'),
    ]);
    const updates = buildAppSessionCleanupUpdates({
      session,
      userProfile: userSnapshot.exists() ? (userSnapshot.val() || {}) : null,
      notificationDevice: notificationDeviceSnapshot.val() || null,
      disableAllNotificationDelivery,
      nowMs,
    });
    const eventId = typeof createEventId === 'function' ? createEventId() : null;
    if (eventId) {
      updates[`app_session_events/${eventId}`] = buildAppSessionEvent({ session, eventType, reason, actorType, nowMs });
    }
    await db.ref().update(updates);
    await cleanupDriverLocationForSession({ db, session });
    return { updates, eventId };
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
  cleanupAppSession,
  isActiveSessionRecord,
  releaseNotificationDeviceLock,
};
