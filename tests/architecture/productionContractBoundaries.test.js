'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  validateDriverAssignmentResponse,
  validateDriverLoginResponse,
  validatePassengerLoginResponse,
} = require('../../src/shared/contracts/generated/loginResponses');
const { validateResolvedMediaResponse } = require('../../src/shared/contracts/generated/mediaResponses');
const { validateNotificationPayload } = require('../../src/shared/contracts/generated/notificationPayload');
const { validateClientAppSession, validateRemoteAppSession } = require('../../src/shared/contracts/generated/appSession');

const repositoryRoot = path.resolve(__dirname, '../..');
const clientSession = {
  schemaVersion: 1,
  sessionId: `sess_v1_${'a'.repeat(32)}`,
  principalId: `pax_v2_${'b'.repeat(32)}`,
  principalType: 'passenger',
  tourId: 'TOUR_1',
  driverId: null,
  issuedAtMs: 1000,
  expiresAtMs: 2000,
  sessionRevision: 1,
};

test('focused generated boundary validators fail closed without rejecting valid response shapes', () => {
  assert.equal(validateClientAppSession(clientSession).valid, true);
  assert.equal(validateRemoteAppSession({
    ...clientSession,
    authUid: 'firebase-uid',
    status: 'active',
    lastAuthenticatedAtMs: 1000,
  }).valid, true);
  assert.equal(validateClientAppSession({ ...clientSession, email: 'secret@example.test' }).valid, false);

  const passengerSuccess = {
    valid: true,
    reason: 'OK',
    bookingRef: 'BOOK_1',
    tourId: 'TOUR_1',
    tourCode: null,
    stablePassengerId: clientSession.principalId,
    identityVersion: 'pax_v2',
    session: clientSession,
    booking: {},
    tour: {},
    grantExpiresAtMs: 2000,
  };
  assert.equal(validatePassengerLoginResponse(passengerSuccess).valid, true);
  assert.equal(validatePassengerLoginResponse({ valid: false, reason: 'INVALID_CREDENTIALS' }).valid, true);
  assert.equal(validatePassengerLoginResponse({ valid: true, session: clientSession, email: 'secret@example.test' }).valid, false);
  [123, [], {}].forEach((tourCode) => {
    assert.equal(validatePassengerLoginResponse({ ...passengerSuccess, tourCode }).valid, false);
  });
  assert.equal(validatePassengerLoginResponse({
    ...passengerSuccess,
    session: { ...clientSession, sessionRevision: 0 },
  }).valid, false);
  assert.equal(validatePassengerLoginResponse({ ...passengerSuccess, unexpected: true }).valid, false);
  assert.equal(validateDriverLoginResponse({ valid: false, reason: 'DRIVER_NOT_FOUND' }).valid, true);
  assert.equal(validateDriverLoginResponse({ valid: true, authUid: 'secret' }).valid, false);
  assert.equal(validateDriverAssignmentResponse({ success: false, reason: 'TOUR_NOT_FOUND' }).valid, true);
  assert.equal(validateDriverAssignmentResponse({ success: true, tourId: 'TOUR_1', driverCode: 'secret' }).valid, false);

  assert.equal(validateResolvedMediaResponse({ success: true, expiresAtMs: 2000, media: {} }).valid, true);
  assert.equal(validateResolvedMediaResponse({ success: true, expiresAtMs: 2000, media: {}, downloadToken: 'secret' }).valid, false);
  assert.equal(validateNotificationPayload({ screen: 'Chat', tourId: 'TOUR_1', timestamp: 1000 }).valid, true);
  assert.equal(validateNotificationPayload({ screen: 'Chat', tourId: 'TOUR_1', bookingRef: 'SECRET' }).valid, false);
  ['email', 'phone', 'signedUrl', 'token', 'unexpected'].forEach((field) => {
    assert.equal(validateNotificationPayload({
      screen: 'Chat',
      tourId: 'TOUR_1',
      timestamp: 1000,
      [field]: 'secret',
    }).valid, false);
  });
  ['1000', 0, -1, 1.5, null].forEach((timestamp) => {
    assert.equal(validateNotificationPayload({ screen: 'Chat', tourId: 'TOUR_1', timestamp }).valid, false);
  });
});

test('focused validators accept intended login, assignment, and resolved-media variants', () => {
  const assignedDriverSession = {
    ...clientSession,
    principalId: 'driver:D-100',
    principalType: 'driver',
    tourId: 'TOUR_1',
    driverId: 'D-100',
  };
  const unassignedDriverSession = { ...assignedDriverSession, tourId: null };
  assert.equal(validateDriverLoginResponse({
    valid: true,
    type: 'driver',
    driver: {
      id: 'D-100',
      name: null,
      assignedTourId: 'TOUR_1',
      assignedTourCode: null,
      hasAssignedTour: true,
    },
    tour: { id: 'TOUR_1' },
    assignmentStatus: 'ASSIGNED',
    identityClaimed: true,
    session: assignedDriverSession,
  }).valid, true);
  assert.equal(validateDriverLoginResponse({
    valid: true,
    type: 'driver',
    driver: {
      id: 'D-100',
      name: null,
      assignedTourId: null,
      assignedTourCode: null,
      hasAssignedTour: false,
    },
    tour: null,
    assignmentStatus: 'UNASSIGNED',
    identityClaimed: true,
    session: unassignedDriverSession,
  }).valid, true);
  assert.equal(validateDriverAssignmentResponse({
    success: true,
    tourId: 'TOUR_1',
    tourCode: '5001D 1',
    previousTourId: null,
    session: assignedDriverSession,
  }).valid, true);
  assert.equal(validateResolvedMediaResponse({
    success: true,
    expiresAtMs: 2000,
    media: {
      sourceOnly: { sourceUrl: 'https://signed.example/source' },
      variants: {
        viewerUrl: 'https://signed.example/viewer',
        thumbnailUrl: 'https://signed.example/thumbnail',
      },
    },
  }).valid, true);
  assert.equal(validateResolvedMediaResponse({
    success: true,
    expiresAtMs: 2000,
    media: { photo: { downloadToken: 'secret' } },
  }).valid, false);
});

test('production boundary modules route untrusted values through focused generated adapters', () => {
  const expectations = new Map([
    ['src/app/session/appSessionBoundary.js', 'contracts/generated/appSession'],
    ['src/shared/api/responseBoundaries.js', 'contracts/generated/loginResponses'],
    ['src/shared/api/responseBoundaries.js#media', 'contracts/generated/mediaResponses'],
    ['src/app/navigation/notificationNavigationBoundary.js', 'contracts/generated/notificationPayload'],
    ['web-admin/src/shared/session/appSessionBoundary.js', 'contracts/generated/appSession'],
  ]);
  expectations.forEach((specifier, keyedPath) => {
    const relativePath = keyedPath.split('#')[0];
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    assert.match(source, new RegExp(specifier, 'u'), relativePath);
  });

  const consumers = [
    ['services/appSessionService.js', 'appSessionBoundary'],
    ['services/booking/bookingVerifierService.js', 'responseBoundaries'],
    ['services/booking/manifestService.js', 'responseBoundaries'],
    ['services/photo/photoMediaService.js', 'responseBoundaries'],
    ['utils/notificationRouting.js', 'notificationNavigationBoundary'],
    ['web-admin/src/services/appSessionAdminService.js', 'appSessionBoundary'],
  ];
  consumers.forEach(([relativePath, boundary]) => {
    assert.match(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'), new RegExp(boundary, 'u'), relativePath);
  });
});
