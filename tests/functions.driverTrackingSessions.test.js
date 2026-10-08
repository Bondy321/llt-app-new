'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hasCurrentDriverAuthority } = require('../functions/lib/driverLocationProjection');
const { cleanupExpiredDriverLocations } = require('../functions/lib/driverLocationExpiryCleanup');
const {
  hasActiveTrackingIntent, reconcileDriverTrackingIntentChange, retireDriverTrackingIntentsForAppSession,
} = require('../functions/src/domains/live-state/driverTrackingSessions');
const { parseTrackingStopInput, performDriverTrackingStop } = require('../functions/src/domains/live-state/driverTrackingStop');
const { createDriverTrackingStopHandler } = require('../functions/src/domains/live-state/driverTrackingStopFunctions');
const { buildDriverSessionRecord } = require('../functions/lib/appSession');
const { cleanupLiveStateForSession } = require('../functions/lib/appSessionCleanup');

function createMockDatabase(initialState, { beforeTransaction, coldTransactionPaths = [] } = {}) {
  const state = structuredClone(initialState);
  const parts = (path) => String(path || '').split('/').filter(Boolean);
  const read = (path) => parts(path).reduce((node, part) => node?.[part], state);
  const write = (path, value) => {
    const keys = parts(path);
    let cursor = state;
    keys.slice(0, -1).forEach((key) => {
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    });
    if (value === null) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = structuredClone(value);
  };
  const nestedValue = (value, key) => key.split('/').reduce((node, part) => node?.[part], value);
  const snapshot = (value) => ({ exists: () => value != null, val: () => structuredClone(value ?? null) });

  return {
    state,
    ref(path = '') {
      let query = { orderBy: null, equalTo: undefined, startAt: -Infinity, endAt: Infinity, limit: Infinity };
      const ref = {
        orderByChild(key) { query.orderBy = key; return ref; },
        equalTo(value) { query.equalTo = value; return ref; },
        startAt(value) { query.startAt = value; return ref; },
        endAt(value) { query.endAt = value; return ref; },
        limitToFirst(value) { query.limit = value; return ref; },
        async once() { return ref.get(); },
        async get() {
          const value = read(path);
          if (!query.orderBy || !value || typeof value !== 'object') return snapshot(value);
          const selected = Object.entries(value)
            .filter(([, item]) => {
              const orderedValue = nestedValue(item, query.orderBy);
              if (query.equalTo !== undefined) return orderedValue === query.equalTo;
              return Number.isFinite(orderedValue) && orderedValue >= query.startAt && orderedValue <= query.endAt;
            })
            .sort(([leftId, left], [rightId, right]) => {
              const byValue = nestedValue(left, query.orderBy) - nestedValue(right, query.orderBy);
              return byValue || leftId.localeCompare(rightId);
            })
            .slice(0, query.limit);
          return snapshot(Object.fromEntries(selected));
        },
        async transaction(update) {
          await beforeTransaction?.({ path, state, read, write });
          const current = structuredClone(read(path) ?? null);
          if (coldTransactionPaths.includes(path) && update(null) === undefined) {
            return { committed: false, snapshot: snapshot(current) };
          }
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          write(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
      return ref;
    },
  };
}


const SID = `sess_v1_${'a'.repeat(32)}`;
const live = 'track_first';
const sourceKey = `${SID}|${live}`;
const intent = (overrides = {}) => ({ schemaVersion: 1, authUid: 'uid-a', appSessionId: SID,
  driverId: 'D-A', tourId: 'tour_a', liveSharingSessionId: live,
  startedAtMs: 100, expiresAtMs: 2000, status: 'active', ...overrides });
const source = (overrides = {}) => ({ schemaVersion: 2, isSharing: true, source: 'auto', mode: 'live',
  authUid: 'uid-a', appSessionId: SID, driverId: 'D-A', tourId: 'tour_a', liveSharingSessionId: live,
  latitude: 56.1, longitude: -4.2, accuracy: 10, timestamp: 200, cleanupAtMs: 3000, ...overrides });
const state = (tracking = intent(), location = source()) => ({
  driver_tracking_sessions: tracking ? { [sourceKey]: tracking } : {},
  driver_location_sessions: location ? { [sourceKey]: location } : {},
});
const event = (database, before, after, reconcileProjection = async () => {}) =>
  reconcileDriverTrackingIntentChange({ database, sourceKey, before, after, nowMs: 1000, reconcileProjection });

test('tracked authority requires exact active unexpired intent; legacy sources remain compatible', async () => {
  for (const tracking of [null, intent({ status: 'stopped' }), intent({ expiresAtMs: 1000 }),
    intent({ driverId: 'D-B' }), intent({ tourId: 'tour_b' }), intent({ authUid: 'uid-b' }),
    intent({ extraPermission: true }), intent({ liveSharingSessionId: 'track_other' })]) {
    assert.equal(await hasActiveTrackingIntent(createMockDatabase(state(tracking)), source(), 1000), false);
  }
  assert.equal(await hasActiveTrackingIntent(createMockDatabase(state()), source(), 1000), true);
  assert.equal(await hasActiveTrackingIntent(createMockDatabase({}), source({ liveSharingSessionId: 'loc_legacy' }), 1000), true);
});

test('server driver authority excludes tracked sources even when the entire current assignment remains valid', async () => {
  const initial = { ...state(),
    app_sessions: { 'uid-a': { sessionId: SID, authUid: 'uid-a', status: 'active', principalType: 'driver',
      principalId: 'driver:D-A', driverId: 'D-A', tourId: 'tour_a', expiresAtMs: 2000, driverLoginPolicyGeneration: 0 } },
    users: { 'uid-a': { principalType: 'driver', driverId: 'D-A', driverAssignedTourId: 'tour_a' } },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0 } },
    drivers: { 'D-A': { authUid: 'uid-a' } },
    tour_manifests: { tour_a: { assigned_drivers: { 'D-A': true } } },
  };
  const database = createMockDatabase(initial);
  assert.equal(await hasCurrentDriverAuthority(database, source(), 1000), true);
  database.state.driver_tracking_sessions[sourceKey].status = 'stopped';
  assert.equal(await hasCurrentDriverAuthority(database, source(), 1000), false);
  assert.equal(await hasCurrentDriverAuthority(database, source({ liveSharingSessionId: 'loc_legacy' }), 1000), true);
});

test('a stopped event removes only its owned live leaf and keeps the tombstone and other handset', async () => {
  const database = createMockDatabase(state(intent({ status: 'stopped' })));
  database.state.driver_location_sessions.other = source({ authUid: 'uid-b', appSessionId: 'other', liveSharingSessionId: 'track_other' });
  const tours = [];
  const result = await event(database, intent(), intent({ status: 'stopped' }), async ({ tourId }) => tours.push(tourId));
  assert.equal(result.removed, true);
  assert.equal(database.state.driver_location_sessions[sourceKey], undefined);
  assert.ok(database.state.driver_location_sessions.other);
  assert.equal(database.state.driver_tracking_sessions[sourceKey].status, 'stopped');
  assert.deepEqual(tours, ['tour_a']);
  assert.equal((await event(database, intent(), intent({ status: 'stopped' }))).removed, false);
});

test('delayed stopped and deleted events preserve a currently active replacement', async () => {
  for (const after of [intent({ status: 'stopped' }), null]) {
    const database = createMockDatabase(state());
    assert.equal((await event(database, intent({ status: 'stopped' }), after)).reason, 'ACTIVE_INTENT');
    assert.ok(database.state.driver_location_sessions[sourceKey]);
  }
  const database = createMockDatabase(state(intent({ status: 'stopped', startedAtMs: 500 })));
  assert.equal((await event(database, intent(), intent({ status: 'stopped' }))).reason, 'INTENT_CHANGED');
  assert.ok(database.state.driver_location_sessions[sourceKey]);
});

test('deleted intent reconciles current public state while preserving mismatched live ownership', async () => {
  const database = createMockDatabase(state(null, source({ authUid: 'uid-b' })));
  const tours = [];
  const result = await event(database, intent({ status: 'stopped' }), null, async ({ tourId }) => tours.push(tourId));
  assert.equal(result.removed, false);
  assert.ok(database.state.driver_location_sessions[sourceKey]);
  assert.deepEqual(tours, ['tour_a']);
});

test('intent expiry cleanup is indexed and bounded and retains stopped fences until immutable expiry', async () => {
  const database = createMockDatabase(state(intent({ status: 'stopped', expiresAtMs: 1000 })));
  const futureKey = `${SID}|track_future`;
  database.state.driver_tracking_sessions[futureKey] = intent({ status: 'stopped', liveSharingSessionId: 'track_future', expiresAtMs: 1001 });
  const result = await cleanupExpiredDriverLocations({ database, nowMs: 1000, limit: 1, reconcileProjection: async () => {} });
  assert.equal(result.trackingIntentsScanned, 1);
  assert.equal(result.trackingIntentsRemoved, 1);
  assert.equal(result.trackingSourcesRemoved, 1);
  assert.equal(result.hasMore, true);
  assert.equal(database.state.driver_tracking_sessions[sourceKey], undefined);
  assert.ok(database.state.driver_tracking_sessions[futureKey]);
  assert.equal(database.state.driver_location_sessions[sourceKey], undefined);
});

test('expiry compare-and-delete preserves an intent refreshed during reconciliation', async () => {
  const database = createMockDatabase(state(intent({ expiresAtMs: 1000 })));
  const result = await cleanupExpiredDriverLocations({ database, nowMs: 1000, reconcileProjection: async () => {
    database.state.driver_tracking_sessions[sourceKey] = intent({ startedAtMs: 500, expiresAtMs: 4000 });
  } });
  assert.equal(result.trackingIntentsRemoved, 0);
  assert.equal(database.state.driver_tracking_sessions[sourceKey].expiresAtMs, 4000);
});


const STOP_NOW = 100_000;
const stopIntent = (overrides = {}) => intent({ status: 'stopped', startedAtMs: 1000, expiresAtMs: 200_000, ...overrides });
const stopAuthorityState = () => ({
  app_sessions: { 'uid-a': buildDriverSessionRecord({ authUid: 'uid-a', sessionId: SID, driverId: 'D-A',
    tourId: 'tour_a', nowMs: 1000, expiresAtMs: 200_000 }) },
  users: { 'uid-a': { principalType: 'driver', driverId: 'D-A', driverPrincipalId: 'driver:D-A', driverAssignedTourId: 'tour_a' } },
  drivers: { 'D-A': { authUid: 'uid-a', currentTourId: 'tour_a' } },
  tour_manifests: { tour_a: { assigned_drivers: { 'D-A': true } } },
  tours: { tour_a: { driverId: 'D-A', driverAssignmentRevision: 7 } },
  driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0,
    revision: 1, updatedAtMs: 1000, transitionPhase: 'stable' } },
});
const stop = (db, input = stopIntent(), options = {}) => performDriverTrackingStop({
  db, authUid: 'uid-a', input, nowMs: STOP_NOW, reconcileProjection: async () => {}, ...options,
});

