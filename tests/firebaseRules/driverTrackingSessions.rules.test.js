'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { reconcileDriverLocationProjection } = require('../../functions/lib/driverLocationProjection');
const { buildAssignmentOwnedDriverLocationPickup } = require('../../functions/lib/driverLocationPickup');
const { reconcileDriverTrackingIntentChange } = require('../../functions/src/domains/live-state/driverTrackingSessions');
const { performDriverTrackingStop } = require('../../functions/src/domains/live-state/driverTrackingStop');

const PROJECT_ID = 'demo-llt-tracking-intent';
const UID = 'tracking-driver-a';
const OTHER_UID = 'tracking-driver-b';
const DRIVER = 'D-TRACK';
const TOUR = 'TOUR_TRACK';
const SID = `sess_v1_${'a'.repeat(32)}`;
const OTHER_SID = `sess_v1_${'b'.repeat(32)}`;
const LIVE = 'track_first';
const sourceKey = (live = LIVE, sid = SID) => `${sid}|${live}`;
const intentPath = (live = LIVE, sid = SID) => `driver_tracking_sessions/${sourceKey(live, sid)}`;
const locationPath = (live = LIVE, sid = SID) => `driver_location_sessions/${sourceKey(live, sid)}`;
let environment;
let databaseURL;
let nowMs;
let expiresAtMs;
const trusted = (callback) => environment.withSecurityRulesDisabled(context => callback(context.database(databaseURL)));
const client = (uid = UID) => environment.authenticatedContext(uid).database(databaseURL);
const intent = (overrides = {}) => ({ schemaVersion: 1, authUid: UID, appSessionId: SID,
  driverId: DRIVER, tourId: TOUR, liveSharingSessionId: LIVE, status: 'active',
  startedAtMs: nowMs, expiresAtMs, ...overrides });
const location = (overrides = {}) => ({ schemaVersion: 2, isSharing: true, source: 'auto', mode: 'live',
  authUid: UID, appSessionId: SID, driverId: DRIVER, tourId: TOUR, liveSharingSessionId: LIVE,
  latitude: 56.1, longitude: -4.2, accuracy: 12, timestamp: Date.now(), cleanupAtMs: Date.now() + 1800000,
  ...overrides });

test.before(async () => {
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  databaseURL = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  environment = await initializeTestEnvironment({ projectId: PROJECT_ID, database: {
    host, port: Number(port), rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8'),
  } });
});
test.after(async () => { await environment?.cleanup(); });
test.beforeEach(async () => {
  nowMs = Date.now(); expiresAtMs = nowMs + 3600000;
  const records = {
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: nowMs },
    [`drivers/${DRIVER}`]: { authUid: UID, currentTourId: TOUR, name: 'Synthetic driver' },
    [`tours/${TOUR}`]: { name: 'Synthetic tour', driverId: DRIVER, driverAssignmentRevision: 7 },
    [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: true,
  };
  for (const [uid, sid] of [[UID, SID], [OTHER_UID, OTHER_SID]]) {
    records[`users/${uid}`] = { principalType: 'driver', driverId: DRIVER,
      driverPrincipalId: `driver:${DRIVER}`, driverAssignedTourId: TOUR };
    records[`app_sessions/${uid}`] = { schemaVersion: 1, sessionId: sid, authUid: uid,
      principalId: `driver:${DRIVER}`, principalType: 'driver', driverId: DRIVER, tourId: TOUR,
      driverLoginPolicyGeneration: 0, status: 'active', issuedAtMs: nowMs,
      lastAuthenticatedAtMs: nowMs, expiresAtMs, sessionRevision: 1 };
  }
  await trusted(async db => { await db.ref().set(null); await db.ref().update(records); });
});

