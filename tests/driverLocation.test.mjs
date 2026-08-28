import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriverLocationPayload,
  buildDriverLocationSourcePayload,
  getDriverLocationPresentation,
  getDriverLocationSnapshotKey,
  getDriverLocationStatusMeta,
} from '../utils/driverLocation.js';
import {
  createDriverLocationSessionId,
  publishDriverLocation,
  withdrawLiveDriverLocation,
  withdrawDriverLocation,
} from '../services/driverLocationService.js';

const TEST_APP_SESSION_ID = 'sess_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_SESSION_SCOPE = Object.freeze({
  authUid: 'uid_driver_a',
  sessionId: TEST_APP_SESSION_ID,
  principalId: 'D-ONE',
  role: 'driver',
  tourId: 'TOUR_1',
});

test('manual driver locations remain actionable pickup points without claiming to be live', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const result = getDriverLocationPresentation({
    latitude: 56.0,
    longitude: -4.5,
    timestamp: now - (24 * 60 * 60 * 1000),
    source: 'manual',
    isSharing: true,
  }, now);

  assert.equal(result.available, true);
  assert.equal(result.actionable, true);
  assert.equal(result.mode, 'pickup');
  assert.equal(result.freshness, 'pickup');
});

test('live driver locations become non-actionable, then disappear when expired', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const record = {
    latitude: 56.0,
    longitude: -4.5,
    source: 'auto',
    isSharing: true,
  };

  assert.equal(getDriverLocationPresentation({ ...record, timestamp: now - 60_000 }, now).freshness, 'live');
  assert.equal(getDriverLocationPresentation({ ...record, timestamp: now - (3 * 60_000) }, now).freshness, 'live');
  const stale = getDriverLocationPresentation({ ...record, timestamp: now - (15 * 60_000) }, now);
  assert.equal(stale.available, true);
  assert.equal(stale.actionable, false);
  assert.equal(stale.freshness, 'stale');

  const expired = getDriverLocationPresentation({ ...record, timestamp: now - (31 * 60_000) }, now);
  assert.equal(expired.available, false);
  assert.equal(expired.coordinates, null);
});

test('low-accuracy points remain visible but cannot launch directions', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const presentation = getDriverLocationPresentation({
    latitude: 56,
    longitude: -4,
    timestamp: now,
    source: 'auto',
    accuracy: 501,
  }, now);
  assert.equal(presentation.available, true);
  assert.equal(presentation.actionable, false);
  assert.equal(presentation.freshness, 'low_accuracy');
  assert.equal(getDriverLocationStatusMeta(presentation).needsRefresh, true);
});

test('snapshot keys are stable for duplicates and change for real publications', () => {
  const base = { latitude: 56, longitude: -4, timestamp: 1234, source: 'auto', sessionId: 'session_a' };
  assert.equal(getDriverLocationSnapshotKey(base), getDriverLocationSnapshotKey({ ...base }));
  assert.notEqual(getDriverLocationSnapshotKey(base), getDriverLocationSnapshotKey({ ...base, timestamp: 1235 }));
  assert.equal(getDriverLocationSnapshotKey({ latitude: 'bad', longitude: -4, timestamp: 1234 }), '');
});

test('withdrawn, malformed, and far-future driver locations are unavailable', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const base = { latitude: 56, longitude: -4, timestamp: now };
  assert.equal(getDriverLocationPresentation({ ...base, isSharing: false }, now).available, false);
  assert.equal(getDriverLocationPresentation({ ...base, latitude: 999 }, now).available, false);
  assert.equal(getDriverLocationPresentation({ ...base, timestamp: now + (6 * 60_000) }, now).freshness, 'invalid');
});

test('location payload uses a server timestamp and bounded schema', () => {
  const payload = buildDriverLocationPayload({
    latitude: 56.01,
    longitude: -4.02,
    accuracy: 12,
    address: '  Main Street  ',
    updatedBy: ' Driver ',
    source: 'auto',
    sessionId: 'session_1234',
    nowMs: 10_000,
  });

  assert.deepEqual(payload.timestamp, { '.sv': 'timestamp' });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.mode, 'live');
  assert.equal(payload.isSharing, true);
  assert.equal(payload.address, 'Main Street');
  assert.equal(payload.updatedBy, 'Driver');
  assert.equal(payload.sessionId, 'session_1234');
  assert.equal(payload.cleanupAtMs, 10_000 + (30 * 60 * 1000));
  assert.throws(() => buildDriverLocationPayload({
    latitude: 56,
    longitude: -4,
    source: 'auto',
    sessionId: 'bad',
  }), /session ID/);
  assert.throws(() => buildDriverLocationPayload({
    latitude: 56,
    longitude: -4,
    source: 'auto',
    sessionId: 'session_1234',
  }), /accuracy/);
});

