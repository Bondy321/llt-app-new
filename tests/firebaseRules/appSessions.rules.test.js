const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-app-session-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const AUTH_UID = 'passenger-session-user';
const OTHER_UID = 'other-session-user';
const DRIVER_UID = 'driver-session-user';
const DRIVER_UID_B = 'driver-session-user-b';
const DRIVER_ID = 'D-SESSION';
const TOUR_ID = 'TOUR_SESSION';
const OTHER_TOUR_ID = 'TOUR_OTHER';
const PRINCIPAL_ID = `pax_v2_${'1'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'2'.repeat(32)}`;
const DRIVER_SESSION_ID = `sess_v1_${'3'.repeat(32)}`;
const DRIVER_SESSION_ID_B = `sess_v1_${'6'.repeat(32)}`;
const TRANSITIONED_PASSENGER_PRINCIPAL_ID = `pax_v2_${'4'.repeat(32)}`;
const TRANSITIONED_PASSENGER_SESSION_ID = `sess_v1_${'5'.repeat(32)}`;
const NOW = Date.now();
const EXPIRES = NOW + (60 * 60 * 1000);

const parseHost = () => {
  const [host, portText] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  return { host, port: Number(portText), databaseURL: `http://${host}:${portText}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
let testEnv;
let dbUrl;
const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const passengerSession = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  authUid: AUTH_UID,
  principalId: PRINCIPAL_ID,
  principalType: 'passenger',
  tourId: TOUR_ID,
  status: 'active',
  issuedAtMs: NOW,
  lastAuthenticatedAtMs: NOW,
  expiresAtMs: EXPIRES,
  sessionRevision: 1,
};

const replaceDriverSessionWithPassenger = async ({ policy = null, assigned = true } = {}) => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    await db.ref().update({
      [`app_sessions/${DRIVER_UID}`]: {
        schemaVersion: 1,
        sessionId: TRANSITIONED_PASSENGER_SESSION_ID,
        authUid: DRIVER_UID,
        principalId: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        principalType: 'passenger',
        tourId: TOUR_ID,
        driverId: null,
        status: 'active',
        issuedAtMs: NOW,
        lastAuthenticatedAtMs: NOW,
        expiresAtMs: EXPIRES,
        sessionRevision: 2,
      },
      [`users/${DRIVER_UID}`]: {
        principalType: 'passenger',
        stablePassengerId: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        stablePassengerKey: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        privatePhotoOwnerId: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        privatePhotoOwnerKey: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        identityVersion: 'pax_v2',
        bookingRef: 'BOOK-TRANSITION',
        // These deliberately model the stale authority left by the pre-fix issuer.
        driverId: DRIVER_ID,
        driverPrincipalId: `driver:${DRIVER_ID}`,
        driverAssignedTourId: TOUR_ID,
      },
      [`tours/${TOUR_ID}/participants/${DRIVER_UID}`]: {
        schemaVersion: 2,
        userId: DRIVER_UID,
        principalId: TRANSITIONED_PASSENGER_PRINCIPAL_ID,
        sessionId: TRANSITIONED_PASSENGER_SESSION_ID,
        sessionExpiresAtMs: EXPIRES,
        joinedAtMs: NOW,
        lastAuthenticatedAtMs: NOW,
      },
      [`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`]: assigned ? true : null,
      'driver_login_policy/v1': policy,
    });
    const rootSnapshot = await db.ref().get();
    assert.equal(rootSnapshot.child(`admin_users/${DRIVER_UID}`).exists(), false);
    assert.equal(rootSnapshot.child(`app_sessions/${DRIVER_UID}/principalType`).val(), 'passenger');
    assert.equal(rootSnapshot.child(`app_sessions/${DRIVER_UID}/driverId`).exists(), false);
  });
};

const policyRecord = ({ enforceSingleDevice, generation }) => ({
  schemaVersion: 1,
  enforceSingleDevice,
  generation,
  revision: 1,
  updatedAtMs: NOW,
});

const buildLocationPayload = ({
  uid = DRIVER_UID,
  appSessionId = DRIVER_SESSION_ID,
  driverId = DRIVER_ID,
  tourId = TOUR_ID,
  liveSharingSessionId = 'live_session_1234',
  manual = false,
  overrides = {},
} = {}) => ({
  schemaVersion: 2,
  isSharing: true,
  mode: manual ? 'pickup' : 'live',
  source: manual ? 'manual' : 'auto',
  latitude: 56.0,
  longitude: -4.5,
  accuracy: 12,
  timestamp: { '.sv': 'timestamp' },
  authUid: uid,
  appSessionId,
  driverId,
  tourId,
  ...(manual ? {} : {
    cleanupAtMs: Date.now() + (30 * 60 * 1000),
    liveSharingSessionId,
  }),
  ...overrides,
});

const buildChatStatusPayload = ({
  uid = AUTH_UID,
  appSessionId = SESSION_ID,
  principalId = PRINCIPAL_ID,
  principalType = 'passenger',
  tourId = TOUR_ID,
  scope = 'group',
  kind = 'presence',
  overrides = {},
} = {}) => ({
  schemaVersion: 2,
  actorKey: principalId,
  appSessionId,
  authUid: uid,
  principalId,
  principalType,
  tourId,
  tourActorKey: `${tourId}|${principalId}`,
  scope,
  name: principalType === 'driver' ? 'Driver' : 'Passenger',
  isDriver: principalType === 'driver',
  timestamp: { '.sv': 'timestamp' },
  expiresAtMs: Date.now() + (kind === 'typing' ? 10_000 : (5 * 60 * 1000)),
  ...overrides,
});

const assertCoreDriverWritesDenied = async () => {
  const db = dbFor(DRIVER_UID);
  const transitionedSession = (await db.ref(`app_sessions/${DRIVER_UID}`).get()).val();
  assert.equal(transitionedSession.principalType, 'passenger');
  assert.equal(transitionedSession.driverId ?? null, null);
  await assertFails(db.ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0,
    longitude: -4.5,
    timestamp: Date.now(),
  }));
  await assertFails(db.ref(`tours/${TOUR_ID}/itinerary`).set({ title: 'Spoofed driver itinerary' }));
  await assertFails(db.ref(`tours/${TOUR_ID}/driver_itinerary`).set('Spoofed driver-only notes'));
};

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
});

test.beforeEach(async () => {
  await testEnv.clearDatabase();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      [`app_sessions/${AUTH_UID}`]: passengerSession,
      [`users/${AUTH_UID}`]: {
        principalType: 'passenger',
        stablePassengerId: PRINCIPAL_ID,
        stablePassengerKey: PRINCIPAL_ID,
        privatePhotoOwnerId: PRINCIPAL_ID,
        privatePhotoOwnerKey: PRINCIPAL_ID,
        identityVersion: 'pax_v2',
        bookingRef: 'BOOK-SESSION',
      },
      [`tours/${TOUR_ID}`]: {
        name: 'Session tour',
        isActive: true,
        participants: {
          [AUTH_UID]: {
            schemaVersion: 2,
            userId: AUTH_UID,
            principalId: PRINCIPAL_ID,
            sessionId: SESSION_ID,
            sessionExpiresAtMs: EXPIRES,
            joinedAtMs: NOW,
            lastAuthenticatedAtMs: NOW,
          },
        },
      },
      [`group_tour_photos/${TOUR_ID}/photo-1`]: {
        userId: PRINCIPAL_ID,
        storagePath: `group_tour_photos/${TOUR_ID}/photo-1.jpg`,
        timestamp: NOW,
      },
      [`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}/private-1`]: {
        userId: PRINCIPAL_ID,
        storagePath: `private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}/private-1.jpg`,
        timestamp: NOW,
      },
      [`users/${DRIVER_UID}`]: {
        principalType: 'driver',
        driverId: DRIVER_ID,
        driverPrincipalId: `driver:${DRIVER_ID}`,
        driverAssignedTourId: TOUR_ID,
      },
      [`users/${DRIVER_UID_B}`]: {
        principalType: 'driver',
        driverId: DRIVER_ID,
        driverPrincipalId: `driver:${DRIVER_ID}`,
        driverAssignedTourId: TOUR_ID,
      },
      [`drivers/${DRIVER_ID}`]: { authUid: DRIVER_UID, currentTourId: TOUR_ID, name: 'Driver' },
      [`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`]: true,
      [`bookings/BOOK-SESSION`]: { tourId: TOUR_ID },
      [`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`]: { status: 'PENDING' },
      [`app_sessions/${DRIVER_UID}`]: {
        schemaVersion: 1,
        sessionId: DRIVER_SESSION_ID,
        authUid: DRIVER_UID,
        principalId: `driver:${DRIVER_ID}`,
        principalType: 'driver',
        tourId: TOUR_ID,
        driverId: DRIVER_ID,
        driverLoginPolicyGeneration: 0,
        status: 'active',
        issuedAtMs: NOW,
        lastAuthenticatedAtMs: NOW,
        expiresAtMs: EXPIRES,
        sessionRevision: 1,
      },
      [`app_sessions/${DRIVER_UID_B}`]: {
        schemaVersion: 1,
        sessionId: DRIVER_SESSION_ID_B,
        authUid: DRIVER_UID_B,
        principalId: `driver:${DRIVER_ID}`,
        principalType: 'driver',
        tourId: TOUR_ID,
        driverId: DRIVER_ID,
        driverLoginPolicyGeneration: 0,
        status: 'active',
        issuedAtMs: NOW,
        lastAuthenticatedAtMs: NOW,
        expiresAtMs: EXPIRES,
        sessionRevision: 1,
      },
      'driver_tour_packs/departure-1': {
        tourId: TOUR_ID,
        expiresAtMs: EXPIRES,
        revision: 1,
      },
      'driver_login_policy/v1': policyRecord({ enforceSingleDevice: false, generation: 0 }),
    });
  });
});

test.after(async () => { if (testEnv) await testEnv.cleanup(); });

test('active passenger session can read tour and photo metadata and write only its raw group-chat state', async () => {
  const db = dbFor(AUTH_UID);
  await assertSucceeds(db.ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(db.ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/itinerary`).get());
  await assertSucceeds(db.ref(`group_tour_photos/${TOUR_ID}`).get());
  await assertSucceeds(db.ref(`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}`).get());
  await assertSucceeds(db.ref(`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`).get());
  await assertFails(db.ref(`chats/${TOUR_ID}/typing/${PRINCIPAL_ID}`).set({ name: 'Passenger', timestamp: NOW }));
  await assertFails(db.ref(`chats/${TOUR_ID}/presence/${PRINCIPAL_ID}`).set({
    name: 'Passenger', lastSeen: NOW, online: true,
  }));
  await assertSucceeds(db.ref(`chat_typing_sessions/group/${SESSION_ID}`).set(
    buildChatStatusPayload({ kind: 'typing' }),
  ));
  await assertSucceeds(db.ref(`chat_presence_sessions/group/${SESSION_ID}`).set(
    buildChatStatusPayload(),
  ));
});

