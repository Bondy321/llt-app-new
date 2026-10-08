const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { reconcileDriverLocationProjection } = require('../../functions/lib/driverLocationProjection');
const { buildAssignmentOwnedDriverLocationPickup } = require('../../functions/lib/driverLocationPickup');

const PROJECT_ID = 'demo-llt-location-service';
const TOUR = 'TOUR_LOCATION';
const DRIVER = 'D-LOCATION';
const UID_A = 'location-driver-a';
const UID_B = 'location-driver-b';
const SID_A = `sess_v1_${'a'.repeat(32)}`;
const SID_B = `sess_v1_${'b'.repeat(32)}`;
let environment;
let databaseURL;
let service;
const key = (sid, live) => `driver_location_sessions/${sid}|${live}`;
const scope = (uid, sid) => ({ authUid: uid, sessionId: sid, role: 'driver',
  principalId: `driver:${DRIVER}`, cacheOwnerId: DRIVER, tourId: TOUR });
const publish = (db, uid, sid, live, latitude = 56.1) => service.publishDriverLocation({
  dbInstance: db, sessionScope: scope(uid, sid), tourId: TOUR, source: 'auto', sessionId: live,
  location: { latitude, longitude: -4.2, accuracy: 12 },
});
const withdraw = (db, sid, live) => service.withdrawLiveDriverLocation({
  dbInstance: db, tourId: TOUR, appSessionId: sid, expectedSessionId: live,
});
const trusted = (callback) => environment.withSecurityRulesDisabled(context => callback(context.database(databaseURL)));
const client = uid => environment.authenticatedContext(uid).database(databaseURL);

test.before(async () => {
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  databaseURL = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  environment = await initializeTestEnvironment({ projectId: PROJECT_ID, database: {
    host, port: Number(port), rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8'),
  } });
  service = await import('../../services/driverLocationService.js');
});
test.after(async () => { await environment?.cleanup(); });
test.beforeEach(async () => {
  const now = Date.now();
  const records = {
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: now },
    [`drivers/${DRIVER}`]: { authUid: UID_A, currentTourId: TOUR, name: 'Synthetic driver' },
    [`tours/${TOUR}`]: { name: 'Synthetic tour', driverId: DRIVER, driverAssignmentRevision: 7 },
    [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: true,
  };
  for (const [uid, sid] of [[UID_A, SID_A], [UID_B, SID_B]]) {
    records[`users/${uid}`] = { principalType: 'driver', driverId: DRIVER,
      driverPrincipalId: `driver:${DRIVER}`, driverAssignedTourId: TOUR };
    records[`app_sessions/${uid}`] = { schemaVersion: 1, sessionId: sid, authUid: uid,
      principalId: `driver:${DRIVER}`, principalType: 'driver', tourId: TOUR, driverId: DRIVER,
      driverLoginPolicyGeneration: 0, status: 'active', issuedAtMs: now,
      lastAuthenticatedAtMs: now, expiresAtMs: now + 3600000, sessionRevision: 1 };
  }
  await trusted(async db => { await db.ref().set(null); await db.ref().update(records); });
});

test('real write-only service publishes and withdraws with server acknowledgements; projection becomes a tombstone', async () => {
  const db = client(UID_A);
  const live = 'loc_service_first';
  const published = await publish(db, UID_A, SID_A, live);
  assert.equal(published.publicationAcknowledged, true);
  assert.equal(published.storedLocation, null);
  assert.match(published.timestampSource, /^(server|client)_estimate$/);
  await assertFails(db.ref(key(SID_A, live)).once('value'));
  await trusted(async admin => {
    const source = (await admin.ref(key(SID_A, live)).get()).val();
    assert.equal(typeof source.timestamp, 'number');
    assert.ok(Math.abs(source.timestamp - Date.now()) < 60000);
    const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(result.projection.latitude, 56.1);
    for (const field of ['authUid', 'appSessionId', 'liveSharingSessionId', 'driverId']) {
      assert.equal(Object.hasOwn(result.projection, field), false);
    }
  });
  assert.equal((await withdraw(db, SID_A, live)).withdrawalAcknowledged, true);
  assert.equal((await withdraw(db, SID_A, live)).withdrawalAcknowledged, true);
  await trusted(async admin => {
    assert.equal((await admin.ref(key(SID_A, live)).get()).exists(), false);
    const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(result.projection, null);
    assert.equal((await admin.ref(`tours/${TOUR}/driverLocation`).get()).val().isSharing, false);
  });
});

test('stopping an old live session preserves another handset and the assignment-owned pickup fallback', async () => {
  const a = client(UID_A); const b = client(UID_B);
  await trusted(admin => admin.ref(`driver_location_pickups/${TOUR}`).set(buildAssignmentOwnedDriverLocationPickup({
    driverId: DRIVER, tourId: TOUR, assignmentRevision: 7,
    location: { latitude: 55.9, longitude: -4.1, accuracy: 8 },
  })));
  await publish(a, UID_A, SID_A, 'loc_service_old');
  await publish(b, UID_B, SID_B, 'loc_service_new', 56.2);
  await assertFails(a.ref(key(SID_B, 'loc_service_new')).remove());
  await withdraw(a, SID_A, 'loc_service_old');
  await trusted(async admin => {
    assert.equal((await admin.ref(key(SID_B, 'loc_service_new')).get()).exists(), true);
    const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(result.projection.latitude, 56.2);
  });
  await withdraw(b, SID_B, 'loc_service_new');
  await trusted(async admin => {
    const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(result.projection.mode, 'pickup');
    assert.equal(result.projection.latitude, 55.9);
    assert.equal((await admin.ref(`driver_location_pickups/${TOUR}`).get()).exists(), true);
  });
});

for (const [reason, update] of [
  ['logout', () => ({ [`app_sessions/${UID_A}/status`]: 'ended' })],
  ['revocation', () => ({ [`app_sessions/${UID_A}/status`]: 'revoked' })],
  ['expiry', () => ({ [`app_sessions/${UID_A}/expiresAtMs`]: Date.now() - 1000 })],
  ['reassignment', () => ({ [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: null })],
]) test(`${reason} denies successful client publication/withdrawal and excludes retained sources from the public projection`, async () => {
  const db = client(UID_A);
  await publish(db, UID_A, SID_A, 'loc_service_revoked');
  await trusted(admin => admin.ref().update(update()));
  await assert.rejects(publish(db, UID_A, SID_A, 'loc_service_revoked'));
  await assert.rejects(withdraw(db, SID_A, 'loc_service_revoked'));
  await trusted(async admin => {
    const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(result.projection, null);
    assert.equal((await admin.ref(`tours/${TOUR}/driverLocation`).get()).val().isSharing, false);
  });
});

test('the armed disconnect handler actually removes its private live source', async () => {
  const db = client(UID_A);
  const live = 'loc_service_disconnect';
  await publish(db, UID_A, SID_A, live);
  db.goOffline();
  try {
    await trusted(async admin => {
      const deadline = Date.now() + 10000;
      while ((await admin.ref(key(SID_A, live)).get()).exists()) {
        assert.ok(Date.now() < deadline, 'disconnect cleanup must remove the source');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const result = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
      assert.equal(result.projection, null);
    });
  } finally { db.goOnline(); }
});