test('stop API parser requires exact stopped schema and rejects unsafe ownership path segments', () => {
  assert.deepEqual(parseTrackingStopInput(stopIntent()), stopIntent());
  for (const changes of [{ status: 'active' }, { extra: true }, { driverId: '../other' },
    { authUid: 'uid/other' }, { liveSharingSessionId: 'loc_legacy' }, { startedAtMs: null }]) {
    assert.equal(parseTrackingStopInput(stopIntent(changes)), null);
  }
});

test('authenticated trusted stop records monotonic stopped intent before deleting and reprojecting', async () => {
  const db = createMockDatabase(state(stopIntent({ status: 'active' }), source()));
  let projected = false;
  const result = await stop(db, stopIntent(), { reconcileProjection: async () => {
    assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'stopped');
    assert.equal(db.state.driver_location_sessions[sourceKey], undefined);
    projected = true;
  } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.withdrawalAcknowledged, true);
  assert.equal(result.payload.sourceRemoved, true);
  assert.equal(result.payload.fencePersisted, true);
  assert.equal(projected, true);
  assert.equal(db.state.app_session_locks['uid-a'], undefined);
  assert.deepEqual(db.state.driver_tracking_sessions[sourceKey], stopIntent());
  assert.equal((await stop(db)).payload.sourceRemoved, false);
});

