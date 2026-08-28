'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPassengerCustomClaims,
} = require('../functions/src/domains/passenger-auth/passengerLoginWorkflow');

test('passenger claim issuance clears every known legacy driver-authority claim', () => {
  const claims = buildPassengerCustomClaims({
    admin: true,
    driverId: 'D-OLD',
    driverPrincipalId: 'driver:D-OLD',
    driverAssignedTourId: 'TOUR_OLD',
    driverLoginPolicyGeneration: 9,
    isDriver: true,
    privatePhotoOwnerKey: 'pax_v2_old',
    passengerIdentityVersion: 1,
  }, 'pax_v2_0123456789abcdef0123456789abcdef');

  assert.deepEqual(claims, {
    admin: true,
    privatePhotoOwnerKey: 'pax_v2_0123456789abcdef0123456789abcdef',
    passengerIdentityVersion: 'pax_v2',
  });
});
