'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
  calculateSessionExpiry,
  createAppSessionId,
  isActiveSessionRecord,
} = require('../functions/lib/appSession');
const { acquireAppSessionLock, releaseAppSessionLock } = require('../functions/lib/appSessionLock');
const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
const { buildAppSessionCleanupUpdates, cleanupAppSession } = require('../functions/lib/appSessionCleanup');
const {
  buildCutoverUpdates,
  closeAdminApps,
  isParticipantBackedByActiveSession,
  parseArgs: parseMigrationArgs,
} = require('../functions/scripts/migrateAppSessions');

const PASSENGER_ID = `pax_v2_${'a'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'b'.repeat(32)}`;

const snapshot = (value) => ({
  val: () => value,
  exists: () => value !== null && value !== undefined,
});

const createTransactionDb = (initial = {}) => {
  const state = { ...initial };
  return {
    state,
    ref(path = '') {
      return {
        async once() { return snapshot(state[path]); },
        async update(updates) {
          Object.entries(updates).forEach(([key, value]) => {
            if (value === null) delete state[key]; else state[key] = value;
          });
        },
        async transaction(updater) {
          const next = updater(state[path] ?? null);
          if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) };
          if (next === null) delete state[path]; else state[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
};

test('passenger sessions are opaque, bounded, credential-free and bind schema-v2 membership', () => {
  const nowMs = 1_800_000_000_000;
  const session = buildPassengerSessionRecord({
    authUid: 'uid-passenger',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_A',
    sessionId: SESSION_ID,
    nowMs,
  });
  assert.equal(isActiveSessionRecord(session, { nowMs }), true);
  assert.match(session.sessionId, /^sess_v1_[a-f0-9]{32}$/);
  assert.equal(session.expiresAtMs, nowMs + (12 * 60 * 60 * 1000));
  assert.equal(JSON.stringify(session).includes('booking'), false);
  assert.equal(JSON.stringify(session).includes('email'), false);
  assert.deepEqual(buildPassengerParticipantRecord({ session }), {
    schemaVersion: 2,
    userId: 'uid-passenger',
    principalId: PASSENGER_ID,
    sessionId: SESSION_ID,
    sessionExpiresAtMs: session.expiresAtMs,
    joinedAtMs: nowMs,
    lastAuthenticatedAtMs: nowMs,
  });
});

test('driver sessions cover assigned and bounded unassigned states with revision validation', () => {
  const nowMs = 1_800_000_000_000;
  const assigned = buildDriverSessionRecord({
    authUid: 'uid-driver', driverId: 'D-1', tourId: 'TOUR_A', sessionId: SESSION_ID, nowMs,
  });
  const unassigned = buildDriverSessionRecord({
    authUid: 'uid-driver', driverId: 'D-1', tourId: null,
    sessionId: `sess_v1_${'c'.repeat(32)}`, nowMs,
  });
  assert.equal(assigned.principalId, 'driver:D-1');
  assert.equal(assigned.expiresAtMs, nowMs + (12 * 60 * 60 * 1000));
  assert.equal(unassigned.expiresAtMs, nowMs + (60 * 60 * 1000));
  assert.equal(isActiveSessionRecord({ ...assigned, sessionRevision: 0 }, { nowMs }), false);
  assert.throws(() => buildDriverSessionRecord({
    authUid: 'uid-driver', driverId: 'D/unsafe', tourId: null, sessionId: SESSION_ID, nowMs,
  }), /driver principal/i);
  assert.throws(() => buildPassengerSessionRecord({
    authUid: 'uid-passenger', principalId: 'booking@example.test', tourId: 'TOUR_A', sessionId: SESSION_ID, nowMs,
  }), /passenger principal/i);
});

test('session IDs have the required entropy-shaped opaque format and expiry is capped', () => {
  const ids = new Set(Array.from({ length: 100 }, () => createAppSessionId()));
  assert.equal(ids.size, 100);
  [...ids].forEach((id) => assert.match(id, /^sess_v1_[a-f0-9]{32}$/));
  assert.equal(calculateSessionExpiry({
    principalType: 'passenger', tourId: 'TOUR_A', nowMs: 100, ttlMs: 99 * 24 * 60 * 60 * 1000,
  }), 100 + (24 * 60 * 60 * 1000));
});

test('per-UID lock serialises contenders, recovers expiry and releases only for its owner', async () => {
  const db = createTransactionDb();
  const first = await acquireAppSessionLock({ db, authUid: 'uid-1', operation: 'issue', owner: 'owner-a', nowMs: 100 });
  assert.equal(first.acquired, true);
  assert.equal((await acquireAppSessionLock({
    db, authUid: 'uid-1', operation: 'end', owner: 'owner-b', nowMs: 101,
  })).acquired, false);
  assert.equal(await releaseAppSessionLock({ db, authUid: 'uid-1', owner: 'owner-b' }), false);
  assert.equal((await acquireAppSessionLock({
    db, authUid: 'uid-1', operation: 'cleanup', owner: 'owner-c', nowMs: 31_000,
  })).acquired, true);
  assert.equal(await releaseAppSessionLock({ db, authUid: 'uid-1', owner: 'owner-c' }), true);
});

test('active access requires the matching live session and schema-v2 participant', async () => {
  const nowMs = 1_000;
  const session = buildPassengerSessionRecord({
    authUid: 'uid-p', principalId: PASSENGER_ID, tourId: 'TOUR_A', sessionId: SESSION_ID,
    nowMs, expiresAtMs: 20_000,
  });
  const participant = buildPassengerParticipantRecord({ session });
  const db = createTransactionDb({
    'app_sessions/uid-p': session,
    'tours/TOUR_A/participants/uid-p': participant,
    'users/uid-p': { principalType: 'passenger', stablePassengerId: PASSENGER_ID, identityVersion: 'pax_v2' },
  });
  assert.equal((await verifyActiveAppSession({ db, authUid: 'uid-p', expectedTourId: 'TOUR_A', nowMs })).allowed, true);
  delete db.state['app_sessions/uid-p'];
  assert.equal((await verifyActiveAppSession({ db, authUid: 'uid-p', expectedTourId: 'TOUR_A', nowMs })).reason, 'SESSION_INACTIVE');
  db.state['app_sessions/uid-p'] = { ...session, expiresAtMs: 999 };
  assert.equal((await verifyActiveAppSession({ db, authUid: 'uid-p', expectedTourId: 'TOUR_A', nowMs })).reason, 'SESSION_INACTIVE');
});

test('cleanup removes only ephemeral authority and rejects a changed session', async () => {
  const session = buildPassengerSessionRecord({
    authUid: 'uid-p', principalId: PASSENGER_ID, tourId: 'TOUR_A', sessionId: SESSION_ID,
    nowMs: 1_000, expiresAtMs: 20_000,
  });
  const updates = buildAppSessionCleanupUpdates({
    session,
    userProfile: { bookingRef: 'BOOK-1', stablePassengerId: PASSENGER_ID },
    nowMs: 2_000,
  });
  assert.equal(updates['app_sessions/uid-p'], null);
  assert.equal(updates['tours/TOUR_A/participants/uid-p'], null);
  assert.equal(updates['tour_access_grants/TOUR_A/uid-p'], null);
  assert.equal(updates['booking_access_grants/BOOK-1/uid-p'], null);
  assert.equal(Object.keys(updates).some((key) => key.includes('passenger_identity_security')), false);
  assert.equal(Object.keys(updates).some((key) => key.includes('identity_bindings')), false);

  const db = createTransactionDb({
    'app_sessions/uid-p': session,
    'users/uid-p': { bookingRef: 'BOOK-1', stablePassengerId: PASSENGER_ID },
  });
  await assert.rejects(cleanupAppSession({
    db, session, expectedSessionId: `sess_v1_${'d'.repeat(32)}`,
  }), (error) => error.code === 'SESSION_CHANGED');
  assert.ok(db.state['app_sessions/uid-p']);
});

test('cutover migration is dry-run-first, bounded and never synthesises trusted sessions', () => {
  const options = parseMigrationArgs([]);
  assert.equal(options.apply, false);
  assert.equal(options.limit, 25);
  const updates = buildCutoverUpdates({
    staleParticipantRows: [{ tourId: 'TOUR_A', authUid: 'uid-p' }],
    tourGrantRows: [{ tourId: 'TOUR_A', authUid: 'uid-p' }],
    bookingGrantRows: [{ bookingRef: 'BOOK-1', authUid: 'uid-p' }],
    pushTokenUidsToDeactivate: ['uid-p'],
  });
  assert.equal(updates['tours/TOUR_A/participants/uid-p'], null);
  assert.equal(updates['users/uid-p/pushTokenStatus'], 'UNAVAILABLE');
  assert.equal(Object.keys(updates).some((key) => key.startsWith('app_sessions/')), false);
});

test('cutover preserves a participant and push token backed by a current exact session', () => {
  const nowMs = 10_000;
  const session = buildPassengerSessionRecord({
    authUid: 'uid-current',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_CURRENT',
    sessionId: SESSION_ID,
    nowMs: 1_000,
    expiresAtMs: 20_000,
  });
  const participant = buildPassengerParticipantRecord({ session });
  assert.equal(isParticipantBackedByActiveSession({
    tourId: 'TOUR_CURRENT', authUid: 'uid-current', record: participant,
  }, { 'uid-current': session }, nowMs), true);
  assert.equal(isParticipantBackedByActiveSession({
    tourId: 'OTHER_TOUR', authUid: 'uid-current', record: participant,
  }, { 'uid-current': session }, nowMs), false);

  const updates = buildCutoverUpdates({
    staleParticipantRows: [],
    tourGrantRows: [],
    bookingGrantRows: [],
    pushTokenUidsToDeactivate: [],
  });
  assert.deepEqual(updates, {});
});

test('cutover migration closes every Firebase Admin app so CLI runs terminate', async () => {
  const closed = [];
  await closeAdminApps({
    apps: [
      { delete: async () => { closed.push('first'); } },
      null,
      { delete: async () => { closed.push('second'); } },
    ],
  });
  assert.deepEqual(closed.sort(), ['first', 'second']);
});