test('the same still-authenticated token loses every sensitive path when its app session is removed', async () => {
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(`app_sessions/${AUTH_UID}`).remove());
  const db = dbFor(AUTH_UID);
  await assertSucceeds(db.ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(db.ref(`tours/${TOUR_ID}`).get());
  await assertFails(db.ref(`group_tour_photos/${TOUR_ID}`).get());
  await assertFails(db.ref(`private_tour_photos/${TOUR_ID}/${PRINCIPAL_ID}`).get());
  await assertFails(db.ref(`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION`).get());
  await assertFails(db.ref(`logs/${AUTH_UID}/session/probe`).set({ message: 'stale' }));
  await assertFails(db.ref(`chats/${TOUR_ID}/typing/${PRINCIPAL_ID}`).set({ name: 'Stale', timestamp: NOW }));
  await assertFails(db.ref(`chats/${TOUR_ID}/presence/${PRINCIPAL_ID}`).set({ name: 'Stale', lastSeen: NOW, online: true }));
  await assertFails(db.ref(`chat_typing_sessions/group/${SESSION_ID}`).set(buildChatStatusPayload({ kind: 'typing' })));
  await assertFails(db.ref(`chat_presence_sessions/group/${SESSION_ID}`).set(buildChatStatusPayload()));
});

