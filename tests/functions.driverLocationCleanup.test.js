const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanupExpiredDriverLocations,
} = require('../functions/lib/driverLocationExpiryCleanup');

function createMockDatabase(initialState, { beforeTransaction } = {}) {
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
      let query = { orderBy: null, startAt: -Infinity, endAt: Infinity, limit: Infinity };
      const ref = {
        orderByChild(key) { query.orderBy = key; return ref; },
        startAt(value) { query.startAt = value; return ref; },
        endAt(value) { query.endAt = value; return ref; },
        limitToFirst(value) { query.limit = value; return ref; },
        async get() {
          const value = read(path);
          if (!query.orderBy || !value || typeof value !== 'object') return snapshot(value);
          const selected = Object.entries(value)
            .filter(([, item]) => {
              const orderedValue = nestedValue(item, query.orderBy);
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

function liveLocation({ appSessionId = 'session-a', liveSharingSessionId = 'live-session-a', tourId = 'tour_1', timestamp = 100, cleanupAtMs = 200 } = {}) {
  return {
    schemaVersion: 2,
    source: 'auto',
    mode: 'live',
    appSessionId,
    liveSharingSessionId,
    tourId,
    timestamp,
    cleanupAtMs,
    latitude: 56.1,
    longitude: -4.6,
  };
}

test('removes expired disconnect-safe live driver locations and is idempotent', async () => {
  const nowMs = 1_000;
  const database = createMockDatabase({
    driver_location_sessions: {
      expired: liveLocation({ tourId: 'expired', cleanupAtMs: nowMs }),
      future: liveLocation({ tourId: 'future', cleanupAtMs: nowMs + 1 }),
    },
  });
  const reconciled = [];

  const result = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async ({ tourId }) => reconciled.push(tourId) });
  assert.deepEqual(result, { ok: true, scanned: 1, removed: 1, pickupsScanned: 0, pickupsRemoved: 0, restoredPickups: 0, reconciledTours: ['expired'], hasMore: false, cleanedAtMs: nowMs });
  assert.equal(database.state.driver_location_sessions.expired, undefined);
  assert.ok(database.state.driver_location_sessions.future);
  assert.deepEqual(reconciled, ['expired']);

  const retry = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async () => {} });
  assert.equal(retry.removed, 0);
});

test('preserves a live location refreshed after the candidate query', async () => {
  const nowMs = 1_000;
  let refreshed = false;
  const database = createMockDatabase({
    driver_location_sessions: { old: liveLocation({ appSessionId: 'old', timestamp: 10, cleanupAtMs: nowMs }) },
  }, {
    beforeTransaction: ({ path, write }) => {
      if (!refreshed && path === 'driver_location_sessions/old') {
        refreshed = true;
        write(path, liveLocation({ appSessionId: 'new', liveSharingSessionId: 'live-session-new', timestamp: 999, cleanupAtMs: nowMs + 60_000 }));
      }
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async () => {} });
  assert.equal(result.removed, 0);
  assert.deepEqual(database.state.driver_location_sessions.old, liveLocation({ appSessionId: 'new', liveSharingSessionId: 'live-session-new', timestamp: 999, cleanupAtMs: nowMs + 60_000 }));
});

test('preserves manual, malformed, and records without a cleanup lease', async () => {
  const nowMs = 1_000;
  const database = createMockDatabase({
    driver_location_sessions: {
      manual: { ...liveLocation({ cleanupAtMs: nowMs }), mode: 'pickup', source: 'manual' },
      malformed: { schemaVersion: 2, mode: 'live', cleanupAtMs: nowMs },
      legacy: { latitude: 56.1, longitude: -4.6, timestamp: 100, cleanupAtMs: nowMs },
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async () => {} });
  assert.equal(result.removed, 0);
  assert.ok(database.state.driver_location_sessions.manual);
  assert.ok(database.state.driver_location_sessions.malformed);
  assert.ok(database.state.driver_location_sessions.legacy);
});

test('expired live coordinates leave the separate fixed pickup source untouched', async () => {
  const nowMs = 1_000;
  const fallbackPickup = {
    schemaVersion: 2,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: 56.2,
    longitude: -4.7,
    timestamp: 50,
    address: '  Pier Road  ',
  };
  const database = createMockDatabase({
    driver_location_sessions: { live: liveLocation({ cleanupAtMs: nowMs }) },
    driver_location_pickups: { tour_1: fallbackPickup },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async () => {} });
  assert.equal(result.removed, 1);
  assert.equal(result.restoredPickups, 0);
  assert.deepEqual(database.state.driver_location_pickups.tour_1, fallbackPickup);
});

test('expires assignment-owned pickups with compare-safe deletion and projection reconciliation', async () => {
  const nowMs = 10_000;
  const expired = {
    schemaVersion: 1,
    isSharing: true,
    source: 'manual',
    mode: 'pickup',
    driverId: 'D-ONE',
    tourId: 'tour_1',
    assignmentRevision: 5,
    latitude: 56.2,
    longitude: -4.7,
    timestamp: 5_000,
    publishedAtMs: 5_000,
    expiresAtMs: nowMs,
  };
  const reconciled = [];
  const database = createMockDatabase({ driver_location_pickups: { tour_1: expired } });
  const result = await cleanupExpiredDriverLocations({
    database,
    nowMs,
    reconcileProjection: async ({ tourId }) => reconciled.push(tourId),
  });
  assert.equal(result.pickupsScanned, 1);
  assert.equal(result.pickupsRemoved, 1);
  assert.equal(database.state.driver_location_pickups.tour_1, undefined);
  assert.deepEqual(reconciled, ['tour_1']);
});

test('preserves a refreshed pickup after the expiry query', async () => {
  const nowMs = 10_000;
  const expired = {
    schemaVersion: 1, isSharing: true, source: 'manual', mode: 'pickup',
    driverId: 'D-ONE', tourId: 'tour_1', assignmentRevision: 5,
    latitude: 56.2, longitude: -4.7, timestamp: 5_000,
    publishedAtMs: 5_000, expiresAtMs: nowMs,
  };
  const refreshed = { ...expired, timestamp: 9_000, publishedAtMs: 9_000, expiresAtMs: nowMs + 60_000 };
  let replaced = false;
  const database = createMockDatabase({ driver_location_pickups: { tour_1: expired } }, {
    beforeTransaction: ({ path, write }) => {
      if (!replaced && path === 'driver_location_pickups/tour_1') {
        replaced = true;
        write(path, refreshed);
      }
    },
  });
  const result = await cleanupExpiredDriverLocations({ database, nowMs, reconcileProjection: async () => {} });
  assert.equal(result.pickupsRemoved, 0);
  assert.deepEqual(database.state.driver_location_pickups.tour_1, refreshed);
});

test('enforces bounded batches and validates cleanup inputs', async () => {
  const nowMs = 1_000;
  const locations = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
    `tour_${String(index).padStart(3, '0')}`,
    liveLocation({ appSessionId: `session-${index}`, liveSharingSessionId: `live-session-${index}`, tourId: `tour_${String(index).padStart(3, '0')}`, timestamp: index, cleanupAtMs: nowMs }),
  ]));
  const database = createMockDatabase({ driver_location_sessions: locations });

  const firstBatch = await cleanupExpiredDriverLocations({ database, nowMs, limit: 100, reconcileProjection: async () => {} });
  assert.equal(firstBatch.scanned, 100);
  assert.equal(firstBatch.removed, 100);
  assert.equal(firstBatch.hasMore, true);
  assert.ok(database.state.driver_location_sessions.tour_100);
  await assert.rejects(() => cleanupExpiredDriverLocations({ database, nowMs, limit: 101 }), /limit must be 1-100/);
  await assert.rejects(() => cleanupExpiredDriverLocations({ database, nowMs: -1 }), /non-negative safe integer/);
  await assert.rejects(() => cleanupExpiredDriverLocations({ nowMs }), /Realtime Database instance/);
});
