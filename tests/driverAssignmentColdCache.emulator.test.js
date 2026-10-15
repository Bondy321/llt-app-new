'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A local Realtime Database emulator is required');
}
const projectId = 'demo-llt-assignment-cold';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const {
  queueOwnedDriverAssignmentTransition, abandonDriverAssignmentReservation,
  acquireAssignmentTransitionWorker, releaseAssignmentTransitionWorker,
  releaseDriverAssignmentBarrier, recordAssignmentTransitionFailure,
  processDriverAssignmentTransitions,
  advanceDriverAssignmentTransition,
} = require('../functions/src/domains/driver-assignment/assignmentTransition');
const { renewDriverLoginAdmission } = require('../functions/src/domains/driver-auth/driverDevicePolicy');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'assignment-fixture-writer');
const db = writer.database();
const transitionId = 'synthetic-transition';
const transitionPath = `driver_assignment_transitions/v1/${transitionId}`;
const barrierPath = 'driver_assignment_active/v1/D-SYNTHETIC';
const admissionPath = 'driver_login_policy/v1/loginAdmissions/synthetic-admission';
let appCounter = 0;
const reservation = () => ({ schemaVersion: 1, status: 'reserving', transitionId,
  reservationOwner: 'synthetic-owner', driverId: 'D-SYNTHETIC', tourId: 'SYNTHETIC_TOUR',
  barrierDriverIds: ['D-SYNTHETIC'], admissionId: 'synthetic-admission',
  reservationExpiresAtMs: Date.now() + 180000, createdAtMs: Date.now(), updatedAtMs: Date.now() });