test('ambiguous missing-fence stop accepts old start only under full current driver authority', async () => {
  const db = createMockDatabase(stopAuthorityState());
  let projected = false;
  const result = await stop(db, stopIntent(), { reconcileProjection: async () => { projected = true; } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.fencePersisted, true);
  assert.deepEqual(db.state.driver_tracking_sessions[sourceKey], stopIntent());
  assert.equal(projected, true);
  assert.equal(db.state.app_session_locks['uid-a'], undefined);
  assert.equal(db.state.driver_assignment_locks.drivers['D-A'], undefined);
  assert.equal(db.state.driver_assignment_locks.tours.tour_a, undefined);
});

test('exact retained source proves retired ownership even without an intent, active session, or current policy', async () => {
  const db = createMockDatabase(state(null, source()));
  const retired = stopIntent({ startedAtMs: 100, expiresAtMs: 2000 });
  let projected = false;
  const result = await stop(db, retired, { reconcileProjection: async () => { projected = true; } });
  assert.equal(result.status, 200);
  assert.deepEqual(db.state.driver_tracking_sessions[sourceKey], retired);
  assert.equal(db.state.driver_location_sessions[sourceKey], undefined);
  assert.equal(projected, true);
});

for (const [name, mutate] of [
  ['missing session', value => { delete value.app_sessions['uid-a']; }],
  ['changed session', value => { value.app_sessions['uid-a'].sessionId = `sess_v1_${'b'.repeat(32)}`; }],
  ['revoked session', value => { value.app_sessions['uid-a'].status = 'revoked'; }],
  ['expired session', value => { value.app_sessions['uid-a'].expiresAtMs = STOP_NOW; }],
]) test(`missing state with ${name} acknowledges exact absence without selecting an unowned tour to reproject`, async () => {
  const initial = stopAuthorityState(); mutate(initial);
  const db = createMockDatabase(initial);
  const result = await stop(db, stopIntent(), { reconcileProjection: async () => {
    assert.fail('no server-owned intent/source proves this requested tour');
  } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.withdrawalAcknowledged, true);
  assert.equal(result.payload.reason, 'ALREADY_RETIRED');
  assert.equal(result.payload.fencePersisted, false);
  assert.equal(db.state.driver_tracking_sessions?.[sourceKey], undefined);
  assert.equal(db.state.driver_location_sessions?.[sourceKey], undefined);
});

for (const [name, mutate] of [
  ['missing policy', value => { delete value.driver_login_policy; }],
  ['malformed policy', value => { value.driver_login_policy.v1.schemaVersion = 2; }],
  ['policy generation mismatch', value => { value.driver_login_policy.v1.generation = 1; }],
  ['implicit session policy generation', value => { delete value.app_sessions['uid-a'].driverLoginPolicyGeneration; }],
  ['policy transition', value => { value.driver_login_policy.v1.transitionPhase = 'draining';
    value.driver_login_policy.v1.transitionId = 'changing'; value.driver_login_policy.v1.targetEnforceSingleDevice = true; }],
  ['single-device claim loss', value => { value.driver_login_policy.v1.enforceSingleDevice = true; value.drivers['D-A'].authUid = 'uid-b'; }],
  ['missing driver profile', value => { delete value.drivers['D-A']; }],
  ['profile identity mismatch', value => { value.users['uid-a'].driverId = 'D-B'; }],
  ['role loss', value => { value.app_sessions['uid-a'].principalType = 'passenger'; }],
  ['changed assignment', value => { delete value.tour_manifests.tour_a.assigned_drivers['D-A']; }],
  ['active assignment transition', value => { value.driver_assignment_active = { v1: { 'D-A': { transitionId: 'changing' } } }; }],
  ['false assignment transition marker', value => { value.driver_assignment_active = { v1: { 'D-A': { transitionId: false } } }; }],
]) test(`missing-fence stop does not create any authority with ${name}`, async () => {
  const initial = stopAuthorityState(); mutate(initial);
  const db = createMockDatabase(initial);
  const result = await stop(db);
  assert.notEqual(result.status, 200);
  assert.equal(result.payload.withdrawalAcknowledged, undefined);
  assert.equal(db.state.driver_tracking_sessions?.[sourceKey], undefined);
  assert.equal(db.state.driver_location_sessions?.[sourceKey], undefined);
});

test('foreign requester, conflicting source and altered immutable intent fail without deletion', async () => {
  const db = createMockDatabase(state(stopIntent({ status: 'active' }), source()));
  assert.equal((await stop(db, stopIntent(), { authUid: 'uid-b' })).status, 403);
  for (const changes of [{ startedAtMs: 1001 }, { expiresAtMs: 200001 }, { tourId: 'tour_b' }, { driverId: 'D-B' }]) {
    assert.equal((await stop(db, stopIntent(changes))).status, 409);
  }
  assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'active');
  assert.ok(db.state.driver_location_sessions[sourceKey]);
  const foreign = createMockDatabase(state(null, source({ authUid: 'uid-b' })));
  assert.equal((await stop(foreign)).status, 403);
  assert.equal(foreign.state.driver_location_sessions[sourceKey].authUid, 'uid-b');
  const changed = createMockDatabase(state(null, source({ driverId: 'D-B' })));
  assert.equal((await stop(changed)).status, 409);
  assert.equal(changed.state.driver_location_sessions[sourceKey].driverId, 'D-B');
});

test('active missing state requires exact session identity and expiry; unbounded retirement expiry fails', async () => {
  for (const changes of [{ expiresAtMs: 199999 }, { driverId: 'D-B' }, { tourId: 'tour_b' },
    { expiresAtMs: Number.MAX_SAFE_INTEGER }]) {
    const db = createMockDatabase(stopAuthorityState());
    assert.notEqual((await stop(db, stopIntent(changes))).status, 200);
    assert.equal(db.state.driver_tracking_sessions?.[sourceKey], undefined);
  }
});

test('stop-only recovery accepts a future device-clock start under exact full current authority', async () => {
  const db = createMockDatabase(stopAuthorityState());
  const stopped = stopIntent({ startedAtMs: STOP_NOW + 60001 });
  const result = await stop(db, stopped);
  assert.equal(result.status, 200);
  assert.equal(result.payload.withdrawalAcknowledged, true);
  assert.deepEqual(db.state.driver_tracking_sessions[sourceKey], stopped);
  assert.equal(db.state.driver_location_sessions?.[sourceKey], undefined);
});

test('concurrent intent/source ownership replacement cannot be stopped or deleted', async () => {
  let replaced = false;
  const db = createMockDatabase(state(stopIntent({ status: 'active' }), source()), {
    beforeTransaction: ({ path, write }) => {
      if (!replaced && path === `driver_tracking_sessions/${sourceKey}`) {
        replaced = true;
        write(path, stopIntent({ status: 'active', authUid: 'uid-b' }));
      }
    },
  });
  assert.equal((await stop(db)).status, 403);
  assert.equal(db.state.driver_tracking_sessions[sourceKey].authUid, 'uid-b');
  assert.ok(db.state.driver_location_sessions[sourceKey]);
  replaced = false;
  const changed = createMockDatabase(state(stopIntent({ status: 'active' }), source()), {
    beforeTransaction: ({ path, write }) => {
      if (!replaced && path === `driver_location_sessions/${sourceKey}`) {
        replaced = true; write(path, source({ tourId: 'tour_b' }));
      }
    },
  });
  assert.equal((await stop(changed)).payload.reason, 'TRACKING_CHANGED');
  assert.equal(changed.state.driver_location_sessions[sourceKey].tourId, 'tour_b');
});

test('projection failure retains a stopped fence but never emits withdrawal acknowledgment; retry finishes', async () => {
  const db = createMockDatabase(state(stopIntent({ status: 'active' }), source()));
  const failed = await stop(db, stopIntent(), { reconcileProjection: async () => { throw new Error('busy'); } });
  assert.equal(failed.status, 500);
  assert.equal(failed.payload.withdrawalAcknowledged, undefined);
  assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'stopped');
  assert.equal(db.state.driver_location_sessions[sourceKey], undefined);
  assert.equal((await stop(db)).payload.withdrawalAcknowledged, true);
});

