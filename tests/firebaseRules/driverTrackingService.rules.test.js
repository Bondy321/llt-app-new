'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { createMockUserToken } = require('@firebase/util');
const { performDriverTrackingStop } = require('../../functions/src/domains/live-state/driverTrackingStop');
const { reconcileDriverLocationProjection } = require('../../functions/lib/driverLocationProjection');
const { buildAssignmentOwnedDriverLocationPickup } = require('../../functions/lib/driverLocationPickup');

const PROJECT = 'demo-llt-tracking-service';
const UID = 'tracking-service-driver';
const OTHER = 'tracking-service-other';
const DRIVER = 'D-TRACKSERVICE';
const TOUR = 'TOUR_TRACKSERVICE';
const SID = `sess_v1_${'c'.repeat(32)}`;
const OTHER_SID = `sess_v1_${'d'.repeat(32)}`;
let environment, databaseURL, restURL, expiresAtMs, modules;
const trusted = async callback => {
  let result;
  await environment.withSecurityRulesDisabled(async context => { result = await callback(context.database(databaseURL)); });
  return result;
};
const sourcePath = live => `driver_location_sessions/${SID}|${live}`;
const fencePath = live => `driver_tracking_sessions/${SID}|${live}`;
const scope = () => ({ role: 'driver', authUid: UID, cacheOwnerId: DRIVER, principalId: `driver:${DRIVER}`,
  sessionId: SID, tourId: TOUR, expiresAtMs });

