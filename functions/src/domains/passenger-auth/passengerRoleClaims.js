'use strict';

// @ts-check

const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');

const { PASSENGER_IDENTITY_VERSION } = loadLegacyLibrary('passengerIdentity');

const LEGACY_DRIVER_AUTHORITY_CLAIMS = new Set([
  'driverId',
  'driverPrincipalId',
  'driverAssignedTourId',
  'driverLoginPolicyGeneration',
  'isDriver',
]);

const buildPassengerCustomClaims = (existingClaims, privatePhotoOwnerKey) => ({
  ...Object.fromEntries(Object.entries(existingClaims || {})
    .filter(([name]) => !LEGACY_DRIVER_AUTHORITY_CLAIMS.has(name))),
  privatePhotoOwnerKey,
  passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
});

module.exports = { buildPassengerCustomClaims };
