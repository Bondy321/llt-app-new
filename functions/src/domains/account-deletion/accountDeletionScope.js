'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');

const { isActiveSessionRecord, isValidAppSessionId } = loadLegacyLibrary('appSession');
const { isOpaquePassengerId } = loadLegacyLibrary('passengerIdentity');

const scopeFailure = (reason = 'ACCOUNT_DELETION_SCOPE_INCOMPLETE') => ({ valid: false, reason });

// eslint-disable-next-line complexity -- trusted passenger and driver scope validation must fail closed in one boundary
const deriveTrustedAccountDeletionScope = async ({ db, authUid, expectedSessionId, nowMs = Date.now() }) => {
  if (!db?.ref || !isValidFirebaseKey(authUid) || !isValidAppSessionId(expectedSessionId)) {
    return scopeFailure('INVALID_INPUT');
  }
  const [sessionSnapshot, profileSnapshot, deviceSnapshot] = await Promise.all([
    db.ref(`app_sessions/${authUid}`).once('value'),
    db.ref(`users/${authUid}`).once('value'),
    db.ref(`notification_devices/${authUid}`).once('value'),
  ]);
  const session = sessionSnapshot.val();
  const profile = profileSnapshot.val();
  const notificationDevice = deviceSnapshot.val() || null;
  if (!isActiveSessionRecord(session, { nowMs }) || session.authUid !== authUid
    || session.sessionId !== expectedSessionId || !profile || typeof profile !== 'object') {
    return scopeFailure(session?.sessionId && session.sessionId !== expectedSessionId
      ? 'SESSION_CHANGED' : 'ACCOUNT_DELETION_SCOPE_INCOMPLETE');
  }

  if (session.principalType === 'driver') {
    const driverId = typeof session.driverId === 'string' ? session.driverId.trim() : '';
    if (!isValidFirebaseKey(driverId) || session.principalId !== `driver:${driverId}`
      || profile.driverId !== driverId || profile.driverPrincipalId !== session.principalId
      || profile.principalType !== 'driver') return scopeFailure();
    const driverSnapshot = await db.ref(`drivers/${driverId}`).once('value');
    if (!driverSnapshot.exists()) return scopeFailure();
    return {
      valid: true,
      session,
      profile,
      notificationDevice,
      privateScope: {
        authUid,
        expectedSessionId,
        principalType: 'driver',
        principalId: session.principalId,
        tourId: typeof session.tourId === 'string' && session.tourId ? session.tourId : null,
        driverId,
        actorKeys: [authUid],
      },
    };
  }

  if (session.principalType !== 'passenger' || !isValidFirebaseKey(session.tourId)) return scopeFailure();
  const bookingRef = typeof profile.bookingRef === 'string' ? profile.bookingRef.trim() : '';
  const stablePassengerId = typeof profile.stablePassengerId === 'string' ? profile.stablePassengerId.trim() : '';
  const stablePassengerKey = typeof profile.stablePassengerKey === 'string' ? profile.stablePassengerKey.trim() : '';
  const privatePhotoOwnerKey = typeof profile.privatePhotoOwnerKey === 'string'
    ? profile.privatePhotoOwnerKey.trim()
    : '';
  if (!isValidFirebaseKey(bookingRef) || !isOpaquePassengerId(stablePassengerId)
    || stablePassengerKey !== stablePassengerId || privatePhotoOwnerKey !== stablePassengerId
    || session.principalId !== stablePassengerId || profile.principalType !== 'passenger') return scopeFailure();
  const [securitySnapshot, bindingSnapshot] = await Promise.all([
    db.ref(`passenger_identity_security/${bookingRef}`).once('value'),
    db.ref(`identity_bindings/${stablePassengerKey}/${authUid}`).once('value'),
  ]);
  const security = securitySnapshot.val();
  if (!security || security.authorizedAuthUid !== authUid
    || security.passengerPrincipalId !== stablePassengerId || bindingSnapshot.val() !== true) return scopeFailure();
  return {
    valid: true,
    session,
    profile,
    notificationDevice,
    privateScope: {
      authUid,
      expectedSessionId,
      principalType: 'passenger',
      principalId: stablePassengerId,
      tourId: session.tourId,
      bookingRef,
      stablePassengerId,
      stablePassengerKey,
      privatePhotoOwnerKey,
      actorKeys: [...new Set([authUid, stablePassengerId, stablePassengerKey, privatePhotoOwnerKey])],
    },
  };
};

module.exports = { deriveTrustedAccountDeletionScope };
