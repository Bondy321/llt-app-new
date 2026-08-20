const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-manual-passenger',
  storageBucket: 'demo-llt-manual-passenger.appspot.com',
});

const { __testables } = require('../functions/index.js');

const createMockRealtimeDb = (state) => {
  const getValue = (dbPath = '') => dbPath
    .split('/')
    .filter(Boolean)
    .reduce((node, key) => (node || {})[key], state);

  const snapshotFor = (value) => ({
    exists: () => value !== undefined && value !== null,
    val: () => value,
  });

  return {
    ref(dbPath = '') {
      const value = () => getValue(dbPath);
      return {
        async once() {
          return snapshotFor(value());
        },
        orderByChild(childKey) {
          return {
            equalTo(expected) {
              return {
                async once() {
                  const collection = value() || {};
                  const filtered = Object.entries(collection).reduce((acc, [key, child]) => {
                    if (child?.[childKey] === expected) {
                      acc[key] = child;
                    }
                    return acc;
                  }, {});
                  return snapshotFor(Object.keys(filtered).length > 0 ? filtered : null);
                },
              };
            },
          };
        },
      };
    },
  };
};

const applyMultiPathUpdates = (state, updates) => {
  Object.entries(updates).forEach(([path, value]) => {
    const parts = path.split('/').filter(Boolean);
    let cursor = state;
    parts.slice(0, -1).forEach((part) => {
      cursor[part] = cursor[part] || {};
      cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = value;
  });
  return state;
};

const buildValidManualPassengerPlan = () => {
  const normalized = __testables.normalizeManualPassengerPayload({
    tourId: '5112D_8',
    bookingRef: ' t123456 ',
    email: ' Review@Example.COM ',
    pickupDate: '2026-06-15',
    pickupTime: '08:30',
    pickupLocation: 'Buchanan Bus Station',
    passengers: [
      { name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' },
      { name: 'Second Reviewer', seatNumber: 20, phone: '+44 7700 900001' },
    ],
  }, {
    tourCode: '5112D 8',
    startDate: '15/06/2026',
    endDate: '15/06/2026',
    isActive: true,
    maxParticipants: 53,
  });

  return __testables.buildManualPassengerBookingUpdates({
    normalized,
    actorUid: 'admin-uid-1',
    nowIso: '2026-06-15T09:00:00.000Z',
    idempotencyKey: 'manual-create:test',
    tourData: {
      tourCode: '5112D 8',
      pickupPoints: [{ date: '15/06/2026', time: '07:30', location: 'Existing' }],
    },
    existingTourBookings: {
      EXISTING: {
        passengerNames: ['Existing Passenger'],
        seatNumbers: [1],
      },
    },
    existingTopLevelPickupPoints: [],
  });
};

test('normalizeManualPassengerPayload enforces the fields needed for passenger app login', () => {
  assert.throws(
    () => __testables.normalizeManualPassengerPayload({
      tourId: '5112D_8',
      bookingRef: '',
      email: 'bad-email',
      pickupDate: '2026-06-15',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      passengers: [{ name: 'Apple Reviewer', seatNumber: 19, phone: '+44 7700 900000' }],
    }, {
      tourCode: '5112D 8',
      startDate: '15/06/2026',
      endDate: '15/06/2026',
      isActive: true,
      maxParticipants: 53,
    }),
    /Booking reference/,
  );
});

test('buildManualPassengerBookingUpdates creates the same effective booking and identity shape as uploads', () => {
  const plan = buildValidManualPassengerPlan();

  assert.deepEqual(plan.updates['bookings/T123456'], {
    bookingRef: 'T123456',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    passengerNames: ['Apple Reviewer', 'Second Reviewer'],
    passengers: ['Apple Reviewer', 'Second Reviewer'],
    passengerDetails: [
      {
        name: 'Apple Reviewer',
        bookingRef: 'T123456',
        tourId: '5112D_8',
        tourCode: '5112D 8',
        seatLabel: 'S19',
        seatNo: 19,
        pickupPoint: {
          date: '15/06/2026',
          time: '08:30',
          location: 'Buchanan Bus Station',
        },
        pickupDate: '15/06/2026',
        phone: '+44 7700 900000',
      },
      {
        name: 'Second Reviewer',
        bookingRef: 'T123456',
        tourId: '5112D_8',
        tourCode: '5112D 8',
        seatLabel: 'S20',
        seatNo: 20,
        pickupPoint: {
          date: '15/06/2026',
          time: '08:30',
          location: 'Buchanan Bus Station',
        },
        pickupDate: '15/06/2026',
        phone: '+44 7700 900001',
      },
    ],
    pickupPoints: [
      {
        date: '15/06/2026',
        time: '08:30',
        location: 'Buchanan Bus Station',
      },
    ],
    seatNumbers: [19, 20],
    seatLabels: ['S19', 'S20'],
    pickupDate: '15/06/2026',
    pickupTime: '08:30',
    pickupLocation: 'Buchanan Bus Station',
    source: 'web-admin-manual',
    createdAt: '2026-06-15T09:00:00.000Z',
    createdBy: 'admin-uid-1',
  });
  assert.deepEqual(plan.updates['booking_identities/T123456'], {
    bookingRef: 'T123456',
    normalizedBookingRef: 'T123456',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    email: 'review@example.com',
    normalizedEmail: 'review@example.com',
  });
  assert.deepEqual(plan.updates['tour_manifests/5112D_8/bookings/T123456'], {
    status: 'PENDING',
    passengerStatus: ['PENDING', 'PENDING'],
    lastUpdated: '2026-06-15T09:00:00.000Z',
    idempotencyKey: 'manual-create:test',
  });
  assert.equal(plan.updates['tours/5112D_8/bookedPassengerCount'], 3);
  assert.equal(plan.updates['tours/5112D_8/manifestPassengerCount'], 3);
  assert.equal(plan.updates['tours/5112D_8/currentParticipants'], 3);
  assert.deepEqual(plan.updates['tours/5112D_8/pickupPoints'], [
    { date: '15/06/2026', time: '07:30', location: 'Existing' },
    { date: '15/06/2026', time: '08:30', location: 'Buchanan Bus Station' },
  ]);
});

test('manual passenger write plan appears in app manifest payload as a normal pending booking', async () => {
  const plan = buildValidManualPassengerPlan();
  const state = applyMultiPathUpdates({
    tours: {
      '5112D_8': {
        name: 'Highlands',
        tourCode: '5112D 8',
        startDate: '15/06/2026',
        endDate: '15/06/2026',
        isActive: true,
        maxParticipants: 53,
      },
    },
    bookings: {
      EXISTING: {
        bookingRef: 'EXISTING',
        tourId: '5112D_8',
        tourCode: '5112D 8',
        passengerNames: ['Existing Passenger'],
        pickupPoints: [{ date: '15/06/2026', time: '07:30', location: 'Existing' }],
        seatNumbers: [1],
      },
    },
    booking_identities: {},
    tour_manifests: {},
    pickupPoints: {},
  }, plan.updates);

  const manifest = await __testables.buildTourManifestPayload({
    tourId: '5112D_8',
    db: createMockRealtimeDb(state),
  });

  const manualBooking = manifest.bookings.find((booking) => booking.id === 'T123456');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.complete, true);
  assert.ok(manualBooking);
  assert.deepEqual(manualBooking.passengerNames, ['Apple Reviewer', 'Second Reviewer']);
  assert.deepEqual(manualBooking.seatNumbers, [19, 20]);
  assert.equal(manualBooking.pickupDate, '15/06/2026');
  assert.equal(manualBooking.pickupTime, '08:30');
  assert.equal(manualBooking.pickupLocation, 'Buchanan Bus Station');
  assert.equal(manualBooking.status, 'PENDING');
  assert.deepEqual(manualBooking.passengerStatus, ['PENDING', 'PENDING']);
  assert.equal(manifest.stats.totalBookings, 2);
  assert.equal(manifest.stats.totalPax, 3);
  assert.deepEqual(state.booking_identities.T123456, {
    bookingRef: 'T123456',
    normalizedBookingRef: 'T123456',
    tourId: '5112D_8',
    tourCode: '5112D 8',
    email: 'review@example.com',
    normalizedEmail: 'review@example.com',
  });
});

test('findManualPassengerSeatConflicts catches seats already assigned on the tour', () => {
  const conflicts = __testables.findManualPassengerSeatConflicts({
    ABC123: {
      seatNumbers: [18],
      passengerDetails: [{ seatNo: 19 }],
    },
  }, [
    { seatNumber: 19 },
    { seatNumber: 20 },
  ]);

  assert.deepEqual(conflicts, [19]);
});

test('manual passenger write plan rejects a booking that exceeds tour capacity', () => {
  const normalized = __testables.normalizeManualPassengerPayload({
    tourId: 'SMALL_1',
    bookingRef: 'NEWBOOKING',
    email: 'guest@example.com',
    pickupDate: '2026-06-15',
    pickupTime: '08:30',
    pickupLocation: 'Buchanan Bus Station',
    passengers: [{ name: 'New Guest', seatNumber: 2, phone: '+44 7700 900000' }],
  }, {
    tourCode: 'SMALL 1',
    startDate: '15/06/2026',
    endDate: '15/06/2026',
    isActive: true,
    maxParticipants: 2,
  });

  assert.throws(
    () => __testables.buildManualPassengerBookingUpdates({
      normalized,
      actorUid: 'admin-uid-1',
      tourData: { maxParticipants: 2 },
      existingTourBookings: {
        EXISTING: { passengerNames: ['One', 'Two'] },
      },
    }),
    (error) => error?.code === 'TOUR_CAPACITY_EXCEEDED',
  );
});
