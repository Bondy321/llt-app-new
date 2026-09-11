'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  buildPassengerSafeBooking,
  buildPassengerSafeItinerary,
} = require('../passenger-auth/public');
const { canonicalize } = require('./passengerTripContract');

const SIGNAL_ROOT = 'passenger_trip_signals/v1';
const signalOptions = Object.freeze({
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  maxInstances: 10,
  retry: true,
});

const TOUR_SIGNAL_FIELDS = Object.freeze({
  Name: 'name',
  TourCode: 'tourCode',
  Destination: 'destination',
  StartDate: 'startDate',
  EndDate: 'endDate',
  Duration: 'duration',
  Active: 'isActive',
  CurrentParticipants: 'currentParticipants',
  MaxParticipants: 'maxParticipants',
  DriverName: 'driverName',
  DriverPhone: 'driverPhone',
  AssignmentRevision: 'driverAssignmentRevision',
});

const nextCounter = (value) => (
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value + 1 : 1
);
const currentCounter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** @param {any} value */
const stableEqual = (left, right) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

/** @param {any} db @param {string} bookingRef */
const incrementBookingSignal = async (db, bookingRef) => db
  .ref(`${SIGNAL_ROOT}/bookings/${bookingRef}`)
  .transaction((current) => ({
    schemaVersion: 1,
    booking: nextCounter(current?.booking),
  }), undefined, false);

/** @param {any} db @param {string} tourId @param {'tour'|'itinerary'} part */
const incrementTourSignal = async (db, tourId, part) => db
  .ref(`${SIGNAL_ROOT}/tours/${tourId}`)
  .transaction((current) => ({
    schemaVersion: 1,
    tour: part === 'tour' ? nextCounter(current?.tour) : currentCounter(current?.tour),
    itinerary: part === 'itinerary'
      ? nextCounter(current?.itinerary)
      : currentCounter(current?.itinerary),
  }), undefined, false);

const handlePassengerTripBookingSignal = async ({ event, db = admin.database() }) => {
  const bookingRef = event.params?.bookingRef;
  if (!isValidFirebaseKey(bookingRef)) return null;
  const before = event.data?.before?.val?.();
  const after = event.data?.after?.val?.();
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    await db.ref(`${SIGNAL_ROOT}/bookings/${bookingRef}`).remove();
    return { removed: true };
  }
  const beforeProjection = before && typeof before === 'object'
    ? buildPassengerSafeBooking(bookingRef, before, before.tourId)
    : null;
  const afterProjection = buildPassengerSafeBooking(bookingRef, after, after.tourId);
  if (stableEqual(beforeProjection, afterProjection)) return null;
  const sourceRef = db.ref(`bookings/${bookingRef}`);
  if (!(await sourceRef.once('value')).exists()) {
    await db.ref(`${SIGNAL_ROOT}/bookings/${bookingRef}`).remove();
    return { removed: true };
  }
  await incrementBookingSignal(db, bookingRef);
  if (!(await sourceRef.once('value')).exists()) {
    await db.ref(`${SIGNAL_ROOT}/bookings/${bookingRef}`).remove();
    return { removed: true };
  }
  return { incremented: true };
};

const handlePassengerTripTourSignal = async ({ event, part, db = admin.database() }) => {
  const tourId = event.params?.tourId;
  if (!isValidFirebaseKey(tourId) || (part !== 'tour' && part !== 'itinerary')) return null;
  const tourExists = (await db.ref(`tours/${tourId}/tourCode`).once('value')).exists();
  if (!tourExists) {
    await db.ref(`${SIGNAL_ROOT}/tours/${tourId}`).remove();
    return { removed: true };
  }
  const before = event.data?.before?.val?.();
  const after = event.data?.after?.val?.();
  const meaningful = part === 'itinerary'
    ? !stableEqual(buildPassengerSafeItinerary(before), buildPassengerSafeItinerary(after))
    : !stableEqual(before, after);
  if (!meaningful) return null;
  await incrementTourSignal(db, tourId, part);
  if (!(await db.ref(`tours/${tourId}/tourCode`).once('value')).exists()) {
    await db.ref(`${SIGNAL_ROOT}/tours/${tourId}`).remove();
    return { removed: true };
  }
  return { incremented: true, part };
};

const createPassengerTripSignalFunctions = ({ onValueWrittenFn = onValueWritten, dbFactory = () => admin.database() } = {}) => {
  const register = (ref, handler) => /** @type {any} */ (onValueWrittenFn)(
    { ...signalOptions, ref },
    (event) => handler({ event, db: dbFactory() }),
  );
  const functions = {
    projectPassengerTripBooking: register('/bookings/{bookingRef}', handlePassengerTripBookingSignal),
    projectPassengerTripItinerary: register('/tours/{tourId}/itinerary', (input) => (
      handlePassengerTripTourSignal({ ...input, part: 'itinerary' })
    )),
  };
  Object.entries(TOUR_SIGNAL_FIELDS).forEach(([suffix, field]) => {
    functions[`projectPassengerTripTour${suffix}`] = register(`/tours/{tourId}/${field}`, (input) => (
      handlePassengerTripTourSignal({ ...input, part: 'tour' })
    ));
  });
  return functions;
};

const passengerTripSignalFunctions = createPassengerTripSignalFunctions();

module.exports = {
  SIGNAL_ROOT,
  TOUR_SIGNAL_FIELDS,
  createPassengerTripSignalFunctions,
  currentCounter,
  handlePassengerTripBookingSignal,
  handlePassengerTripTourSignal,
  incrementBookingSignal,
  incrementTourSignal,
  nextCounter,
  signalOptions,
  stableEqual,
  ...passengerTripSignalFunctions,
};
