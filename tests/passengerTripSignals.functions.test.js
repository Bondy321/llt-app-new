'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-passenger-trip-signals' });

const {
  SIGNAL_ROOT,
  TOUR_SIGNAL_FIELDS,
  createPassengerTripSignalFunctions,
  handlePassengerTripBookingSignal,
  handlePassengerTripTourSignal,
} = require('../functions/src/domains/passenger-trip/passengerTripSignals');
const { buildTourDeletionUpdates } = require('../functions/src/domains/administration/tourDeletion');

const TOUR_ID = '5112D_8';
const BOOKING_REF = 'BOOK123';

const getAtPath = (state, path) => path.split('/').filter(Boolean)
  .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), state);

const setAtPath = (state, path, value) => {
  const keys = path.split('/').filter(Boolean);
  let cursor = state;
  keys.slice(0, -1).forEach((key) => { cursor[key] = cursor[key] || {}; cursor = cursor[key]; });
  if (value === null) delete cursor[keys[keys.length - 1]];
  else cursor[keys[keys.length - 1]] = value;
};

const createSignalDb = (state) => {
  const writes = [];
  return {
    state,
    writes,
    ref(path) {
      return {
        async once(event) {
          assert.equal(event, 'value');
          const value = getAtPath(state, path);
          return { exists: () => value !== undefined && value !== null, val: () => value };
        },
        async transaction(updater) {
          const next = updater(getAtPath(state, path));
          if (next === undefined) return { committed: false, snapshot: { val: () => getAtPath(state, path) } };
          setAtPath(state, path, next);
          writes.push({ type: 'transaction', path, value: next });
          return { committed: true, snapshot: { val: () => next } };
        },
        async remove() {
          setAtPath(state, path, null);
          writes.push({ type: 'remove', path });
        },
      };
    },
  };
};

const snapshot = (value) => ({ val: () => value });
const bookingEvent = (before, after) => ({
  params: { bookingRef: BOOKING_REF },
  data: { before: snapshot(before), after: snapshot(after) },
});
const tourEvent = (before, after) => ({
  params: { tourId: TOUR_ID },
  data: { before: snapshot(before), after: snapshot(after) },
});

test('booking trigger increments only when the passenger-safe projection changes', async () => {
  const before = {
    tourId: TOUR_ID,
    passengerNames: ['Alex Example'],
    seatNumbers: [4],
    pickupTime: '08:30',
    internalNotes: 'old',
    supplierCost: 100,
  };
  const internalOnly = { ...before, internalNotes: 'new', supplierCost: 999 };
  const changed = { ...internalOnly, pickupTime: '08:45' };
  const db = createSignalDb({
    bookings: { [BOOKING_REF]: changed },
    tours: { [TOUR_ID]: { tourCode: '5112D 8' } },
  });
  assert.equal(await handlePassengerTripBookingSignal({ event: bookingEvent(before, internalOnly), db }), null);
  assert.deepEqual(db.writes, []);

  assert.deepEqual(await handlePassengerTripBookingSignal({ event: bookingEvent(internalOnly, changed), db }), {
    incremented: true,
  });
  assert.deepEqual(getAtPath(db.state, `${SIGNAL_ROOT}/bookings/${BOOKING_REF}`), {
    schemaVersion: 1,
    booking: 1,
  });
  const signalText = JSON.stringify(getAtPath(db.state, `${SIGNAL_ROOT}/bookings/${BOOKING_REF}`));
  assert.equal(signalText.includes('Alex Example'), false);
  assert.equal(signalText.includes('08:45'), false);
});

test('booking deletion removes its exact signal', async () => {
  const db = createSignalDb({
    passenger_trip_signals: { v1: { bookings: { [BOOKING_REF]: { schemaVersion: 1, booking: 9 } } } },
  });
  const result = await handlePassengerTripBookingSignal({
    event: bookingEvent({ tourId: TOUR_ID, passengerNames: ['Alex'] }, null),
    db,
  });
  assert.deepEqual(result, { removed: true });
  assert.equal(getAtPath(db.state, `${SIGNAL_ROOT}/bookings/${BOOKING_REF}`), undefined);
  assert.deepEqual(db.writes, [{ type: 'remove', path: `${SIGNAL_ROOT}/bookings/${BOOKING_REF}` }]);
});

