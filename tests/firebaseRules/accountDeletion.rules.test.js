const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { toRealtimeKeySegment } = require('../../services/identityService');

const PROJECT_ID = 'demo-llt-account-deletion-rules';
const TOUR_ID = 'TOUR_DELETE_001';
const PASSENGER_AUTH_UID = 'passenger-delete-auth-1';
const PASSENGER_STABLE_ID = 'pax_v1:BOOKING123:reviewer@example.com';
const PASSENGER_STABLE_KEY = toRealtimeKeySegment(PASSENGER_STABLE_ID);
const DRIVER_AUTH_UID = 'driver-delete-auth-1';
const DRIVER_ID = 'D-REVIEW';
const DRIVER_PRINCIPAL_ID = `driver:${DRIVER_ID}`;

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
    [`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`]: null,
    [`chats/${TOUR_ID}/messages/passenger-owned/deleted`]: true,
    [`chats/${TOUR_ID}/messages/passenger-owned/text`]: '',
    [`chats/${TOUR_ID}/messages/passenger-owned/deletedAt`]: '2026-06-05T08:01:00.000Z',
    [`chats/${TOUR_ID}/messages/passenger-owned/deletedBy`]: PASSENGER_AUTH_UID,
    [`chats/${TOUR_ID}/messages/passenger-reacted/reactions/wave/${PASSENGER_STABLE_KEY}`]: null,
  }));
});

test('allows driver account deletion cleanup update shape', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref().update({
    [`users/${DRIVER_AUTH_UID}`]: null,
    [`logs/${DRIVER_AUTH_UID}`]: null,
    [`drivers/${DRIVER_ID}/authUid`]: null,
    [`tours/${TOUR_ID}/liveTracking/${DRIVER_AUTH_UID}`]: null,
    [`tours/${TOUR_ID}/driverLocation`]: null,
    [`identity_bindings/${DRIVER_ID}/${DRIVER_AUTH_UID}`]: null,
    [`internal_chats/${TOUR_ID}/messages/driver-owned`]: null,
  }));
});
