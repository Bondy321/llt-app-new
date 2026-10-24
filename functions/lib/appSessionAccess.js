'use strict';

const {
  isActiveSessionRecord,
  isValidAppSessionId,
  isValidFirebaseKey,
} = require('./appSession');
const { normalizeTourKeyForComparison } = require('../src/infrastructure/validation/stringNormalization');
const { readSourceRoster } = require('../src/domains/manifests/sourceRoster');

const denied = (reason) => ({ allowed: false, reason });

const normalizeDriverLoginPolicy = (value, allowAdmittedDrain = false) => {
  if (value === null || value === undefined) {
    return { valid: false, enforceSingleDevice: true, generation: -1 };
  }
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1
    && typeof value.enforceSingleDevice === 'boolean'
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && Number.isSafeInteger(value.updatedAtMs) && value.updatedAtMs > 0
    && (value.transitionPhase === undefined || value.transitionPhase === 'stable'
      || (allowAdmittedDrain && value.transitionPhase === 'draining'));
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
  driverLoginAdmission = null,
  nowMs = Date.now(),
} = {}) => {
  if (!db || !isValidFirebaseKey(authUid)) return denied('INVALID_AUTH_UID');
  if (expectedTourId !== undefined && expectedTourId !== null && !isValidFirebaseKey(expectedTourId)) {
    return denied('INVALID_TOUR');
  }
  if (expectedRole && expectedRole !== 'passenger' && expectedRole !== 'driver') return denied('INVALID_ROLE');
  if (expectedSessionId && !isValidAppSessionId(expectedSessionId)) return denied('INVALID_SESSION_ID');

  const [sessionSnapshot, authoritySnapshot] = await Promise.all([
    db.ref(`app_sessions/${authUid}`).once('value'),
    db.ref(`app_session_authority/${authUid}`).once('value'),
  ]);
  const session = sessionSnapshot.val();
  if (!isActiveSessionRecord(session, { nowMs })) return denied('SESSION_INACTIVE');
  const authority = authoritySnapshot.val();
  if (authority?.schemaVersion !== 1 || authority.state !== 'committed'
    || !/^[a-f0-9]{48}$/.test(authority.epoch || '')
    || authority.sessionId !== session.sessionId) return denied('SESSION_AUTHORITY_CHANGED');
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
      || !Number.isSafeInteger(participant.sessionExpiresAtMs)
      || participant.sessionExpiresAtMs <= nowMs) {
      return denied('PARTICIPANT_SESSION_MISMATCH');
    }
    if (user.stablePassengerId !== session.principalId
      || user.identityVersion !== 'pax_v2'
      || user.principalType !== 'passenger') {
      return denied('PASSENGER_PROFILE_MISMATCH');
    }
    if (typeof user.bookingRef !== 'string' || user.bookingRef.length > 160 || !isValidFirebaseKey(user.bookingRef)) {
      return denied('PASSENGER_PROFILE_MISMATCH');
    }
    const [bookingSnapshot, securitySnapshot] = await Promise.all([
      db.ref(`bookings/${user.bookingRef}`).once('value'),
      db.ref(`passenger_identity_security/${user.bookingRef}`).once('value'),
    ]);
    const security = securitySnapshot.val();
    if (security?.deviceAuthorizationVersion !== 2 || security.authorizedAuthUids?.[authUid] !== true
      || security.loginLocked === true || security.passengerPrincipalId !== session.principalId) return denied('PASSENGER_AUTHORITY_CHANGED');
    const booking = bookingSnapshot.val();
    if (!booking || typeof booking !== 'object' || Array.isArray(booking)
      || booking.loginEligible === false || booking.sourceRoster?.state === 'not_in_report') {
      return denied('BOOKING_NOT_LOGIN_ELIGIBLE');
    }
    let roster;
    try { roster = readSourceRoster(booking); } catch { return denied('SOURCE_ROSTER_INVALID'); }
    if (roster && roster.state !== 'active') return denied('BOOKING_NOT_LOGIN_ELIGIBLE');
    // Source publication can move a booking while retaining its former
    // participant/profile/history. That former session cannot confer access
    // to the old tour; a fresh login must establish the new passenger scope.
    if (normalizeTourKeyForComparison(booking.tourId) !== normalizeTourKeyForComparison(session.tourId)) {
      return denied('SESSION_TOUR_MISMATCH');
    }
  } else {
    const { verifyStaffSessionAuthority } = require('../src/domains/driver-auth/staffEnrolment');
    if (!(await verifyStaffSessionAuthority({ db, authUid, session }))) return denied('STAFF_AUTHORIZATION_REQUIRED');
    const [userSnapshot, driverSnapshot, policySnapshot, transitionSnapshot, staffSnapshot] = await Promise.all([
      db.ref(`users/${authUid}`).once('value'),
      db.ref(`drivers/${session.driverId}`).once('value'),
      db.ref('driver_login_policy/v1').once('value'),
      db.ref(`driver_assignment_active/v1/${session.driverId}`).once('value'),
      db.ref(`driver_staff_policy/${session.driverId}`).once('value'),
    ]);
    const user = userSnapshot.val() || {};
    const driver = driverSnapshot.val() || {};
    const policyValue = policySnapshot.val();
    let ownsAssignmentAdmission = false;
    if (transitionSnapshot.exists()) {
      const marker = transitionSnapshot.val();
      const admission = marker?.loginAdmissions?.[driverLoginAdmission?.assignmentAdmissionId];
      ownsAssignmentAdmission = driverLoginAdmission && marker?.schemaVersion === 1
        && Object.keys(marker).every(key => ['schemaVersion', 'loginAdmissions'].includes(key))
        && admission?.authUidHash === driverLoginAdmission.admissionAuthUidHash
        && Number.isSafeInteger(admission?.expiresAtMs) && admission.expiresAtMs > nowMs;
      if (!ownsAssignmentAdmission) return denied('DRIVER_ASSIGNMENT_MISMATCH');
    }
    // Only recovery of a server-admitted login can finish through its own drain.
    // Ordinary API access never receives this proof and remains fail closed.
    const admittedPolicy = policyValue?.loginAdmissions?.[driverLoginAdmission?.policyAdmissionId];
    const ownsDrainingPolicyAdmission = ownsAssignmentAdmission && policyValue?.transitionPhase === 'draining'
      && admittedPolicy?.schemaVersion === 1 && admittedPolicy.admissionType === 'driver_login'
      && admittedPolicy.authUidHash === driverLoginAdmission.admissionAuthUidHash
      && admittedPolicy.generation === session.driverLoginPolicyGeneration
      && admittedPolicy.policyRevision === driverLoginAdmission.admissionPolicyRevision
      && Number.isSafeInteger(driverLoginAdmission.admissionPolicyRevision)
      && policyValue.revision === driverLoginAdmission.admissionPolicyRevision + 1
      && Number.isSafeInteger(admittedPolicy.expiresAtMs) && admittedPolicy.expiresAtMs > nowMs;
    const policy = normalizeDriverLoginPolicy(policyValue, ownsDrainingPolicyAdmission);
    const sessionGeneration = Number.isSafeInteger(session.driverLoginPolicyGeneration)
      ? session.driverLoginPolicyGeneration
      : -1;
    if (!policy.valid || sessionGeneration !== policy.generation) {
      return denied('DRIVER_POLICY_MISMATCH');
    }
    if (user.driverId !== session.driverId
      || user.driverPrincipalId !== session.principalId
      || user.principalType !== 'driver'
      || (policy.enforceSingleDevice && (driver.authUid !== authUid
        || driver.authUidStaffGeneration !== staffSnapshot.val()?.generation))) {
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
    } else {
      if (driver.currentTourId || user.driverAssignedTourId) return denied('DRIVER_ASSIGNMENT_MISMATCH');
      if (!allowUnassignedDriver) return denied('DRIVER_UNASSIGNED');
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
