'use strict';

const AUTH_UID = 'passenger-auth-uid';
const PRINCIPAL_ID = `pax_v2_${'a'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'b'.repeat(32)}`;
const BOOKING_REF = 'BOOK123';
const TOUR_ID = '5112D_8';

const clone = (value) => JSON.parse(JSON.stringify(value));
const getAtPath = (state, path) => path.split('/').filter(Boolean)
  .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), state);
const setAtPath = (state, path, value) => {
  const keys = path.split('/').filter(Boolean);
  let cursor = state;
  keys.slice(0, -1).forEach((key) => { cursor[key] = cursor[key] || {}; cursor = cursor[key]; });
  if (value === null) delete cursor[keys[keys.length - 1]];
  else cursor[keys[keys.length - 1]] = value;
};
const snapshot = (value) => ({
  exists: () => value !== undefined && value !== null,
  val: () => value,
});

const buildState = () => ({
  users: { [AUTH_UID]: { bookingRef: BOOKING_REF } },
  passenger_identity_security: { [BOOKING_REF]: {
    authorizedAuthUid: AUTH_UID,
    passengerPrincipalId: PRINCIPAL_ID,
    passengerIdentityVersion: 'pax_v2',
    loginLocked: false,
  } },
  bookings: { [BOOKING_REF]: {
    bookingRef: BOOKING_REF,
    tourId: TOUR_ID,
    tourCode: '5112D 8',
    passengerNames: ['Alex Example'],
    seatNumbers: [4],
    pickupDate: '10/09/2026',
    pickupTime: '08:30',
    pickupLocation: 'Buchanan Bus Station',
  } },
  tours: { [TOUR_ID]: {
    tourCode: '5112D 8',
    name: 'Loch Lomond Day Tour',
    destination: 'Loch Lomond',
    startDate: '10/09/2026',
    endDate: '10/09/2026',
    duration: 1,
    isActive: true,
    currentParticipants: 24,
    maxParticipants: 53,
    driverName: 'Driver Example',
    driverPhone: '+44 7000 000003',
    driverAssignmentRevision: 7,
    itinerary: { title: 'Your day', revision: 1, days: [{ day: 1, content: 'Cruise' }] },
  } },
});

const createPassengerTripFixture = () => {
  const state = clone(buildState());
  const reads = [];
  const writes = [];
  const db = {
    ref(path = '') {
      return {
        async once() {
          reads.push(path);
          return snapshot(getAtPath(state, path));
        },
        async transaction(updater) {
          const next = updater(getAtPath(state, path));
          if (next === undefined) return { committed: false, snapshot: snapshot(getAtPath(state, path)) };
          setAtPath(state, path, next);
          writes.push({ type: 'transaction', path, value: clone(next) });
          return { committed: true, snapshot: snapshot(next) };
        },
        async remove() {
          setAtPath(state, path, null);
          writes.push({ type: 'remove', path });
        },
      };
    },
  };
  const scope = { authUid: AUTH_UID, principalId: PRINCIPAL_ID, bookingRef: BOOKING_REF,
    tourId: TOUR_ID, sessionId: SESSION_ID };
  const access = { allowed: true, principalId: PRINCIPAL_ID, tourId: TOUR_ID,
    session: { sessionId: SESSION_ID } };
  return { access, db, reads, scope, state, writes, get: (path) => getAtPath(state, path),
    set: (path, value) => setAtPath(state, path, value), snapshot };
};

module.exports = {
  AUTH_UID,
  BOOKING_REF,
  PRINCIPAL_ID,
  SESSION_ID,
  TOUR_ID,
  buildState,
  createPassengerTripFixture,
};
