const test = require('node:test');
const assert = require('node:assert');
const { joinTour, ensureBookingSchemaConsistency, ensureTourParticipantCount } = require('../services/bookingServiceRealtime');

const secureSessionFor = (tourId, userId) => ({
  schemaVersion: 1,
  sessionId: `sess_v1_${String(userId).replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase()}`,
  principalType: 'passenger',
  principalId: `pax_v2_${String(userId).replace(/[^a-f0-9]/gi, '').padEnd(32, 'a').slice(0, 32).toLowerCase()}`,
  driverId: null,
  tourId,
  issuedAtMs: Date.now() - 1_000,
  expiresAtMs: Date.now() + 60_000,
  sessionRevision: 1,
});

const seedSecureMembership = (mockDb, tourId, userId) => {
  const session = secureSessionFor(tourId, userId);
  mockDb.state.tours[tourId].participants[userId] = {
    schemaVersion: 2,
    principalId: session.principalId,
    sessionId: session.sessionId,
    sessionExpiresAtMs: session.expiresAtMs,
    joinedAtMs: Date.now(),
  };
  return { appSession: session };
};

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

const seedActiveTour = (mockDb, tourId, overrides = {}) => {
  mockDb.state.tours[tourId] = {
    isActive: true,
    participants: {},
    currentParticipants: 0,
    ...overrides,
  };
};

test('accepts server-owned membership without changing the trusted booked-passenger total', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-1');

  const options = seedSecureMembership(mockDb, 'tour-1', 'user-1');
  const result = await joinTour('tour-1', 'user-1', mockDb, options);

  assert.equal(result.success, true);
  assert.equal(result.currentParticipants, 0);
  assert.ok(mockDb.state.tours['tour-1'].participants['user-1']);
  assert.equal(mockDb.state.tours['tour-1'].currentParticipants, 0);
});

test('handles concurrent reads of independently server-issued memberships', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-abc');

  await Promise.all([
    joinTour('tour-abc', 'user-1', mockDb, seedSecureMembership(mockDb, 'tour-abc', 'user-1')),
    joinTour('tour-abc', 'user-2', mockDb, seedSecureMembership(mockDb, 'tour-abc', 'user-2'))
  ]);

  assert.equal(mockDb.state.tours['tour-abc'].currentParticipants, 0);
  assert.deepEqual(
    Object.keys(mockDb.state.tours['tour-abc'].participants).sort(),
    ['user-1', 'user-2']
  );
});

test('returns existing count when user rejoins the same tour', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-rejoin');

  const options = seedSecureMembership(mockDb, 'tour-rejoin', 'user-1');
  await joinTour('tour-rejoin', 'user-1', mockDb, options);
  const repeatJoin = await joinTour('tour-rejoin', 'user-1', mockDb, options);

  assert.equal(repeatJoin.success, true);
  assert.equal(repeatJoin.currentParticipants, 0);
  assert.equal(mockDb.state.tours['tour-rejoin'].currentParticipants, 0);
  assert.equal(Object.keys(mockDb.state.tours['tour-rejoin'].participants).length, 1);
});

test('keeps participant counts stable across repeated joins for the same user', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-repeat');

  const options = seedSecureMembership(mockDb, 'tour-repeat', 'user-99');
  await Promise.all([
    joinTour('tour-repeat', 'user-99', mockDb, options),
    joinTour('tour-repeat', 'user-99', mockDb, options),
    joinTour('tour-repeat', 'user-99', mockDb, options)
  ]);

  assert.equal(mockDb.state.tours['tour-repeat'].currentParticipants, 0);
  assert.deepEqual(Object.keys(mockDb.state.tours['tour-repeat'].participants), ['user-99']);
});

test('refuses to recreate missing server membership even when legacy transaction support exists', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-2');
  mockDb.transactionError = new Error('transaction failed');

  await assert.rejects(joinTour('tour-2', 'user-3', mockDb), /server did not create secure tour membership/i);
  assert.equal(mockDb.state.tours['tour-2'].participants['user-3'], undefined);
});

test('does not create missing tours from the customer app', async () => {
  const mockDb = createMockRealtimeDb();

  await assert.rejects(joinTour('missing-tour', 'user-3', mockDb), /Tour not found/);
  assert.equal(mockDb.state.tours['missing-tour'], undefined);
});

test('shapes canonical booking data for display without mutating the booking record', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.state.bookings = {
    ABC123: {
      passengerNames: ['Alice', 'Bob'],
      pickupPoints: [{ location: 'Glasgow Central', time: '08:00' }],
      seatNumbers: ['1']
    }
  };

  const { normalizedBooking, updated } = await ensureBookingSchemaConsistency(
    'ABC123',
    mockDb.state.bookings.ABC123,
    mockDb
  );

  assert.equal(updated, false);
  assert.equal(normalizedBooking.pickupPoints[0].location, 'Glasgow Central');
  assert.equal(normalizedBooking.pickupPoints[0].time, '08:00');
  assert.equal(normalizedBooking.seatNumbers.length, 2);
  assert.equal(normalizedBooking.seatNumbers[1], 'TBA');
  assert.equal(mockDb.state.bookings.ABC123.seatNumbers.length, 1);
});

test('uses app-membership count only as a read-only fallback when booked count is missing', async () => {
  const mockDb = createMockRealtimeDb();
  mockDb.state.tours['tour-99'] = {
    participants: {
      'user-1': { joinedAt: 'ts' },
      'user-2': { joinedAt: 'ts' }
    }
  };

  const reconciled = await ensureTourParticipantCount('tour-99', mockDb);

  assert.equal(reconciled, 2);
  assert.equal(mockDb.state.tours['tour-99'].currentParticipants, undefined);
});

test('preserves trusted booked-passenger totals when app membership differs', async () => {
  const mockDb = createMockRealtimeDb();
  seedActiveTour(mockDb, 'tour-booked-total', {
    currentParticipants: 42,
    participants: { 'user-existing': { joinedAt: 'ts' } },
  });

  const options = seedSecureMembership(mockDb, 'tour-booked-total', 'user-new');
  const result = await joinTour('tour-booked-total', 'user-new', mockDb, options);

  assert.equal(result.currentParticipants, 42);
  assert.equal(mockDb.state.tours['tour-booked-total'].currentParticipants, 42);
  assert.deepEqual(Object.keys(mockDb.state.tours['tour-booked-total'].participants).sort(), [
    'user-existing',
    'user-new',
  ]);
});