test('stale membership and stale assignment alone grant no access', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    await db.ref(`app_sessions/${AUTH_UID}`).remove();
    await db.ref(`app_sessions/${DRIVER_UID}`).remove();
  });
  await assertFails(dbFor(AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
});

test('session records are server-owned, self-readable only, and admin-readable', async () => {
  await assertFails(dbFor(OTHER_UID).ref(`app_sessions/${AUTH_UID}`).get());
  await assertFails(dbFor(AUTH_UID).ref(`app_sessions/${AUTH_UID}/status`).set('active'));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`app_sessions/${AUTH_UID}`).get());
});

test('assigned driver needs the matching active session for operational access', async () => {
  await assertSucceeds(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(`app_sessions/${DRIVER_UID}/expiresAtMs`).set(NOW - 1));
  await assertFails(dbFor(DRIVER_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(DRIVER_UID).ref('driver_tour_packs/departure-1').get());
});

test('a coherently assigned active driver session writes raw location and an unrevised legacy public location', async () => {
  const db = dbFor(DRIVER_UID);
  const liveSharingSessionId = 'live_session_primary';
  await assertSucceeds(db.ref(`driver_location_sessions/${DRIVER_SESSION_ID}|${liveSharingSessionId}`).set(
    buildLocationPayload({ liveSharingSessionId }),
  ));
  await assertFails(db.ref(`driver_location_pickups/${TOUR_ID}`).set(
    buildLocationPayload({ manual: true }),
  ));
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0, longitude: -4.5, timestamp: Date.now(),
  }));
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/itinerary`).set({ title: 'Current driver itinerary' }));
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/driver_itinerary`).set('Current driver notes'));

  const actionPath = `driver_tour_pack_actions/departure-1/${DRIVER_ID}/schemaVersion`;
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(actionPath).set(1));
  await assertSucceeds(db.ref(actionPath).remove());
});

