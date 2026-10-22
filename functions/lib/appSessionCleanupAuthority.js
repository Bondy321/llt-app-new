'use strict';

const AUTHORITY_FIELDS = [
  'schemaVersion', 'sessionId', 'authUid', 'principalId', 'principalType', 'tourId',
  'driverId', 'driverLoginPolicyGeneration', 'issuedAtMs', 'lastAuthenticatedAtMs',
  'expiresAtMs', 'sessionRevision',
];

const sameSessionAuthority = (current, expected) => Boolean(current && expected
  && AUTHORITY_FIELDS.every((key) => (current[key] ?? null) === (expected[key] ?? null)));

const sessionChanged = () => Object.assign(new Error('App session authority changed'), { code: 'SESSION_CHANGED' });

// The canonical revision fence and captured absolute expiry are compared in the
// SAME bounded transaction. A new owner can acquire only after that expiry, so
// even the reservation -> revision handover gap cannot admit an old callback.
const mutateCleanupSession = async ({ db, session, lease, clock, remove = false }) => {
  let matched = false;
  const result = await db.ref(`app_sessions/${session.authUid}`).transaction((current) => {
    matched = false;
    if (current === null) return null;
    if (!sameSessionAuthority(current, session)
      || !['active', 'ending'].includes(current.status)
      || current.sessionId !== lease.sessionId || current.sessionRevision !== lease.sessionRevision
      || !Number.isSafeInteger(lease.expiresAtMs) || lease.expiresAtMs <= clock()) return undefined;
    matched = true;
    return remove ? null : { ...current, status: 'ending' };
  }, undefined, false);
  if (!result?.committed || (!matched && result.snapshot.exists())) throw sessionChanged();
  return { alreadyEnded: !matched };
};

const mutateOwnedRecord = async (ref, owns, mutate = () => null) => ref.transaction((current) => {
  if (current === null) return null;
  if (!owns(current)) return undefined;
  return mutate(current);
}, undefined, false);

const ownsSession = (record, sessionId) => (record?.appSessionId ?? record?.sessionId) === sessionId;

const cleanupOwnedSessionRecords = async ({ db, session, userProfile, notificationDevice,
  disableAllNotificationDelivery, nowMs, buildNotificationDeviceCleanupUpdates }) => {
  const { authUid, sessionId, tourId } = session;
  if (userProfile) {
    await mutateOwnedRecord(db.ref(`users/${authUid}`), (current) => (
      current.appSessionId === sessionId || (!current.appSessionId
        && current.lastUpdated === userProfile.lastUpdated
        && current.principalType === userProfile.principalType
        && current.pushToken === userProfile.pushToken)
    ), (current) => {
      const { pushToken: _pushToken, ...profile } = current;
      return { ...profile, pushTokenStatus: 'UNAVAILABLE', pushTokenInvalidReason: 'SESSION_ENDED',
        pushTokenUpdatedAt: new Date(nowMs).toISOString() };
    });
  }
  if (tourId) {
    // Legacy untagged UID state has no exact owner. Preserve it rather than
    // deleting a successor's identical value; it grants no app-session access.
    for (const path of [`tours/${tourId}/liveTracking/${authUid}`,
      `notification_read_state/${tourId}/${authUid}`,
      `notification_read_migration_requests/${tourId}/${authUid}`]) {
      await mutateOwnedRecord(db.ref(path), (current) => ownsSession(current, sessionId));
    }
    if (session.principalType === 'passenger') {
      await mutateOwnedRecord(db.ref(`tours/${tourId}/participants/${authUid}`), (current) => (
        current.sessionId === sessionId && current.sessionExpiresAtMs === session.expiresAtMs
      ));
      await mutateOwnedRecord(db.ref(`tour_access_grants/${tourId}/${authUid}`),
        (current) => ownsSession(current, sessionId));
      if (userProfile?.bookingRef) {
        await mutateOwnedRecord(db.ref(`booking_access_grants/${userProfile.bookingRef}/${authUid}`),
          (current) => ownsSession(current, sessionId));
      }
    }
  }
  if (notificationDevice) {
    // Legacy operational bindings prove exact session ownership. An untagged
    // marketing-only snapshot can have been created after takeover; equality
    // with that snapshot provides no ownership evidence and must preserve it.
    await mutateOwnedRecord(db.ref(`notification_devices/${authUid}`), (current) => (
      current.authoritySessionId ? current.authoritySessionId === sessionId
        : current.operationalSessionId === sessionId
    ), (current) => {
      const updates = buildNotificationDeviceCleanupUpdates({ session, notificationDevice: current,
        disableAllNotificationDelivery, nowMs });
      const next = { ...current };
      for (const [path, value] of Object.entries(updates)) {
        const field = path.split('/').at(-1);
        if (value === null) delete next[field]; else next[field] = value;
      }
      return next;
    });
  }
};

module.exports = { cleanupOwnedSessionRecords, mutateCleanupSession, sameSessionAuthority };
