const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { driverAuthorityUpdates, sessionIdFor } = require('./sessionFixtures');
const { buildAssignmentOwnedDriverLocationPickup } = require('../../functions/lib/driverLocationPickup');

const PROJECT_ID = 'demo-llt-location-service';
const TOUR = 'TOUR_LOCATION';
const DRIVER = 'D-LOCATION';
const UID_A = 'location-driver-a';
const UID_B = 'location-driver-b';
const SID_A = sessionIdFor(UID_A);
const SID_B = sessionIdFor(UID_B);
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
    [`drivers/${DRIVER}/name`]: 'Synthetic driver',
    [`tours/${TOUR}`]: { name: 'Synthetic tour', driverId: DRIVER, driverAssignmentRevision: 7 },
    [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: true,
  };
  for (const uid of [UID_A, UID_B]) Object.assign(records, driverAuthorityUpdates({ uid, driverId: DRIVER, tourId: TOUR, nowMs: now }));
  await trusted(async db => { await db.ref().set(null); await db.ref().update(records); });
});

test('legacy automatic publication is denied even for a fully authorized driver', async () => {
  await assert.rejects(publish(client(UID_A), UID_A, SID_A, 'legacy_auto'), { code: 'EXPLICIT_TRACKING_REQUIRED' });
  const now = Date.now();
  await assertFails(client(UID_A).ref(key(SID_A, 'legacy_auto')).set({ schemaVersion: 2, isSharing: true, mode: 'live', source: 'auto',
    latitude: 56, longitude: -4, accuracy: 10, timestamp: now, cleanupAtMs: now + 30 * 60 * 1000,
    authUid: UID_A, appSessionId: SID_A, liveSharingSessionId: 'legacy_auto', driverId: DRIVER, tourId: TOUR }));
  await trusted(async db => assert.equal((await db.ref(key(SID_A, 'legacy_auto')).get()).exists(), false));
});

test('real SDK withdrawal cleans the exact retired leaf without reading private coordinates', async () => {
  await trusted(db => db.ref(key(SID_A, 'loc_retired_001')).set({ authUid: UID_A, appSessionId: SID_A, driverId: DRIVER, liveSharingSessionId: 'loc_retired_001', tourId: TOUR, latitude: 56 }));
  const db = client(UID_A);
  await assertFails(db.ref(key(SID_A, 'loc_retired_001')).once('value'));
  assert.equal((await withdraw(db, SID_A, 'loc_retired_001')).withdrawalAcknowledged, true);
  assert.equal((await withdraw(db, SID_A, 'loc_retired_001')).withdrawalAcknowledged, true);
  await trusted(async admin => assert.equal((await admin.ref(key(SID_A, 'loc_retired_001')).get()).exists(), false));
});

test('a stale compatibility cleanup cannot delete another handset or its assignment pickup', async () => {
  await trusted(async db => {
    await db.ref(key(SID_A, 'loc_old_001')).set({ authUid: UID_A, appSessionId: SID_A, driverId: DRIVER, liveSharingSessionId: 'loc_old_001', tourId: TOUR });
    await db.ref(key(SID_B, 'loc_current_001')).set({ authUid: UID_B, appSessionId: SID_B, driverId: DRIVER, liveSharingSessionId: 'loc_current_001', tourId: TOUR });
    await db.ref(`driver_location_pickups/${TOUR}`).set(buildAssignmentOwnedDriverLocationPickup({ driverId: DRIVER, tourId: TOUR, assignmentRevision: 7, location: { latitude: 56, longitude: -4 } }));
  });
  const db = client(UID_A);
  await assertFails(db.ref(key(SID_B, 'loc_current_001')).remove());
  await withdraw(db, SID_A, 'loc_old_001');
  await trusted(async admin => {
    assert.equal((await admin.ref(key(SID_B, 'loc_current_001')).get()).exists(), true);
    assert.equal((await admin.ref(`driver_location_pickups/${TOUR}`).get()).exists(), true);
  });
});

// Explicit start, native controller, independent authenticated REST, delayed replay,
// stop tombstones and projection acceptance remain covered by driverTrackingService.rules.test.js.
