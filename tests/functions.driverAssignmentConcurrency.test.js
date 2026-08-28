'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCanonicalDriverAssignmentUpdates,
  buildCurrentAssignmentProfileProjection,
  buildDriverAssignmentReconciliationUpdates,
  createAssignmentRequestHash,
  createAssignmentTransitionId,
} = require('../functions/src/domains/driver-assignment/driverAssignment');
const {
  ASSIGNMENT_LOCK_TTL_MS,
  acquireAssignmentLocationInvalidations,
  acquireAssignmentTransitionWorker,
  acquireDriverAssignmentBarrier,
  acquireDriverAssignmentLoginAdmission,
  cleanupExpiredDriverAssignmentRecords,
  commitReconciliationAfterCleanup,
  recordAssignmentTransitionFailure,
  readDriverSessionPage,
  reconcileTransitionSessionPage,
  reserveDriverAssignmentTransition,
  releaseDriverAssignmentLoginAdmission,
} = require('../functions/src/domains/driver-assignment/assignmentTransition');
const { acquireAppSessionLock } = require('../functions/lib/appSessionLock');

const session = (authUid, id, revision = 1) => ({
  schemaVersion: 1,
  sessionId: `sess_v1_${id.repeat(32)}`,
  authUid,
  principalId: 'driver:D-ONE',
  principalType: 'driver',
  tourId: 'TOUR_OLD',
  driverId: 'D-ONE',
  driverLoginPolicyGeneration: 3,
  status: 'active',
  issuedAtMs: 100,
  lastAuthenticatedAtMs: 100,
  expiresAtMs: 9_999_999,
  sessionRevision: revision,
});

const driverProfile = (driverId = 'D-ONE') => ({
  principalType: 'driver',
  driverId,
  driverPrincipalId: `driver:${driverId}`,
  driverAssignedTourId: null,
});

const assignmentPickup = (driverId, tourId, assignmentRevision) => ({
  schemaVersion: 1,
  isSharing: true,
  source: 'manual',
  mode: 'pickup',
  driverId,
  tourId,
  assignmentRevision,
  latitude: 55.9,
  longitude: -4.4,
});

test('already-current admin profile updates preserve assignment and live operational state', () => {
  const state = {
    drivers: {
      'D-ONE': {
        name: 'Old Name', phone: '07000', currentTourId: 'TOUR_ONE', assignmentRevision: 7,
        assignments: { TOUR_ONE: true },
      },
    },
    tours: {
      TOUR_ONE: {
        driverId: 'D-ONE', driverName: 'Old Name', driverPhone: '07000',
        driverAssignmentRevision: 11,
        driverLocation: { latitude: 55.9, longitude: -4.4, sessionRevision: 4 },
      },
    },
    tour_manifests: { TOUR_ONE: { assigned_drivers: { 'D-ONE': true } } },
    driver_location_pickups: { TOUR_ONE: assignmentPickup('D-ONE', 'TOUR_ONE', 11) },
    driver_locations_public: {
      'D-ONE': { tourId: 'TOUR_ONE', sessionId: 'sess_v1_public', sessionRevision: 4 },
    },
    app_sessions: {
      'uid-one': { driverId: 'D-ONE', tourId: 'TOUR_ONE', sessionRevision: 4 },
    },
    notification_devices: {
      'uid-one': { operationalTourId: 'TOUR_ONE', operationalSessionRevision: 4, registrationRevision: 9 },
    },
    driver_assignment_transitions: { v1: {} },
    driver_assignment_transition_queue: { v1: {} },
  };
  const preserved = structuredClone({
    assignmentRevision: state.drivers['D-ONE'].assignmentRevision,
    tourRevision: state.tours.TOUR_ONE.driverAssignmentRevision,
    driverLocation: state.tours.TOUR_ONE.driverLocation,
    pickup: state.driver_location_pickups.TOUR_ONE,
    publicLocation: state.driver_locations_public['D-ONE'],
    session: state.app_sessions['uid-one'],
    device: state.notification_devices['uid-one'],
    transitions: state.driver_assignment_transitions,
    queue: state.driver_assignment_transition_queue,
  });

  const projection = buildCurrentAssignmentProfileProjection({
    isAdmin: true,
    operation: 'assign',
    driverId: 'D-ONE',
    tourId: 'TOUR_ONE',
    expectedDriverRevision: 7,
    expectedTourRevision: 11,
    driverProfileUpdates: { name: 'New Name', phone: '07111' },
    driverData: state.drivers['D-ONE'],
    tourData: state.tours.TOUR_ONE,
    manifestData: state.tour_manifests.TOUR_ONE,
  });

  assert.equal(projection.status, 'ready');
  assert.deepEqual(Object.keys(projection.updates).sort(), [
    'drivers/D-ONE/name',
    'drivers/D-ONE/phone',
    'tours/TOUR_ONE/driverName',
    'tours/TOUR_ONE/driverPhone',
  ]);
  Object.entries(projection.updates).forEach(([path, value]) => {
    const keys = path.split('/');
    state[keys[0]][keys[1]][keys[2]] = value;
  });
  assert.deepEqual({
    assignmentRevision: state.drivers['D-ONE'].assignmentRevision,
    tourRevision: state.tours.TOUR_ONE.driverAssignmentRevision,
    driverLocation: state.tours.TOUR_ONE.driverLocation,
    pickup: state.driver_location_pickups.TOUR_ONE,
    publicLocation: state.driver_locations_public['D-ONE'],
    session: state.app_sessions['uid-one'],
    device: state.notification_devices['uid-one'],
    transitions: state.driver_assignment_transitions,
    queue: state.driver_assignment_transition_queue,
  }, preserved);
  assert.equal(buildCurrentAssignmentProfileProjection({
    ...projection,
    isAdmin: false,
    operation: 'assign',
    driverId: 'D-ONE',
    tourId: 'TOUR_ONE',
    driverProfileUpdates: { name: 'Forbidden', phone: '000' },
    driverData: state.drivers['D-ONE'],
    tourData: state.tours.TOUR_ONE,
    manifestData: state.tour_manifests.TOUR_ONE,
  }).status, 'not_applicable');
});