test('private live-source identity bounds match the backend and rules contract', () => {
  const build = (overrides = {}) => buildDriverLocationSourcePayload({
    latitude: 56,
    longitude: -4,
    accuracy: 8,
    source: 'auto',
    liveSharingSessionId: 'live_session_1',
    authUid: 'a'.repeat(128),
    appSessionId: TEST_APP_SESSION_ID,
    driverId: 'D'.repeat(100),
    tourId: 'T'.repeat(100),
    nowMs: 1_000,
    ...overrides,
  });
  const boundary = build();
  assert.equal(boundary.authUid.length, 128);
  assert.equal(boundary.driverId.length, 100);
  assert.equal(boundary.tourId.length, 100);
  assert.throws(() => build({ authUid: 'a'.repeat(129) }), /authenticated user ID/i);
  assert.throws(() => build({ driverId: 'D'.repeat(101) }), /driver ID/i);
  assert.throws(() => build({ tourId: 'T'.repeat(101) }), /tour ID/i);
});

test('live session IDs are opaque, bounded, and collision-ready', () => {
  const id = createDriverLocationSessionId(() => 1234, () => 0.123456789);
  assert.match(id, /^loc_[a-z0-9]+_[a-z0-9]{8,10}$/);
});

test('publish and withdraw use separate durable pickup and exact live-session paths', async () => {
  const calls = [];
  const pickupMutations = [];
  const pickupMutation = async (request) => {
    pickupMutations.push(request);
    return request.operation === 'publish'
      ? { success: true, pickup: { ...request.location, timestamp: 1234 } }
      : { success: true, removed: true };
  };
  const dbInstance = {
    ref(path) {
      calls.push({ path, set: [], remove: 0 });
      const call = calls.at(-1);
      return {
        async set(value) { call.set.push(value); },
        async remove() { call.remove += 1; },
        onDisconnect() {
          return {
            async remove() { call.disconnectRemove = (call.disconnectRemove || 0) + 1; },
            async cancel() { call.disconnectCancel = (call.disconnectCancel || 0) + 1; },
          };
        },
        async transaction(updater) {
          const next = updater({ source: 'auto', mode: 'live' });
          call.transactionValue = next;
          return { committed: next === null };
        },
      };
    },
  };

  const published = await publishDriverLocation({
    tourId: '5112D 8',
    location: { latitude: 56, longitude: -4, accuracy: 5 },
    updatedBy: 'Driver',
    sessionScope: { ...TEST_SESSION_SCOPE, tourId: '5112D_8' },
    dbInstance,
    now: () => 1234,
    pickupMutation,
  });
  await withdrawDriverLocation({
    tourId: '5112D 8',
    sessionScope: { ...TEST_SESSION_SCOPE, tourId: '5112D_8' },
    pickupMutation,
  });
  const liveWithdrawal = await withdrawLiveDriverLocation({
    tourId: '5112D 8',
    appSessionId: TEST_APP_SESSION_ID,
    expectedSessionId: 'session_live_1',
    dbInstance,
  });

  assert.equal(published.timestamp, 1234);
  assert.deepEqual(pickupMutations.map(({ operation, tourId }) => ({ operation, tourId })), [
    { operation: 'publish', tourId: '5112D_8' },
    { operation: 'withdraw', tourId: '5112D_8' },
  ]);
  assert.deepEqual(calls.map((call) => call.path), [
    `driver_location_sessions/${TEST_APP_SESSION_ID}|session_live_1`,
  ]);
  assert.equal(liveWithdrawal.removed, false);
  assert.equal(calls[0].transactionValue, undefined);
});

test('stopping live sharing does not mutate a missing exact live leaf', async () => {
  let transactionResult = 'not-run';
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          transactionResult = updater(null);
          return { committed: false };
        },
      };
    },
  };

  const result = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    appSessionId: TEST_APP_SESSION_ID,
    expectedSessionId: 'session_live_1',
    dbInstance,
  });
  assert.equal(result.removed, false);
  assert.equal(transactionResult, undefined);
});

test('a location captured for a revoked tour scope cannot reach Firebase', async () => {
  let resolveCapture;
  let scopeCurrent = true;
  const writes = [];
  const capture = new Promise((resolve) => { resolveCapture = resolve; });
  const dbInstance = {
    ref(path) {
      return { async set(value) { writes.push({ path, value }); } };
    },
  };

  const autoShareRun = (async () => {
    const location = await capture;
    return publishDriverLocation({
      tourId: 'FORMER_TOUR',
      location,
      source: 'auto',
      sessionId: 'session_former',
      sessionScope: { ...TEST_SESSION_SCOPE, tourId: 'FORMER_TOUR' },
      dbInstance,
      isScopeCurrent: () => scopeCurrent,
    });
  })();

  scopeCurrent = false;
  resolveCapture({ latitude: 56, longitude: -4, accuracy: 8 });
  const result = await autoShareRun;

  assert.deepEqual(result, {
    success: false,
    skipped: true,
    reason: 'DRIVER_LOCATION_SCOPE_REVOKED',
  });
  assert.deepEqual(writes, []);
});