test('explicit cutover rejects 1.0.4 shared location, presence, and typing bridges', async () => {
  const db = dbFor(DRIVER_UID);
  const driverPrincipalId = `driver:${DRIVER_ID}`;
  const legacyLocation = db.ref(`tours/${TOUR_ID}/driverLocation`);
  const legacyPaths = [
    db.ref(`chats/${TOUR_ID}/presence/${driverPrincipalId}`),
    db.ref(`chats/${TOUR_ID}/typing/${driverPrincipalId}`),
    db.ref(`internal_chats/${TOUR_ID}/presence/${driverPrincipalId}`),
    db.ref(`internal_chats/${TOUR_ID}/typing/${driverPrincipalId}`),
  ];

  await assertSucceeds(legacyLocation.set({ latitude: 56, longitude: -4.5, timestamp: Date.now() }));
  await assertSucceeds(legacyPaths[0].set({ name: 'Driver', isDriver: true, lastSeen: NOW, online: true }));
  await assertSucceeds(legacyPaths[1].set({ name: 'Driver', isDriver: true, timestamp: NOW }));
  await assertSucceeds(legacyPaths[2].set({ name: 'Driver', isDriver: true, lastSeen: NOW, online: true }));
  await assertSucceeds(legacyPaths[3].set({ name: 'Driver', isDriver: true, timestamp: NOW }));

  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref('live_state_rollout/v1').set({
    schemaVersion: 1,
    phase: 'cutover',
    revision: 1,
    updatedAtMs: Date.now(),
  }));

  await assertFails(legacyLocation.update({ timestamp: Date.now() }));
  for (const legacyPath of legacyPaths) await assertFails(legacyPath.remove());
});

