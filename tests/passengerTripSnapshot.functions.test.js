'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-passenger-trip-snapshot' });

const {
  fingerprintPassengerTripContent,
  normalizePassengerTripRequest,
} = require('../functions/src/domains/passenger-trip/passengerTripContract');
const {
  createPassengerTripSnapshotHandler,
} = require('../functions/src/domains/passenger-trip/passengerTripFunctions');

const AUTH_UID = 'passenger-auth-uid';
const PRINCIPAL_ID = `pax_v2_${'a'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'b'.repeat(32)}`;
const BOOKING_REF = 'BOOK123';
const TOUR_ID = '5112D_8';

const getAtPath = (state, path) => path.split('/').filter(Boolean)
  .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), state);

const createSnapshot = (value) => ({
  exists: () => value !== undefined && value !== null,
  val: () => value,
});

const createReadDb = (state, { failures = new Set(), onRead = () => {} } = {}) => {
  const reads = [];
  return {
    reads,
    ref(path) {
      return {
        async once(event) {
          assert.equal(event, 'value');
          reads.push(path);
          onRead(path, state);
          if (failures.has(path)) throw new Error('synthetic read failure');
          return createSnapshot(getAtPath(state, path));
        },
      };
    },
  };
};

const baseState = () => ({
  users: {
    [AUTH_UID]: { bookingRef: BOOKING_REF, ignoredProfileField: 'private' },
  },
  passenger_identity_security: {
    [BOOKING_REF]: {
      authorizedAuthUid: AUTH_UID,
      deviceAuthorizationVersion: 2,
      authorizedAuthUids: { [AUTH_UID]: true },
      passengerPrincipalId: PRINCIPAL_ID,
      passengerIdentityVersion: 'pax_v2',
      loginLocked: false,
      internalAudit: 'private',
    },
  },
  bookings: {
    [BOOKING_REF]: {
      bookingRef: BOOKING_REF,
      tourId: TOUR_ID,
      tourCode: '5112D 8',
      passengerNames: ['Alex Example', 'Sam Example'],
      passengerDetails: [
        { name: 'Alex Example', phone: '+44 7000 000001', seatNo: 4 },
        { name: 'Sam Example', phone: '+44 7000 000002', seatNo: 5 },
      ],
      seatNumbers: [4, 5],
      pickupDate: '10/09/2026',
      pickupTime: '08:30',
      pickupLocation: 'Buchanan Bus Station',
      pickupAddress: 'Killermont Street',
      supplierCost: 999,
      internalNotes: 'Never expose',
      email: 'private@example.com',
    },
  },
  tours: {
    [TOUR_ID]: {
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
      services: { hotel: { supplierRate: 1000 } },
      participants: { [AUTH_UID]: { private: true } },
      driver_itinerary: 'Depot instructions',
      itinerary: {
        title: 'Your day',
        revision: 3,
        updatedAt: 1_787_990_400_000,
        days: [{ day: 1, content: 'Cruise and viewpoints', internalNotes: 'private' }],
        supplierDocuments: ['private.pdf'],
      },
    },
  },
});

const createResponse = () => ({
  statusCode: null,
  body: null,
  headers: {},
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return value; },
  set(name, value) { this.headers[name] = value; return this; },
});

const allowedAccess = {
  allowed: true,
  principalId: PRINCIPAL_ID,
  tourId: TOUR_ID,
  session: { sessionId: SESSION_ID },
};

const noDeletion = async () => true;

const runHandler = async ({ state = baseState(), body, failures, onRead, verifySession, authorizeRequest } = {}) => {
  const db = createReadDb(state, { failures, onRead });
  const res = createResponse();
  const verifyCalls = [];
  const handler = createPassengerTripSnapshotHandler({
    dbFactory: () => db,
    authorizeRequest: authorizeRequest || (async () => ({ success: true, uid: AUTH_UID })),
    verifySession: verifySession || (async (input) => { verifyCalls.push(input); return allowedAccess; }),
    ensureNoAccountDeletion: noDeletion,
    ensureNoPassengerDeletion: noDeletion,
    clock: () => 1_789_000_000_000,
  });
  await handler({ method: 'POST', body: body || {
    expectedSessionId: SESSION_ID,
    parts: ['booking', 'tour', 'itinerary'],
    versions: {},
  } }, res);
  return { db, res, verifyCalls };
};

