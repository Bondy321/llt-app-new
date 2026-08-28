const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acquireDriverLocationProjectionInvalidation,
  buildDriverLocationProjection,
  cleanupDriverLocationsForAppSession,
  hasCurrentDriverAuthority,
  isValidLiveSource,
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

const rolloutContext = (phase, projectionRevision) => ({
  valid: true,
  isDefault: false,
  rollout: { schemaVersion: 1, phase, projectionRevision, updatedAtMs: projectionRevision * 100 },
});

test('private live-source validation rejects identifiers beyond canonical limits', () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  source.authUid = 'a'.repeat(128);
  source.driverId = 'D'.repeat(100);
  source.tourId = 'T'.repeat(100);
  assert.equal(isValidLiveSource(source, 300), true);
  assert.equal(isValidLiveSource({ ...source, authUid: 'a'.repeat(129) }, 300), false);
  assert.equal(isValidLiveSource({ ...source, driverId: 'D'.repeat(101) }, 300), false);
  assert.equal(isValidLiveSource({ ...source, tourId: 'T'.repeat(101) }, 300), false);
});

test('location projection recomputes newest source and deterministic fallback without leaking ownership', () => {
  const manual = {
    schemaVersion: 1,
    isSharing: true,
    source: 'manual',
    mode: 'pickup',
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    assignmentRevision: 1,
    latitude: 55,
    longitude: -4,
    timestamp: 10,
    publishedAtMs: 10,
    expiresAtMs: 10_000,
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
    tours: { TOUR_1: {} },
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
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, undefined);

  const delayedAPublish = await reconcileDriverLocationSourceChange({
    database,
    before: null,
    after: a,
    nowMs: 301,
  });
  assert.equal(delayedAPublish.results[0].projection.latitude, 56.2);
  assert.equal(database.state.driver_location_projection_state.TOUR_1.revision, 2);
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, undefined);
});

test('mixed 1.0.4 and 1.0.5 projection behavior changes only after explicit rollout cutover', async () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({
    driver_location_sessions: { app_a: source },
    app_sessions: {
      [source.authUid]: {
        sessionId: source.appSessionId,
        authUid: source.authUid,
        status: 'active',
        principalType: 'driver',
        principalId: 'driver:D-ONE',
        driverId: 'D-ONE',
        tourId: 'TOUR_1',
        driverLoginPolicyGeneration: 0,
        expiresAtMs: 10_000,
      },
    },
    users: { [source.authUid]: { principalType: 'driver', driverId: 'D-ONE', driverAssignedTourId: 'TOUR_1' } },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0 } },
    drivers: { 'D-ONE': {} },
    tours: { TOUR_1: {} },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
  });

  await reconcileDriverLocationProjection({ database, tourId: 'TOUR_1', nowMs: 300 });
  assert.equal(database.state.live_state_rollout, undefined);
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, undefined);

  database.state.live_state_rollout = {
    v1: { schemaVersion: 1, phase: 'cutover', projectionRevision: 1, updatedAtMs: 301 },
  };
  await reconcileDriverLocationProjection({ database, tourId: 'TOUR_1', nowMs: 302 });
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 2);
  assert.equal(database.state.live_state_rollout.v1.projectionRevision, 1);
});

test('compatibility to cutover change in flight defers publication and converges on retry', async () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({ driver_location_sessions: { app_a: source }, tours: { TOUR_1: {} } });
  const reads = [rolloutContext('compatibility', 1), rolloutContext('cutover', 2)];
  await assert.rejects(reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 300,
    validateLiveRecord: async () => true,
    readRollout: async () => reads.shift(),
  }), (error) => error.code === 'LIVE_STATE_ROLLOUT_CHANGED');
  assert.equal(database.state.tours.TOUR_1.driverLocation, undefined);

  await reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 301,
    validateLiveRecord: async () => true,
    readRollout: async () => rolloutContext('cutover', 2),
  });
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 2);
});

test('cutover to compatibility change in flight defers publication and removes revision on retry', async () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({
    driver_location_sessions: { app_a: source },
    tours: { TOUR_1: { driverLocation: { schemaVersion: 1, isSharing: true, timestamp: 90, projectionRevision: 4 } } },
  });
  const reads = [rolloutContext('cutover', 4), rolloutContext('compatibility', 5)];
  await assert.rejects(reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 300,
    validateLiveRecord: async () => true,
    readRollout: async () => reads.shift(),
  }), (error) => error.code === 'LIVE_STATE_ROLLOUT_CHANGED');
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, 4);

  await reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 301,
    validateLiveRecord: async () => true,
    readRollout: async () => rolloutContext('compatibility', 5),
  });
  assert.equal(database.state.tours.TOUR_1.driverLocation.projectionRevision, undefined);
});

test('a delayed source trigger cannot recreate a deleted tour', async () => {
  const source = live('app_a', 'live_a', 100, 56.1);
  const database = createProjectionDatabase({ driver_location_sessions: { app_a: source } });
  const result = await reconcileDriverLocationProjection({
    database,
    tourId: 'TOUR_1',
    nowMs: 300,
    validateLiveRecord: async () => true,
  });
  assert.equal(result.published, false);
  assert.equal(result.reason, 'TOUR_MISSING');
  assert.equal(database.state.tours, undefined);
  assert.equal(database.state.driver_location_projection_state, undefined);
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
    schemaVersion: 1,
    isSharing: true,
    source: 'manual',
    mode: 'pickup',
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    assignmentRevision: 4,
    latitude: 55.9,
    longitude: -4.3,
    timestamp: 400,
    publishedAtMs: 400,
    expiresAtMs: 10_000,
  };
  const database = createProjectionDatabase({
    driver_location_pickups: { TOUR_1: manual },
    live_state_rollout: { v1: { schemaVersion: 1, phase: 'cutover', projectionRevision: 1, updatedAtMs: 100 } },
    drivers: { 'D-ONE': { currentTourId: 'TOUR_1' } },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
    tours: {
      TOUR_1: {
        driverId: 'D-ONE',
        driverAssignmentRevision: 4,
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
  const database = createProjectionDatabase({
    driver_location_sessions: { app_a: source },
    live_state_rollout: { v1: { schemaVersion: 1, phase: 'cutover', projectionRevision: 1, updatedAtMs: 100 } },
    tours: { TOUR_1: {} },
  });
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

test('location cleanup preserves assignment-owned pickup while retrying the expected old tour', async () => {
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
  assert.deepEqual(database.state.driver_location_pickups.TOUR_1, manual);
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
