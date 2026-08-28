const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acquireDriverLocationProjectionInvalidation,
  buildDriverLocationProjection,
  cleanupDriverLocationsForAppSession,
  hasCurrentDriverAuthority,
  reconcileDriverLocationProjection,
  reconcileDriverLocationSourceChange,
  releaseDriverLocationProjectionInvalidation,
} = require('../functions/lib/driverLocationProjection');

function createProjectionDatabase(initialState) {
  const state = structuredClone(initialState);
  const parts = (path = '') => path.split('/').filter(Boolean);
  const read = (path = '') => parts(path).reduce((node, key) => node?.[key], state);
  const write = (path, value) => {
    const keys = parts(path);
    let cursor = state;
    for (const key of keys.slice(0, -1)) {
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    }
    if (value === null) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = structuredClone(value);
  };
  const snapshot = (value) => ({ val: () => structuredClone(value ?? null), exists: () => value != null });
  return {
    state,
    ref(path = '') {
      const query = { child: null, equal: undefined };
      const ref = {
        orderByChild(child) { query.child = child; return ref; },
        equalTo(value) { query.equal = value; return ref; },
        async get() {
          const value = read(path);
          if (!query.child || !value || typeof value !== 'object') return snapshot(value);
          return snapshot(Object.fromEntries(Object.entries(value).filter(([, child]) => child?.[query.child] === query.equal)));
        },
        async transaction(update) {
          const current = structuredClone(read(path) ?? null);
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
        async update(updates) {
          for (const [target, value] of Object.entries(updates)) write(target, value);
        },
      };
      return ref;
    },
  };
}

const live = (appSessionId, liveSharingSessionId, timestamp, latitude) => ({
  schemaVersion: 2,
  source: 'auto',
  mode: 'live',
  authUid: `uid_${appSessionId}`,
  appSessionId,
  liveSharingSessionId,
  driverId: 'D-ONE',
  tourId: 'TOUR_1',
  latitude,
  longitude: -4,
  accuracy: 8,
  timestamp,
  cleanupAtMs: 100_000,
});

test('location projection recomputes newest source and deterministic fallback without leaking ownership', () => {
  const manual = {
    schemaVersion: 2,
    source: 'manual',
    mode: 'pickup',
    authUid: 'uid_manual',
    appSessionId: 'app_manual',
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    latitude: 55,
    longitude: -4,
    timestamp: 10,
  };
  const a = live('app_a', 'live_a', 100, 56.1);
  const b = live('app_b', 'live_b', 200, 56.2);
  const projectedB = buildDriverLocationProjection({ liveRecords: [a, b], manualRecord: manual, nowMs: 300 });
  assert.equal(projectedB.latitude, 56.2);
  assert.equal(projectedB.authUid, undefined);
  assert.equal(projectedB.appSessionId, undefined);

  const projectedA = buildDriverLocationProjection({ liveRecords: [a], manualRecord: manual, nowMs: 300 });
  assert.equal(projectedA.latitude, 56.1);
  const projectedManual = buildDriverLocationProjection({ liveRecords: [], manualRecord: manual, nowMs: 300 });
  assert.equal(projectedManual.mode, 'pickup');
});

test('equal-time location candidates use an ownership-stable tie-break', () => {
  const a = live('app_a', 'live_z', 200, 56.1);
  const b = live('app_b', 'live_a', 200, 56.2);
  const first = buildDriverLocationProjection({ liveRecords: [a, b], nowMs: 300 });
  const second = buildDriverLocationProjection({ liveRecords: [b, a], nowMs: 300 });
  assert.deepEqual(first, second);
});

test('a delayed stale source event re-reads current leaves and cannot regress the projection', async () => {
  const a = live('app_a', 'live_a', 100, 56.1);
  const b = live('app_b', 'live_b', 200, 56.2);
  const database = createProjectionDatabase({
    driver_location_sessions: { app_b: b },
    app_sessions: {
      uid_app_b: {
        sessionId: 'app_b',
        authUid: 'uid_app_b',
        status: 'active',
        principalType: 'driver',
        principalId: 'driver:D-ONE',
        driverId: 'D-ONE',
        tourId: 'TOUR_1',
        driverLoginPolicyGeneration: 0,
        expiresAtMs: 10_000,
      },
    },
    users: {
      uid_app_b: {
        principalType: 'driver',
        driverId: 'D-ONE',
        driverAssignedTourId: 'TOUR_1',
      },
    },
    driver_login_policy: {
      v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0 },
    },
    drivers: { 'D-ONE': {} },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
  });

  const delayedADelete = await reconcileDriverLocationSourceChange({
    database,
    before: a,
    after: null,
    nowMs: 300,
  });
  assert.equal(delayedADelete.results[0].projection.latitude, 56.2);
  assert.equal(database.state.tours.TOUR_1.driverLocation.latitude, 56.2);
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 1);

  const delayedAPublish = await reconcileDriverLocationSourceChange({
    database,
    before: null,
    after: a,
    nowMs: 301,
  });
  assert.equal(delayedAPublish.results[0].projection.latitude, 56.2);
  assert.equal(database.state.driver_location_projection_state.TOUR_1.revision, 2);
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 2);
});