// Seed on one actual Admin connection, then transact through a separate named
// app which has never subscribed/read the path. Observe the genuine SDK callback
// values; do not fake a null cache or replace the server's transaction protocol.
const cold = async operation => {
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `assignment-cold-${++appCounter}`);
  const observations = new Map();
  const database = { ref(path = '') {
    const ref = path ? app.database().ref(path) : app.database().ref();
    const transaction = ref.transaction.bind(ref);
    ref.transaction = (update, ...args) => transaction(current => {
      if (!observations.has(path)) observations.set(path, current === null);
      return update(current);
    }, ...args);
    return ref;
  } };
  try { return await operation(database, observations); }
  finally { await app.delete(); }
};
test.beforeEach(async () => { await db.ref().set(null); });
test.after(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

test('actual Admin SDK cold null does not prove a reserved server record is absent', async () => {
  await db.ref(transitionPath).set(reservation());
  await cold(async (database, observations) => {
    const rejected = await database.ref(transitionPath).transaction(current => current ? current : undefined, undefined, false);
    assert.equal(observations.get(transitionPath), true);
    assert.equal(rejected.committed, false, 'the original null-abort pattern never reaches the existing server reservation');
    assert.equal((await db.ref(transitionPath).get()).val().status, 'reserving');
  });
});

test('cold queue handoff reaches the server and preserves its exact reservation', async () => {
  const source = reservation();
  await db.ref(transitionPath).set(source);
  await cold(async (database, observations) => {
    assert.equal(await queueOwnedDriverAssignmentTransition({ db: database, transitionId,
      reservationOwner: source.reservationOwner, policy: { generation: 3 }, nowMs: 123 }), true);
    assert.equal(observations.get(transitionPath), true);
  });
  const saved = (await db.ref(transitionPath).get()).val();
  assert.equal(saved.status, 'queued');
  assert.equal(saved.reservationOwner, source.reservationOwner);
  assert.equal(saved.driverId, source.driverId);
  assert.equal(saved.reservationExpiresAtMs, undefined);
  assert.deepEqual(saved.policy, { generation: 3 });
});

test('concurrent cold workers and queue handoffs admit exactly one owner', async () => {
  await db.ref(transitionPath).set(reservation());
  const queued = await Promise.all([0, 1].map(() => cold(database => queueOwnedDriverAssignmentTransition({
    db: database, transitionId, reservationOwner: 'synthetic-owner', policy: { generation: 3 },
  }))));
  assert.equal(queued.filter(Boolean).length, 1);
  const claims = await Promise.all(['worker-a', 'worker-b'].map(owner => cold(database => acquireAssignmentTransitionWorker({
    db: database, transitionId, owner, nowMs: 100,
  }))));
  assert.equal(claims.filter(result => result.acquired).length, 1);
  assert.equal((await db.ref(transitionPath).get()).val().workerOwner, claims.find(result => result.acquired).owner);
});

test('queue and abandon cannot recreate a deleted reservation or replace another owner/state', async () => {
  for (const source of [null, { ...reservation(), reservationOwner: 'another-owner' },
    { ...reservation(), status: 'queued' }]) {
    await db.ref(transitionPath).set(source);
    await cold(async database => {
      assert.equal(await queueOwnedDriverAssignmentTransition({ db: database, transitionId,
        reservationOwner: 'synthetic-owner', policy: { generation: 3 } }), false);
      assert.equal(await abandonDriverAssignmentReservation({ db: database, transitionId,
        reservationOwner: 'synthetic-owner' }), false);
    });
    assert.deepEqual((await db.ref(transitionPath).get()).val(), source);
  }
});

test('cold abandonment releases exact reservation, admission and barrier without changing operational data', async () => {
  const source = reservation();
  await db.ref().update({ [transitionPath]: source,
    [`driver_assignment_transition_queue/v1/${transitionId}`]: true,
    [admissionPath]: { durableUntilExplicitRelease: true },
    [barrierPath]: { schemaVersion: 1, transitionId },
    'driver_assignment_active/v1/D-OTHER': { transitionId: 'another-transition' },
    'tour_manifests/SYNTHETIC_TOUR/bookings/preserved': { boardingStatus: 'BOARDED', passengerCount: 2 },
  });
  await cold(async (database, observations) => {
    assert.equal(await abandonDriverAssignmentReservation({ db: database, transitionId,
      reservationOwner: source.reservationOwner }), true);
    assert.equal(observations.get(transitionPath), true);
    assert.equal(observations.get(barrierPath), true);
  });
  assert.equal((await db.ref(transitionPath).get()).val().status, 'aborted');
  for (const path of [admissionPath, barrierPath, `driver_assignment_transition_queue/v1/${transitionId}`]) {
    assert.equal((await db.ref(path).get()).exists(), false, path);
  }
  assert.deepEqual((await db.ref('driver_assignment_active/v1/D-OTHER').get()).val(), { transitionId: 'another-transition' });
  assert.equal((await db.ref('tour_manifests/SYNTHETIC_TOUR/bookings/preserved/boardingStatus').get()).val(), 'BOARDED');
});

test('cold worker claim/release acknowledges only a live exact owner and never recreates deleted work', async () => {
  await db.ref(transitionPath).set({ ...reservation(), status: 'queued' });
  await cold(async (database, observations) => {
    const claimed = await acquireAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-a', nowMs: 100 });
    assert.equal(observations.get(transitionPath), true);
    assert.equal(claimed.acquired, true);
  });
  await cold(async database => {
    assert.equal((await acquireAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-b', nowMs: 101 })).acquired, false);
    assert.equal(await releaseAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-b' }), false);
  });
  await cold(async (database, observations) => {
    assert.equal(await releaseAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-a' }), true);
    assert.equal(observations.get(transitionPath), true);
  });
  await db.ref(transitionPath).remove();
  await cold(async database => {
    assert.equal((await acquireAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-a' })).acquired, false);
    assert.equal(await releaseAssignmentTransitionWorker({ db: database, transitionId, owner: 'worker-a' }), false);
  });
  assert.equal((await db.ref(transitionPath).get()).exists(), false);
});

test('cold barrier release preserves another transition and is safe to replay after absence', async () => {
  await db.ref(barrierPath).set({ schemaVersion: 1, transitionId });
  await cold(async database => assert.equal(await releaseDriverAssignmentBarrier({ db: database,
    driverId: 'D-SYNTHETIC', transitionId: 'other-transition' }), false));
  await cold(async (database, observations) => {
    assert.equal(await releaseDriverAssignmentBarrier({ db: database, driverId: 'D-SYNTHETIC', transitionId }), true);
    assert.equal(observations.get(barrierPath), true);
  });
  await cold(async database => assert.equal(await releaseDriverAssignmentBarrier({ db: database,
    driverId: 'D-SYNTHETIC', transitionId }), false));
  assert.equal((await db.ref(barrierPath).get()).exists(), false);
});

test('cold durable admission renewal never treats a deleted admission as valid', async () => {
  await db.ref(admissionPath).set({ schemaVersion: 1, durableUntilExplicitRelease: true, generation: 3 });
  await cold(async (database, observations) => {
    assert.equal(await renewDriverLoginAdmission({ db: database, admissionId: 'synthetic-admission', nowMs: 123 }), true);
    assert.equal(observations.get(admissionPath), true);
  });
  assert.equal((await db.ref(admissionPath).get()).val().lastRenewedAtMs, 123);
  await db.ref(admissionPath).remove();
  await cold(async database => assert.equal(await renewDriverLoginAdmission({ db: database, admissionId: 'synthetic-admission' }), false));
  assert.equal((await db.ref(admissionPath).get()).exists(), false);
});

test('cold failure bookkeeping records current work without recreating an absent transition', async () => {
  await db.ref(transitionPath).set({ ...reservation(), status: 'queued' });
  await cold(async (database, observations) => {
    assert.equal(await recordAssignmentTransitionFailure({ db: database, transitionId, nowMs: 123, reason: 'SYNTHETIC_RETRY' }), true);
    assert.equal(observations.get(transitionPath), true);
  });
  assert.equal((await db.ref(transitionPath).get()).val().attemptCount, 1);
  await db.ref(transitionPath).remove();
  await cold(async database => assert.equal(await recordAssignmentTransitionFailure({ db: database, transitionId, nowMs: 124, reason: 'SYNTHETIC_RETRY' }), false));
  assert.equal((await db.ref(transitionPath).get()).exists(), false);
});

test('supported scheduler recovery expires an interrupted reservation and clears its durable barrier', async () => {
  await db.ref().update({ [transitionPath]: { ...reservation(), reservationExpiresAtMs: 100 },
    [`driver_assignment_transition_queue/v1/${transitionId}`]: true,
    [admissionPath]: { durableUntilExplicitRelease: true }, [barrierPath]: { schemaVersion: 1, transitionId } });
  await cold(async database => {
    const result = await processDriverAssignmentTransitions({ db: database, nowMs: 101 });
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].reason, 'ASSIGNMENT_RESERVATION_EXPIRED');
  });
  assert.equal((await db.ref(transitionPath).get()).val().reason, 'ASSIGNMENT_RESERVATION_EXPIRED');
  assert.equal((await db.ref(barrierPath).get()).exists(), false);
  assert.equal((await db.ref(admissionPath).get()).exists(), false);
});

test('supported recovery handles the live failure shape: expired reservation and barrier with no admission', async () => {
  await db.ref().update({ [transitionPath]: { ...reservation(), reservationExpiresAtMs: 100 },
    [`driver_assignment_transition_queue/v1/${transitionId}`]: true,
    [barrierPath]: { schemaVersion: 1, transitionId, durableUntilExplicitRelease: true },
    'drivers/D-SYNTHETIC': { currentTourId: 'OLD_TOUR', assignmentRevision: 0 },
    'tour_manifests/SYNTHETIC_TOUR/bookings/history': { boardingStatus: 'BOARDED' },
  });
  await cold(async database => {
    const result = await processDriverAssignmentTransitions({ db: database, nowMs: 101 });
    assert.equal(result.results[0].reason, 'ASSIGNMENT_RESERVATION_EXPIRED');
  });
  assert.equal((await db.ref(barrierPath).get()).exists(), false);
  assert.equal((await db.ref(admissionPath).get()).exists(), false);
  assert.deepEqual((await db.ref('drivers/D-SYNTHETIC').get()).val(), { currentTourId: 'OLD_TOUR', assignmentRevision: 0 });
  assert.equal((await db.ref('tour_manifests/SYNTHETIC_TOUR/bookings/history/boardingStatus').get()).val(), 'BOARDED');
  assert.equal((await db.ref(transitionPath).get()).val().status, 'failed', 'failed intent remains recorded, never silently discarded');
});

test('exact terminal replay repairs an orphan cold barrier without a queue or changing a successor', async () => {
  for (const status of ['failed', 'completed']) {
    const source = { ...reservation(), status, reason: 'ASSIGNMENT_RESERVATION_EXPIRED', result: { assigned: true } };
    await db.ref().update({ [transitionPath]: source,
      [barrierPath]: { schemaVersion: 1, transitionId, durableUntilExplicitRelease: true },
      'driver_assignment_active/v1/D-SUCCESSOR': { transitionId: 'successor' } });
    await cold(async (database, observations) => {
      const result = await advanceDriverAssignmentTransition({ db: database, transitionId });
      assert.equal(result.status, status);
      assert.equal(observations.get(barrierPath), true);
    });
    assert.equal((await db.ref(barrierPath).get()).exists(), false);
    assert.deepEqual((await db.ref(transitionPath).get()).val(), source);
    await db.ref(barrierPath).set({ transitionId: 'successor' });
    await cold(database => advanceDriverAssignmentTransition({ db: database, transitionId }));
    assert.deepEqual((await db.ref(barrierPath).get()).val(), { transitionId: 'successor' });
    assert.deepEqual((await db.ref('driver_assignment_active/v1/D-SUCCESSOR').get()).val(), { transitionId: 'successor' });
  }
});
