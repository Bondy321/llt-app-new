const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'demo-bucket.appspot.com' });
const { __testables } = require('../functions/index');

const snapshot = (value) => ({
  val: () => value,
  exists: () => value !== null && value !== undefined,
  child: (path) => snapshot(path.split('/').filter(Boolean).reduce(
    (current, segment) => (current == null ? undefined : current[segment]),
    value,
  )),
});

const dbFor = (values) => ({
  ref: (path) => ({ once: async () => snapshot(values[path]) }),
});

test('group media access accepts only a current passenger or coherently assigned driver', async () => {
  const passengerId = 'pax_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const expiresAtMs = Date.now() + 60_000;
  const values = {
    'tours/TOUR_A': { participants: { passengerA: {
      schemaVersion: 2,
      userId: 'passengerA',
      principalId: passengerId,
      sessionId: 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sessionExpiresAtMs: expiresAtMs,
    } } },
    'tours/TOUR_A/participants/passengerA': {
      schemaVersion: 2,
      userId: 'passengerA',
      principalId: passengerId,
      sessionId: 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sessionExpiresAtMs: expiresAtMs,
    },
    'app_sessions/passengerA': {
      schemaVersion: 1,
      sessionId: 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authUid: 'passengerA',
      principalType: 'passenger',
      principalId: passengerId,
      driverId: null,
      tourId: 'TOUR_A',
      status: 'active',
      issuedAtMs: Date.now() - 1_000,
      lastAuthenticatedAtMs: Date.now() - 1_000,
      expiresAtMs,
      sessionRevision: 1,
    },
    'users/passengerA': { stablePassengerId: passengerId, identityVersion: 'pax_v2', principalType: 'passenger' },
    'admin_users/passengerA': null,
    'tours/TOUR_B': { participants: {} },
    'app_sessions/driverA': {
      schemaVersion: 1,
      sessionId: 'sess_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      authUid: 'driverA', principalType: 'driver', principalId: 'driver:D-1', driverId: 'D-1',
      tourId: 'TOUR_A', status: 'active', issuedAtMs: Date.now() - 1_000,
      lastAuthenticatedAtMs: Date.now() - 1_000, expiresAtMs, sessionRevision: 1,
    },
    'users/driverA': { driverId: 'D-1', driverPrincipalId: 'driver:D-1', principalType: 'driver', driverAssignedTourId: 'TOUR_A' },
    'admin_users/driverA': null,
    'drivers/D-1': { authUid: 'driverA', currentTourId: 'TOUR_A' },
    'tour_manifests/TOUR_A/assigned_drivers/D-1': true,
    'app_sessions/staleDriver': {
      schemaVersion: 1,
      sessionId: 'sess_v1_cccccccccccccccccccccccccccccccc',
      authUid: 'staleDriver', principalType: 'driver', principalId: 'driver:D-2', driverId: 'D-2',
      tourId: 'TOUR_A', status: 'active', issuedAtMs: Date.now() - 1_000,
      lastAuthenticatedAtMs: Date.now() - 1_000, expiresAtMs, sessionRevision: 1,
    },
    'users/staleDriver': { driverId: 'D-2', driverPrincipalId: 'driver:D-2', principalType: 'driver', driverAssignedTourId: 'TOUR_A' },
    'admin_users/staleDriver': null,
    'drivers/D-2': { authUid: 'staleDriver', currentTourId: 'OLD_TOUR' },
    'tour_manifests/TOUR_A/assigned_drivers/D-2': true,
  };
  const db = dbFor(values);
  const passengerAccess = await __testables.verifyCurrentTourPhotoAccess({ db, authUid: 'passengerA', tourId: 'TOUR_A' });
  assert.equal(passengerAccess.allowed, true);
  assert.equal(passengerAccess.role, 'passenger');
  assert.equal(passengerAccess.principalId, passengerId);
  assert.equal(passengerAccess.session.sessionId, 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((await __testables.verifyCurrentTourPhotoAccess({ db, authUid: 'passengerA', tourId: 'TOUR_B' })).allowed, false);
  const driverAccess = await __testables.verifyCurrentTourPhotoAccess({ db, authUid: 'driverA', tourId: 'TOUR_A' });
  assert.equal(driverAccess.allowed, true);
  assert.equal(driverAccess.role, 'assigned_driver');
  assert.equal(driverAccess.principalId, 'driver:D-1');
  assert.equal(driverAccess.driverId, 'D-1');
  assert.equal((await __testables.verifyCurrentTourPhotoAccess({ db, authUid: 'staleDriver', tourId: 'TOUR_A' })).allowed, false);
  assert.equal((await __testables.verifyCurrentTourPhotoAccess({ db, authUid: 'passengerA', tourId: 'INVENTED' })).reason, 'NOT_FOUND');
});

test('group media path validation and request bounds reject cross-tour and oversized requests', () => {
  assert.equal(__testables.isGroupMediaPathForRecord({
    path: 'group_tour_photos/TOUR_A/source.jpg', tourId: 'TOUR_A',
  }), true);
  assert.equal(__testables.isGroupMediaPathForRecord({
    path: 'group_tour_photos/TOUR_B/source.jpg', tourId: 'TOUR_A',
  }), false);
  assert.equal(__testables.isGroupMediaPathForRecord({
    path: 'group_tour_photos/TOUR_A/../TOUR_B/source.jpg', tourId: 'TOUR_A',
  }), false);
  assert.deepEqual(__testables.normalizeGroupMediaRequest({
    tourId: 'TOUR_A', photoIds: ['p1', 'p1', 'p2'],
  }), { tourId: 'TOUR_A', photoIds: ['p1', 'p2'] });
  assert.equal(__testables.normalizeGroupMediaRequest({
    tourId: 'TOUR_A', photoIds: Array.from({ length: 51 }, (_, index) => `p${index}`),
  }), null);
});

test('group media App Check supports explicit disable, fails closed when missing, and verifies enabled tokens', async () => {
  await assert.rejects(
    __testables.enforceGroupMediaAppCheck({ headers: {} }, { K_SERVICE: 'deployed' }, { verifyToken: async () => {} }),
    (error) => error.code === 'GROUP_MEDIA_APP_CHECK_CONFIGURATION_REQUIRED',
  );
  let disabledVerificationCalls = 0;
  assert.equal(await __testables.enforceGroupMediaAppCheck(
    { headers: {} },
    { K_SERVICE: 'deployed', REQUIRE_APP_CHECK_FOR_GROUP_MEDIA: 'false' },
    { verifyToken: async () => { disabledVerificationCalls += 1; } },
  ), true);
  assert.equal(disabledVerificationCalls, 0);
  assert.equal(await __testables.enforceGroupMediaAppCheck(
    { headers: {} },
    { K_SERVICE: 'deployed', REQUIRE_APP_CHECK_FOR_GROUP_MEDIA: 'true' },
    { verifyToken: async () => {} },
  ), false);
  let verified = null;
  assert.equal(await __testables.enforceGroupMediaAppCheck(
    { headers: { 'x-firebase-appcheck': 'valid-token' } },
    { K_SERVICE: 'deployed', REQUIRE_APP_CHECK_FOR_GROUP_MEDIA: 'true' },
    { verifyToken: async (token) => { verified = token; } },
  ), true);
  assert.equal(verified, 'valid-token');
});

test('group upload metadata is deterministic and contains no customer identity', () => {
  const encoded = encodeURIComponent(JSON.stringify({
    tourId: 'TOUR_A', idempotencyKey: 'photo-job-1', caption: 'Loch view', uploaderName: 'Alex',
  }));
  assert.deepEqual(__testables.normalizeGroupPhotoUploadMetadata(encoded), {
    tourId: 'TOUR_A', idempotencyKey: 'photo-job-1', caption: 'Loch view', uploaderName: 'Alex',
  });
  assert.equal(__testables.extensionForGroupPhotoContentType('image/jpeg'), 'jpg');
  assert.equal(__testables.extensionForGroupPhotoContentType('text/plain'), null);
});