const createAssignmentReconciliationRaceDb = ({ beforeFirstSessionLock }) => {
  const state = {
    app_sessions: { 'uid-a': { ...session('uid-a', 'a'), tourId: null } },
    users: { 'uid-a': driverProfile() },
    notification_devices: {
      'uid-a': {
        operationalEligible: true,
        operationalSessionId: session('uid-a', 'a').sessionId,
        operationalSessionRevision: 1,
        operationalTourId: null,
        marketingEligible: true,
        marketingPreferences: { day_trips: true },
        pushToken: 'ExponentPushToken[oldoldoldoldoldoldoldold]',
        registrationRevision: 4,
      },
    },
    drivers: { 'D-ONE': { authUid: 'uid-a' } },
  };
  let mutationApplied = false;
  let pushIndex = 0;
  const parts = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((value, key) => value?.[key], state);
  const write = (path, value) => {
    const keys = parts(path);
    if (!keys.length) throw new Error('Root replacement is not supported');
    let parent = state;
    keys.slice(0, -1).forEach((key) => {
      if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
      parent = parent[key];
    });
    const key = keys[keys.length - 1];
    if (value === null || value === undefined) delete parent[key];
    else parent[key] = value;
  };
  const snapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => (value === null || value === undefined ? null : structuredClone(value)),
  });
  const makeSessionQuery = ({ cursor = null, limit = Number.MAX_SAFE_INTEGER } = {}) => ({
    startAt: (_driverId, key) => makeSessionQuery({ cursor: key, limit }),
    endAt: () => makeSessionQuery({ cursor, limit }),
    equalTo: () => makeSessionQuery({ cursor, limit }),
    limitToFirst: (nextLimit) => makeSessionQuery({ cursor, limit: nextLimit }),
    once: async () => {
      const entries = Object.entries(state.app_sessions || {})
        .filter(([authUid, value]) => value?.driverId === 'D-ONE' && (!cursor || authUid >= cursor))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit);
      return snapshot(Object.fromEntries(entries));
    },
  });
  const db = {
    ref(path = '') {
      if (!path) {
        return {
          update: async (updates) => Object.entries(updates).forEach(([updatePath, value]) => write(updatePath, value)),
        };
      }
      if (path === 'app_sessions') {
        return { orderByChild: () => makeSessionQuery() };
      }
      return {
        once: async () => snapshot(read(path)),
        push: () => ({ key: `event-${++pushIndex}` }),
        transaction: async (updater) => {
          if (!mutationApplied && path === 'app_session_locks/uid-a') {
            mutationApplied = true;
            beforeFirstSessionLock(state);
          }
          const current = read(path) ?? null;
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
  return { db, state };
};

const reconcileAfterPaginationRace = async (beforeFirstSessionLock) => {
  const { db, state } = createAssignmentReconciliationRaceDb({ beforeFirstSessionLock });
  const result = await reconcileTransitionSessionPage({
    db,
    transitionId: 'transition-race',
    transition: {
      status: 'subject_sessions',
      driverId: 'D-ONE',
      operation: 'assign',
      tourId: 'TOUR_NEW',
      policy: { enforceSingleDevice: false, generation: 3 },
      actorType: 'operations_admin',
      subjectSessionCursor: null,
    },
    nowMs: 5_000,
    pageSize: 25,
  });
  return { result, state };
};

const createAssignmentTerminalDb = ({
  transitions = {}, retention = {}, failWarningWrites = 0, failRootUpdates = 0,
} = {}) => {
  const state = {
    driver_assignment_retention: { v1: structuredClone(retention) },
    driver_assignment_transitions: { v1: structuredClone(transitions) },
    driver_assignment_transition_queue: {
      v1: Object.fromEntries(Object.keys(transitions).map((transitionId) => [transitionId, true])),
    },
    driver_assignment_active: { v1: {} },
    driver_assignment_idempotency: { v1: {} },
    driver_assignment_locks: { drivers: {}, tours: {} },
    driver_login_policy: { v1: { loginAdmissions: {} } },
    operations_terminal_warnings: { v1: {} },
  };
  Object.entries(transitions).forEach(([transitionId, transition]) => {
    [transition.driverId, transition.incumbentDriverId]
      .filter(Boolean)
      .forEach((driverId) => { state.driver_assignment_active.v1[driverId] = { transitionId }; });
    if (transition.admissionId) {
      state.driver_login_policy.v1.loginAdmissions[transition.admissionId] = { transitionId };
    }
  });
  let warningFailuresRemaining = failWarningWrites;
  let rootUpdateFailuresRemaining = failRootUpdates;
  let warningWriteAttempts = 0;
  const parts = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((value, key) => value?.[key], state);
  const write = (path, value) => {
    const keys = parts(path);
    let parent = state;
    keys.slice(0, -1).forEach((key) => {
      if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
      parent = parent[key];
    });
    const key = keys[keys.length - 1];
    if (value === null || value === undefined) delete parent[key];
    else parent[key] = value;
  };
  const snapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => (value === null || value === undefined ? null : structuredClone(value)),
  });
  const db = {
    ref(path = '') {
      if (!path) return {
        update: async (updates) => {
          if (rootUpdateFailuresRemaining > 0) {
            rootUpdateFailuresRemaining -= 1;
            throw new Error('atomic terminal cleanup unavailable');
          }
          Object.entries(updates).forEach(([updatePath, value]) => write(updatePath, value));
        },
      };
      const query = {
        startAt: () => query,
        endAt: () => query,
        limitToFirst: () => query,
        once: async () => snapshot(read(path) || {}),
      };
      return {
        once: async () => snapshot(read(path)),
        orderByChild: () => query,
        transaction: async (updater) => {
          if (path.startsWith('operations_terminal_warnings/v1/')) {
            warningWriteAttempts += 1;
            if (warningFailuresRemaining > 0) {
              warningFailuresRemaining -= 1;
              throw new Error('warning persistence unavailable');
            }
          }
          const current = read(path) ?? null;
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
  return { db, state, warningWriteAttempts: () => warningWriteAttempts };
};

test('policy-off assignment reconciles every current-generation handset and preserves marketing consent', () => {
  const sessions = {
    'uid-a': session('uid-a', 'a'),
    'uid-b': session('uid-b', 'b', 4),
  };
  const devices = {
    'uid-a': {
      operationalEligible: true,
      operationalSessionId: sessions['uid-a'].sessionId,
      operationalSessionRevision: 1,
      operationalTourId: 'TOUR_OLD',
      marketingEligible: true,
      marketingPreferences: { day_trips: true },
      pushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      registrationRevision: 5,
    },
    'uid-b': {
      operationalEligible: true,
      operationalSessionId: sessions['uid-b'].sessionId,
      operationalSessionRevision: 4,
      operationalTourId: 'TOUR_OLD',
      marketingEligible: true,
      marketingPreferences: { cruises_ferries: true },
      pushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
      registrationRevision: 9,
    },
  };

  const result = buildDriverAssignmentReconciliationUpdates({
    driverId: 'D-ONE',
    targetTourId: 'TOUR_NEW',
    sessions,
    profiles: { 'uid-a': driverProfile(), 'uid-b': driverProfile() },
    devices,
    policy: { enforceSingleDevice: false, generation: 3 },
    driverData: { authUid: 'uid-a' },
    nowMs: 1_000,
  });

  assert.deepEqual(result.reconciledAuthUids, ['uid-a', 'uid-b']);
  assert.equal(result.updates['app_sessions/uid-a'].tourId, 'TOUR_NEW');
  assert.equal(result.updates['app_sessions/uid-b'].sessionRevision, 5);
  assert.equal(result.updates['users/uid-a/driverAssignedTourId'], 'TOUR_NEW');
  assert.equal(result.updates['users/uid-b/driverAssignedTourId'], 'TOUR_NEW');
  assert.equal(result.updates['notification_devices/uid-a/operationalTourId'], 'TOUR_NEW');
  assert.equal(result.updates['notification_devices/uid-b/operationalSessionRevision'], 5);
  assert.equal(Object.keys(result.updates).some((path) => path.includes('marketing')), false);
  assert.equal(Object.keys(result.updates).some((path) => path.endsWith('/pushToken')), false);
});

test('policy-on assignment queues exact cleanup for every non-claimed handset', () => {
  const sessions = {
    'uid-a': session('uid-a', 'a'),
    'uid-b': session('uid-b', 'b'),
  };
  const result = buildDriverAssignmentReconciliationUpdates({
    driverId: 'D-ONE',
    targetTourId: null,
    sessions,
    profiles: { 'uid-a': driverProfile(), 'uid-b': driverProfile() },
    devices: {},
    policy: { enforceSingleDevice: true, generation: 3 },
    driverData: { authUid: 'uid-a' },
    nowMs: 2_000,
  });

  assert.deepEqual(result.reconciledAuthUids, ['uid-a']);
  assert.deepEqual(result.obsoleteAuthUids, ['uid-b']);
  assert.equal(result.updates['app_sessions/uid-a'].tourId, null);
  assert.equal(result.updates['driver_login_policy_cleanup/v1/uid-b'].sessionId, sessions['uid-b'].sessionId);
});

test('assignment request hashing is deterministic and binds revisions and operation', () => {
  const first = createAssignmentRequestHash({
    operation: 'assign', driverId: 'D-ONE', tourId: 'TOUR_NEW', expectedDriverRevision: 2, expectedTourRevision: 8,
  });
  const replay = createAssignmentRequestHash({
    expectedTourRevision: 8, tourId: 'TOUR_NEW', expectedDriverRevision: 2, driverId: 'D-ONE', operation: 'assign',
  });
  const stale = createAssignmentRequestHash({
    operation: 'assign', driverId: 'D-ONE', tourId: 'TOUR_NEW', expectedDriverRevision: 2, expectedTourRevision: 7,
  });
  assert.equal(first, replay);
  assert.notEqual(first, stale);
});

test('admin replacement moves two competing drivers with monotonic revisions in one update map', () => {
  const result = buildCanonicalDriverAssignmentUpdates({
    operation: 'assign',
    driverId: 'D-NEW',
    driverData: { name: 'New Driver', assignmentRevision: 4 },
    tourId: 'TOUR_A',
    tourData: {
      tourCode: 'TOUR A',
      driverId: 'D-OLD',
      driverAssignmentRevision: 7,
      driverLocation: { projectionRevision: 11, isSharing: true },
    },
    incumbentDriverId: 'D-OLD',
    incumbentDriverData: { currentTourId: 'TOUR_A', assignmentRevision: 12 },
    pickups: { TOUR_A: assignmentPickup('D-OLD', 'TOUR_A', 7) },
    actorId: 'admin:hash',
    nowMs: 2_000,
  });

  assert.equal(result.updates['tours/TOUR_A/driverId'], 'D-NEW');
  assert.equal(result.updates['tours/TOUR_A/driverAssignmentRevision'], 8);
  assert.deepEqual(result.updates['tours/TOUR_A/driverLocation'], {
    schemaVersion: 1,
    isSharing: false,
    timestamp: 2_000,
    projectionRevision: 12,
  });
  assert.equal(result.updates['drivers/D-NEW/assignmentRevision'], 5);
  assert.equal(result.updates['drivers/D-OLD/assignmentRevision'], 13);
  assert.equal(result.updates['drivers/D-OLD/currentTourId'], null);
  assert.equal(result.updates['tour_manifests/TOUR_A/assigned_drivers/D-OLD'], null);
  assert.equal(result.updates['tour_manifests/TOUR_A/assigned_drivers/D-NEW'], true);
  assert.equal(result.updates['driver_location_pickups/TOUR_A'], null);
});

test('canonical reassignment clears the exact subject previous-tour pickup but preserves a newer target pickup', () => {
  const result = buildCanonicalDriverAssignmentUpdates({
    operation: 'assign',
    driverId: 'D-ONE',
    driverData: { currentTourId: 'TOUR_OLD', assignmentRevision: 2 },
    tourId: 'TOUR_NEW',
    tourData: { driverId: 'D-TWO', driverAssignmentRevision: 5 },
    previousTourData: { driverId: 'D-ONE', driverAssignmentRevision: 8 },
    incumbentDriverId: 'D-TWO',
    incumbentDriverData: { currentTourId: 'TOUR_NEW', assignmentRevision: 4 },
    pickups: {
      TOUR_OLD: assignmentPickup('D-ONE', 'TOUR_OLD', 8),
      TOUR_NEW: assignmentPickup('D-TWO', 'TOUR_NEW', 6),
    },
    actorId: 'admin:hash',
    nowMs: 3_000,
  });

  assert.equal(result.updates['driver_location_pickups/TOUR_OLD'], null);
  assert.equal(result.updates['driver_location_pickups/TOUR_NEW'], undefined);
});

test('canonical unassignment clears only the exact current assignment pickup', () => {
  const exact = buildCanonicalDriverAssignmentUpdates({
    operation: 'unassign',
    driverId: 'D-ONE',
    driverData: { currentTourId: 'TOUR_A', assignmentRevision: 2 },
    tourId: 'TOUR_A',
    tourData: { driverId: 'D-ONE', driverAssignmentRevision: 9 },
    pickups: { TOUR_A: assignmentPickup('D-ONE', 'TOUR_A', 9) },
    actorId: 'admin:hash',
    nowMs: 3_000,
  });
  const differentDriver = buildCanonicalDriverAssignmentUpdates({
    operation: 'unassign',
    driverId: 'D-ONE',
    driverData: { currentTourId: 'TOUR_A', assignmentRevision: 2 },
    tourId: 'TOUR_A',
    tourData: { driverId: 'D-ONE', driverAssignmentRevision: 9 },
    pickups: { TOUR_A: assignmentPickup('D-TWO', 'TOUR_A', 9) },
    actorId: 'admin:hash',
    nowMs: 3_000,
  });

  assert.equal(exact.updates['driver_location_pickups/TOUR_A'], null);
  assert.equal(differentDriver.updates['driver_location_pickups/TOUR_A'], undefined);
});

test('canonical assignment location cleanup uses shared projection fences for every affected tour', async () => {
  const updates = {
    'tours/TOUR_OLD/driverLocation': { projectionRevision: 4, isSharing: false },
    'tours/TOUR_NEW/driverLocation': { projectionRevision: 8, isSharing: false },
    'drivers/D-ONE/currentTourId': 'TOUR_NEW',
  };
  const acquired = [];
  const released = [];
  const invalidations = await acquireAssignmentLocationInvalidations({
    db: {},
    updates,
    leaseOwner: 'assignment:test',
    nowMs: 500,
    acquireInvalidation: async ({ tourId, leaseOwner }) => {
      acquired.push({ tourId, leaseOwner });
      const revision = tourId === 'TOUR_NEW' ? 20 : 21;
      return {
        tourId,
        leaseOwner,
        publicPath: `tours/${tourId}/driverLocation`,
        tombstone: {
          schemaVersion: 1, isSharing: false, timestamp: 500, projectionRevision: revision,
        },
      };
    },
    releaseInvalidation: async ({ invalidation }) => released.push(invalidation.tourId),
  });
  assert.deepEqual(acquired.map(({ tourId }) => tourId), ['TOUR_NEW', 'TOUR_OLD']);
  assert.equal(updates['tours/TOUR_NEW/driverLocation'].projectionRevision, 20);
  assert.equal(updates['tours/TOUR_OLD/driverLocation'].projectionRevision, 21);
  assert.equal(updates['drivers/D-ONE/currentTourId'], 'TOUR_NEW');
  assert.equal(invalidations.length, 2);
  assert.deepEqual(released, []);
});

test('assignment projection fencing releases earlier tours when a later tour is busy', async () => {
  const released = [];
  const busy = Object.assign(new Error('busy'), { code: 'DRIVER_LOCATION_PROJECTION_BUSY' });
  await assert.rejects(acquireAssignmentLocationInvalidations({
    db: {},
    updates: {
      'tours/TOUR_A/driverLocation': null,
      'tours/TOUR_B/driverLocation': null,
    },
    leaseOwner: 'assignment:test',
    nowMs: 500,
    acquireInvalidation: async ({ tourId, leaseOwner }) => {
      if (tourId === 'TOUR_B') throw busy;
      return {
        tourId,
        leaseOwner,
        publicPath: `tours/${tourId}/driverLocation`,
        tombstone: { projectionRevision: 2 },
      };
    },
    releaseInvalidation: async ({ invalidation }) => released.push(invalidation.tourId),
  }), (error) => error.code === 'DRIVER_LOCATION_PROJECTION_BUSY');
  assert.deepEqual(released, ['TOUR_A']);
});

test('admin replacement removes every stale manifest incumbent, not only the tour scalar', () => {
  const result = buildCanonicalDriverAssignmentUpdates({
    operation: 'assign',
    driverId: 'D-NEW',
    driverData: { assignmentRevision: 1 },
    tourId: 'TOUR_A',
    tourData: { driverId: 'D-OLD', driverAssignmentRevision: 2 },
    incumbentDriverId: 'D-OLD',
    incumbentDriversData: {
      'D-OLD': { currentTourId: 'TOUR_A', assignmentRevision: 3 },
      'D-STALE': { currentTourId: 'TOUR_A', assignmentRevision: 8 },
    },
    actorId: 'admin:hash',
    nowMs: 2_000,
  });

  assert.equal(result.updates['tour_manifests/TOUR_A/assigned_drivers/D-OLD'], null);
  assert.equal(result.updates['tour_manifests/TOUR_A/assigned_drivers/D-STALE'], null);
  assert.equal(result.updates['drivers/D-STALE/currentTourId'], null);
  assert.equal(result.updates['drivers/D-STALE/assignmentRevision'], 9);
});

test('transition reservation and worker lease each admit exactly one concurrent owner', async () => {
  const makeAtomicRef = (initial = null) => {
    let current = initial;
    let queue = Promise.resolve();
    return {
      read: () => current,
      ref: () => ({
        transaction(updater) {
          const result = queue.then(() => {
            const next = updater(current);
            if (next === undefined) {
              return { committed: false, snapshot: { val: () => current } };
            }
            current = next;
            return { committed: true, snapshot: { val: () => current } };
          });
          queue = result.then(() => undefined);
          return result;
        },
      }),
    };
  };
  const reservationDb = makeAtomicRef();
  const reservation = {
    actorHash: 'actor-a', requestHash: 'request-a', idempotencyPath: 'idem-a',
  };
  const reservations = await Promise.all([
    reserveDriverAssignmentTransition({
      db: reservationDb, transitionId: 'transition-a', reservation: { ...reservation, reservationOwner: 'one' }, nowMs: 100,
    }),
    reserveDriverAssignmentTransition({
      db: reservationDb, transitionId: 'transition-a', reservation: { ...reservation, reservationOwner: 'two' }, nowMs: 100,
    }),
  ]);
  assert.equal(reservations.filter((result) => result.reserved).length, 1);

  const retryDb = makeAtomicRef({
    status: 'aborted',
    actorHash: reservation.actorHash,
    requestHash: reservation.requestHash,
    idempotencyPath: reservation.idempotencyPath,
  });
  assert.equal((await reserveDriverAssignmentTransition({
    db: retryDb,
    transitionId: 'transition-a',
    reservation: { ...reservation, reservationOwner: 'retry-owner' },
    nowMs: 200,
  })).reserved, true);
  assert.equal(retryDb.read().status, 'reserving');

  const workerDb = makeAtomicRef({ status: 'queued' });
  const workers = await Promise.all([
    acquireAssignmentTransitionWorker({ db: workerDb, transitionId: 'transition-a', owner: 'one', nowMs: 100 }),
    acquireAssignmentTransitionWorker({ db: workerDb, transitionId: 'transition-a', owner: 'two', nowMs: 100 }),
  ]);
  assert.equal(workers.filter((result) => result.acquired).length, 1);
  assert.equal(workerDb.read().workerExpiresAtMs, 100 + (180 * 1000));
});

test('assignment page session locks remain fenced past the function timeout', async () => {
  let current = null;
  const db = {
    ref: () => ({
      transaction: async (updater) => {
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: { val: () => current } };
        current = next;
        return { committed: true, snapshot: { val: () => current } };
      },
    }),
  };
  assert.equal((await acquireAppSessionLock({
    db, authUid: 'uid-a', operation: 'assign', owner: 'worker-a', nowMs: 100,
    ttlMs: ASSIGNMENT_LOCK_TTL_MS,
  })).acquired, true);
  assert.equal((await acquireAppSessionLock({
    db, authUid: 'uid-a', operation: 'assign', owner: 'worker-b', nowMs: 120_100,
    ttlMs: ASSIGNMENT_LOCK_TTL_MS,
  })).acquired, false);
});

test('assignment reconciliation does not restore driver authority after a paged session becomes passenger', async () => {
  const passenger = {
    schemaVersion: 1,
    sessionId: `sess_v1_${'p'.repeat(32)}`,
    authUid: 'uid-a',
    principalId: 'passenger:pax-one',
    principalType: 'passenger',
    tourId: 'TOUR_PASSENGER',
    status: 'active',
    issuedAtMs: 4_000,
    lastAuthenticatedAtMs: 4_000,
    expiresAtMs: 9_999_999,
    sessionRevision: 1,
  };
  const passengerProfile = { principalType: 'passenger', stablePassengerId: 'pax-one' };
  const { state } = await reconcileAfterPaginationRace((current) => {
    current.app_sessions['uid-a'] = passenger;
    current.users['uid-a'] = passengerProfile;
  });

  assert.deepEqual(state.app_sessions['uid-a'], passenger);
  assert.deepEqual(state.users['uid-a'], passengerProfile);
  assert.equal(state.users['uid-a'].driverId, undefined);
  assert.equal(state.users['uid-a'].driverAssignedTourId, undefined);
});

test('assignment reconciliation does not recreate a session that logged out after pagination', async () => {
  const signedOutProfile = { ...driverProfile(), driverAssignedTourId: null };
  const { state } = await reconcileAfterPaginationRace((current) => {
    delete current.app_sessions['uid-a'];
    current.users['uid-a'] = signedOutProfile;
  });

  assert.equal(state.app_sessions['uid-a'], undefined);
  assert.deepEqual(state.users['uid-a'], signedOutProfile);
});

test('assignment reconciliation does not recreate an administratively revoked session after pagination', async () => {
  const revokedProfile = { ...driverProfile(), securityState: 'revoked' };
  const { state } = await reconcileAfterPaginationRace((current) => {
    delete current.app_sessions['uid-a'];
    current.users['uid-a'] = revokedProfile;
  });

  assert.equal(state.app_sessions['uid-a'], undefined);
  assert.deepEqual(state.users['uid-a'], revokedProfile);
});

test('assignment reconciliation skips a fresh profile that no longer maps to the paged driver', async () => {
  const currentSession = { ...session('uid-a', 'm', 3), tourId: null };
  const mismatchedProfile = driverProfile('D-TWO');
  const { state } = await reconcileAfterPaginationRace((current) => {
    current.app_sessions['uid-a'] = currentSession;
    current.users['uid-a'] = mismatchedProfile;
  });

  assert.deepEqual(state.app_sessions['uid-a'], currentSession);
  assert.deepEqual(state.users['uid-a'], mismatchedProfile);
});

test('assignment reconciliation uses a newer same-driver session issued after pagination', async () => {
  const newerSession = { ...session('uid-a', 'n', 7), tourId: null, issuedAtMs: 4_000 };
  const { state } = await reconcileAfterPaginationRace((current) => {
    current.app_sessions['uid-a'] = newerSession;
    current.users['uid-a'] = driverProfile();
    current.notification_devices['uid-a'] = {
      ...current.notification_devices['uid-a'],
      operationalSessionId: newerSession.sessionId,
      operationalSessionRevision: newerSession.sessionRevision,
      registrationRevision: 8,
    };
  });

  assert.equal(state.app_sessions['uid-a'].sessionId, newerSession.sessionId);
  assert.equal(state.app_sessions['uid-a'].sessionRevision, 8);
  assert.equal(state.app_sessions['uid-a'].tourId, 'TOUR_NEW');
  assert.equal(state.notification_devices['uid-a'].operationalSessionId, newerSession.sessionId);
  assert.equal(state.notification_devices['uid-a'].operationalSessionRevision, 8);
});

test('assignment reconciliation derives notification authority from the registration changed after pagination', async () => {
  const currentSession = { ...session('uid-a', 'c', 6), tourId: null, issuedAtMs: 4_000 };
  const freshToken = 'ExponentPushToken[freshfreshfreshfreshfresh1]';
  const freshPreferences = { cruises_ferries: true };
  const { state } = await reconcileAfterPaginationRace((current) => {
    current.app_sessions['uid-a'] = currentSession;
    current.users['uid-a'] = driverProfile();
    current.notification_devices['uid-a'] = {
      operationalEligible: true,
      operationalSessionId: currentSession.sessionId,
      operationalSessionRevision: currentSession.sessionRevision,
      operationalTourId: null,
      marketingEligible: true,
      marketingPreferences: freshPreferences,
      pushToken: freshToken,
      registrationRevision: 40,
    };
  });

  assert.equal(state.notification_devices['uid-a'].pushToken, freshToken);
  assert.deepEqual(state.notification_devices['uid-a'].marketingPreferences, freshPreferences);
  assert.equal(state.notification_devices['uid-a'].registrationRevision, 41);
  assert.equal(state.notification_devices['uid-a'].operationalSessionId, currentSession.sessionId);
  assert.equal(state.notification_devices['uid-a'].operationalSessionRevision, 7);
  assert.equal(state.notification_devices['uid-a'].operationalTourId, 'TOUR_NEW');
});

test('resumable assignment session reads are bounded and cursor-safe beyond 50 handsets', async () => {
  const sessions = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [
    `uid-${index.toString().padStart(3, '0')}`,
    { driverId: 'D-ONE', sessionId: `session-${index}` },
  ]));
  const makeQuery = (cursor = null) => ({
    startAt: (_driverId, key) => makeQuery(key),
    endAt: () => makeQuery(cursor),
    equalTo: () => makeQuery(cursor),
    limitToFirst: (limit) => ({
      once: async () => ({
        val: () => Object.fromEntries(Object.entries(sessions)
          .filter(([key]) => cursor === null || key >= cursor)
          .slice(0, limit)),
      }),
    }),
  });
  const db = { ref: () => ({ orderByChild: () => makeQuery() }) };

  const first = await readDriverSessionPage(db, 'D-ONE', null, 25);
  const second = await readDriverSessionPage(db, 'D-ONE', first.cursor, 25);
  const third = await readDriverSessionPage(db, 'D-ONE', second.cursor, 25);

  assert.equal(first.authUids.length, 25);
  assert.equal(second.authUids.length, 25);
  assert.equal(third.authUids.length, 11);
  assert.equal(first.entries, undefined);
  assert.equal(first.hasMore, true);
  assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.authUids, ...second.authUids, ...third.authUids]).size, 61);
});