test('session and assignment lock contention leaves no stop mutations', async () => {
  const initial = stopAuthorityState();
  initial.app_session_locks = { 'uid-a': { owner: 'other', expiresAtMs: STOP_NOW + 10000 } };
  const sessionBusy = createMockDatabase(initial);
  assert.equal((await stop(sessionBusy)).payload.reason, 'SESSION_IN_PROGRESS');
  const assignment = stopAuthorityState();
  assignment.driver_assignment_locks = { drivers: { 'D-A': { owner: 'other', expiresAtMs: STOP_NOW + 10000 } } };
  const assignmentBusy = createMockDatabase(assignment);
  assert.equal((await stop(assignmentBusy)).payload.reason, 'ASSIGNMENT_IN_PROGRESS');
  assert.equal(assignmentBusy.state.driver_tracking_sessions?.[sourceKey], undefined);
});

const responseRecorder = () => ({ statusCode: null, payload: null,
  status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } });

test('HTTP stop requires POST and authenticated authorization before any database operation', async () => {
  let calls = 0;
  const handler = createDriverTrackingStopHandler({ authorizeRequest: async ({ res }) => {
    calls += 1; res.status(401).json({ success: false, reason: 'NOT_AUTHENTICATED' }); return null;
  }, getDatabase: () => { assert.fail('unauthorized request accessed the database'); } });
  const get = responseRecorder();
  await handler({ method: 'GET' }, get);
  assert.equal(get.statusCode, 405); assert.equal(calls, 0);
  const post = responseRecorder();
  await handler({ method: 'POST', body: stopIntent() }, post);
  assert.equal(post.statusCode, 401); assert.equal(calls, 1);
});

