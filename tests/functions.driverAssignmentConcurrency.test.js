'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCanonicalDriverAssignmentUpdates,
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
  readDriverSessionPage,
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

  assert.equal(first.entries.length, 25);
  assert.equal(second.entries.length, 25);
  assert.equal(third.entries.length, 11);
  assert.equal(first.hasMore, true);
  assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.entries, ...second.entries, ...third.entries].map(([key]) => key)).size, 61);
});

test('assignment retention cleanup deletes only bounded expired private records', async () => {
  const rootUpdates = [];
  const activeTransactions = [];
  const values = {
    'driver_assignment_retention/v1': {
      old: {
        targetPath: 'driver_assignment_idempotency/v1/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb',
        expiresAtMs: 50,
      },
    },
    'driver_assignment_transitions/v1': {
      transition1: {
        status: 'failed', driverId: 'D-ONE', incumbentDriverId: 'D-TWO', admissionId: 'assignment-1', expiresAtMs: 50,
      },
      incomplete: {
        status: 'subject_sessions', driverId: 'D-THREE', admissionId: 'assignment-2', expiresAtMs: 50,
      },
    },
  };
  const db = {
    ref(path = '') {
      if (!path) return { update: async (updates) => rootUpdates.push(updates) };
      if (path.startsWith('driver_assignment_active/v1/')) return {
        transaction: async (updater) => {
          activeTransactions.push(path);
          return { committed: updater('transition1') === null };
        },
      };
      return {
        orderByChild: () => ({ startAt: () => ({ endAt: () => ({ limitToFirst: (limit) => ({
          once: async () => {
            assert.equal(limit, 10);
            return { val: () => values[path] || {} };
          },
        }) }) }) }),
      };
    },
  };

  const result = await cleanupExpiredDriverAssignmentRecords({ db, nowMs: 100, limit: 10 });
  assert.deepEqual(result, { idempotencyRecordsDeleted: 1, transitionsDeleted: 1 });
  assert.equal(rootUpdates[0]['driver_assignment_idempotency/v1/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb'], null);
  assert.equal(rootUpdates[0]['driver_login_policy/v1/loginAdmissions/assignment-1'], null);
  assert.equal(rootUpdates[0]['driver_assignment_transitions/v1/incomplete'], undefined);
  assert.equal(rootUpdates[0]['driver_login_policy/v1/loginAdmissions/assignment-2'], undefined);
  assert.deepEqual(activeTransactions.sort(), [
    'driver_assignment_active/v1/D-ONE',
    'driver_assignment_active/v1/D-TWO',
  ]);
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
