'use strict';

const { randomUUID } = require('crypto');

const PASSENGER_IDENTITY_VERSION = 'pax_v2';
const OPAQUE_PASSENGER_ID_PATTERN = /^pax_v2_[a-f0-9]{32}$/;
const LEGACY_PASSENGER_ID_PATTERN = /^pax_v1:/;

const createOpaquePassengerId = ({ uuid = randomUUID } = {}) => (
  `pax_v2_${uuid().replace(/-/g, '').toLowerCase()}`
);

const isOpaquePassengerId = (value) => (
  typeof value === 'string' && OPAQUE_PASSENGER_ID_PATTERN.test(value.trim())
);

const isLegacyPassengerId = (value) => (
  typeof value === 'string' && LEGACY_PASSENGER_ID_PATTERN.test(value.trim())
);

const ensureOpaquePassengerIdentity = async ({
  securityRef,
  seed = {},
  createId = createOpaquePassengerId,
  nowMs = Date.now(),
} = {}) => {
  if (!securityRef?.transaction) {
    throw new Error('A passenger identity security transaction reference is required');
  }

  const result = await securityRef.transaction((current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return {
        ...(seed && typeof seed === 'object' && !Array.isArray(seed) ? seed : {}),
        passengerPrincipalId: createId(),
        passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
        passengerIdentityIssuedAtMs: nowMs,
      };
    }
    if (isOpaquePassengerId(current.passengerPrincipalId)) return current;
    return {
      ...current,
      passengerPrincipalId: createId(),
      passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
      passengerIdentityIssuedAtMs: nowMs,
    };
  });

  const value = result?.snapshot?.val?.() || null;
  if (!result?.committed || !isOpaquePassengerId(value?.passengerPrincipalId)) {
    throw new Error('Unable to issue an opaque passenger identity');
  }
  return {
    identity: value,
    passengerPrincipalId: value.passengerPrincipalId,
    identityVersion: PASSENGER_IDENTITY_VERSION,
  };
};

const authorizePassengerLoginDevice = async ({ securityRef, authUid } = {}) => {
  if (!securityRef?.transaction || typeof authUid !== 'string' || !authUid.trim()) {
    throw new Error('A passenger security reference and authenticated UID are required');
  }
  let rejectionReason = null;
  const result = await securityRef.transaction((current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      rejectionReason = 'IDENTITY_INCOMPLETE';
      return;
    }
    if (!isOpaquePassengerId(current.passengerPrincipalId)) {
      rejectionReason = 'IDENTITY_INCOMPLETE';
      return;
    }
    if (current.loginLocked === true) {
      rejectionReason = 'REAUTHORIZE_REQUIRED';
      return;
    }
    const authorizedAuthUid = typeof current.authorizedAuthUid === 'string'
      ? current.authorizedAuthUid.trim()
      : '';
    if (authorizedAuthUid && authorizedAuthUid !== authUid) {
      rejectionReason = 'REAUTHORIZE_REQUIRED';
      return;
    }
    if (authorizedAuthUid === authUid) return current;
    return {
      ...current,
      authorizedAuthUid: authUid,
      loginDeviceBoundAtMs: Date.now(),
    };
  });
  if (!result?.committed) {
    const error = new Error(rejectionReason || 'Unable to authorize passenger login device');
    error.code = rejectionReason || 'IDENTITY_INCOMPLETE';
    throw error;
  }
  return result.snapshot.val();
};

const buildPassengerIdentitySecurityUpdates = ({
  authUid,
  bookingRef,
  tourId,
  passengerPrincipalId,
  previousProfile = {},
  nowMs = Date.now(),
} = {}) => {
  if (!authUid || !bookingRef || !tourId || !isOpaquePassengerId(passengerPrincipalId)) return null;

  const updates = {
    [`users/${authUid}/stablePassengerId`]: passengerPrincipalId,
    [`users/${authUid}/stablePassengerKey`]: passengerPrincipalId,
    [`users/${authUid}/privatePhotoOwnerId`]: passengerPrincipalId,
    [`users/${authUid}/privatePhotoOwnerKey`]: passengerPrincipalId,
    [`users/${authUid}/privatePhotoOwnerType`]: 'opaque_passenger',
    [`users/${authUid}/identityVersion`]: PASSENGER_IDENTITY_VERSION,
    [`users/${authUid}/bookingRef`]: bookingRef,
    [`users/${authUid}/normalizedPassengerEmail`]: null,
    [`users/${authUid}/lastUpdated`]: nowMs,
    [`identity_bindings/${passengerPrincipalId}/${authUid}`]: true,
    [`identity_bindings_meta/${passengerPrincipalId}`]: {
      identityVersion: PASSENGER_IDENTITY_VERSION,
      lastSeenAt: nowMs,
    },
  };

  const previousIds = new Set([
    previousProfile?.stablePassengerId,
    previousProfile?.stablePassengerKey,
    previousProfile?.privatePhotoOwnerId,
    previousProfile?.privatePhotoOwnerKey,
  ].filter((value) => typeof value === 'string' && value && value !== passengerPrincipalId));
  previousIds.forEach((previousId) => {
    updates[`identity_bindings/${previousId}/${authUid}`] = null;
    updates[`identity_bindings_meta/${previousId}`] = null;
  });
  return updates;
};

module.exports = {
  PASSENGER_IDENTITY_VERSION,
  OPAQUE_PASSENGER_ID_PATTERN,
  buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice,
  createOpaquePassengerId,
  ensureOpaquePassengerIdentity,
  isLegacyPassengerId,
  isOpaquePassengerId,
};