test('auto publication arms disconnect removal and reports the authoritative server timestamp', async () => {
  const events = [];
  const stored = { timestamp: 9876, source: 'auto', mode: 'live', sessionId: 'session_live' };
  const dbInstance = {
    ref() {
      return {
        async set() { events.push('set'); },
        onDisconnect() { return { async remove() { events.push('disconnect-remove'); } }; },
        async once() { return { val: () => stored }; },
      };
    },
  };
  const result = await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56, longitude: -4, accuracy: 8 },
    source: 'auto',
    sessionId: 'session_live',
    sessionScope: TEST_SESSION_SCOPE,
    dbInstance,
    now: () => 1234,
  });
  assert.deepEqual(events, ['disconnect-remove', 'set']);
  assert.equal(result.timestamp, 9876);
  assert.equal(result.storedLocation, stored);
});

test('post-write scope revocation removes only the publication session', async () => {
  let scopeChecks = 0;
  let transactionInput;
  let current = null;
  const dbInstance = {
    ref() {
      return {
        onDisconnect() { return { async remove() {}, async cancel() {} }; },
        async set(value) { current = value; },
        async transaction(updater) {
          transactionInput = updater(current);
          if (transactionInput === undefined) return { committed: false };
          current = transactionInput;
          return { committed: true, snapshot: { val: () => current } };
        },
      };
    },
  };
  const result = await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56, longitude: -4, accuracy: 8 },
    source: 'auto',
    sessionId: 'session_live',
    sessionScope: TEST_SESSION_SCOPE,
    dbInstance,
    isScopeCurrent: () => {
      scopeChecks += 1;
      return scopeChecks === 1;
    },
  });
  assert.equal(result.reason, 'DRIVER_LOCATION_SCOPE_REVOKED_AFTER_WRITE');
  assert.equal(transactionInput, null);
});

test('live sharing and fixed pickup remain separate across withdrawal', async () => {
  const pickup = {
    schemaVersion: 1,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: 56.2,
    longitude: -4.7,
    timestamp: 500,
    address: 'Pier Road',
  };
  const values = new Map();
  const pickupMutations = [];
  const pickupMutation = async (request) => {
    pickupMutations.push(request);
    if (request.operation === 'publish') values.set('trusted-pickup', pickup);
    return { success: true, pickup };
  };
  const dbInstance = {
    ref(path) {
      return {
        async set(value) { values.set(path, value); },
        async transaction(updater) {
          const current = values.get(path) || null;
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: { val: () => current } };
          if (next === null) values.delete(path); else values.set(path, next);
          return { committed: true, snapshot: { val: () => next } };
        },
        onDisconnect() {
          return {
            async remove() {},
            async cancel() {},
          };
        },
        async once() { return { val: () => values.get(path) || null }; },
      };
    },
  };

  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: pickup,
    source: 'manual',
    sessionScope: TEST_SESSION_SCOPE,
    dbInstance,
    now: () => 500,
    pickupMutation,
  });

  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.3, longitude: -4.8, accuracy: 8 },
    source: 'auto',
    sessionId: 'session_live',
    sessionScope: TEST_SESSION_SCOPE,
    dbInstance,
    now: () => 1000,
  });
  assert.ok(values.has('trusted-pickup'));
  assert.ok(values.has(`driver_location_sessions/${TEST_APP_SESSION_ID}|session_live`));

  const result = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    appSessionId: TEST_APP_SESSION_ID,
    dbInstance,
    expectedSessionId: 'session_live',
  });
  assert.equal(result.removed, true);
  assert.ok(values.has('trusted-pickup'));
  assert.equal(pickupMutations.length, 1);
  assert.equal(values.has(`driver_location_sessions/${TEST_APP_SESSION_ID}|session_live`), false);
});

test('session-scoped withdrawal cannot delete a newer live session', async () => {
  let next;
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          next = updater({
            schemaVersion: 2,
            source: 'auto',
            mode: 'live',
            appSessionId: TEST_APP_SESSION_ID,
            liveSharingSessionId: 'new_session',
            tourId: 'TOUR_1',
          });
          return { committed: false };
        },
      };
    },
  };
  const result = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    appSessionId: TEST_APP_SESSION_ID,
    dbInstance,
    expectedSessionId: 'old_session',
  });
  assert.equal(next, undefined);
  assert.equal(result.removed, false);
});
