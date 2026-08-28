const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { toRealtimeKeySegment } = require('../../services/identityService');
const { passengerAuthorityUpdates, driverAuthorityUpdates } = require('./sessionFixtures');

const PROJECT_ID = 'demo-llt-account-deletion-rules';
const TOUR_ID = 'TOUR_DELETE_001';
const PASSENGER_AUTH_UID = 'passenger-delete-auth-1';
const PASSENGER_STABLE_ID = 'pax_v2_66666666666666666666666666666666';
const PASSENGER_STABLE_KEY = toRealtimeKeySegment(PASSENGER_STABLE_ID);
const DRIVER_AUTH_UID = 'driver-delete-auth-1';
const SECOND_DRIVER_AUTH_UID = 'driver-delete-auth-2';
const DRIVER_ID = 'D-REVIEW';
const DRIVER_PRINCIPAL_ID = `driver:${DRIVER_ID}`;
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const DELEGATED_ADMIN_UID = 'delegated-delete-admin';

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const compareDeleteOwnedScalar = async (scalarRef, deletingUid) => {
  const initial = await scalarRef.once('value');
  if (initial.val() !== deletingUid) return { committed: false, skipped: true };

  let initialLocalPass = true;
  return scalarRef.transaction((current) => {
    if (initialLocalPass && current === null) {
      initialLocalPass = false;
      return null;
    }
    initialLocalPass = false;
    return current === deletingUid ? null : undefined;
  });
};

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: emulator.host,
      port: emulator.port,
      rules,
    },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);

    await db.ref(`users/${PASSENGER_AUTH_UID}`).set({
      stablePassengerId: PASSENGER_STABLE_ID,
      stablePassengerKey: PASSENGER_STABLE_KEY,
      privatePhotoOwnerId: PASSENGER_STABLE_ID,
      privatePhotoOwnerKey: PASSENGER_STABLE_KEY,
      principalType: 'passenger',
    });
    await db.ref(`identity_bindings/${PASSENGER_STABLE_KEY}/${PASSENGER_AUTH_UID}`).set(true);
    await db.ref(`passenger_identity_security/T123456`).set({
      passengerPrincipalId: PASSENGER_STABLE_ID,
      passengerIdentityVersion: 'pax_v2',
      authorizedAuthUid: PASSENGER_AUTH_UID,
    });
    await db.ref(`tours/${TOUR_ID}/participants/${PASSENGER_AUTH_UID}`).set({
      userId: PASSENGER_AUTH_UID,
      joinedAt: 1710000000000,
    });
    await db.ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`).set({
      userId: PASSENGER_AUTH_UID,
      isSharing: true,
      lastUpdate: '2026-06-05T08:00:00.000Z',
      coords: { latitude: 56.1, longitude: -4.6 },
    });
    await db.ref(`logs/${PASSENGER_AUTH_UID}/session_1/log_1`).set({
      level: 'ERROR',
      message: 'review cleanup log',
    });
    await db.ref(`chats/${TOUR_ID}/messages/passenger-owned`).set({
      senderId: PASSENGER_STABLE_KEY,
      senderStableId: PASSENGER_STABLE_KEY,
      senderName: 'Passenger',
      text: 'please remove me',
      timestamp: 1710000000001,
      isDriver: false,
      status: 'sent',
      imageUrl: 'https://example.com/source.jpg',
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });
    await db.ref(`chats/${TOUR_ID}/messages/passenger-reacted`).set({
      senderId: 'other-user',
      senderStableId: 'other-user',
      senderName: 'Other Passenger',
      text: 'keep this',
      timestamp: 1710000000002,
      isDriver: false,
      status: 'sent',
      reactions: {
        wave: {
          [PASSENGER_STABLE_KEY]: true,
        },
      },
    });

    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Review Driver',
      authUid: DRIVER_AUTH_UID,
      currentTourId: TOUR_ID,
    });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({
      driverId: DRIVER_ID,
      driverPrincipalId: DRIVER_PRINCIPAL_ID,
      driverAssignedTourId: TOUR_ID,
      principalType: 'driver',
    });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`tours/${TOUR_ID}/driverLocation`).set({
      latitude: 56.1,
      longitude: -4.6,
      timestamp: 1710000000003,
    });
    await db.ref(`internal_chats/${TOUR_ID}/messages/driver-owned`).set({
      senderId: DRIVER_PRINCIPAL_ID,
      senderStableId: DRIVER_PRINCIPAL_ID,
      senderName: 'Review Driver',
      text: 'driver note',
      timestamp: 1710000000004,
      isDriver: true,
      status: 'sent',
    });
    await db.ref(`admin_users/${DELEGATED_ADMIN_UID}`).set(true);
    await db.ref('operations_terminal_warnings/v1/warning-test').set({
      schemaVersion: 1,
      warningId: 'warning-test',
      jobType: 'passenger_role_claim',
      reason: 'expired_after_repeated_failure',
      identifierHashes: { authUidHash: 'a'.repeat(64) },
      attemptCount: 3,
      firstAttemptAtMs: 1787900000000,
      lastAttemptAtMs: 1787900100000,
      expiresAtMs: 1787900200000,
      createdAtMs: 1787900200000,
      status: 'open',
      retainUntilMs: 1790492200000,
    });
    await db.ref().update({
      ...passengerAuthorityUpdates({
        uid: PASSENGER_AUTH_UID, tourId: TOUR_ID, principalId: PASSENGER_STABLE_ID, bookingRef: 'T123456',
      }),
      ...driverAuthorityUpdates({ uid: DRIVER_AUTH_UID, driverId: DRIVER_ID, tourId: TOUR_ID }),
      ...driverAuthorityUpdates({ uid: SECOND_DRIVER_AUTH_UID, driverId: DRIVER_ID, tourId: TOUR_ID }),
      [`drivers/${DRIVER_ID}/authUid`]: DRIVER_AUTH_UID,
      [`logs/${SECOND_DRIVER_AUTH_UID}/session_1/log_1`]: {
        level: 'INFO',
        message: 'secondary handset cleanup log',
      },
    });
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows passenger account deletion cleanup update shape', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref().update({
    [`users/${PASSENGER_AUTH_UID}`]: null,
    [`logs/${PASSENGER_AUTH_UID}`]: null,
    [`identity_bindings/${PASSENGER_STABLE_KEY}/${PASSENGER_AUTH_UID}`]: null,
    'passenger_identity_security/T123456/authorizedAuthUid': null,
    [`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`]: null,
    [`chats/${TOUR_ID}/messages/passenger-owned/deleted`]: true,
    [`chats/${TOUR_ID}/messages/passenger-owned/text`]: '',
    [`chats/${TOUR_ID}/messages/passenger-owned/deletedAt`]: '2026-06-05T08:01:00.000Z',
    [`chats/${TOUR_ID}/messages/passenger-owned/deletedBy`]: PASSENGER_AUTH_UID,
    [`chats/${TOUR_ID}/messages/passenger-reacted/reactions/wave/${PASSENGER_STABLE_KEY}`]: null,
  }));
});

test('policy-off scalar owner compare-deletes only its own claim before safe account cleanup', async () => {
  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`drivers/${DRIVER_ID}/authUid`).set(DRIVER_AUTH_UID)
  ));
  const ownerDb = dbFor(DRIVER_AUTH_UID);
  const ownerClaimRef = ownerDb.ref(`drivers/${DRIVER_ID}/authUid`);
  const result = await assertSucceeds(compareDeleteOwnedScalar(ownerClaimRef, DRIVER_AUTH_UID));
  assert.equal(result.committed, true);

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref().update({
    [`users/${DRIVER_AUTH_UID}`]: null,
    [`logs/${DRIVER_AUTH_UID}`]: null,
    [`tours/${TOUR_ID}/liveTracking/${DRIVER_AUTH_UID}`]: null,
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    assert.equal((await db.ref(`drivers/${DRIVER_ID}/authUid`).get()).exists(), false);
    assert.equal((await db.ref(`internal_chats/${TOUR_ID}/messages/driver-owned`).get()).exists(), true);
    assert.equal((await db.ref(`tours/${TOUR_ID}/driverLocation`).get()).exists(), true);
  });
});

test('policy-off non-owner deletion preserves another handset scalar and shared driver content', async () => {
  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`drivers/${DRIVER_ID}/authUid`).set(DRIVER_AUTH_UID)
  ));
  const secondaryDb = dbFor(SECOND_DRIVER_AUTH_UID);
  const secondaryClaimRef = secondaryDb.ref(`drivers/${DRIVER_ID}/authUid`);
  await assertFails(secondaryClaimRef.remove());

  const result = await assertSucceeds(compareDeleteOwnedScalar(secondaryClaimRef, SECOND_DRIVER_AUTH_UID));
  assert.equal(result.committed, false);

  await assertSucceeds(secondaryDb.ref().update({
    [`users/${SECOND_DRIVER_AUTH_UID}`]: null,
    [`logs/${SECOND_DRIVER_AUTH_UID}`]: null,
    [`tours/${TOUR_ID}/liveTracking/${SECOND_DRIVER_AUTH_UID}`]: null,
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(dbUrl);
    assert.equal((await db.ref(`drivers/${DRIVER_ID}/authUid`).get()).val(), DRIVER_AUTH_UID);
    assert.equal((await db.ref(`internal_chats/${TOUR_ID}/messages/driver-owned`).get()).exists(), true);
    assert.equal((await db.ref(`tours/${TOUR_ID}/driverLocation`).get()).exists(), true);
  });
});

test('terminal warnings are operations-readable and client-write denied', async () => {
  const warningPath = 'operations_terminal_warnings/v1/warning-test';
  await assertSucceeds(dbFor(ADMIN_UID).ref(warningPath).get());
  await assertSucceeds(dbFor(DELEGATED_ADMIN_UID).ref(warningPath).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(warningPath).get());
  await assertFails(dbFor(ADMIN_UID).ref(`${warningPath}/status`).set('acknowledged'));
  await assertFails(dbFor(DELEGATED_ADMIN_UID).ref(warningPath).remove());
});