test('intent is write-only and cannot confer permission; tracked publication requires exact active intent', async () => {
  const db = client();
  await assertFails(db.ref(locationPath()).set(location()));
  await assertSucceeds(db.ref(intentPath()).set(intent()));
  await assertFails(db.ref(intentPath()).get());
  await assertFails(db.ref('driver_tracking_sessions').get());
  await assertFails(client(OTHER_UID).ref(intentPath()).get());
  await assertSucceeds(db.ref(locationPath()).set(location()));
  await assertFails(client(OTHER_UID).ref(locationPath()).set(location({ authUid: OTHER_UID, appSessionId: OTHER_SID })));
  await assertFails(db.ref(intentPath()).remove());
  await assertFails(db.ref(intentPath()).set(intent()));
  await assertFails(db.ref('driver_tracking_sessions/arbitrary').set(intent()));
  await assertSucceeds(db.ref(locationPath('loc_legacy')).set(location({ liveSharingSessionId: 'loc_legacy' })));
});

test('stop tombstone blocks delayed publications and reactivation while a new tracking ID remains available', async () => {
  const db = client();
  await db.ref(intentPath()).set(intent());
  await db.ref(locationPath()).set(location());
  await assertSucceeds(db.ref(intentPath()).set(intent({ status: 'stopped' })));
  await assertSucceeds(db.ref(intentPath()).set(intent({ status: 'stopped' })));
  await assertFails(db.ref(locationPath()).set(location()));
  await assertFails(db.ref(intentPath()).set(intent()));
  await assertSucceeds(db.ref(locationPath()).remove());
  await assertSucceeds(db.ref(locationPath()).remove());
  await assertFails(db.ref(locationPath()).set(location()));
  await assertSucceeds(db.ref(intentPath('track_second')).set(intent({ liveSharingSessionId: 'track_second' })));
  await assertSucceeds(db.ref(locationPath('track_second')).set(location({ liveSharingSessionId: 'track_second' })));
});

test('ambiguous start can create a stopped fence under full authority and acknowledge absent source deletion', async () => {
  const db = client();
  await assertSucceeds(db.ref(intentPath()).set(intent({ status: 'stopped' })));
  await assertSucceeds(db.ref(locationPath()).remove());
  await assertFails(db.ref(locationPath()).set(location()));
  await assertFails(db.ref(intentPath()).set(intent()));
  await assertFails(client(OTHER_UID).ref(locationPath()).remove());
  await trusted(admin => admin.ref(`app_sessions/${UID}/status`).set('revoked'));
  await assertFails(db.ref(intentPath('track_absent')).set(intent({ status: 'stopped', liveSharingSessionId: 'track_absent' })));
  await assertSucceeds(db.ref(intentPath()).set(intent({ status: 'stopped' })));
  await assertSucceeds(db.ref(locationPath()).remove());
});

test('server stop recovers rejected old and future start clocks under exact current authority', async () => {
  for (const startedAtMs of [nowMs - 120000, nowMs + 120000]) {
    const liveSharingSessionId = startedAtMs < nowMs ? 'track_oldclock' : 'track_futureclock';
    const active = intent({ startedAtMs, liveSharingSessionId });
    await assertFails(client().ref(intentPath(liveSharingSessionId)).set(active));
    const stopped = { ...active, status: 'stopped' };
    await trusted(async admin => {
      const result = await performDriverTrackingStop({ db: admin, authUid: UID, input: stopped });
      assert.equal(result.status, 200);
      assert.equal(result.payload.withdrawalAcknowledged, true);
      assert.deepEqual((await admin.ref(intentPath(liveSharingSessionId)).get()).val(), stopped);
    });
    await assertFails(client().ref(locationPath(liveSharingSessionId)).set(location({ liveSharingSessionId })));
  }
});

test('server missing-fence stop cleans owned retained source after revocation and rejects foreign caller', async () => {
  const stopped = intent({ status: 'stopped' });
  await trusted(async admin => {
    await admin.ref(locationPath()).set(location());
    await admin.ref(`app_sessions/${UID}/status`).set('revoked');
    const denied = await performDriverTrackingStop({ db: admin, authUid: OTHER_UID, input: stopped });
    assert.equal(denied.status, 403);
    assert.equal((await admin.ref(locationPath()).get()).exists(), true);
    const result = await performDriverTrackingStop({ db: admin, authUid: UID, input: stopped });
    assert.equal(result.status, 200);
    assert.equal(result.payload.withdrawalAcknowledged, true);
    assert.equal((await admin.ref(locationPath()).get()).exists(), false);
    assert.deepEqual((await admin.ref(intentPath()).get()).val(), stopped);
  });
});

