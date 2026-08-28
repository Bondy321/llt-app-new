const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { passengerAuthorityUpdates, driverAuthorityUpdates, sessionIdFor } = require('./sessionFixtures');

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

const buildRawDriverLocation = ({
  uid = DRIVER_AUTH_UID,
  driverId = DRIVER_ID,
  tourId = TOUR_ID,
  appSessionId = sessionIdFor(uid),
  liveSharingSessionId = 'location_rules_123',
  manual = false,
  overrides = {},
} = {}) => ({
  schemaVersion: 2,
  isSharing: true,
  mode: manual ? 'pickup' : 'live',
  source: manual ? 'manual' : 'auto',
  latitude: 56.0,
  longitude: -4.6,
  timestamp: { '.sv': 'timestamp' },
  accuracy: 12,
  updatedBy: 'Driver Palmer',
  authUid: uid,
  appSessionId,
  driverId,
  tourId,
  ...(manual ? {} : {
    liveSharingSessionId,
    cleanupAtMs: Date.now() + (30 * 60 * 1000),
  }),
  ...overrides,
});

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
      itinerary: { title: 'Passenger itinerary', days: [{ day: 1, content: 'Welcome' }] },
      driver_itinerary: 'Depot and supplier instructions',
      services: { service1: { contractRef: 'SECRET' } },
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
    await db.ref().update({
      ...passengerAuthorityUpdates({ uid: PASSENGER_AUTH_UID, tourId: TOUR_ID }),
      ...passengerAuthorityUpdates({ uid: OTHER_PASSENGER_AUTH_UID, tourId: TOUR_ID }),
      ...driverAuthorityUpdates({ uid: DRIVER_AUTH_UID, driverId: DRIVER_ID, tourId: TOUR_ID }),
    });
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('keeps participant authority server-owned and denies passenger tour mutation', async () => {
  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/participants/${OTHER_PASSENGER_AUTH_UID}`).set({
    userId: OTHER_PASSENGER_AUTH_UID,
    joinedAt: '2026-05-23T19:41:00.000Z',
    lastUpdated: '2026-05-23T19:41:00.000Z',
  }));

  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/currentParticipants`).set(2));
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

test('passengers can read only explicit safe tour leaves while assigned drivers retain the operational tour', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}`).get());
  await assertFails(dbFor(UNATTACHED_AUTH_UID).ref(`tours/${TOUR_ID}`).get());

  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).get());
  await assertSucceeds(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).get());
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/driver_itinerary`).get());
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/services`).get());
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/participants/${PASSENGER_AUTH_UID}`).get());
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/participants`).get());
});

test('denies passengers from writing driver-only tour location fields', async () => {
  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/driverLocation`).set({
    latitude: 56.0,
    longitude: -4.6,
    timestamp: '2026-05-23T19:42:00.000Z',
  }));
});

test('allows raw location and staged legacy location only until the server projection revision appears', async () => {
  const liveSharingSessionId = 'location_assigned_123';
  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID)
      .ref(`driver_location_sessions/${sessionIdFor(DRIVER_AUTH_UID)}|${liveSharingSessionId}`)
      .set(buildRawDriverLocation({ liveSharingSessionId })),
  );
  const legacyLocationRef = dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/driverLocation`);
  await assertSucceeds(legacyLocationRef.set({
    schemaVersion: 1,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: 56.0,
    longitude: -4.6,
    accuracy: 12,
    timestamp: { '.sv': 'timestamp' },
    updatedBy: 'Driver Palmer',
  }));

  await testEnv.withSecurityRulesDisabled((context) => (
    context.database(dbUrl).ref(`tours/${TOUR_ID}/driverLocation/projectionRevision`).set(1)
  ));
  await assertFails(legacyLocationRef.update({ timestamp: { '.sv': 'timestamp' } }));
  await assertFails(legacyLocationRef.remove());

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Client itinerary',
    days: [{ day: 1, content: 'Welcome' }],
  }));

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/driver_itinerary`).set(
    '07:30 vehicle checks\n08:00 depart depot',
  ));

  await assertFails(
    dbFor(OTHER_DRIVER_AUTH_UID)
      .ref(`driver_location_sessions/${sessionIdFor(OTHER_DRIVER_AUTH_UID)}|location_unassigned_123`)
      .set(buildRawDriverLocation({
        uid: OTHER_DRIVER_AUTH_UID,
        driverId: OTHER_DRIVER_ID,
        tourId: 'OTHER_TOUR',
        liveSharingSessionId: 'location_unassigned_123',
      })),
  );
});