test('assignment transition queue failures persist bounded retry history without dropping the job', async () => {
  const transition = {
    transitionId: 'transition-retry',
    status: 'subject_sessions',
    driverId: 'D-ONE',
    tourId: 'TOUR_ONE',
    createdAtMs: 1,
    expiresAtMs: 1_000,
  };
  const { db, state } = createAssignmentTerminalDb({ transitions: { 'transition-retry': transition } });

  assert.equal(await recordAssignmentTransitionFailure({
    db, transitionId: 'transition-retry', nowMs: 10, reason: 'PROJECTION/DETAIL must not leak',
  }), true);
  assert.equal(await recordAssignmentTransitionFailure({
    db, transitionId: 'transition-retry', nowMs: 20, reason: 'SESSION_CLEANUP_RETRY',
  }), true);

  const persisted = state.driver_assignment_transitions.v1['transition-retry'];
  assert.equal(persisted.attemptCount, 2);
  assert.equal(persisted.firstAttemptAtMs, 10);
  assert.equal(persisted.lastAttemptAtMs, 20);
  assert.equal(persisted.lastFailureReason, 'session_cleanup_retry');
  assert.equal(JSON.stringify(persisted).includes('DETAIL must'), false);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-retry'], true);
});

test('expired failed and aborted assignments emit deterministic warnings before exact source deletion', async () => {
  const failed = {
    transitionId: 'transition-failed', status: 'failed', driverId: 'D-ONE', tourId: 'TOUR_ONE',
    incumbentDriverId: 'D-TWO', admissionId: 'assignment-failed', reason: 'ASSIGNMENT_STALE',
    attemptCount: 3, firstAttemptAtMs: 40, lastAttemptAtMs: 80, createdAtMs: 1, expiresAtMs: 100,
  };
  const aborted = {
    transitionId: 'transition-aborted', status: 'aborted', driverId: 'D-THREE', tourId: 'TOUR_TWO',
    reason: 'ASSIGNMENT_RESERVATION_ABORTED', createdAtMs: 2, expiresAtMs: 100,
  };
  const incomplete = {
    transitionId: 'transition-incomplete', status: 'subject_sessions', driverId: 'D-FOUR',
    admissionId: 'assignment-incomplete', createdAtMs: 3, expiresAtMs: 100,
  };
  const retention = {
    old: {
      targetPath: 'driver_assignment_idempotency/v1/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAtMs: 50,
    },
  };
  const { db, state } = createAssignmentTerminalDb({
    transitions: {
      'transition-failed': failed,
      'transition-aborted': aborted,
      'transition-incomplete': incomplete,
    },
    retention,
  });
  const retentionSnapshot = await db.ref('driver_assignment_retention/v1').orderByChild('expiresAtMs')
    .startAt(0).endAt(200).limitToFirst(10).once('value');
  assert.deepEqual(retentionSnapshot.val(), retention);

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 200, limit: 10 }), {
    idempotencyRecordsDeleted: 1,
    transitionsDeleted: 2,
    terminalWarnings: 2,
    terminalWarningFailures: 0,
    terminalCleanupFailures: 0,
  });
  assert.equal(state.driver_assignment_transitions.v1['transition-failed'], undefined);
  assert.equal(state.driver_assignment_transitions.v1['transition-aborted'], undefined);
  assert.deepEqual(state.driver_assignment_transitions.v1['transition-incomplete'], incomplete);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-failed'], undefined);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-aborted'], undefined);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-incomplete'], true);
  assert.equal(state.driver_login_policy.v1.loginAdmissions['assignment-failed'], undefined);
  const warnings = Object.values(state.operations_terminal_warnings.v1);
  assert.equal(warnings.length, 2);
  const failedWarning = warnings.find((warning) => warning.reason === 'assignment_stale');
  assert.ok(failedWarning);
  assert.equal(failedWarning.jobType, 'driver_assignment_transition');
  assert.equal(failedWarning.attemptCount, 3);
  assert.equal(failedWarning.firstAttemptAtMs, 40);
  assert.equal(failedWarning.lastAttemptAtMs, 80);
  assert.equal(failedWarning.acknowledged, false);
  assert.equal(JSON.stringify(warnings).includes('transition-failed'), false);
  assert.equal(JSON.stringify(warnings).includes('D-ONE'), false);

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 300, limit: 10 }), {
    idempotencyRecordsDeleted: 0,
    transitionsDeleted: 0,
    terminalWarnings: 0,
    terminalWarningFailures: 0,
    terminalCleanupFailures: 0,
  });
  assert.equal(Object.keys(state.operations_terminal_warnings.v1).length, 2);
});