test('projection authority requires the canonical driver principal, profile, generation and manifest', async () => {
  const source = live('app_b', 'live_b', 200, 56.2);
  const database = createProjectionDatabase({
    app_sessions: {
      uid_app_b: {
        sessionId: 'app_b',
        authUid: 'uid_app_b',
        status: 'active',
        principalType: 'driver',
        principalId: 'D-ONE',
        driverId: 'D-ONE',
        tourId: 'TOUR_1',
        driverLoginPolicyGeneration: 0,
        expiresAtMs: 10_000,
      },
    },
    users: { uid_app_b: { principalType: 'driver', driverId: 'D-ONE', driverAssignedTourId: 'TOUR_1' } },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0 } },
    drivers: { 'D-ONE': {} },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
  });
  assert.equal(await hasCurrentDriverAuthority(database, source, 300), false);
  database.state.app_sessions.uid_app_b.principalId = 'driver:D-ONE';
  assert.equal(await hasCurrentDriverAuthority(database, source, 300), true);
  database.state.tour_manifests.TOUR_1.assigned_drivers['D-ONE'] = false;
  assert.equal(await hasCurrentDriverAuthority(database, source, 300), false);
});

test('projection authority fails closed until a valid policy record is materialised', async () => {
  const record = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({
    app_sessions: {
      [record.authUid]: {
        sessionId: record.appSessionId,
        authUid: record.authUid,
        status: 'active',
        principalType: 'driver',
        principalId: 'driver:D-ONE',
        driverId: 'D-ONE',
        tourId: 'TOUR_1',
        driverLoginPolicyGeneration: 0,
        expiresAtMs: 10_000,
      },
    },
    users: {
      [record.authUid]: {
        principalType: 'driver',
        driverId: 'D-ONE',
        driverAssignedTourId: 'TOUR_1',
      },
    },
    drivers: { 'D-ONE': {} },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
  });

  assert.equal(await hasCurrentDriverAuthority(database, record, 300), false);
});

test('the first manual projection after an assignment tombstone advances the public revision', async () => {
  const manual = {
    schemaVersion: 2,
    source: 'manual',
    mode: 'pickup',
    authUid: 'uid-manual',
    appSessionId: 'app-manual',
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    latitude: 55.9,
    longitude: -4.3,
    timestamp: 400,
  };
  const database = createProjectionDatabase({
    driver_location_pickups: { TOUR_1: manual },
    tours: {
      TOUR_1: {
        driverLocation: {
          schemaVersion: 1,
          isSharing: false,
          timestamp: 300,
          projectionRevision: 9,
        },
      },
    },
  });

  const result = await reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 500,
    validateLiveRecord: async () => true,
  });

  assert.equal(result.revision, 10);
  assert.equal(database.state.tours.TOUR_1.driverLocation.isSharing, true);
  assert.equal(database.state.tours.TOUR_1.driverLocation.source, 'manual');
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 10);
});

test('assignment invalidation waits out a paused projector and reserves a newer tombstone revision', async () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({ driver_location_sessions: { app_a: source } });
  let allowValidation;
  let validationStarted;
  const started = new Promise((resolve) => { validationStarted = resolve; });
  const allowed = new Promise((resolve) => { allowValidation = resolve; });
  const projecting = reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 300,
    leaseOwner: 'paused-projector',
    validateLiveRecord: async () => {
      validationStarted();
      await allowed;
      return true;
    },
  });

  await started;
  await assert.rejects(acquireDriverLocationProjectionInvalidation({
    database,
    tourId: 'TOUR_1',
    nowMs: 301,
    leaseOwner: 'assignment-transition',
  }), (error) => error.code === 'DRIVER_LOCATION_PROJECTION_BUSY');

  allowValidation();
  const projected = await projecting;
  assert.equal(projected.revision, 1);

  const invalidation = await acquireDriverLocationProjectionInvalidation({
    database,
    tourId: 'TOUR_1',
    nowMs: 302,
    leaseOwner: 'assignment-transition',
  });
  assert.equal(invalidation.revision, 2);
  await database.ref().update({ [invalidation.publicPath]: invalidation.tombstone });
  await releaseDriverLocationProjectionInvalidation({ database, invalidation });

  assert.equal(database.state.tours.TOUR_1.driverLocation.isSharing, false);
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 2);
  assert.equal(database.state.driver_location_projection_state.TOUR_1.leaseOwner, undefined);
});

test('location cleanup retries the expected old tour after a partial raw-source deletion', async () => {
  const manual = {
    schemaVersion: 2,
    source: 'manual',
    mode: 'pickup',
    authUid: 'uid-old',
    appSessionId: 'app-old',
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    latitude: 55.9,
    longitude: -4.3,
    timestamp: 200,
  };
  const database = createProjectionDatabase({
    driver_location_pickups: { TOUR_1: manual },
    driver_location_projection_state: {
      TOUR_1: {
        leaseOwner: 'paused-projector',
        leaseRevision: 1,
        leaseExpiresAtMs: 10_000,
      },
    },
    tours: {
      TOUR_1: {
        driverLocation: {
          schemaVersion: 1,
          isSharing: true,
          mode: 'pickup',
          source: 'manual',
          latitude: 55.9,
          longitude: -4.3,
          timestamp: 200,
        },
      },
    },
  });

  await assert.rejects(cleanupDriverLocationsForAppSession({
    database,
    appSessionId: 'app-old',
    expectedTourId: 'TOUR_1',
    nowMs: 300,
  }), (error) => error.code === 'DRIVER_LOCATION_PROJECTION_BUSY');
  assert.equal(database.state.driver_location_pickups.TOUR_1, undefined);
  assert.equal(database.state.tours.TOUR_1.driverLocation.isSharing, true);

  database.state.driver_location_projection_state.TOUR_1 = { revision: 0 };
  const retry = await cleanupDriverLocationsForAppSession({
    database,
    appSessionId: 'app-old',
    expectedTourId: 'TOUR_1',
    nowMs: 301,
  });
  assert.equal(retry.removed, 0);
  assert.deepEqual(retry.reconciledTours, ['TOUR_1']);
  assert.equal(database.state.tours.TOUR_1.driverLocation.isSharing, false);
});
