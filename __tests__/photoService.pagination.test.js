const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchTourPhotosPage,
  fetchPrivatePhotosPage,
  subscribeToTourPhotos,
} = require('../services/photoService');

const makeSnapshot = (value) => ({ val: () => value });

test('fetchTourPhotosPage enforces bounded page contract and deterministic cursor output', async () => {
  const calls = { limitArg: null, endAtArgs: null };
  const result = await fetchTourPhotosPage(
    { tourId: 'T-1', limit: 2 },
    {
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      orderByChildFn: (field) => ({ type: 'order', field }),
      endAtFn: (...args) => {
        calls.endAtArgs = args;
        return { type: 'endAt', args };
      },
      limitToLastFn: (limit) => {
        calls.limitArg = limit;
        return { type: 'limit', limit };
      },
      queryFn: (ref, ...constraints) => ({ ref, constraints }),
      getFn: async () => makeSnapshot({
        a: { timestamp: '100' },
        b: { timestamp: 200 },
        c: { timestamp: null },
      }),
    }
  );

  assert.equal(calls.limitArg, 3);
  assert.equal(calls.endAtArgs, null);
  assert.deepEqual(result.items.map((item) => item.id), ['b', 'a']);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.nextCursor, { timestamp: 100, id: 'a' });
});

test('fetchTourPhotosPage ignores invalid cursor values and excludes explicit cursor item', async () => {
  let appliedEndAt = null;

  const invalidCursorResult = await fetchTourPhotosPage(
    { tourId: 'T-2', limit: 3, endBefore: { timestamp: 'not-a-number', id: 'x' } },
    {
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      orderByChildFn: () => ({}),
      endAtFn: (...args) => {
        appliedEndAt = args;
        return args;
      },
      limitToLastFn: (limit) => limit,
      queryFn: (_ref, ...constraints) => constraints,
      getFn: async () => makeSnapshot({ one: { timestamp: 1 } }),
    }
  );

  assert.equal(appliedEndAt, null);
  assert.equal(invalidCursorResult.items.length, 1);

  const explicitCursorResult = await fetchTourPhotosPage(
    { tourId: 'T-3', limit: 3, endBefore: { timestamp: 120, id: 'photo-b' } },
    {
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      orderByChildFn: () => ({}),
      endAtFn: (...args) => {
        appliedEndAt = args;
        return args;
      },
      limitToLastFn: (limit) => limit,
      queryFn: (_ref, ...constraints) => constraints,
      getFn: async () => makeSnapshot({
        'photo-a': { timestamp: 130 },
        'photo-b': { timestamp: 120 },
        'photo-c': { timestamp: 110 },
      }),
    }
  );

  assert.deepEqual(appliedEndAt, [120, 'photo-b']);
  assert.deepEqual(explicitCursorResult.items.map((item) => item.id), ['photo-a', 'photo-c']);
});

test('fetchPrivatePhotosPage normalizes timestamps and returns empty contract for no rows', async () => {
  const empty = await fetchPrivatePhotosPage(
    { tourId: 'T-9', userId: 'U-9', limit: -3 },
    {
      realtimeDbInstance: {},
      dbRefFn: (_db, path) => ({ path }),
      orderByChildFn: () => ({}),
      limitToLastFn: (limit) => limit,
      endAtFn: () => ({}),
      queryFn: (_ref, ...constraints) => constraints,
      getFn: async () => makeSnapshot(null),
    }
  );

  assert.deepEqual(empty, { items: [], nextCursor: null, hasMore: false });
});

test('subscribeToTourPhotos remains backward compatible and bounded via limitToLast window', async () => {
  let seenLimit = null;
  let callbackRows = null;

  const unsubscribe = subscribeToTourPhotos('tour-live', (rows) => {
    callbackRows = rows;
  }, {
    realtimeDbInstance: {},
    dbRefFn: (_db, path) => ({ path }),
    orderByChildFn: () => 'timestamp',
    limitToLastFn: (limit) => {
      seenLimit = limit;
      return limit;
    },
    queryFn: (_ref, ...constraints) => constraints,
    onValueFn: (_query, onData) => {
      onData(makeSnapshot({
        old: { timestamp: 10 },
        newest: { timestamp: 50 },
      }));
      return () => {};
    },
  });

  assert.equal(seenLimit, 100);
  assert.deepEqual(callbackRows.map((row) => row.id), ['newest', 'old']);
  assert.equal(typeof unsubscribe, 'function');
});