test('assignment warning persistence failure retains the claimed transition and replay is idempotent', async () => {
  const failed = {
    transitionId: 'transition-warning-retry', status: 'failed', driverId: 'D-ONE', tourId: 'TOUR_ONE',
    admissionId: 'assignment-warning-retry', reason: 'CLEANUP_RETRY', attemptCount: 2,
    firstAttemptAtMs: 10, lastAttemptAtMs: 20, createdAtMs: 1, expiresAtMs: 100,
  };
  const { db, state, warningWriteAttempts } = createAssignmentTerminalDb({
    transitions: { 'transition-warning-retry': failed },
    failWarningWrites: 1,
  });

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 200, limit: 10 }), {
    idempotencyRecordsDeleted: 0,
    transitionsDeleted: 0,
    terminalWarnings: 0,
    terminalWarningFailures: 1,
    terminalCleanupFailures: 0,
  });
  const retained = state.driver_assignment_transitions.v1['transition-warning-retry'];
  assert.ok(retained);
  assert.match(retained.terminalWarningId, /^warning_v1_[a-f0-9]{32}$/);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-warning-retry'], true);
  assert.ok(state.driver_login_policy.v1.loginAdmissions['assignment-warning-retry']);
  const deterministicWarningId = retained.terminalWarningId;

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 250, limit: 10 }), {
    idempotencyRecordsDeleted: 0,
    transitionsDeleted: 1,
    terminalWarnings: 1,
    terminalWarningFailures: 0,
    terminalCleanupFailures: 0,
  });
  assert.equal(warningWriteAttempts(), 2);
  assert.equal(state.driver_assignment_transitions.v1['transition-warning-retry'], undefined);
  assert.equal(state.driver_assignment_transition_queue.v1['transition-warning-retry'], undefined);
  assert.ok(state.operations_terminal_warnings.v1[deterministicWarningId]);
  assert.equal(Object.keys(state.operations_terminal_warnings.v1).length, 1);
});