for (const [reason, update] of [
  ['expiry', () => ({ [`app_sessions/${UID}/expiresAtMs`]: Date.now() - 1000 })],
  ['revocation', () => ({ [`app_sessions/${UID}/status`]: 'revoked' })],
  ['reassignment', () => ({ [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: null })],
  ['role loss', () => ({ [`app_sessions/${UID}/principalType`]: 'passenger', [`users/${UID}/driverId`]: null })],
  ['session replacement', () => ({ [`app_sessions/${UID}/sessionId`]: OTHER_SID })],
  ['policy change', () => ({ 'driver_login_policy/v1/generation': 1 })],
]) test(`${reason} still permits exact owner stop and source removal but denies any publication`, async () => {
  const db = client();
  const active = intent();
  await db.ref(intentPath()).set(active);
  await db.ref(locationPath()).set(location());
  await trusted(admin => admin.ref().update(update()));
  await assertFails(db.ref(locationPath()).set(location()));
  await assertFails(client(OTHER_UID).ref(intentPath()).set({ ...active, status: 'stopped' }));
  await assertFails(db.ref(intentPath()).set({ ...active, status: 'stopped', startedAtMs: active.startedAtMs + 1 }));
  await assertSucceeds(db.ref(intentPath()).set({ ...active, status: 'stopped' }));
  await assertFails(client(OTHER_UID).ref(locationPath()).remove());
  await assertSucceeds(db.ref(locationPath()).remove());
  await assertSucceeds(db.ref(locationPath()).remove());
});

test('intent creation rejects altered identity, key, expiry, clock, schema and extra permission fields', async () => {
  const db = client();
  for (const changes of [
    { authUid: OTHER_UID }, { appSessionId: OTHER_SID }, { driverId: 'D-OTHER' }, { tourId: 'TOUR_OTHER' },
    { liveSharingSessionId: 'loc_legacy' }, { liveSharingSessionId: 'track_x' },
    { liveSharingSessionId: `track_${'x'.repeat(75)}` }, { expiresAtMs: expiresAtMs - 1 },
    { expiresAtMs: expiresAtMs + 1 }, { startedAtMs: nowMs - 120000 }, { startedAtMs: nowMs + 120000 },
    { schemaVersion: 2 }, { status: 'unknown' }, { grantsLocationWrite: true },
  ]) await assertFails(db.ref(intentPath()).set(intent(changes)));
  await db.ref(intentPath()).set(intent());
  for (const field of ['authUid', 'appSessionId', 'driverId', 'tourId', 'liveSharingSessionId', 'startedAtMs', 'expiresAtMs', 'schemaVersion']) {
    const value = intent({ status: 'stopped' });
    value[field] = typeof value[field] === 'number' ? value[field] + 1 : `${value[field]}x`;
    await assertFails(db.ref(intentPath()).set(value));
  }
  await assertFails(db.ref(intentPath()).set(intent({ status: 'stopped', extra: true })));
});

for (const [reason, update] of [
  ['missing policy', () => ({ 'driver_login_policy/v1': null })],
  ['policy generation mismatch', () => ({ 'driver_login_policy/v1/generation': 1 })],
  ['single-device claim loss', () => ({ 'driver_login_policy/v1/enforceSingleDevice': true, [`drivers/${DRIVER}/authUid`]: OTHER_UID })],
  ['active assignment transition', () => ({ [`driver_assignment_active/v1/${DRIVER}/transitionId`]: 'changing' })],
  ['expired session', () => ({ [`app_sessions/${UID}/expiresAtMs`]: Date.now() - 1000 })],
  ['missing driver profile', () => ({ [`drivers/${DRIVER}`]: null })],
]) test(`${reason} denies both active and absent stopped intent creation`, async () => {
  await trusted(admin => admin.ref().update(update()));
  for (const status of ['active', 'stopped']) await assertFails(client().ref(intentPath()).set(intent({ status })));
});

test('trusted stopped-intent event removes exact source and reconciles privacy-safe public projection', async () => {
  const db = client();
  const active = intent();
  await db.ref(intentPath()).set(active);
  await db.ref(locationPath()).set(location());
  await trusted(async admin => {
    assert.equal((await reconcileDriverLocationProjection({ database: admin, tourId: TOUR })).projection.mode, 'live');
  });
  const stopped = { ...active, status: 'stopped' };
  await db.ref(intentPath()).set(stopped);
  await trusted(async admin => {
    const excluded = await reconcileDriverLocationProjection({ database: admin, tourId: TOUR });
    assert.equal(excluded.projection, null);
    const result = await reconcileDriverTrackingIntentChange({ database: admin, sourceKey: sourceKey(),
      before: active, after: stopped, reconcileProjection: reconcileDriverLocationProjection });
    assert.equal(result.removed, true);
    assert.equal((await admin.ref(locationPath()).get()).exists(), false);
    assert.equal((await admin.ref(intentPath()).get()).val().status, 'stopped');
    const publicLocation = (await admin.ref(`tours/${TOUR}/driverLocation`).get()).val();
    assert.equal(publicLocation.isSharing, false);
    for (const field of ['authUid', 'appSessionId', 'liveSharingSessionId', 'driverId', 'tourId', 'status']) {
      assert.equal(Object.hasOwn(publicLocation, field), false);
    }
  });
});

test('retiring one tracked handset preserves another live source and then the fixed pickup fallback', async () => {
  const a = client(); const b = client(OTHER_UID);
  const otherLive = 'track_other';
  const activeA = intent();
  const activeB = intent({ authUid: OTHER_UID, appSessionId: OTHER_SID, liveSharingSessionId: otherLive });
  await a.ref(intentPath()).set(activeA);
  await a.ref(locationPath()).set(location());
  await b.ref(intentPath(otherLive, OTHER_SID)).set(activeB);
  await b.ref(locationPath(otherLive, OTHER_SID)).set(location({ authUid: OTHER_UID, appSessionId: OTHER_SID,
    liveSharingSessionId: otherLive, latitude: 56.2, timestamp: Date.now() + 1000 }));
  await trusted(admin => admin.ref(`driver_location_pickups/${TOUR}`).set(buildAssignmentOwnedDriverLocationPickup({
    driverId: DRIVER, tourId: TOUR, assignmentRevision: 7,
    location: { latitude: 55.9, longitude: -4.1, accuracy: 8 },
  })));
  await a.ref(intentPath()).set({ ...activeA, status: 'stopped' });
  await trusted(async admin => {
    await reconcileDriverTrackingIntentChange({ database: admin, sourceKey: sourceKey(), before: activeA,
      after: { ...activeA, status: 'stopped' }, reconcileProjection: reconcileDriverLocationProjection });
    assert.equal((await admin.ref(locationPath(otherLive, OTHER_SID)).get()).exists(), true);
    assert.equal((await admin.ref(`tours/${TOUR}/driverLocation`).get()).val().latitude, 56.2);
  });
  await b.ref(intentPath(otherLive, OTHER_SID)).set({ ...activeB, status: 'stopped' });
  await trusted(async admin => {
    await reconcileDriverTrackingIntentChange({ database: admin, sourceKey: sourceKey(otherLive, OTHER_SID), before: activeB,
      after: { ...activeB, status: 'stopped' }, reconcileProjection: reconcileDriverLocationProjection });
    const projection = (await admin.ref(`tours/${TOUR}/driverLocation`).get()).val();
    assert.equal(projection.mode, 'pickup');
    assert.equal(projection.latitude, 55.9);
    assert.equal((await admin.ref(`driver_location_pickups/${TOUR}`).get()).exists(), true);
  });
});
