'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAssignmentOwnedDriverLocationPickup,
  hasCurrentPickupAssignmentAuthority,
  removeDriverLocationPickupIfAssignmentMatches,
} = require('../functions/lib/driverLocationPickup');
const { buildDriverSessionRecord } = require('../functions/lib/appSession');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../functions/src/infrastructure/database/operationLock');
const {
  parseInput,
  performPickupMutation,
} = require('../functions/src/domains/live-state/driverLocationPickupFunctions');

const snapshot = (value) => ({ exists: () => value != null, val: () => structuredClone(value ?? null) });

const createDb = (initial = {}) => {
  const state = structuredClone(initial);
  const parts = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((node, key) => node?.[key], state);
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
  return {
    state,
    ref(path) {
      return {
        async once() { return snapshot(read(path)); },
        async set(value) { write(path, value); },
        async transaction(update) {
          const current = structuredClone(read(path) ?? null);
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
};

test('trusted pickup publication stamps assignment authority without installation lifetime fields', () => {
  const pickup = buildAssignmentOwnedDriverLocationPickup({
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    assignmentRevision: 7,
    location: { latitude: 56.1, longitude: -4.6, accuracy: 9 },
    address: ' Pier Road ',
    updatedBy: ' Driver ',
    nowMs: 1_000,
    tourEndAtMs: 10_000,
  });

  assert.equal(pickup.driverId, 'D-ONE');
  assert.equal(pickup.tourId, 'TOUR_1');
  assert.equal(pickup.assignmentRevision, 7);
  assert.equal(pickup.authUid, undefined);
  assert.equal(pickup.appSessionId, undefined);
  assert.equal(pickup.address, 'Pier Road');
  assert.ok(pickup.expiresAtMs > 10_000);
});

test('trusted Function publishes and withdraws through the real app-session lock validator', async () => {
  const nowMs = Date.now();
  const authUid = 'uid-driver-pickup';
  const sessionId = `sess_v1_${'a'.repeat(32)}`;
  const session = buildDriverSessionRecord({
    authUid,
    driverId: 'D-ONE',
    tourId: 'TOUR_1',
    sessionId,
    nowMs,
  });
  const db = createDb({
    app_sessions: { [authUid]: session },
    users: {
      [authUid]: {
        principalType: 'driver',
        driverId: 'D-ONE',
        driverPrincipalId: 'driver:D-ONE',
        driverAssignedTourId: 'TOUR_1',
      },
    },
    drivers: { 'D-ONE': { currentTourId: 'TOUR_1', name: 'Driver One' } },
    tours: { TOUR_1: { driverId: 'D-ONE', driverAssignmentRevision: 7 } },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
    driver_login_policy: {
      v1: {
        schemaVersion: 1,
        enforceSingleDevice: false,
        generation: 0,
        revision: 1,
        updatedAtMs: nowMs,
        transitionPhase: 'stable',
      },
    },
  });
  const publishInput = parseInput({
    operation: 'publish',
    tourId: 'TOUR_1',
    expectedSessionId: sessionId,
    clientVersion: '1.0.5',
    location: { latitude: 56.1, longitude: -4.6, accuracy: 9 },
    address: 'Pier Road',
  });

  const published = await performPickupMutation({ db, input: publishInput, requestAuth: { uid: authUid } });
  assert.equal(published.status, 200);
  assert.equal(db.state.driver_location_pickups.TOUR_1.assignmentRevision, 7);
  assert.equal(db.state.driver_location_pickups.TOUR_1.appSessionId, undefined);
  assert.equal(db.state.app_session_locks?.[authUid], undefined);

  const withdrawInput = parseInput({
    operation: 'withdraw',
    tourId: 'TOUR_1',
    expectedSessionId: sessionId,
    clientVersion: '1.0.5',
  });
  const withdrawn = await performPickupMutation({ db, input: withdrawInput, requestAuth: { uid: authUid } });
  assert.deepEqual(withdrawn, {
    status: 200,
    payload: { success: true, operation: 'withdraw', removed: true },
  });
  assert.equal(db.state.driver_location_pickups.TOUR_1, undefined);
  assert.equal(db.state.app_session_locks?.[authUid], undefined);
});

test('tour deletion assignment lock prevents an in-flight pickup from resurrecting deleted state', async () => {
  const nowMs = Date.now();
  const authUid = 'uid-driver-delete-race';
  const sessionId = `sess_v1_${'b'.repeat(32)}`;
  const db = createDb({
    app_sessions: { [authUid]: buildDriverSessionRecord({ authUid, driverId: 'D-ONE', tourId: 'TOUR_1', sessionId, nowMs }) },
    users: { [authUid]: { principalType: 'driver', driverId: 'D-ONE', driverPrincipalId: 'driver:D-ONE', driverAssignedTourId: 'TOUR_1' } },
    drivers: { 'D-ONE': { currentTourId: 'TOUR_1' } },
    tours: { TOUR_1: { driverId: 'D-ONE', driverAssignmentRevision: 7, driverLocation: { isSharing: true } } },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
    driver_location_projection_state: { TOUR_1: { revision: 2 } },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: nowMs, transitionPhase: 'stable' } },
  });
  const deletionLockPath = 'driver_assignment_locks/tours/TOUR_1';
  assert.equal(await acquireManualBookingLock({
    db, path: deletionLockPath, owner: 'tour-delete', nowMs, ttlMs: 60_000,
  }), true);

  const publish = await performPickupMutation({
    db,
    requestAuth: { uid: authUid },
    input: parseInput({
      operation: 'publish', tourId: 'TOUR_1', expectedSessionId: sessionId,
      clientVersion: '1.0.5', location: { latitude: 56.1, longitude: -4.6, accuracy: 8 },
    }),
  });
  delete db.state.tours.TOUR_1;
  delete db.state.driver_location_projection_state.TOUR_1;
  delete db.state.driver_location_pickups?.TOUR_1;
  await releaseManualBookingLock({ db, path: deletionLockPath, owner: 'tour-delete' });

  assert.deepEqual(publish, {
    status: 409,
    payload: { success: false, reason: 'ASSIGNMENT_IN_PROGRESS' },
  });
  assert.equal(db.state.tours.TOUR_1, undefined);
  assert.equal(db.state.driver_location_pickups?.TOUR_1, undefined);
  assert.equal(db.state.driver_location_projection_state.TOUR_1, undefined);
});

test('pickup projection authority survives creator logout but follows exact assignment revision', async () => {
  const pickup = buildAssignmentOwnedDriverLocationPickup({
    driverId: 'D-ONE', tourId: 'TOUR_1', assignmentRevision: 7,
    location: { latitude: 56.1, longitude: -4.6 }, nowMs: 1_000,
  });
  const db = createDb({
    drivers: { 'D-ONE': { currentTourId: 'TOUR_1' } },
    tours: { TOUR_1: { driverId: 'D-ONE', driverAssignmentRevision: 7 } },
    tour_manifests: { TOUR_1: { assigned_drivers: { 'D-ONE': true } } },
  });

  assert.equal(await hasCurrentPickupAssignmentAuthority(db, pickup, 2_000), true);
  db.state.tours.TOUR_1.driverAssignmentRevision = 8;
  assert.equal(await hasCurrentPickupAssignmentAuthority(db, pickup, 2_000), false);
});

test('explicit withdrawal is compare-safe against a newer assignment publication', async () => {
  const db = createDb({
    driver_location_pickups: {
      TOUR_1: buildAssignmentOwnedDriverLocationPickup({
        driverId: 'D-ONE', tourId: 'TOUR_1', assignmentRevision: 8,
        location: { latitude: 56.1, longitude: -4.6 }, nowMs: 1_000,
      }),
    },
  });

  const stale = await removeDriverLocationPickupIfAssignmentMatches({
    database: db, tourId: 'TOUR_1', driverId: 'D-ONE', assignmentRevision: 7,
  });
  assert.equal(stale.removed, false);
  assert.equal(db.state.driver_location_pickups.TOUR_1.assignmentRevision, 8);

  const current = await removeDriverLocationPickupIfAssignmentMatches({
    database: db, tourId: 'TOUR_1', driverId: 'D-ONE', assignmentRevision: 8,
  });
  assert.equal(current.removed, true);
  assert.equal(db.state.driver_location_pickups.TOUR_1, undefined);
});