test('post-warning atomic cleanup failure retains exact assignment fences for an idempotent replay', async () => {
  const actorHash = 'a'.repeat(24);
  const idempotencyId = 'b'.repeat(24);
  const idempotencyPath = `driver_assignment_idempotency/v1/${actorHash}/${idempotencyId}`;
  const failed = {
    transitionId: 'transition-atomic-retry', status: 'failed', driverId: 'D-ONE', tourId: 'TOUR_NEW',
    previousTourId: 'TOUR_OLD', incumbentDriverId: 'D-TWO', barrierDriverIds: ['D-ONE', 'D-TWO'],
    admissionId: 'assignment-atomic-retry', idempotencyPath, actorHash, requestHash: 'request-hash',
    reason: 'CLEANUP_RETRY', attemptCount: 2, firstAttemptAtMs: 10, lastAttemptAtMs: 20,
    createdAtMs: 1, expiresAtMs: 100,
  };
  const { db, state } = createAssignmentTerminalDb({
    transitions: { 'transition-atomic-retry': failed },
    failRootUpdates: 1,
  });
  state.driver_assignment_idempotency.v1[actorHash] = {
    [idempotencyId]: {
      schemaVersion: 1,
      status: 'pending',
      transitionId: failed.transitionId,
      requestHash: failed.requestHash,
    },
  };

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 200, limit: 10 }), {
    idempotencyRecordsDeleted: 0,
    transitionsDeleted: 0,
    terminalWarnings: 1,
    terminalWarningFailures: 0,
    terminalCleanupFailures: 1,
  });
  const retained = state.driver_assignment_transitions.v1[failed.transitionId];
  assert.ok(retained);
  assert.match(retained.terminalWarningId, /^warning_v1_[a-f0-9]{32}$/);
  assert.equal(state.driver_assignment_transition_queue.v1[failed.transitionId], true);
  assert.ok(state.driver_login_policy.v1.loginAdmissions[failed.admissionId]);
  assert.equal(state.driver_assignment_active.v1['D-ONE'].transitionId, failed.transitionId);
  assert.equal(state.driver_assignment_active.v1['D-TWO'].transitionId, failed.transitionId);
  assert.ok(state.driver_assignment_locks.drivers['D-ONE']);
  assert.ok(state.driver_assignment_locks.tours.TOUR_NEW);
  assert.ok(state.driver_assignment_locks.tours.TOUR_OLD);
  assert.ok(state.driver_assignment_idempotency.v1[actorHash][idempotencyId]);
  const warningId = retained.terminalWarningId;
  assert.equal(Object.keys(state.operations_terminal_warnings.v1).length, 1);

  assert.deepEqual(await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 250, limit: 10 }), {
    idempotencyRecordsDeleted: 0,
    transitionsDeleted: 1,
    terminalWarnings: 1,
    terminalWarningFailures: 0,
    terminalCleanupFailures: 0,
  });
  assert.equal(state.driver_assignment_transitions.v1[failed.transitionId], undefined);
  assert.equal(state.driver_assignment_transition_queue.v1[failed.transitionId], undefined);
  assert.equal(state.driver_login_policy.v1.loginAdmissions[failed.admissionId], undefined);
  assert.equal(state.driver_assignment_active.v1['D-ONE'], undefined);
  assert.equal(state.driver_assignment_active.v1['D-TWO'], undefined);
  assert.equal(state.driver_assignment_locks.drivers['D-ONE'], undefined);
  assert.equal(state.driver_assignment_locks.tours.TOUR_NEW, undefined);
  assert.equal(state.driver_assignment_locks.tours.TOUR_OLD, undefined);
  assert.equal(state.driver_assignment_idempotency.v1[actorHash][idempotencyId], undefined);
  assert.ok(state.operations_terminal_warnings.v1[warningId]);
  assert.equal(Object.keys(state.operations_terminal_warnings.v1).length, 1);
});