test('driver-only writes require a materialized policy and an exact session generation claim', async () => {
  const db = dbFor(DRIVER_UID);
  const liveSharingSessionId = 'live_policy_exact';
  const locationPath = `driver_location_sessions/${DRIVER_SESSION_ID}|${liveSharingSessionId}`;
  const chatPath = `chat_presence_sessions/internal/${DRIVER_SESSION_ID}`;
  const actionPath = `driver_tour_pack_actions/departure-1/${DRIVER_ID}/schemaVersion`;
  const locationPayload = () => buildLocationPayload({ liveSharingSessionId });
  const chatPayload = () => buildChatStatusPayload({
    uid: DRIVER_UID,
    appSessionId: DRIVER_SESSION_ID,
    principalId: `driver:${DRIVER_ID}`,
    principalType: 'driver',
    scope: 'internal',
  });
  const assertRepresentativeWritesFail = async () => {
    await assertFails(db.ref(locationPath).set(locationPayload()));
    await assertFails(db.ref(chatPath).set(chatPayload()));
    await assertFails(db.ref(`tours/${TOUR_ID}/itinerary`).set({ title: 'Policy probe' }));
    await assertFails(db.ref(actionPath).set(1));
  };

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref('driver_login_policy/v1').remove()
  ));
  await assertRepresentativeWritesFail();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const adminDb = context.database(dbUrl);
    await adminDb.ref('driver_login_policy/v1').set(policyRecord({ enforceSingleDevice: false, generation: 0 }));
    await adminDb.ref(`app_sessions/${DRIVER_UID}/driverLoginPolicyGeneration`).remove();
  });
  await assertRepresentativeWritesFail();

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`app_sessions/${DRIVER_UID}/driverLoginPolicyGeneration`).set(1)
  ));
  await assertRepresentativeWritesFail();

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref('driver_login_policy/v1').set(
      policyRecord({ enforceSingleDevice: false, generation: 1 }),
    )
  ));
  await assertSucceeds(db.ref(locationPath).set(locationPayload()));
  await assertSucceeds(db.ref(chatPath).set(chatPayload()));
  await assertSucceeds(db.ref(`tours/${TOUR_ID}/itinerary`).set({ title: 'Exact policy generation' }));
  await assertSucceeds(db.ref(actionPath).set(1));
});

test('driver writes pause for an active assignment transition and resume after transitionId clears', async () => {
  const db = dbFor(DRIVER_UID);
  const liveSharingSessionId = 'live_assignment_fence';
  const locationPath = `driver_location_sessions/${DRIVER_SESSION_ID}|${liveSharingSessionId}`;
  const chatPath = `chat_presence_sessions/internal/${DRIVER_SESSION_ID}`;
  const actionPath = `driver_tour_pack_actions/departure-1/${DRIVER_ID}/schemaVersion`;
  const writeRepresentatives = async (assertion) => {
    await assertion(db.ref(locationPath).set(buildLocationPayload({ liveSharingSessionId })));
    await assertion(db.ref(chatPath).set(buildChatStatusPayload({
      uid: DRIVER_UID,
      appSessionId: DRIVER_SESSION_ID,
      principalId: `driver:${DRIVER_ID}`,
      principalType: 'driver',
      scope: 'internal',
    })));
    await assertion(db.ref(`tours/${TOUR_ID}/itinerary`).set({ title: 'Assignment transition probe' }));
    await assertion(db.ref(actionPath).set(1));
  };

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`driver_assignment_active/v1/${DRIVER_ID}`).set({
      transitionId: 'transition-fence-1',
      loginAdmissions: {
        'admission-hash-1': {
          expiresAtMs: EXPIRES,
        },
      },
    })
  ));
  await writeRepresentatives(assertFails);

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`driver_assignment_active/v1/${DRIVER_ID}/transitionId`).remove()
  ));
  await writeRepresentatives(assertSucceeds);
});