test('request boundary accepts only the fixed session, parts, and versions shape', () => {
  assert.deepEqual(normalizePassengerTripRequest({
    expectedSessionId: SESSION_ID,
    parts: ['booking', 'itinerary'],
    versions: { booking: 'c'.repeat(64) },
  }), {
    expectedSessionId: SESSION_ID,
    parts: ['booking', 'itinerary'],
    versions: { booking: 'c'.repeat(64) },
  });
  assert.equal(normalizePassengerTripRequest({
    expectedSessionId: SESSION_ID,
    parts: ['booking'],
    versions: {},
    bookingRef: 'OTHER',
  }), null);
  assert.equal(normalizePassengerTripRequest({
    expectedSessionId: SESSION_ID,
    parts: ['booking', 'booking'],
    versions: {},
  }), null);
  assert.equal(normalizePassengerTripRequest({
    expectedSessionId: SESSION_ID,
    parts: ['booking'],
    versions: { tour: 'd'.repeat(64) },
  }), null);
});

test('snapshot derives exact scope and returns recursively bounded passenger projections', async () => {
  const { db, res, verifyCalls } = await runHandler();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.deepEqual(res.body.scope, {
    authUid: AUTH_UID,
    principalId: PRINCIPAL_ID,
    bookingRef: BOOKING_REF,
    tourId: TOUR_ID,
    sessionId: SESSION_ID,
  });
  assert.equal(res.body.checkedAtMs, 1_789_000_000_000);
  assert.equal(res.body.schemaVersion, 1);
  assert.equal(res.body.parts.booking.status, 'value');
  assert.deepEqual(res.body.parts.booking.data.passengerNames, ['Alex Example', 'Sam Example']);
  assert.deepEqual(res.body.parts.booking.data.seatNumbers, [4, 5]);
  assert.equal(res.body.parts.booking.data.pickupTime, '08:30');
  assert.equal(res.body.parts.tour.data.driverName, 'Driver Example');
  assert.equal(res.body.parts.itinerary.data.days[0].content, 'Cruise and viewpoints');
  const payloadText = JSON.stringify(res.body);
  for (const forbidden of ['supplierCost', 'internalNotes', 'supplierDocuments', 'driver_itinerary',
    'private@example.com', '+44 7000 000001', 'services', 'participants']) {
    assert.equal(payloadText.includes(forbidden), false, forbidden);
  }
  assert.equal(verifyCalls.length, 2);
  assert.equal(verifyCalls[0].expectedRole, 'passenger');
  assert.equal(verifyCalls[0].expectedSessionId, SESSION_ID);
  const forbiddenReads = new Set(['bookings', 'tours', 'users', `tours/${TOUR_ID}`]);
  assert.equal(db.reads.some((path) => forbiddenReads.has(path)), false);
  assert.ok(db.reads.includes(`bookings/${BOOKING_REF}`));
  assert.ok(db.reads.includes(`tours/${TOUR_ID}/itinerary`));
});

test('conditional versions still perform canonical reads before returning unchanged', async () => {
  const first = await runHandler();
  const versions = Object.fromEntries(Object.entries(first.res.body.parts)
    .map(([part, value]) => [part, value.version]));
  const second = await runHandler({ body: {
    expectedSessionId: SESSION_ID,
    parts: ['booking', 'tour', 'itinerary'],
    versions,
  } });
  assert.deepEqual(Object.fromEntries(Object.entries(second.res.body.parts)
    .map(([part, value]) => [part, value.status])), {
    booking: 'unchanged', tour: 'unchanged', itinerary: 'unchanged',
  });
  assert.ok(second.db.reads.includes(`bookings/${BOOKING_REF}`));
  assert.ok(second.db.reads.includes(`tours/${TOUR_ID}/driverPhone`));
  assert.ok(second.db.reads.includes(`tours/${TOUR_ID}/itinerary`));
});

test('an additional authorized phone reads the same trip without enumerating device authorizations', async () => {
  const state = baseState();
  state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 2;
  state.passenger_identity_security[BOOKING_REF].authorizedAuthUid = 'original-phone';
  state.passenger_identity_security[BOOKING_REF].authorizedAuthUids = {
    'original-phone': true,
    [AUTH_UID]: true,
    'another-private-phone': true,
  };
  const { db, res } = await runHandler({ state });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope.principalId, PRINCIPAL_ID);
  assert.equal(res.body.parts.booking.status, 'value');
  assert.equal(db.reads.filter((path) => path === `passenger_identity_security/${BOOKING_REF}/authorizedAuthUids/${AUTH_UID}`).length, 2);
  assert.equal(db.reads.includes(`passenger_identity_security/${BOOKING_REF}/authorizedAuthUids`), false);
  const payload = JSON.stringify(res.body);
  for (const forbidden of ['authorizedAuthUid', 'authorizedAuthUids', 'original-phone', 'another-private-phone']) {
    assert.equal(payload.includes(forbidden), false, forbidden);
  }
});

