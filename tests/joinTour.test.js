const test = require('node:test');
const assert = require('node:assert');
const { joinTour } = require('../services/bookingServiceRealtime');

const createMockRealtimeDb = () => {
  const state = { tours: {} };

  const getValue = (segments) => segments.reduce((node, key) => (node || {})[key], state);

  const setValue = (segments, value) => {
    let node = state;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      node[segment] = node[segment] || {};
      node = node[segment];
    }
    node[segments[segments.length - 1]] = value;
  };

  const db = {
    transactionError: null,
    state,
    ref(path) {
      const segments = path.split('/');
      return {
        async set(value) {
          setValue(segments, value);
        },
        async transaction(updateFn) {
          if (db.transactionError) {
            throw db.transactionError;
          }

          const currentValue = getValue(segments);
          const newValue = updateFn(currentValue);

          if (newValue === undefined) {
            return {
              committed: false,
              snapshot: { val: () => currentValue }
            };
          }

          setValue(segments, newValue);
          return {
            committed: true,
            snapshot: { val: () => newValue }
          };
        }
      };
    }
  };

  return db;
};

test('increments participant count using a transaction', async () => {
  const mockDb = createMockRealtimeDb();
  const result = await joinTour('tour-1', 'user-1', mockDb);

  assert.equal(result.success, true);
  assert.equal(result.currentParticipants, 1);
  assert.ok(mockDb.state.tours['tour-1'].participants['user-1']);
});

test('handles concurrent joins with reliable increments', async () => {
  const mockDb = createMockRealtimeDb();

  await Promise.all([
    joinTour('tour-abc', 'user-1', mockDb),
    joinTour('tour-abc', 'user-2', mockDb)
  ]);

  assert.equal(mockDb.state.tours['tour-abc'].currentParticipants, 2);
  assert.deepEqual(
    Object.keys(mockDb.state.tours['tour-abc'].participants).sort(),
    ['user-1', 'user-2']
  );
});

test('surfaces transaction errors', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.transactionError = new Error('transaction failed');

  await assert.rejects(joinTour('tour-2', 'user-3', mockDb), /transaction failed/);
});