test('policy-off multi-device drivers can own separate raw location and chat leaves', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update({
      'driver_login_policy/v1': policyRecord({ enforceSingleDevice: false, generation: 0 }),
      [`app_sessions/${DRIVER_UID}/driverLoginPolicyGeneration`]: 0,
      [`app_sessions/${DRIVER_UID_B}/driverLoginPolicyGeneration`]: 0,
    });
  });

  for (const [uid, appSessionId, liveSharingSessionId] of [
    [DRIVER_UID, DRIVER_SESSION_ID, 'live_multi_device_a'],
    [DRIVER_UID_B, DRIVER_SESSION_ID_B, 'live_multi_device_b'],
  ]) {
    const db = dbFor(uid);
    const principalId = `driver:${DRIVER_ID}`;
    await assertSucceeds(db.ref(`driver_location_sessions/${appSessionId}|${liveSharingSessionId}`).set(
      buildLocationPayload({ uid, appSessionId, liveSharingSessionId }),
    ));
    await assertSucceeds(db.ref(`chat_presence_sessions/internal/${appSessionId}`).set(
      buildChatStatusPayload({
        uid,
        appSessionId,
        principalId,
        principalType: 'driver',
        scope: 'internal',
      }),
    ));
    await assertSucceeds(db.ref(`chat_typing_sessions/group/${appSessionId}`).set(
      buildChatStatusPayload({
        uid,
        appSessionId,
        principalId,
        principalType: 'driver',
        kind: 'typing',
      }),
    ));
  }

  const driverAPresencePath = `chat_presence_sessions/internal/${DRIVER_SESSION_ID}`;
  await assertFails(dbFor(DRIVER_UID_B).ref(driverAPresencePath).remove());
  await assertSucceeds(dbFor(DRIVER_UID).ref(driverAPresencePath).remove());
});

test('raw location writes bind the exact session, driver, tour, key, schema, and owner deletion', async () => {
  const db = dbFor(DRIVER_UID);
  const otherDb = dbFor(DRIVER_UID_B);
  const liveSharingSessionId = 'live_owned_session';
  const sourcePath = `driver_location_sessions/${DRIVER_SESSION_ID}|${liveSharingSessionId}`;

  await assertFails(db.ref(`driver_location_sessions/${DRIVER_SESSION_ID}|wrong_live_key`).set(
    buildLocationPayload({ liveSharingSessionId }),
  ));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ appSessionId: DRIVER_SESSION_ID_B })));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ driverId: 'D-OTHER' })));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ tourId: OTHER_TOUR_ID })));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ overrides: { accuracy: null } })));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ overrides: { accuracy: 10001 } })));
  await assertFails(db.ref(sourcePath).set(buildLocationPayload({ overrides: { extra: true } })));
  await assertFails(dbFor(AUTH_UID).ref(`driver_location_sessions/${SESSION_ID}|${liveSharingSessionId}`).set(
    buildLocationPayload({ uid: AUTH_UID, appSessionId: SESSION_ID, liveSharingSessionId }),
  ));

  await assertSucceeds(db.ref(sourcePath).set(buildLocationPayload({ liveSharingSessionId })));
  await assertFails(otherDb.ref(sourcePath).remove());
  await assertSucceeds(db.ref(sourcePath).remove());

  const pickupPath = `driver_location_pickups/${TOUR_ID}`;
  await assertFails(db.ref(pickupPath).set(buildLocationPayload({ manual: true })));
  await assertFails(otherDb.ref(pickupPath).remove());
  await assertFails(db.ref(`driver_location_pickups/${OTHER_TOUR_ID}`).set(
    buildLocationPayload({ manual: true, tourId: OTHER_TOUR_ID }),
  ));
  await assertFails(db.ref(pickupPath).remove());
});

