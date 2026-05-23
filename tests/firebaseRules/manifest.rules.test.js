const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-rules';
const TOUR_ID = '5203L_22';
const TOUR_CODE = '5203L 22';
const BOOKING_REF = 'T123456';
const LEGACY_TOUR_CODE_BOOKING_REF = 'TLEGACY1';
const MANIFEST_PATH = `tour_manifests/${TOUR_ID}/bookings/${BOOKING_REF}`;
const LEGACY_MANIFEST_PATH = `tour_manifests/${TOUR_ID}/bookings/${LEGACY_TOUR_CODE_BOOKING_REF}`;
const DRIVER_ID = 'D-DPALMER';
const DRIVER_AUTH_UID = 'driver-auth-1';
const OTHER_DRIVER_ID = 'D-OTHER';
const OTHER_DRIVER_AUTH_UID = 'driver-auth-2';
const PASSENGER_AUTH_UID = 'passenger-auth-1';

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

const manifestUpdate = {
  status: 'BOARDED',
  passengerStatus: ['BOARDED'],
  lastUpdated: '2026-05-23T19:47:04.237Z',
  idempotencyKey: 'manifest-test-1',
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
    await db.ref(`bookings/${BOOKING_REF}`).set({ tourId: TOUR_ID });
    await db.ref(`bookings/${LEGACY_TOUR_CODE_BOOKING_REF}`).set({ tourCode: TOUR_CODE });
    await db.ref(`tours/${TOUR_ID}/tourCode`).set(TOUR_CODE);
    await db.ref(`tour_manifests/${TOUR_ID}/tourCode`).set(TOUR_CODE);
    await db.ref(`tours/${TOUR_ID}/participants/${PASSENGER_AUTH_UID}`).set({
      userId: PASSENGER_AUTH_UID,
      joinedAt: '2026-05-23T19:40:00.000Z',
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
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows assigned driver auth UID to update passenger manifest booking rows', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(MANIFEST_PATH).update(manifestUpdate));
});

test('allows assigned driver auth UID to update legacy tourCode-only booking rows', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(LEGACY_MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-legacy-tour-code',
  }));
});

test('keeps passenger participant manifest updates working', async () => {
  await assertSucceeds(dbFor(PASSENGER_AUTH_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-passenger',
  }));
});

test('denies unassigned driver auth UID from updating another tour manifest', async () => {
  await assertFails(dbFor(OTHER_DRIVER_AUTH_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-unassigned-driver',
  }));
});

test('allows admin manifest update', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref(MANIFEST_PATH).update({
    ...manifestUpdate,
    idempotencyKey: 'manifest-test-admin',
  }));
});
