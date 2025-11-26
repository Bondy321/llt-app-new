const test = require('node:test');
const assert = require('node:assert');
const { joinTour, ensureBookingSchemaConsistency, ensureTourParticipantCount } = require('../services/bookingServiceRealtime');

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
      const segments = path.split('/').filter(Boolean);
      const self = {
        async set(value) {
          setValue(segments, value);
        },
        async update(updates) {
          Object.entries(updates).forEach(([key, value]) => {
            setValue([...segments, key], value);
          });
        },
        async once() {
          const currentValue = getValue(segments);
          return {
            exists: () => currentValue !== undefined && currentValue !== null,
            val: () => currentValue
          };
        },
        child(childPath) {
          return db.ref(`${path}/${childPath}`);
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

      return self;
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

test('returns existing count when user rejoins the same tour', async () => {
  const mockDb = createMockRealtimeDb();

  await joinTour('tour-rejoin', 'user-1', mockDb);
  const repeatJoin = await joinTour('tour-rejoin', 'user-1', mockDb);

  assert.equal(repeatJoin.success, true);
  assert.equal(repeatJoin.currentParticipants, 1);
  assert.equal(mockDb.state.tours['tour-rejoin'].currentParticipants, 1);
  assert.equal(Object.keys(mockDb.state.tours['tour-rejoin'].participants).length, 1);
});

test('keeps participant counts stable across repeated joins for the same user', async () => {
  const mockDb = createMockRealtimeDb();

  await Promise.all([
    joinTour('tour-repeat', 'user-99', mockDb),
    joinTour('tour-repeat', 'user-99', mockDb),
    joinTour('tour-repeat', 'user-99', mockDb)
  ]);

  assert.equal(mockDb.state.tours['tour-repeat'].currentParticipants, 1);
  assert.deepEqual(Object.keys(mockDb.state.tours['tour-repeat'].participants), ['user-99']);
});

test('surfaces transaction errors', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.transactionError = new Error('transaction failed');

  await assert.rejects(joinTour('tour-2', 'user-3', mockDb), /transaction failed/);
});

test('normalizes legacy booking data into pickup points and seats', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.state.bookings = {
    ABC123: {
      passengers: ['Alice', 'Bob'],
      pickupLocation: 'Glasgow Central',
      pickupTime: '08:00',
      seatNumbers: ['1']
    }
  };

  const { normalizedBooking, updated } = await ensureBookingSchemaConsistency(
    'ABC123',
    mockDb.state.bookings.ABC123,
    mockDb
  );

  assert.equal(updated, true);
  assert.equal(normalizedBooking.pickupPoints[0].location, 'Glasgow Central');
  assert.equal(normalizedBooking.pickupPoints[0].time, '08:00');
  assert.deepEqual(mockDb.state.bookings.ABC123.pickupPoints[0], {
    location: 'Glasgow Central',
    time: '08:00'
  });
  assert.equal(normalizedBooking.seatNumbers.length, 2);
  assert.equal(normalizedBooking.seatNumbers[1], 'TBA');
});

test('reconciles participant counts when missing currentParticipants', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.state.tours['tour-99'] = {
    participants: {
      'user-1': { joinedAt: 'ts' },
      'user-2': { joinedAt: 'ts' }
    }
  };

  const reconciled = await ensureTourParticipantCount('tour-99', mockDb);

  assert.equal(reconciled, 2);
  assert.equal(mockDb.state.tours['tour-99'].currentParticipants, 2);
});