test('canonical pickup projection is server-owned for every handset', async () => {
  const pickupPath = `driver_location_pickups/${TOUR_ID}`;
  const driverA = dbFor(DRIVER_UID);
  const driverB = dbFor(DRIVER_UID_B);

  await assertFails(driverA.ref(pickupPath).set(buildLocationPayload({ manual: true })));
  await assertFails(driverB.ref(pickupPath).set(buildLocationPayload({
    uid: DRIVER_UID_B,
    appSessionId: DRIVER_SESSION_ID_B,
    manual: true,
  })));
  await assertFails(driverA.ref(pickupPath).remove());
  await assertFails(driverB.ref(pickupPath).remove());
});

test('raw chat status writes bind exact group ownership and deny malformed or internal passenger state', async () => {
  const db = dbFor(AUTH_UID);
  const presencePath = `chat_presence_sessions/group/${SESSION_ID}`;
  const typingPath = `chat_typing_sessions/group/${SESSION_ID}`;

  await assertFails(db.ref(`chat_presence_sessions/internal/${SESSION_ID}`).set(
    buildChatStatusPayload({ scope: 'internal' }),
  ));
  await assertFails(db.ref(presencePath).set(buildChatStatusPayload({ appSessionId: DRIVER_SESSION_ID })));
  await assertFails(db.ref(presencePath).set(buildChatStatusPayload({ principalId: 'pax_v2_wrong' })));
  await assertFails(db.ref(presencePath).set(buildChatStatusPayload({ tourId: OTHER_TOUR_ID })));
  await assertFails(db.ref(presencePath).set(buildChatStatusPayload({ overrides: { isDriver: true } })));
  await assertFails(db.ref(presencePath).set(buildChatStatusPayload({ overrides: { extra: true } })));
  await assertFails(db.ref(typingPath).set(buildChatStatusPayload({
    kind: 'typing',
    overrides: { expiresAtMs: Date.now() + 120_000 },
  })));

  await assertSucceeds(db.ref(presencePath).set(buildChatStatusPayload()));
  await assertFails(dbFor(OTHER_UID).ref(presencePath).remove());
  await assertSucceeds(db.ref(presencePath).remove());
  await assertSucceeds(db.ref(typingPath).set(buildChatStatusPayload({ kind: 'typing' })));
  await assertSucceeds(db.ref(typingPath).remove());
});

test('public projections and server projection-state roots reject every client writer', async () => {
  const privateCoordinationPaths = [
    `app_session_role_claim_jobs/v1/${DRIVER_UID}`,
    `driver_login_claim_reservations/${DRIVER_ID}`,
    `driver_assignment_locks/drivers/${DRIVER_ID}`,
    'driver_assignment_idempotency/v1/actor-hash/idempotency-hash',
    'driver_assignment_transitions/v1/transition-id',
    'driver_assignment_transition_queue/v1/transition-id',
    `driver_assignment_active/v1/${DRIVER_ID}`,
    'driver_assignment_retention/v1/retention-id',
  ];
  for (const db of [dbFor(AUTH_UID), dbFor(DRIVER_UID), dbFor(ADMIN_UID)]) {
    await assertFails(db.ref(`tours/${TOUR_ID}/driverLocation`).set({ latitude: 56, longitude: -4 }));
    await assertFails(db.ref(`chats/${TOUR_ID}/presence/${PRINCIPAL_ID}`).set({ online: true }));
    await assertFails(db.ref(`chats/${TOUR_ID}/typing/${PRINCIPAL_ID}`).set({ name: 'Direct' }));
    await assertFails(db.ref(`internal_chats/${TOUR_ID}/presence/driver:${DRIVER_ID}`).set({ online: true }));
    await assertFails(db.ref(`internal_chats/${TOUR_ID}/typing/driver:${DRIVER_ID}`).set({ name: 'Direct' }));
    await assertFails(db.ref(`driver_location_projection_state/${TOUR_ID}`).set({ revision: 1 }));
    await assertFails(db.ref(`chat_status_projection_state/group/${TOUR_ID}/${PRINCIPAL_ID}`).set({ revision: 1 }));
    for (const privatePath of privateCoordinationPaths) {
      await assertFails(db.ref(privatePath).set({ probe: true }));
    }
  }
});

