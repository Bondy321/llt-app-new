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
  buildRoleTransitionCleanupUpdates,
} = require('../functions/src/domains/app-sessions/roleTransition');
const {
  issueDriverAppSession,
  issuePassengerAppSession,
} = require('../functions/src/domains/app-sessions/sessionIssuance');
const {
  derivePassengerAccountDeletionKey,
  deriveUidAccountDeletionTombstoneKey,
} = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const {
  buildCutoverUpdates,
  closeAdminApps,
  isParticipantBackedByActiveSession,
  parseArgs: parseMigrationArgs,
} = require('../functions/scripts/migrateAppSessions');

const PASSENGER_ID = `pax_v2_${'a'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'b'.repeat(32)}`;

const chatStatusSource = ({ session, scope = 'group', timestamp, expiresAtMs }) => ({
  schemaVersion: 2,
  authUid: session.authUid,
  appSessionId: session.sessionId,
  actorKey: session.principalId,
  principalId: session.principalId,
  principalType: session.principalType,
  tourId: session.tourId,
  tourActorKey: `${session.tourId}|${session.principalId}`,
  scope,
  name: session.principalType === 'driver' ? 'Driver' : 'Passenger',
  isDriver: session.principalType === 'driver',
  timestamp,
  expiresAtMs,
});

const snapshot = (value) => ({
  val: () => value,
  exists: () => value !== null && value !== undefined,
});

