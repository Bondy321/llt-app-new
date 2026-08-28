'use strict';

const {
  isActiveSessionRecord,
  isValidAppSessionId,
  isValidFirebaseKey,
} = require('./appSession');

const denied = (reason) => ({ allowed: false, reason });

const normalizeDriverLoginPolicy = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, enforceSingleDevice: false, generation: 0 };
  }
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1
    && typeof value.enforceSingleDevice === 'boolean'
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && Number.isSafeInteger(value.updatedAtMs) && value.updatedAtMs > 0;
  return valid
    ? { valid: true, enforceSingleDevice: value.enforceSingleDevice, generation: value.generation }
    : { valid: false, enforceSingleDevice: true, generation: -1 };
};

const verifyActiveAppSession = async ({
  db,
  authUid,
  expectedTourId,
  expectedRole,
  expectedSessionId,
  allowUnassignedDriver = false,
  nowMs = Date.now(),
} = {}) => {
  if (!db || !isValidFirebaseKey(authUid)) return denied('INVALID_AUTH_UID');
  if (expectedTourId !== undefined && expectedTourId !== null && !isValidFirebaseKey(expectedTourId)) {
    return denied('INVALID_TOUR');
  }
  if (expectedRole && expectedRole !== 'passenger' && expectedRole !== 'driver') return denied('INVALID_ROLE');
  if (expectedSessionId && !isValidAppSessionId(expectedSessionId)) return denied('INVALID_SESSION_ID');

  const sessionSnapshot = await db.ref(`app_sessions/${authUid}`).once('value');
  const session = sessionSnapshot.val();
  if (!isActiveSessionRecord(session, { nowMs })) return denied('SESSION_INACTIVE');
  if (session.authUid !== authUid) return denied('SESSION_UID_MISMATCH');
  if (expectedRole && session.principalType !== expectedRole) return denied('SESSION_ROLE_MISMATCH');
  if (expectedSessionId && session.sessionId !== expectedSessionId) return denied('SESSION_CHANGED');
  if (expectedTourId && session.tourId !== expectedTourId) return denied('SESSION_TOUR_MISMATCH');
  if (!expectedTourId && session.principalType === 'driver' && !session.tourId && !allowUnassignedDriver) {
    return denied('DRIVER_UNASSIGNED');
  }

  if (session.principalType === 'passenger') {
    const [participantSnapshot, userSnapshot] = await Promise.all([
      db.ref(`tours/${session.tourId}/participants/${authUid}`).once('value'),
      db.ref(`users/${authUid}`).once('value'),
    ]);
    const participant = participantSnapshot.val();
    const user = userSnapshot.val() || {};
    if (!participant || participant.schemaVersion !== 2) return denied('PARTICIPANT_MISSING');
    if (participant.userId !== authUid
      || participant.sessionId !== session.sessionId
      || participant.principalId !== session.principalId
      || Number(participant.sessionExpiresAtMs) <= nowMs) {
      return denied('PARTICIPANT_SESSION_MISMATCH');
    }
    if (user.stablePassengerId !== session.principalId
      || user.identityVersion !== 'pax_v2'
      || user.principalType !== 'passenger') {
      return denied('PASSENGER_PROFILE_MISMATCH');
    }
  } else {
    const [userSnapshot, driverSnapshot, policySnapshot] = await Promise.all([
      db.ref(`users/${authUid}`).once('value'),
      db.ref(`drivers/${session.driverId}`).once('value'),
      db.ref('driver_login_policy/v1').once('value'),
    ]);
    const user = userSnapshot.val() || {};
    const driver = driverSnapshot.val() || {};
    const policy = normalizeDriverLoginPolicy(policySnapshot.val());
    const sessionGeneration = Number.isSafeInteger(session.driverLoginPolicyGeneration)
      ? session.driverLoginPolicyGeneration
      : 0;
    if (!policy.valid || sessionGeneration !== policy.generation) {
      return denied('DRIVER_POLICY_MISMATCH');
    }
    if (user.driverId !== session.driverId
      || user.driverPrincipalId !== session.principalId
      || user.principalType !== 'driver'
      || (policy.enforceSingleDevice && driver.authUid !== authUid)) {
      return denied('DRIVER_PROFILE_MISMATCH');
    }
    if (session.tourId) {
      const assignmentSnapshot = await db
        .ref(`tour_manifests/${session.tourId}/assigned_drivers/${session.driverId}`)
        .once('value');
      if (assignmentSnapshot.val() !== true
        || driver.currentTourId !== session.tourId
        || user.driverAssignedTourId !== session.tourId) {
        return denied('DRIVER_ASSIGNMENT_MISMATCH');
      }
    } else if (!allowUnassignedDriver) {
      return denied('DRIVER_UNASSIGNED');
    }
  }

  return {
    allowed: true,
    reason: 'OK',
    session,
    role: session.principalType,
    principalId: session.principalId,
    driverId: session.driverId,
    tourId: session.tourId,
  };
};

module.exports = { verifyActiveAppSession };
