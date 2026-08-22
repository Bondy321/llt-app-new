const test = require('node:test');
const assert = require('node:assert/strict');

const { createLazyRealtimeDbResolver } = require('../services/lazyRealtimeDb');

test('lazy realtime database resolution retries after a transient module-load failure', () => {
  const expectedDb = { ref: () => null };
  const errors = [];
  let loadAttempts = 0;
  const resolveRealtimeDb = createLazyRealtimeDbResolver({
    loadFirebaseModule: () => {
      loadAttempts += 1;
      if (loadAttempts === 1) {
        throw new Error('module is still loading');
      }
      return { realtimeDb: expectedDb };
    },
    onLoadError: (error) => errors.push(error.message),
  });

  assert.equal(loadAttempts, 0, 'constructing the resolver must not eagerly load Firebase');
  assert.equal(resolveRealtimeDb(), null);
  assert.deepEqual(errors, ['module is still loading']);
  assert.equal(resolveRealtimeDb(), expectedDb);
  assert.equal(resolveRealtimeDb(), expectedDb);
  assert.equal(loadAttempts, 2, 'a successful database resolution must be cached');
});

test('lazy realtime database resolution does not cache a missing database export', () => {
  const expectedDb = { ref: () => null };
  let loadAttempts = 0;
  const resolveRealtimeDb = createLazyRealtimeDbResolver({
    loadFirebaseModule: () => {
      loadAttempts += 1;
      return loadAttempts === 1 ? {} : { realtimeDb: expectedDb };
    },
  });

  assert.equal(resolveRealtimeDb(), null);
  assert.equal(resolveRealtimeDb(), expectedDb);
  assert.equal(loadAttempts, 2);
});

test('lazy realtime database resolution requires an explicit module loader', () => {
  assert.throws(
    () => createLazyRealtimeDbResolver(),
    /loadFirebaseModule must be a function/
  );
});