const createTransactionDb = (initial = {}, { rootUpdateError = null } = {}) => {
  const state = { ...initial };
  return {
    state,
    ref(path = '') {
      const query = { child: null, equal: undefined };
      const readValue = () => {
        if (!query.child) return state[path];
        const prefix = path ? `${path}/` : '';
        return Object.fromEntries(Object.entries(state)
          .filter(([key, value]) => key.startsWith(prefix)
            && !key.slice(prefix.length).includes('/')
            && (query.equal === undefined || value?.[query.child] === query.equal))
          .map(([key, value]) => [key.slice(prefix.length), value]));
      };
      const ref = {
        orderByChild(child) { query.child = child; return ref; },
        equalTo(value) { query.equal = value; return ref; },
        async get() { return snapshot(readValue()); },
        async once() { return snapshot(readValue()); },
        async update(updates) {
          if (path === '' && rootUpdateError) throw rootUpdateError;
          Object.entries(updates).forEach(([key, value]) => {
            if (value === null) delete state[key]; else state[key] = value;
          });
        },
        push() { return { key: 'event-role-transition' }; },
        async transaction(updater) {
          const next = updater(state[path] ?? null);
          if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) };
          if (next === null) delete state[path]; else state[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
      return ref;
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

test('policy cleanup is an admitted app-session lock operation', async () => {
  const db = createTransactionDb();
  const lock = await acquireAppSessionLock({
    db,
    authUid: 'uid-policy-cleanup',
    operation: 'policy_cleanup',
    owner: 'policy-cleanup-owner',
    nowMs: 100,
  });
  assert.equal(lock.acquired, true);
  assert.equal(lock.lock.operation, 'policy_cleanup');
  assert.equal(await releaseAppSessionLock({
    db, authUid: 'uid-policy-cleanup', owner: 'policy-cleanup-owner',
  }), true);
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

test('driver access follows policy generation and applies the scalar claim only when enabled', async () => {
  const nowMs = 10_000;
  const session = buildDriverSessionRecord({
    authUid: 'uid-driver-b',
    driverId: 'D-1',
    tourId: 'TOUR_A',
    driverLoginPolicyGeneration: 3,
    sessionId: SESSION_ID,
    nowMs: 1_000,
    expiresAtMs: 20_000,
  });
  const db = createTransactionDb({
    'app_sessions/uid-driver-b': session,
    'users/uid-driver-b': {
      driverId: 'D-1',
      driverPrincipalId: 'driver:D-1',
      driverAssignedTourId: 'TOUR_A',
      principalType: 'driver',
    },
    'drivers/D-1': { authUid: 'uid-driver-a', currentTourId: 'TOUR_A' },
    'tour_manifests/TOUR_A/assigned_drivers/D-1': true,
    'driver_login_policy/v1': {
      schemaVersion: 1,
      enforceSingleDevice: false,
      generation: 3,
      revision: 1,
      updatedAtMs: 9_000,
    },
  });

  assert.equal((await verifyActiveAppSession({
    db, authUid: 'uid-driver-b', expectedTourId: 'TOUR_A', expectedRole: 'driver', nowMs,
  })).allowed, true);

  db.state['driver_login_policy/v1'] = {
    ...db.state['driver_login_policy/v1'],
    enforceSingleDevice: true,
    revision: 2,
  };
  assert.equal((await verifyActiveAppSession({
    db, authUid: 'uid-driver-b', expectedTourId: 'TOUR_A', expectedRole: 'driver', nowMs,
  })).reason, 'DRIVER_PROFILE_MISMATCH');

  db.state['drivers/D-1'] = { authUid: 'uid-driver-b', currentTourId: 'TOUR_A' };
  assert.equal((await verifyActiveAppSession({
    db, authUid: 'uid-driver-b', expectedTourId: 'TOUR_A', expectedRole: 'driver', nowMs,
  })).allowed, true);

  db.state['driver_login_policy/v1'] = {
    ...db.state['driver_login_policy/v1'],
    generation: 4,
    revision: 3,
  };
  assert.equal((await verifyActiveAppSession({
    db, authUid: 'uid-driver-b', expectedTourId: 'TOUR_A', expectedRole: 'driver', nowMs,
  })).reason, 'DRIVER_POLICY_MISMATCH');
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

test('role transition cleanup clears current driver authority without touching durable identities or assignments', () => {
  const passengerUpdates = buildRoleTransitionCleanupUpdates({
    authUid: 'uid-role-transition',
    targetPrincipalType: 'passenger',
  });
  assert.deepEqual(passengerUpdates, {
    'users/uid-role-transition/driverId': null,
    'users/uid-role-transition/driverPrincipalId': null,
    'users/uid-role-transition/driverAssignedTourId': null,
  });
  assert.equal(Object.keys(passengerUpdates).some((key) => key.includes('stablePassenger')), false);
  assert.equal(Object.keys(passengerUpdates).some((key) => key.includes('privatePhotoOwner')), false);
  assert.equal(Object.keys(passengerUpdates).some((key) => key.startsWith('drivers/')), false);
  assert.equal(Object.keys(passengerUpdates).some((key) => key.startsWith('tour_manifests/')), false);

  assert.deepEqual(buildRoleTransitionCleanupUpdates({
    authUid: 'uid-role-transition',
    targetPrincipalType: 'driver',
  }), {});
  assert.throws(() => buildRoleTransitionCleanupUpdates({
    authUid: 'unsafe/uid',
    targetPrincipalType: 'passenger',
  }), /invalid app-session role transition/i);
});

test('passenger issuance commits driver cleanup and durable passenger identity in one root update', async () => {
  const nowMs = 1_800_000_000_000;
  const oldDriverSession = buildDriverSessionRecord({
    authUid: 'uid-role-transition',
    driverId: 'D-ROLE',
    tourId: 'TOUR_OLD',
    sessionId: `sess_v1_${'6'.repeat(32)}`,
    nowMs: nowMs - 1_000,
  });
  const durableProfile = {
    stablePassengerId: PASSENGER_ID,
    stablePassengerKey: PASSENGER_ID,
    privatePhotoOwnerId: PASSENGER_ID,
    privatePhotoOwnerKey: PASSENGER_ID,
    identityVersion: 'pax_v2',
    bookingRef: 'BOOK-ROLE',
    driverId: 'D-ROLE',
    driverPrincipalId: 'driver:D-ROLE',
    driverAssignedTourId: 'TOUR_OLD',
    principalType: 'driver',
  };
  const db = createTransactionDb({
    'app_sessions/uid-role-transition': oldDriverSession,
    'users/uid-role-transition': durableProfile,
  });

  let roleClaimSession = null;
  let roleClaimReplacedSession = null;
  const issued = await issuePassengerAppSession({
    db,
    authUid: 'uid-role-transition',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_NEW',
    identityUpdates: {
      'users/uid-role-transition/stablePassengerId': PASSENGER_ID,
      'users/uid-role-transition/privatePhotoOwnerId': PASSENGER_ID,
    },
    grantUpdates: {},
    buildRoleClaimUpdates: (session, replacedSession) => {
      roleClaimSession = session;
      roleClaimReplacedSession = replacedSession;
      return { 'auth_claim_updates/uid-role-transition': { role: 'passenger', sessionId: session.sessionId } };
    },
    nowMs,
  });

  assert.equal(issued.principalType, 'passenger');
  assert.equal(db.state['users/uid-role-transition/driverId'], undefined);
  assert.equal(db.state['users/uid-role-transition/driverPrincipalId'], undefined);
  assert.equal(db.state['users/uid-role-transition/driverAssignedTourId'], undefined);
  assert.equal(db.state['users/uid-role-transition/stablePassengerId'], PASSENGER_ID);
  assert.equal(db.state['users/uid-role-transition/privatePhotoOwnerId'], PASSENGER_ID);
  assert.equal(db.state['drivers/D-ROLE'], undefined);
  assert.equal(db.state['tour_manifests/TOUR_OLD/assigned_drivers/D-ROLE'], undefined);
  assert.equal(db.state['app_sessions/uid-role-transition'].principalType, 'passenger');
  assert.equal(roleClaimSession.sessionId, issued.sessionId);
  assert.equal(roleClaimReplacedSession.sessionId, oldDriverSession.sessionId);
  assert.equal(roleClaimReplacedSession.driverId, 'D-ROLE');
  assert.equal(db.state['auth_claim_updates/uid-role-transition'].sessionId, issued.sessionId);
});

test('passenger session replacement removes its exact chat leaves before publishing the new session', async () => {
  const nowMs = 1_800_000_010_000;
  const oldSession = buildPassengerSessionRecord({
    authUid: 'uid-chat-replace',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_CHAT',
    sessionId: `sess_v1_${'8'.repeat(32)}`,
    nowMs: nowMs - 1_000,
  });
  const rawPresence = chatStatusSource({
    session: oldSession,
    timestamp: nowMs - 100,
    expiresAtMs: nowMs + 60_000,
  });
  const db = createTransactionDb({
    'app_sessions/uid-chat-replace': oldSession,
    'users/uid-chat-replace': { principalType: 'passenger', stablePassengerId: PASSENGER_ID },
    [`chat_presence_sessions/group/${oldSession.sessionId}`]: rawPresence,
    [`chats/TOUR_CHAT/presence/${PASSENGER_ID}`]: {
      name: 'Passenger', online: true, lastSeen: nowMs - 100,
    },
    [`chats/TOUR_CHAT/typing/${PASSENGER_ID}`]: {
      name: 'Passenger', isTyping: true, timestamp: nowMs - 100,
    },
  });

  const issued = await issuePassengerAppSession({
    db,
    authUid: oldSession.authUid,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_CHAT',
    identityUpdates: {},
    grantUpdates: {},
    nowMs,
  });

  assert.notEqual(issued.sessionId, oldSession.sessionId);
  assert.equal(db.state[`chat_presence_sessions/group/${oldSession.sessionId}`], undefined);
  assert.equal(db.state[`chats/TOUR_CHAT/presence/${PASSENGER_ID}`].online, false);
  assert.equal(db.state[`chats/TOUR_CHAT/typing/${PASSENGER_ID}`].isTyping, false);
  assert.ok(db.state[`chats/TOUR_CHAT/typing/${PASSENGER_ID}`].timestamp <= nowMs - 10_001);
});

test('driver replacement preserves an assignment-owned pickup across app-session lifecycle changes', async () => {
  const nowMs = 1_800_000_020_000;
  const oldSession = buildDriverSessionRecord({
    authUid: 'uid-manual-replace',
    driverId: 'D-MANUAL',
    tourId: 'TOUR_MANUAL',
    sessionId: `sess_v1_${'9'.repeat(32)}`,
    nowMs: nowMs - 1_000,
  });
  const db = createTransactionDb({
    'app_sessions/uid-manual-replace': oldSession,
    'users/uid-manual-replace': { principalType: 'driver', driverId: 'D-MANUAL' },
    'drivers/D-MANUAL': { currentTourId: 'TOUR_MANUAL' },
    'tours/TOUR_MANUAL': { driverId: 'D-MANUAL', driverAssignmentRevision: 4 },
    'tour_manifests/TOUR_MANUAL/assigned_drivers/D-MANUAL': true,
    'driver_location_pickups/TOUR_MANUAL': {
      schemaVersion: 1,
      isSharing: true,
      source: 'manual',
      mode: 'pickup',
      driverId: 'D-MANUAL',
      tourId: 'TOUR_MANUAL',
      assignmentRevision: 4,
      latitude: 55.9,
      longitude: -4.3,
      timestamp: nowMs - 100,
      publishedAtMs: nowMs - 100,
      expiresAtMs: nowMs + 10_000,
    },
    'tours/TOUR_MANUAL/driverLocation': {
      schemaVersion: 1,
      isSharing: true,
      source: 'manual',
      mode: 'pickup',
      latitude: 55.9,
      longitude: -4.3,
      timestamp: nowMs - 100,
    },
  });

  await issuePassengerAppSession({
    db,
    authUid: oldSession.authUid,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_NEW',
    identityUpdates: {},
    grantUpdates: {},
    nowMs,
  });

  assert.equal(db.state['driver_location_pickups/TOUR_MANUAL'].assignmentRevision, 4);
  assert.equal(db.state['tours/TOUR_MANUAL/driverLocation'].isSharing, true);
  assert.equal(db.state['app_sessions/uid-manual-replace'].principalType, 'passenger');
});

test('replacement cleanup failure preserves the old root session and a retry reconciles already-deleted chat leaves', async () => {
  const nowMs = 1_800_000_030_000;
  const oldSession = buildPassengerSessionRecord({
    authUid: 'uid-cleanup-retry',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_RETRY',
    sessionId: `sess_v1_${'a'.repeat(32)}`,
    nowMs: nowMs - 1_000,
  });
  const db = createTransactionDb({
    'app_sessions/uid-cleanup-retry': oldSession,
    'users/uid-cleanup-retry': { principalType: 'passenger', stablePassengerId: PASSENGER_ID },
    [`chat_presence_sessions/group/${oldSession.sessionId}`]: chatStatusSource({
      session: oldSession,
      timestamp: nowMs - 100,
      expiresAtMs: nowMs + 60_000,
    }),
    [`chats/TOUR_RETRY/presence/${PASSENGER_ID}`]: {
      name: 'Passenger', online: true, lastSeen: nowMs - 100,
    },
    [`chat_status_projection_state/group/TOUR_RETRY/${PASSENGER_ID}`]: {
      leaseOwner: 'paused-cleanup',
      leaseRevision: 1,
      leaseExpiresAtMs: nowMs + 30_000,
    },
  });

  const issue = () => issuePassengerAppSession({
    db,
    authUid: oldSession.authUid,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_RETRY',
    identityUpdates: {},
    grantUpdates: {},
    nowMs,
  });
  await assert.rejects(issue(), (error) => error.code === 'CHAT_STATUS_PROJECTION_BUSY');
  assert.equal(db.state['app_sessions/uid-cleanup-retry'].sessionId, oldSession.sessionId);
  assert.equal(db.state[`chat_presence_sessions/group/${oldSession.sessionId}`], undefined);
  assert.equal(db.state[`chats/TOUR_RETRY/presence/${PASSENGER_ID}`].online, true);

  db.state[`chat_status_projection_state/group/TOUR_RETRY/${PASSENGER_ID}`] = { revision: 0 };
  const issued = await issue();
  assert.notEqual(issued.sessionId, oldSession.sessionId);
  assert.equal(db.state[`chats/TOUR_RETRY/presence/${PASSENGER_ID}`].online, false);
});

test('driver issuance preserves durable passenger ownership and a failed atomic update changes no role state', async () => {
  const nowMs = 1_800_000_100_000;
  const passengerSession = buildPassengerSessionRecord({
    authUid: 'uid-role-transition',
    principalId: PASSENGER_ID,
    tourId: 'TOUR_A',
    sessionId: `sess_v1_${'7'.repeat(32)}`,
    nowMs: nowMs - 1_000,
  });
  const durableProfile = {
    stablePassengerId: PASSENGER_ID,
    privatePhotoOwnerId: PASSENGER_ID,
    identityVersion: 'pax_v2',
    bookingRef: 'BOOK-ROLE',
    principalType: 'passenger',
  };
  const db = createTransactionDb({
    'app_sessions/uid-role-transition': passengerSession,
    'users/uid-role-transition': durableProfile,
  });
  await issueDriverAppSession({
    db,
    authUid: 'uid-role-transition',
    driverId: 'D-ROLE',
    tourId: 'TOUR_DRIVER',
    driverLoginPolicyGeneration: 2,
    profileUpdates: {
      'users/uid-role-transition/driverId': 'D-ROLE',
      'users/uid-role-transition/driverPrincipalId': 'driver:D-ROLE',
      'users/uid-role-transition/driverAssignedTourId': 'TOUR_DRIVER',
      'users/uid-role-transition/principalType': 'driver',
    },
    nowMs,
  });
  assert.equal(db.state['users/uid-role-transition'].stablePassengerId, PASSENGER_ID);
  assert.equal(db.state['users/uid-role-transition'].privatePhotoOwnerId, PASSENGER_ID);
  assert.equal(db.state['app_sessions/uid-role-transition'].principalType, 'driver');

  const failedDb = createTransactionDb({
    'app_sessions/uid-role-transition': passengerSession,
    'users/uid-role-transition': durableProfile,
  }, { rootUpdateError: new Error('simulated root update failure') });
  await assert.rejects(issueDriverAppSession({
    db: failedDb,
    authUid: 'uid-role-transition',
    driverId: 'D-ROLE',
    tourId: 'TOUR_DRIVER',
    profileUpdates: { 'users/uid-role-transition/driverId': 'D-ROLE' },
    nowMs,
  }), /simulated root update failure/);
  assert.equal(failedDb.state['app_sessions/uid-role-transition'].principalType, 'passenger');
  assert.equal(failedDb.state['users/uid-role-transition'].principalType, 'passenger');
  assert.equal(failedDb.state['users/uid-role-transition/driverId'], undefined);
});

test('passenger issuance fails closed behind a booking-scoped deletion barrier', async () => {
  const nowMs = 1_800_000_200_000;
  const bookingRef = 'BOOK-DELETING';
  const authUid = 'fresh-anonymous-passenger';
  const db = createTransactionDb({
    [`account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(bookingRef)}`]: {
      schemaVersion: 1, deletionId: `acctdel_v1_${'d'.repeat(64)}`, status: 'pending',
    },
  });
  await assert.rejects(issuePassengerAppSession({
    db,
    authUid,
    principalId: PASSENGER_ID,
    tourId: 'TOUR_BLOCKED',
    bookingRef,
    identityUpdates: { [`identity_bindings/${PASSENGER_ID}/${authUid}`]: true },
    grantUpdates: {},
    nowMs,
    clock: () => nowMs,
  }), (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(db.state[`app_sessions/${authUid}`], undefined);
  assert.equal(db.state[`identity_bindings/${PASSENGER_ID}/${authUid}`], undefined);
});

test('permanent UID tombstone blocks stale deleted-user tokens after completion', async () => {
  const nowMs = 1_800_000_210_000;
  const authUid = 'deleted-auth-uid';
  const db = createTransactionDb({
    [`account_deletion_uid_tombstones/v1/${deriveUidAccountDeletionTombstoneKey(authUid)}`]: {
      schemaVersion: 1, permanent: true, createdAtMs: nowMs - 10_000,
    },
  });
  await assert.rejects(issueDriverAppSession({
    db,
    authUid,
    driverId: 'D-DELETED',
    tourId: null,
    profileUpdates: { [`users/${authUid}/driverId`]: 'D-DELETED' },
    nowMs,
    clock: () => nowMs,
  }), (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(db.state[`app_sessions/${authUid}`], undefined);
  assert.equal(db.state[`users/${authUid}/driverId`], undefined);
});

test('expired issuance owner cannot write after deletion takes over the app-session lock', async () => {
  const nowMs = 1_800_000_220_000;
  const authUid = 'stale-issuer';
  const db = createTransactionDb();
  let clockCalls = 0;
  await assert.rejects(issueDriverAppSession({
    db,
    authUid,
    driverId: 'D-STALE',
    tourId: null,
    profileUpdates: { [`users/${authUid}/driverId`]: 'D-STALE' },
    nowMs,
    clock: () => {
      clockCalls += 1;
      db.state[`app_session_locks/${authUid}`] = {
        owner: 'account-deletion-owner', operation: 'revoke',
        createdAtMs: nowMs + 181_000, expiresAtMs: nowMs + 361_000,
      };
      db.state[`account_deletion_active/v1/${authUid}`] = {
        deletionId: `acctdel_v1_${'e'.repeat(64)}`,
      };
      return nowMs + 181_000;
    },
  }), (error) => error.code === 'SESSION_IN_PROGRESS');
  assert.equal(clockCalls, 1);
  assert.equal(db.state[`app_sessions/${authUid}`], undefined);
  assert.equal(db.state[`users/${authUid}/driverId`], undefined);
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