test('HTTP stop denies active/extra-field payloads and never returns success on a failed domain operation', async () => {
  let calls = 0;
  const handler = createDriverTrackingStopHandler({ authorizeRequest: async () => ({ uid: 'uid-a' }), getDatabase: () => ({}),
    stop: async () => { calls += 1; throw new Error('unavailable'); } });
  for (const body of [stopIntent({ status: 'active' }), stopIntent({ injectedPermission: true })]) {
    const res = responseRecorder(); await handler({ method: 'POST', body }, res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
  const res = responseRecorder(); await handler({ method: 'POST', body: stopIntent() }, res);
  assert.equal(calls, 1); assert.equal(res.statusCode, 500); assert.equal(res.payload.withdrawalAcknowledged, undefined);
});


test('captured driver session cleanup retires its exact intent before source removal after role/session loss', async () => {
  const initial = stopAuthorityState();
  const captured = structuredClone(initial.app_sessions['uid-a']);
  const otherSid = `sess_v1_${'b'.repeat(32)}`;
  const otherLive = 'track_other';
  const otherKey = `${otherSid}|${otherLive}`;
  initial.app_sessions['uid-a'].principalType = 'passenger';
  initial.app_sessions['uid-a'].sessionId = `sess_v1_${'c'.repeat(32)}`;
  initial.users['uid-a'].principalType = 'passenger';
  initial.users['uid-a'].driverId = null;
  initial.app_sessions['uid-b'] = buildDriverSessionRecord({ authUid: 'uid-b', sessionId: otherSid,
    driverId: 'D-A', tourId: 'tour_a', nowMs: 1000, expiresAtMs: 200_000 });
  initial.users['uid-b'] = { principalType: 'driver', driverId: 'D-A', driverPrincipalId: 'driver:D-A', driverAssignedTourId: 'tour_a' };
  initial.driver_tracking_sessions = { [sourceKey]: stopIntent({ status: 'active' }),
    [otherKey]: stopIntent({ status: 'active', authUid: 'uid-b', appSessionId: otherSid, liveSharingSessionId: otherLive }) };
  initial.driver_location_sessions = { [sourceKey]: source({ cleanupAtMs: STOP_NOW + 10000 }),
    [otherKey]: source({ authUid: 'uid-b', appSessionId: otherSid, liveSharingSessionId: otherLive,
      timestamp: STOP_NOW + 1, cleanupAtMs: STOP_NOW + 10000, latitude: 56.2 }) };
  const db = createMockDatabase(initial, { beforeTransaction: ({ path, state: current }) => {
    if (path === `driver_location_sessions/${sourceKey}`) assert.equal(current.driver_tracking_sessions[sourceKey].status, 'stopped');
  } });
  const result = await cleanupLiveStateForSession({ db, session: captured, nowMs: STOP_NOW });
  assert.equal(result.tracking.retired, 1);
  assert.equal(result.location.removed, 1);
  assert.deepEqual(db.state.driver_tracking_sessions[sourceKey], stopIntent());
  assert.equal(db.state.driver_location_sessions[sourceKey], undefined);
  assert.equal(db.state.driver_tracking_sessions[otherKey].status, 'active');
  assert.ok(db.state.driver_location_sessions[otherKey]);
  assert.equal(db.state.tours.tour_a.driverLocation.latitude, 56.2);
});

test('retirement query compares exact captured UID, session, driver and tour and preserves a changed publication', async () => {
  for (const changes of [{ authUid: 'uid-b' }, { driverId: 'D-B' }, { tourId: 'tour_b' }]) {
    const db = createMockDatabase(state(stopIntent({ status: 'active', ...changes })));
    const session = stopAuthorityState().app_sessions['uid-a'];
    assert.equal((await retireDriverTrackingIntentsForAppSession({ database: db, session })).retired, 0);
    assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'active');
  }
  let replaced = false;
  const db = createMockDatabase(state(stopIntent({ status: 'active' })), { beforeTransaction: ({ path, write }) => {
    if (!replaced && path === `driver_tracking_sessions/${sourceKey}`) {
      replaced = true; write(path, stopIntent({ status: 'active', startedAtMs: 2000 }));
    }
  } });
  const session = stopAuthorityState().app_sessions['uid-a'];
  assert.equal((await retireDriverTrackingIntentsForAppSession({ database: db, session })).retired, 0);
  assert.equal(db.state.driver_tracking_sessions[sourceKey].startedAtMs, 2000);
  assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'active');
});