test('same-driver logins stay concurrent but an assignment barrier admits no behind-cursor login', async () => {
  let current = null;
  let queue = Promise.resolve();
  const db = {
    ref(path) {
      assert.equal(path, 'driver_assignment_active/v1/D-ONE');
      return {
        transaction(updater) {
          const work = queue.then(() => {
            const next = updater(current);
            if (next === undefined) return { committed: false, snapshot: { val: () => current } };
            current = next;
            return { committed: true, snapshot: { val: () => current } };
          });
          queue = work.then(() => undefined);
          return work;
        },
      };
    },
  };

  const [first, second] = await Promise.all([
    acquireDriverAssignmentLoginAdmission({
      db, driverId: 'D-ONE', admissionId: 'login-a', authUidHash: 'hash-a', nowMs: 100,
    }),
    acquireDriverAssignmentLoginAdmission({
      db, driverId: 'D-ONE', admissionId: 'login-b', authUidHash: 'hash-b', nowMs: 100,
    }),
  ]);
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  assert.equal((await acquireDriverAssignmentBarrier({
    db, driverId: 'D-ONE', transitionId: 'assignment-1', nowMs: 101,
  })).acquired, false);

  await releaseDriverAssignmentLoginAdmission({ db, driverId: 'D-ONE', admissionId: 'login-a' });
  await releaseDriverAssignmentLoginAdmission({ db, driverId: 'D-ONE', admissionId: 'login-b' });
  assert.equal((await acquireDriverAssignmentBarrier({
    db, driverId: 'D-ONE', transitionId: 'assignment-1', nowMs: 102,
  })).acquired, true);
  assert.equal((await acquireDriverAssignmentLoginAdmission({
    db, driverId: 'D-ONE', admissionId: 'login-late', authUidHash: 'hash-late', nowMs: 103,
  })).acquired, false);
  assert.equal((await acquireDriverAssignmentBarrier({
    db, driverId: 'D-ONE', transitionId: 'assignment-1', nowMs: 1_000_000,
  })).acquired, true);
  assert.equal((await acquireDriverAssignmentLoginAdmission({
    db, driverId: 'D-ONE', admissionId: 'login-after-fifteen-minutes', authUidHash: 'hash-late', nowMs: 1_000_001,
  })).acquired, false);
});