test('a replayed booking event cannot recreate a signal after canonical deletion', async () => {
  const db = createSignalDb({
    passenger_trip_signals: { v1: { bookings: { [BOOKING_REF]: { schemaVersion: 1, booking: 4 } } } },
  });
  const before = { tourId: TOUR_ID, pickupTime: '08:30' };
  const after = { tourId: TOUR_ID, pickupTime: '08:45' };
  const result = await handlePassengerTripBookingSignal({ event: bookingEvent(before, after), db });
  assert.deepEqual(result, { removed: true });
  assert.equal(getAtPath(db.state, `${SIGNAL_ROOT}/bookings/${BOOKING_REF}`), undefined);
  assert.equal(db.writes.some((write) => write.type === 'transaction'), false);
});

test('tour and itinerary counters update atomically without overwriting each other', async () => {
  const db = createSignalDb({ tours: { [TOUR_ID]: { tourCode: '5112D 8' } } });
  await handlePassengerTripTourSignal({ event: tourEvent('08:30', '08:45'), part: 'tour', db });
  await handlePassengerTripTourSignal({
    event: tourEvent(null, { title: 'Your day', days: [{ content: 'Cruise' }] }),
    part: 'itinerary',
    db,
  });
  await handlePassengerTripTourSignal({ event: tourEvent('08:45', '09:00'), part: 'tour', db });
  assert.deepEqual(getAtPath(db.state, `${SIGNAL_ROOT}/tours/${TOUR_ID}`), {
    schemaVersion: 1,
    tour: 2,
    itinerary: 1,
  });
  assert.ok(db.writes.every((write) => write.type === 'transaction'));
});

test('itinerary trigger ignores private-only fields but invalidates withdrawal', async () => {
  const db = createSignalDb({ tours: { [TOUR_ID]: { tourCode: '5112D 8' } } });
  const before = { title: 'Your day', days: [{ content: 'Cruise' }], internalNotes: 'one' };
  const internalOnly = { ...before, internalNotes: 'two', supplierDocuments: ['private'] };
  assert.equal(await handlePassengerTripTourSignal({
    event: tourEvent(before, internalOnly), part: 'itinerary', db,
  }), null);
  assert.deepEqual(db.writes, []);
  await handlePassengerTripTourSignal({ event: tourEvent(internalOnly, null), part: 'itinerary', db });
  assert.equal(getAtPath(db.state, `${SIGNAL_ROOT}/tours/${TOUR_ID}/itinerary`), 1);
});

test('tour deletion removes a shared signal instead of recreating it from leaf events', async () => {
  const db = createSignalDb({
    passenger_trip_signals: { v1: { tours: { [TOUR_ID]: { schemaVersion: 1, tour: 3, itinerary: 4 } } } },
  });
  const result = await handlePassengerTripTourSignal({
    event: tourEvent('Old name', null),
    part: 'tour',
    db,
  });
  assert.deepEqual(result, { removed: true });
  assert.equal(getAtPath(db.state, `${SIGNAL_ROOT}/tours/${TOUR_ID}`), undefined);
});

test('signal registration uses one exact booking trigger and explicit tour leaves', () => {
  const registrations = [];
  const registered = createPassengerTripSignalFunctions({
    onValueWrittenFn: (options, handler) => { registrations.push({ options, handler }); return { options }; },
    dbFactory: () => createSignalDb({}),
  });
  assert.equal(registrations.length, 2 + Object.keys(TOUR_SIGNAL_FIELDS).length);
  assert.ok(registrations.some(({ options }) => options.ref === '/bookings/{bookingRef}'));
  assert.ok(registrations.some(({ options }) => options.ref === '/tours/{tourId}/itinerary'));
  for (const field of Object.values(TOUR_SIGNAL_FIELDS)) {
    assert.ok(registrations.some(({ options }) => options.ref === `/tours/{tourId}/${field}`), field);
  }
  assert.equal(registrations.some(({ options }) => options.ref === '/tours/{tourId}'), false);
  assert.ok(registered.projectPassengerTripBooking);
});

test('tour deletion update removes the tour and every included booking signal', () => {
  const updates = buildTourDeletionUpdates({
    tourId: TOUR_ID,
    bookings: { [BOOKING_REF]: {}, SECOND_BOOKING: {} },
  });
  assert.equal(updates[`${SIGNAL_ROOT}/tours/${TOUR_ID}`], null);
  assert.equal(updates[`${SIGNAL_ROOT}/bookings/${BOOKING_REF}`], null);
  assert.equal(updates[`${SIGNAL_ROOT}/bookings/SECOND_BOOKING`], null);
});
