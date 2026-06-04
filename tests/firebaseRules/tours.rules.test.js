const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-tour-rules';
const TOUR_ID = '5203L_22';
const PASSENGER_AUTH_UID = 'passenger-auth-1';
const OTHER_PASSENGER_AUTH_UID = 'passenger-auth-2';
const UNATTACHED_AUTH_UID = 'passenger-auth-unattached';
const DRIVER_ID = 'D-DPALMER';
const DRIVER_AUTH_UID = 'driver-auth-1';
const OTHER_DRIVER_ID = 'D-OTHER';
const OTHER_DRIVER_AUTH_UID = 'driver-auth-2';
const grantPayload = (uid) => ({
  source: 'verifyPassengerLogin',
  bookingRef: `BOOKING-${uid}`,
  tourId: TOUR_ID,
  tourCode: '5203L 22',
  grantedAt: new Date().toISOString(),
  grantedAtMs: Date.now(),
  expiresAtMs: Date.now() + (30 * 60 * 1000),
});

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
    await db.ref(`tours/${TOUR_ID}`).set({
      name: 'Highlands',
      isActive: true,
      maxParticipants: 50,
      currentParticipants: 1,
      participants: {
        [PASSENGER_AUTH_UID]: {
          userId: PASSENGER_AUTH_UID,
          joinedAt: '2026-05-23T19:40:00.000Z',
        },
      },
    });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Palmer',
      authUid: DRIVER_AUTH_UID,
      currentTourId: TOUR_ID,
    });
    await db.ref(`drivers/${OTHER_DRIVER_ID}`).set({
      name: 'Other Driver',
      authUid: OTHER_DRIVER_AUTH_UID,
      currentTourId: 'OTHER_TOUR',
    });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({
      driverId: DRIVER_ID,
      driverPrincipalId: `driver:${DRIVER_ID}`,
      driverAssignedTourId: TOUR_ID,
      principalType: 'driver',
    });
    await db.ref(`users/${OTHER_DRIVER_AUTH_UID}`).set({
      driverId: OTHER_DRIVER_ID,
      driverPrincipalId: `driver:${OTHER_DRIVER_ID}`,
      driverAssignedTourId: 'OTHER_TOUR',
      principalType: 'driver',
    });
    await db.ref(`tour_access_grants/${TOUR_ID}/${OTHER_PASSENGER_AUTH_UID}`).set(grantPayload(OTHER_PASSENGER_AUTH_UID));
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows passengers to write only their own participant row and participant count', async () => {
  await assertSucceeds(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/participants/${OTHER_PASSENGER_AUTH_UID}`).set({
    userId: OTHER_PASSENGER_AUTH_UID,
    joinedAt: '2026-05-23T19:41:00.000Z',
    lastUpdated: '2026-05-23T19:41:00.000Z',
  }));

  await assertSucceeds(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/currentParticipants`).set(2));
  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/name`).set('Changed by passenger'));
  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}`).update({ isActive: false }));
});

test('requires a verified login grant before a new passenger can join a tour', async () => {
  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`tours/${TOUR_ID}/participants/${UNATTACHED_AUTH_UID}`).set({
    userId: UNATTACHED_AUTH_UID,
    joinedAt: '2026-05-23T19:41:00.000Z',
    lastUpdated: '2026-05-23T19:41:00.000Z',
  }));
});

test('limits tour reads to participants, assigned drivers, admins, or verified login grants', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
});

test('denies passengers from writing driver-only tour location fields', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0,
    longitude: -4.6,
    timestamp: '2026-05-23T19:42:00.000Z',
  }));
});

test('allows assigned drivers, but not unassigned drivers, to write driver tour fields', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0,
    longitude: -4.6,
    timestamp: '2026-05-23T19:42:00.000Z',
    updatedBy: 'Driver Palmer',
  }));

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Client itinerary',
    days: [{ day: 1, content: 'Welcome' }],
  }));

  await assertFails(dbFor(OTHER_DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0,
    longitude: -4.6,
    timestamp: '2026-05-23T19:42:00.000Z',
  }));
});

test('limits live tracking and tour safety alerts to tour-attached users', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`).set({
    userId: PASSENGER_AUTH_UID,
    isSharing: true,
    lastUpdate: '2026-05-23T19:43:00.000Z',
    coords: { latitude: 56.0, longitude: -4.6 },
  }));

  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/safetyAlerts/event-1`).set({
    userId: PASSENGER_AUTH_UID,
    status: 'pending',
    timestamp: '2026-05-23T19:43:00.000Z',
  }));

  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`tours/${TOUR_ID}/liveTracking/${UNATTACHED_AUTH_UID}`).set({
    userId: UNATTACHED_AUTH_UID,
    isSharing: true,
    lastUpdate: '2026-05-23T19:43:00.000Z',
    coords: { latitude: 56.0, longitude: -4.6 },
  }));

  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`tours/${TOUR_ID}/safetyAlerts/event-2`).set({
    userId: UNATTACHED_AUTH_UID,
    status: 'pending',
    timestamp: '2026-05-23T19:43:00.000Z',
  }));
});

test('allows admin tour metadata management', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}/name`).set('Admin updated tour'));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}`).update({ isActive: false }));
});