test('map-only authorization works and retained legacy owner cannot bypass current device authorization', async () => {
  for (const legacyOwner of [undefined, AUTH_UID]) {
    const state = baseState();
    state.passenger_identity_security[BOOKING_REF].authorizedAuthUid = legacyOwner;
    if (!legacyOwner) state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 2;
    state.passenger_identity_security[BOOKING_REF].authorizedAuthUids = legacyOwner
      ? { 'second-phone': true } : { [AUTH_UID]: true };
    const { res } = await runHandler({ state });
    assert.equal(res.statusCode, legacyOwner ? 403 : 200);
    if (!legacyOwner) assert.equal(res.body.parts.booking.status, 'value');
  }
});

test('unknown phones, non-boolean authorization values and locked bookings cannot read a trip', async () => {
  for (const value of [undefined, null, false, 'true', 1, {}]) {
    const state = baseState();
    state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 2;
    // A retained legacy owner must not override removal from the current map.
    state.passenger_identity_security[BOOKING_REF].authorizedAuthUids = { [AUTH_UID]: value };
    const { res } = await runHandler({ state });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, reason: 'SESSION_SCOPE_MISMATCH' });
  }
  const state = baseState();
  state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 2;
  state.passenger_identity_security[BOOKING_REF].authorizedAuthUids = { [AUTH_UID]: true };
  state.passenger_identity_security[BOOKING_REF].loginLocked = true;
  const { res } = await runHandler({ state });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, reason: 'SESSION_SCOPE_MISMATCH' });
  state.passenger_identity_security[BOOKING_REF].loginLocked = false;
  state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 3;
  const unknownVersion = await runHandler({ state });
  assert.equal(unknownVersion.res.statusCode, 403);
});

test('device revocation during a conditional read prevents an unchanged trip response', async () => {
  const first = await runHandler();
  const versions = Object.fromEntries(Object.entries(first.res.body.parts)
    .map(([part, value]) => [part, value.version]));
  const state = baseState();
  state.passenger_identity_security[BOOKING_REF].deviceAuthorizationVersion = 2;
  delete state.passenger_identity_security[BOOKING_REF].authorizedAuthUid;
  state.passenger_identity_security[BOOKING_REF].authorizedAuthUids = { [AUTH_UID]: true };
  const { res } = await runHandler({
    state,
    body: { expectedSessionId: SESSION_ID, parts: ['booking', 'tour', 'itinerary'], versions },
    onRead: (path) => {
      if (path === `tours/${TOUR_ID}/itinerary`) {
        delete state.passenger_identity_security[BOOKING_REF].authorizedAuthUids[AUTH_UID];
      }
    },
  });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, reason: 'SESSION_SCOPE_MISMATCH' });
});

test('withdrawn itinerary has a deterministic absence version', async () => {
  const state = baseState();
  delete state.tours[TOUR_ID].itinerary;
  const { res } = await runHandler({ state, body: {
    expectedSessionId: SESSION_ID,
    parts: ['itinerary'],
    versions: {},
  } });
  assert.deepEqual(res.body.parts.itinerary, {
    status: 'absent',
    version: fingerprintPassengerTripContent(null),
  });
});

test('part read failures are isolated while authority and successful parts remain usable', async () => {
  const state = baseState();
  state.tours[TOUR_ID].startDate = 'not-a-date';
  const { res } = await runHandler({
    state,
    failures: new Set([`tours/${TOUR_ID}/itinerary`]),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.parts.booking.status, 'value');
  assert.deepEqual(res.body.parts.tour, { status: 'unavailable' });
  assert.deepEqual(res.body.parts.itinerary, { status: 'unavailable' });
});

test('mismatched canonical booking association fails the whole response', async () => {
  const state = baseState();
  state.bookings[BOOKING_REF].tourId = 'OTHER_TOUR';
  const { res } = await runHandler({ state });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, reason: 'SESSION_SCOPE_MISMATCH' });
});

test('inactive and replaced sessions use bounded recovery reason codes before source reads', async () => {
  for (const [sessionReason, status, reason] of [
    ['SESSION_INACTIVE', 401, 'SESSION_EXPIRED'],
    ['SESSION_CHANGED', 409, 'SESSION_CHANGED'],
    ['PARTICIPANT_SESSION_MISMATCH', 403, 'SESSION_SCOPE_MISMATCH'],
  ]) {
    const { db, res } = await runHandler({
      verifySession: async () => ({ allowed: false, reason: sessionReason }),
    });
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.body, { success: false, reason });
    assert.deepEqual(db.reads, []);
  }
});

test('a session replacement during the bounded read prevents the old response from committing', async () => {
  let checks = 0;
  const { res } = await runHandler({
    verifySession: async () => {
      checks += 1;
      return checks === 1 ? allowedAccess : { allowed: false, reason: 'SESSION_CHANGED' };
    },
  });
  assert.equal(checks, 2);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, reason: 'SESSION_CHANGED' });
});

test('authentication boundary can stop the request without touching trip sources', async () => {
  const { db, res } = await runHandler({
    authorizeRequest: async ({ res: response }) => {
      response.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
      return null;
    },
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(db.reads, []);
});
