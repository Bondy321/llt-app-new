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

function liveLocation({ sessionId = 'session-a', timestamp = 100, cleanupAtMs = 200 } = {}) {
  return {
    schemaVersion: 1,
    mode: 'live',
    sessionId,
    timestamp,
    cleanupAtMs,
    latitude: 56.1,
    longitude: -4.6,
  };
}

test('removes expired disconnect-safe live driver locations and is idempotent', async () => {
  const nowMs = 1_000;
  const database = createMockDatabase({
    tours: {
      expired: { driverLocation: liveLocation({ cleanupAtMs: nowMs }) },
      future: { driverLocation: liveLocation({ cleanupAtMs: nowMs + 1 }) },
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs });
  assert.deepEqual(result, { ok: true, scanned: 1, removed: 1, restoredPickups: 0, hasMore: false, cleanedAtMs: nowMs });
  assert.equal(database.state.tours.expired.driverLocation, undefined);
  assert.ok(database.state.tours.future.driverLocation);

  const retry = await cleanupExpiredDriverLocations({ database, nowMs });
  assert.equal(retry.removed, 0);
});

test('preserves a live location refreshed after the candidate query', async () => {
  const nowMs = 1_000;
  let refreshed = false;
  const database = createMockDatabase({
    tours: { tour_1: { driverLocation: liveLocation({ sessionId: 'old', timestamp: 10, cleanupAtMs: nowMs }) } },
  }, {
    beforeTransaction: ({ path, write }) => {
      if (!refreshed && path === 'tours/tour_1/driverLocation') {
        refreshed = true;
        write(path, liveLocation({ sessionId: 'new', timestamp: 999, cleanupAtMs: nowMs + 60_000 }));
      }
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs });
  assert.equal(result.removed, 0);
  assert.deepEqual(database.state.tours.tour_1.driverLocation, liveLocation({ sessionId: 'new', timestamp: 999, cleanupAtMs: nowMs + 60_000 }));
});

test('preserves manual, malformed, and records without a cleanup lease', async () => {
  const nowMs = 1_000;
  const database = createMockDatabase({
    tours: {
      manual: { driverLocation: { ...liveLocation({ cleanupAtMs: nowMs }), mode: 'pickup' } },
      malformed: { driverLocation: { schemaVersion: 1, mode: 'live', cleanupAtMs: nowMs } },
      legacy: { driverLocation: { latitude: 56.1, longitude: -4.6, timestamp: 100 } },
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs });
  assert.equal(result.removed, 0);
  assert.ok(database.state.tours.manual.driverLocation);
  assert.ok(database.state.tours.malformed.driverLocation);
  assert.ok(database.state.tours.legacy.driverLocation);
});

test('expired live coordinates restore the validated fixed pickup fallback', async () => {
  const nowMs = 1_000;
  const fallbackPickup = {
    schemaVersion: 1,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: 56.2,
    longitude: -4.7,
    timestamp: 50,
    address: '  Pier Road  ',
  };
  const database = createMockDatabase({
    tours: {
      tour_1: {
        driverLocation: { ...liveLocation({ cleanupAtMs: nowMs }), fallbackPickup },
      },
    },
  });

  const result = await cleanupExpiredDriverLocations({ database, nowMs });
  assert.equal(result.removed, 1);
  assert.equal(result.restoredPickups, 1);
  assert.deepEqual(database.state.tours.tour_1.driverLocation, { ...fallbackPickup, address: 'Pier Road' });
});

test('enforces bounded batches and validates cleanup inputs', async () => {
  const nowMs = 1_000;
  const tours = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
    `tour_${String(index).padStart(3, '0')}`,
    { driverLocation: liveLocation({ sessionId: `session-${index}`, timestamp: index, cleanupAtMs: nowMs }) },
  ]));
  const database = createMockDatabase({ tours });

  const firstBatch = await cleanupExpiredDriverLocations({ database, nowMs, limit: 100 });
  assert.deepEqual(firstBatch, { ok: true, scanned: 100, removed: 100, restoredPickups: 0, hasMore: true, cleanedAtMs: nowMs });
  assert.ok(database.state.tours.tour_100.driverLocation);
  await assert.rejects(() => cleanupExpiredDriverLocations({ database, nowMs, limit: 101 }), /limit must be 1-100/);
  await assert.rejects(() => cleanupExpiredDriverLocations({ database, nowMs: -1 }), /non-negative safe integer/);
  await assert.rejects(() => cleanupExpiredDriverLocations({ nowMs }), /Realtime Database instance/);
});