test('transition identity scopes semantic requests by actor and idempotency key', () => {
  const first = createAssignmentTransitionId({ actorHash: 'actor-a', idempotencyId: 'key-a' });
  const otherUid = createAssignmentTransitionId({ actorHash: 'actor-b', idempotencyId: 'key-a' });
  const otherKey = createAssignmentTransitionId({ actorHash: 'actor-a', idempotencyId: 'key-b' });
  assert.notEqual(first, otherUid);
  assert.notEqual(first, otherKey);

  const originalHash = createAssignmentRequestHash({
    operation: 'assign', driverId: 'D-ONE', tourId: 'TOUR_A', expectedDriverRevision: 1, expectedTourRevision: 1,
  });
  const alteredHash = createAssignmentRequestHash({
    operation: 'unassign', driverId: 'D-ONE', tourId: 'TOUR_A', expectedDriverRevision: 1, expectedTourRevision: 1,
  });
  assert.equal(
    createAssignmentTransitionId({ actorHash: 'actor-a', idempotencyId: 'key-a' }),
    first,
  );
  assert.notEqual(originalHash, alteredHash);
});

test('cleanup failure cannot advance a resumable assignment cursor or status', async () => {
  let updateCalled = false;
  const db = { ref: () => ({ update: async () => { updateCalled = true; } }) };
  await assert.rejects(commitReconciliationAfterCleanup({
    db,
    cleanupTasks: [Promise.reject(Object.assign(new Error('projection busy'), { code: 'PROJECTION_BUSY' }))],
    updates: {
      'driver_assignment_transitions/v1/t1/subjectSessionCursor': 'uid-025',
      'driver_assignment_transitions/v1/t1/status': 'finalizing',
    },
  }), /projection busy/);
  assert.equal(updateCalled, false);
});
