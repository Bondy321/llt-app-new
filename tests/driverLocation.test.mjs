import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriverLocationPayload,
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
});

test('live session IDs are opaque, bounded, and collision-ready', () => {
  const id = createDriverLocationSessionId(() => 1234, () => 0.123456789);
  assert.match(id, /^loc_[a-z0-9]+_[a-z0-9]{8,10}$/);
});

test('publish and withdraw write only the canonical tour location path', async () => {
  const calls = [];
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
    dbInstance,
    now: () => 1234,
  });
  await withdrawDriverLocation({ tourId: '5112D 8', dbInstance });
  const liveWithdrawal = await withdrawLiveDriverLocation({ tourId: '5112D 8', dbInstance });

  assert.equal(published.timestamp, 1234);
  assert.deepEqual(calls.map((call) => call.path), [
    'tours/5112D_8/driverLocation',
    'tours/5112D_8/driverLocation',
    'tours/5112D_8/driverLocation',
  ]);
  assert.equal(calls[0].set.length, 1);
  assert.equal(calls[0].disconnectCancel, 1);
  assert.equal(calls[1].remove, 1);
  assert.equal(liveWithdrawal.removed, true);
  assert.equal(calls[2].transactionValue, null);
});

test('stopping live sharing preserves a fixed manual pickup point', async () => {
  let transactionResult = 'not-run';
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          transactionResult = updater({ source: 'manual', mode: 'pickup' });
          return { committed: false };
        },
      };
    },
  };

  const result = await withdrawLiveDriverLocation({ tourId: 'TOUR_1', dbInstance });
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
        async transaction(updater) {
          events.push('transaction');
          const next = updater(null);
          return { committed: true, snapshot: { val: () => ({ ...next, ...stored }) } };
        },
        onDisconnect() { return { async remove() { events.push('disconnect-remove'); } }; },
        async once() { return { val: () => stored }; },
      };
    },
  };
  const result = await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56, longitude: -4 },
    source: 'auto',
    sessionId: 'session_live',
    dbInstance,
    now: () => 1234,
  });
  assert.deepEqual(events, ['transaction', 'disconnect-remove']);
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
    location: { latitude: 56, longitude: -4 },
    source: 'auto',
    sessionId: 'session_live',
    dbInstance,
    isScopeCurrent: () => {
      scopeChecks += 1;
      return scopeChecks === 1;
    },
  });
  assert.equal(result.reason, 'DRIVER_LOCATION_SCOPE_REVOKED_AFTER_WRITE');
  assert.equal(transactionInput, null);
});

test('live sharing preserves and restores the fixed pickup point across withdrawal', async () => {
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
  let current = pickup;
  let disconnectFallback = null;
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: { val: () => current } };
          current = next;
          return { committed: true, snapshot: { val: () => current } };
        },
        onDisconnect() {
          return {
            async set(value) { disconnectFallback = value; },
            async cancel() {},
          };
        },
        async once() { return { val: () => current }; },
      };
    },
  };

  await publishDriverLocation({
    tourId: 'TOUR_1',
    location: { latitude: 56.3, longitude: -4.8 },
    source: 'auto',
    sessionId: 'session_live',
    dbInstance,
    now: () => 1000,
  });
  assert.deepEqual(current.fallbackPickup, pickup);
  assert.deepEqual(disconnectFallback, pickup);

  const result = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    dbInstance,
    expectedSessionId: 'session_live',
  });
  assert.equal(result.removed, true);
  assert.deepEqual(current, pickup);
});

test('session-scoped withdrawal cannot delete a newer live session', async () => {
  let next;
  const dbInstance = {
    ref() {
      return {
        async transaction(updater) {
          next = updater({ source: 'auto', mode: 'live', sessionId: 'new_session' });
          return { committed: false };
        },
      };
    },
  };
  const result = await withdrawLiveDriverLocation({
    tourId: 'TOUR_1',
    dbInstance,
    expectedSessionId: 'old_session',
  });
  assert.equal(next, undefined);
  assert.equal(result.removed, false);
});