test('failed captured intent retirement aborts source cleanup so the exact fence can be retried', async () => {
  const initial = { ...stopAuthorityState(), ...state(stopIntent({ status: 'active' }), source()) };
  const db = createMockDatabase(initial, { beforeTransaction: ({ path }) => {
    if (path === `driver_tracking_sessions/${sourceKey}`) throw new Error('retirement unavailable');
  } });
  await assert.rejects(cleanupLiveStateForSession({ db, session: initial.app_sessions['uid-a'], nowMs: STOP_NOW }), /retirement unavailable/);
  assert.ok(db.state.driver_location_sessions[sourceKey]);
  assert.equal(db.state.driver_tracking_sessions[sourceKey].status, 'active');
});


test('cold RTDB transaction caches still retire exact server source and expired intent', async () => {
  const paths = [`driver_tracking_sessions/${sourceKey}`, `driver_location_sessions/${sourceKey}`];
  const database = createMockDatabase(state(intent({ status: 'stopped', expiresAtMs: 1000 })), { coldTransactionPaths: paths });
  const result = await cleanupExpiredDriverLocations({ database, nowMs: 1000, reconcileProjection: async () => {} });
  assert.equal(result.trackingSourcesRemoved, 1);
  assert.equal(result.trackingIntentsRemoved, 1);
  assert.equal(database.state.driver_location_sessions[sourceKey], undefined);
  assert.equal(database.state.driver_tracking_sessions[sourceKey], undefined);
});
