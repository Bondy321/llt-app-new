const { createHash } = require('node:crypto');

const opaqueHex = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const sessionIdFor = (uid) => `sess_v1_${opaqueHex(`session:${uid}`)}`;
const passengerIdFor = (uid) => `pax_v2_${opaqueHex(`passenger:${uid}`)}`;

const baseSession = ({ uid, principalType, principalId, driverId, tourId, nowMs = Date.now() }) => ({
  schemaVersion: 1,
  sessionId: sessionIdFor(uid),
  authUid: uid,
  principalType,
  principalId,
  driverId,
  tourId,
  status: 'active',
  issuedAtMs: nowMs - 1_000,
  lastAuthenticatedAtMs: nowMs - 1_000,
  expiresAtMs: nowMs + (60 * 60 * 1000),
  sessionRevision: 1,
});

const passengerAuthorityUpdates = ({ uid, tourId, principalId = passengerIdFor(uid), bookingRef = `BOOKING-${uid}`, nowMs = Date.now() }) => {
  const session = baseSession({ uid, principalType: 'passenger', principalId, driverId: null, tourId, nowMs });
  return {
    [`app_sessions/${uid}`]: session,
    [`tours/${tourId}/participants/${uid}`]: {
      schemaVersion: 2,
      userId: uid,
      principalId,
      sessionId: session.sessionId,
      joinedAtMs: nowMs,
      sessionExpiresAtMs: session.expiresAtMs,
    },
    [`users/${uid}/stablePassengerId`]: principalId,
    [`users/${uid}/stablePassengerKey`]: principalId,
    [`users/${uid}/privatePhotoOwnerId`]: principalId,
    [`users/${uid}/privatePhotoOwnerKey`]: principalId,
    [`users/${uid}/privatePhotoOwnerType`]: 'opaque_passenger',
    [`users/${uid}/identityVersion`]: 'pax_v2',
    [`users/${uid}/bookingRef`]: bookingRef,
    [`users/${uid}/principalType`]: 'passenger',
  };
};

const driverAuthorityUpdates = ({ uid, driverId, tourId, driverLoginPolicyGeneration = 0, nowMs = Date.now() }) => {
  const principalId = `driver:${driverId}`;
  const session = baseSession({ uid, principalType: 'driver', principalId, driverId, tourId, nowMs });
  session.driverLoginPolicyGeneration = driverLoginPolicyGeneration;
  return {
    'driver_login_policy/v1': {
      schemaVersion: 1,
      enforceSingleDevice: false,
      generation: 0,
      revision: 1,
      updatedAtMs: nowMs,
    },
    [`app_sessions/${uid}`]: session,
    [`users/${uid}/driverId`]: driverId,
    [`users/${uid}/driverPrincipalId`]: principalId,
    [`users/${uid}/driverAssignedTourId`]: tourId,
    [`users/${uid}/principalType`]: 'driver',
    [`drivers/${driverId}/authUid`]: uid,
    [`drivers/${driverId}/currentTourId`]: tourId,
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
  };
};

module.exports = {
  passengerAuthorityUpdates,
  driverAuthorityUpdates,
  passengerIdFor,
  sessionIdFor,
};