for (const scenario of [
  { name: 'missing policy', policy: null, assigned: true },
  { name: 'policy off at generation zero', policy: policyRecord({ enforceSingleDevice: false, generation: 0 }), assigned: true },
  { name: 'policy off after a non-zero generation', policy: policyRecord({ enforceSingleDevice: false, generation: 3 }), assigned: true },
  { name: 'policy on at generation zero', policy: policyRecord({ enforceSingleDevice: true, generation: 0 }), assigned: true },
  { name: 'policy on after a non-zero generation', policy: policyRecord({ enforceSingleDevice: true, generation: 3 }), assigned: true },
  { name: 'stale manifest assignment', policy: null, assigned: false },
]) {
  test(`driver-to-passenger transition denies core driver writes with ${scenario.name}`, async () => {
    await replaceDriverSessionWithPassenger(scenario);
    await assertCoreDriverWritesDenied();
  });
}

test('driver-to-passenger transition denies delete holes and driver-attributed writes', async () => {
  await replaceDriverSessionWithPassenger();
  const db = dbFor(DRIVER_UID);

  await assertFails(db.ref(`drivers/${DRIVER_ID}/authUid`).remove());
  await assertFails(db.ref(`drivers/${DRIVER_ID}/lastActive`).set(NOW));
  await assertFails(db.ref(`tour_manifests/${TOUR_ID}/bookings/BOOK-SESSION/status`).set('BOARDED'));

  const reportId = 'transitioned-driver-report';
  await assertFails(db.ref(`content_reports/${reportId}`).set({
    schemaVersion: 1,
    reportId,
    tourId: TOUR_ID,
    contentType: 'chat_message',
    contentId: 'driver-message',
    chatScope: 'internal',
    reason: 'privacy_or_safety',
    status: 'open',
    reporterId: `driver:${DRIVER_ID}`,
    reporterAuthUid: DRIVER_UID,
    createdAt: '2026-08-28T11:00:00.000Z',
    createdAtMs: NOW,
    updatedAt: '2026-08-28T11:00:00.000Z',
    updatedAtMs: NOW,
  }));

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`tour_notifications/${TOUR_ID}/role-transition-notice`).set({ probe: true })
  ));
  await assertFails(db.ref(
    `notification_read_state/${TOUR_ID}/driver:${DRIVER_ID}/role-transition-notice`,
  ).set(NOW));

  const actionPath = `driver_tour_pack_actions/departure-1/${DRIVER_ID}/schemaVersion`;
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(actionPath).set(1));
  await assertFails(db.ref(actionPath).remove());

  const messagePath = `internal_chats/${TOUR_ID}/messages/driver-message`;
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(messagePath).set({
    senderId: `driver:${DRIVER_ID}`,
    senderStableId: `driver:${DRIVER_ID}`,
    senderName: 'Driver',
    text: 'Existing internal message',
    timestamp: NOW,
    isDriver: true,
    status: 'sent',
  }));
  await assertFails(db.ref(messagePath).remove());

  await assertFails(db.ref(`chats/${TOUR_ID}/messages/spoofed-driver-message`).set({
    senderId: `driver:${DRIVER_ID}`,
    senderStableId: `driver:${DRIVER_ID}`,
    senderName: 'Driver',
    text: 'Spoofed driver message',
    timestamp: Date.now(),
    isDriver: true,
    status: 'sent',
  }));

  const photoPath = `group_tour_photos/${TOUR_ID}/driver-photo`;
  await testEnv.withSecurityRulesDisabled((context) => context.database(dbUrl).ref(photoPath).set({
    userId: `driver:${DRIVER_ID}`,
    storagePath: `group_tour_photos/${TOUR_ID}/driver-photo.jpg`,
    caption: 'Original',
    timestamp: NOW,
  }));
  await assertFails(db.ref(`${photoPath}/caption`).set('Spoofed edit'));
});