test.before(async () => {
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  restURL = `http://${host}:${port}/?ns=${PROJECT}`; databaseURL = restURL;
  environment = await initializeTestEnvironment({ projectId: PROJECT, database: { host, port: Number(port),
    rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8') } });
  modules = await Promise.all([
    import('../../services/driver-tracking/createDriverTrackingController.js'),
    import('../../services/driver-tracking/trackingRestRepository.js'),
    import('../../services/driverLocationService.js'),
  ]);
});
test.after(async () => { await environment?.cleanup(); });
test.beforeEach(async () => {
  const now = Date.now(); expiresAtMs = now + 3600000;
  const records = {
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: now },
    [`drivers/${DRIVER}`]: { authUid: UID, currentTourId: TOUR },
    [`tours/${TOUR}`]: { driverId: DRIVER, driverAssignmentRevision: 7 },
    [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: true,
  };
  for (const [uid, sid] of [[UID, SID], [OTHER, OTHER_SID]]) {
    records[`users/${uid}`] = { principalType: 'driver', driverId: DRIVER, driverPrincipalId: `driver:${DRIVER}`, driverAssignedTourId: TOUR };
    records[`app_sessions/${uid}`] = { schemaVersion: 1, authUid: uid, sessionId: sid, principalId: `driver:${DRIVER}`,
      principalType: 'driver', driverId: DRIVER, tourId: TOUR, status: 'active', driverLoginPolicyGeneration: 0,
      issuedAtMs: now, lastAuthenticatedAtMs: now, expiresAtMs, sessionRevision: 1 };
  }
  await trusted(async db => { await db.ref().set(null); await db.ref().update(records); });
});

const harness = async (live = 'track_integration_one', fetchOverride = null) => {
  const [{ createDriverTrackingController }, { createTrackingRestRepository }, locationService] = modules;
  const map = new Map(); const httpWrites = []; const stopResponses = []; let nativeStarted = false;
  const client = environment.authenticatedContext(UID).database(databaseURL);
  const auth = { currentUser: { uid: UID, getIdToken: async () => createMockUserToken({ sub: UID, user_id: UID }, PROJECT) } };
  const realFetch = fetch;
  const transport = createTrackingRestRepository({ database: client, auth, baseUrl: restURL, retireEndpoint: 'https://synthetic.test/stop',
    fetchFn: async (url, options) => {
      if (options.method === 'POST') {
        const result = await trusted(db => performDriverTrackingStop({ db, authUid: UID, input: JSON.parse(options.body) }));
        stopResponses.push(result);
        return { ok: result.status === 200, status: result.status, json: async () => result.payload };
      }
      if (url.includes('driver_location_sessions')) httpWrites.push({ url, options });
      return fetchOverride ? fetchOverride(url, options, realFetch) : realFetch(url, options);
    },
  });
  const tracking = createDriverTrackingController({
    storage: { getItem: async key => map.get(key) || null, setItem: async (key, value) => map.set(key, value), removeItem: async key => map.delete(key) },
    makeId: () => live,
    native: { isForeground: () => true, isStarted: async () => nativeStarted, hasPermissions: async () => true,
      requestPermissions: async () => {}, start: async () => { nativeStarted = true; }, stop: async () => { nativeStarted = false; }, permissionMessage: error => error.message },
    verifyAuthority: async () => ({ valid: true }), writeFence: transport.writeFence, retireSession: transport.retireSession,
    publish: (intent, sample, isScopeCurrent) => locationService.publishDriverLocation({
      dbInstance: transport.database, tourId: TOUR, source: 'auto', sessionScope: intent.scope,
      sessionId: intent.liveSharingSessionId, location: sample.coords, isScopeCurrent,
    }),
  });
  await tracking.setScope(scope());
  return { tracking, client, map, httpWrites, stopResponses, sample: () => ({ timestamp: Date.now(), coords: { latitude: 56.15, longitude: -4.25, accuracy: 12 } }),
    start: () => tracking.start({ scope: scope(), disclosureAccepted: true }), nativeStarted: () => nativeStarted };
};

test('real controller + authenticated REST publish behind write-only rules; Stop fences delayed HTTP replay and preserves fixed pickup', async () => {
  const h = await harness();
  assert.equal((await h.start()).success, true);
  const result = await h.tracking.handleLocations({ locations: [h.sample()] });
  assert.equal(result.publicationAcknowledged, true);
  await assertFails(h.client.ref(sourcePath('track_integration_one')).once('value'));
  await assertFails(h.client.ref(fencePath('track_integration_one')).once('value'));
  await trusted(async db => {
    const projected = await reconcileDriverLocationProjection({ database: db, tourId: TOUR });
    assert.equal(projected.projection.latitude, 56.15);
    for (const field of ['authUid', 'driverId', 'appSessionId', 'liveSharingSessionId']) assert.equal(Object.hasOwn(projected.projection, field), false);
    const pickup = buildAssignmentOwnedDriverLocationPickup({ tourId: TOUR, driverId: DRIVER, assignmentRevision: 7,
      location: { latitude: 56.05, longitude: -4.05, accuracy: 12 }, nowMs: Date.now() - 1000 });
    await db.ref(`driver_location_pickups/${TOUR}`).set(pickup);
  });
  const stopped = await h.tracking.stop();
  assert.equal(stopped.withdrawalAcknowledged, true, JSON.stringify(h.stopResponses));
  assert.equal(h.nativeStarted(), false); assert.equal(h.map.size, 0);
  const prior = h.httpWrites[0];
  const late = await fetch(prior.url, { ...prior.options, signal: undefined });
  assert.equal(late.ok, false);
  await trusted(async db => {
    assert.equal((await db.ref(sourcePath('track_integration_one')).get()).exists(), false);
    assert.equal((await db.ref(fencePath('track_integration_one')).get()).val().status, 'stopped');
    const publicPoint = (await db.ref(`tours/${TOUR}/driverLocation`).get()).val();
    assert.equal(publicPoint.latitude, 56.05); assert.equal(publicPoint.source, 'manual');
  });
});

test('Stop after revoked/expired app session removes exact tracked source while another installation survives', async () => {
  const h = await harness(); await h.start(); await h.tracking.handleLocations({ locations: [h.sample()] });
  await trusted(async db => {
    const existing = (await db.ref(sourcePath('track_integration_one')).get()).val();
    await db.ref(`driver_location_sessions/${OTHER_SID}|loc_other_installation`).set({ ...existing,
      authUid: OTHER, appSessionId: OTHER_SID, liveSharingSessionId: 'loc_other_installation', latitude: 56.3 });
    await db.ref(`app_sessions/${UID}`).update({ status: 'ended' });
    await db.ref(`users/${UID}`).set({ principalType: 'passenger' });
  });
  const stopped = await h.tracking.stop();
  assert.equal(stopped.withdrawalAcknowledged, true, JSON.stringify(h.stopResponses));
  await trusted(async db => {
    assert.equal((await db.ref(sourcePath('track_integration_one')).get()).exists(), false);
    assert.equal((await db.ref(`driver_location_sessions/${OTHER_SID}|loc_other_installation`).get()).exists(), true);
  });
});

test('ambiguous active fence request with no server record can be compensated after session retirement', async () => {
  const h = await harness('track_failed_start', async () => {
    await trusted(db => db.ref(`app_sessions/${UID}`).update({ status: 'ended' }));
    throw new Error('connection_lost_before_fence');
  });
  assert.equal((await h.start()).success, false);
  assert.equal(h.tracking.getSnapshot().pending, false, JSON.stringify(h.stopResponses));
  assert.equal(h.nativeStarted(), false); assert.equal(h.map.size, 0);
  await trusted(async db => {
    assert.equal((await db.ref(fencePath('track_failed_start')).get()).exists(), false);
    assert.equal((await db.ref(sourcePath('track_failed_start')).get()).exists(), false);
  });
});