test('validates v2 raw driver location records and accepts server timestamps', async () => {
  const appSessionId = sessionIdFor(DRIVER_AUTH_UID);
  const liveSharingSessionId = 'location_schema_123';
  const locationRef = dbFor(DRIVER_AUTH_UID)
    .ref(`driver_location_sessions/${appSessionId}|${liveSharingSessionId}`);

  await assertSucceeds(locationRef.set(buildRawDriverLocation({ liveSharingSessionId })));
  await assertFails(locationRef.set(buildRawDriverLocation({
    liveSharingSessionId,
    overrides: { cleanupAtMs: Date.now() + (5 * 60 * 1000) },
  })));
  await assertFails(locationRef.set(buildRawDriverLocation({
    liveSharingSessionId,
    overrides: { timestamp: Date.now() + (10 * 60 * 1000) },
  })));
  await assertFails(locationRef.set(buildRawDriverLocation({
    liveSharingSessionId,
    overrides: { source: 'manual' },
  })));
  await assertFails(locationRef.set(buildRawDriverLocation({
    liveSharingSessionId,
    overrides: { unexpectedPrivateField: 'must-not-leak' },
  })));
  await assertSucceeds(locationRef.remove());

  const pickupRef = dbFor(DRIVER_AUTH_UID).ref(`driver_location_pickups/${TOUR_ID}`);
  await assertSucceeds(pickupRef.set(buildRawDriverLocation({ manual: true })));
  await assertFails(pickupRef.set(buildRawDriverLocation({
    manual: true,
    overrides: { unexpectedField: 'not allowed' },
  })));
  await assertSucceeds(pickupRef.remove());
});

test('validates itinerary content, revision metadata, and driver-only text shape', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Conflict-safe itinerary',
    days: [{ day: 1, content: 'Meet at the coach park.' }],
    revision: 2,
    updatedAt: Date.now() - 1000,
    updatedBy: DRIVER_AUTH_UID,
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Malformed itinerary',
    days: [{ day: 0, content: 'Invalid day number' }],
  }));

  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Legacy structured itinerary',
    days: [{
      day: 1,
      title: 'Arrival',
      activities: [{ time: '09:00', description: 'Meet the coach' }],
    }],
    warnings: ['Pickup time is provisional'],
    revision: 3,
    updatedAt: Date.now() - 500,
    updatedBy: DRIVER_AUTH_UID,
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Unexpected payload',
    days: [{ day: 1, content: 'Luss', executablePayload: true }],
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Unexpected root payload',
    days: [{ day: 1, content: 'Luss' }],
    unboundedMetadata: { nested: 'not allowed' },
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/itinerary`).set({
    title: 'Revision rollback',
    days: [{ day: 1, content: 'Luss' }],
    revision: 2,
    updatedAt: Date.now() - 250,
    updatedBy: DRIVER_AUTH_UID,
  }));

  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`tours/${TOUR_ID}/driver_itinerary`).set({
    text: 'Object payloads are not supported by the mobile driver view',
  }));
});

test('limits live tracking and tour safety alerts to tour-attached users', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`).set({
    userId: PASSENGER_AUTH_UID,
    isSharing: true,
    lastUpdate: '2026-05-23T19:43:00.000Z',
    coords: { latitude: 56.0, longitude: -4.6 },
  }));

  await assertFails(dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/safetyAlerts/event-1`).set({
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

test('versioned live sharing uses bounded coordinates, server time, and owner-only removal', async () => {
  const ref = dbFor(PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`);
  await assertSucceeds(ref.set({
    schemaVersion: 2,
    userId: PASSENGER_AUTH_UID,
    isSharing: true,
    lastUpdate: { '.sv': 'timestamp' },
    clientUpdatedAtMs: Date.now(),
    coords: { latitude: 56.0, longitude: -4.6, accuracy: 12 },
  }));
  await assertFails(ref.set({
    schemaVersion: 2,
    userId: PASSENGER_AUTH_UID,
    isSharing: true,
    lastUpdate: { '.sv': 'timestamp' },
    clientUpdatedAtMs: Date.now(),
    coords: { latitude: 96.0, longitude: -4.6, accuracy: 12 },
  }));
  await assertFails(dbFor(OTHER_PASSENGER_AUTH_UID).ref(`tours/${TOUR_ID}/liveTracking/${PASSENGER_AUTH_UID}`).remove());
  await assertSucceeds(ref.remove());
});

test('allows admin tour metadata management', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}/name`).set('Admin updated tour'));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}`).update({ isActive: false }));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}/driverId`).set(DRIVER_ID));
  await assertFails(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}/driverId`).set('D-MISSING'));
  const startDateEpochMs = Date.UTC(2026, 7, 22);
  const endDateEpochMs = Date.UTC(2026, 7, 24);
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}`).update({ startDateEpochMs, endDateEpochMs }));
  await assertFails(dbFor(ADMIN_UID).ref(`tours/${TOUR_ID}/endDateEpochMs`).set(startDateEpochMs - 1));
  await assertSucceeds(
    dbFor(ADMIN_UID).ref('tours')
      .orderByChild('endDateEpochMs')
      .startAt(startDateEpochMs)
      .limitToFirst(500)
      .get(),
  );
});

test('allows hardcoded admin web console collection reads and root multi-path updates', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref('tours').get());
  await assertSucceeds(dbFor(ADMIN_UID).ref('drivers').get());
  await assertSucceeds(dbFor(ADMIN_UID).ref('tour_manifests').get());

  await assertSucceeds(dbFor(ADMIN_UID).ref().update({
    [`drivers/${DRIVER_ID}/phone`]: '07123 456789',
    [`tours/${TOUR_ID}/driverName`]: 'Driver Palmer',
    [`tours/${TOUR_ID}/driverPhone`]: '07123 456789',
    [`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`]: true,
  }));
});
