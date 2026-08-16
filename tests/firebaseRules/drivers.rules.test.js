const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-driver-rules';
const DRIVER_ID = 'D-DPALMER';
const CLAIMED_DRIVER_ID = 'D-CLAIMED';
const DRIVER_AUTH_UID = 'driver-auth-1';
const OTHER_AUTH_UID = 'driver-auth-2';
const DELEGATED_ADMIN_UID = 'delegated-admin-1';

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
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Palmer',
      currentTourId: '5203L_22',
    });
    await db.ref(`drivers/${CLAIMED_DRIVER_ID}`).set({
      name: 'Claimed Driver',
      authUid: DRIVER_AUTH_UID,
      currentTourId: '5203L_22',
    });
    await db.ref('admin_users/delegated-admin-1').set(true);
    await db.ref('tours/TOUR_1').set({
      tourCode: 'TOUR 1',
      driverName: 'TBA',
      driverPhone: '',
    });
    await db.ref('tour_manifests/TOUR_1').set({ assigned_drivers: {} });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({ driverId: CLAIMED_DRIVER_ID });
  });
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('denies arbitrary driver record creation by authenticated clients', async () => {
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('drivers/D-FAKE').set({
    name: 'Fake Driver',
    authUid: DRIVER_AUTH_UID,
  }));
});

test('allows claimed driver self reads but denies unclaimed exact reads and driver listing', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}`).get());
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).get());
  await assertFails(dbFor(DRIVER_AUTH_UID).ref('drivers').get());
});

test('allows admin driver record creation', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref('drivers/D-ADMIN').set({
    name: 'Admin Created',
    authUid: ADMIN_UID,
  }));
});

test('allows a delegated operations admin to list portal collections and apply a canonical assignment', async () => {
  const delegatedDb = dbFor(DELEGATED_ADMIN_UID);
  await assertSucceeds(delegatedDb.ref('drivers').get());
  await assertSucceeds(delegatedDb.ref('tours').get());
  await assertSucceeds(delegatedDb.ref('tour_manifests').get());

  await assertSucceeds(delegatedDb.ref().update({
    'tours/TOUR_1/driverName': 'Claimed Driver',
    'tours/TOUR_1/driverPhone': '+44 7700 900000',
    [`tours/TOUR_1/driverId`]: CLAIMED_DRIVER_ID,
    [`drivers/${CLAIMED_DRIVER_ID}/currentTourId`]: 'TOUR_1',
    [`drivers/${CLAIMED_DRIVER_ID}/currentTourCode`]: 'TOUR 1',
    [`drivers/${CLAIMED_DRIVER_ID}/assignments/TOUR_1`]: true,
    [`tour_manifests/TOUR_1/assigned_drivers/${CLAIMED_DRIVER_ID}`]: true,
    [`tour_manifests/TOUR_1/assigned_driver_codes/${CLAIMED_DRIVER_ID}`]: {
      driverId: CLAIMED_DRIVER_ID,
      tourId: 'TOUR_1',
      tourCode: 'TOUR 1',
      assignedAt: '2026-08-12T10:00:00.000Z',
      assignedBy: DELEGATED_ADMIN_UID,
    },
    [`users/${DRIVER_AUTH_UID}/driverAssignedTourId`]: 'TOUR_1',
    [`users/${DRIVER_AUTH_UID}/lastUpdated`]: 1786538400000,
  }));
});

test('delegated operations admins cannot grant or revoke admin access', async () => {
  const delegatedDb = dbFor(DELEGATED_ADMIN_UID);
  await assertFails(delegatedDb.ref('admin_users/delegated-admin-2').set(true));
  await assertFails(delegatedDb.ref(`admin_users/${DELEGATED_ADMIN_UID}`).remove());
  await assertSucceeds(dbFor(ADMIN_UID).ref('admin_users/delegated-admin-2').set(true));
});

test('denies client-side claiming of an unclaimed driver record', async () => {
  await assertFails(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}`).update({
    authUid: DRIVER_AUTH_UID,
    lastActive: '2026-05-23T19:45:00.000Z',
  }));
});

test('allows claimed drivers to update their own activity fields', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).update({
    lastActive: '2026-05-23T19:46:00.000Z',
  }));
});

test('denies other users from taking over claimed driver records', async () => {
  await assertFails(dbFor(OTHER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}`).update({
    authUid: OTHER_AUTH_UID,
    lastActive: '2026-05-23T19:47:00.000Z',
  }));
});

test('denies claimed drivers from editing assignment or profile authority fields directly', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourId`).set('OTHER_TOUR'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/currentTourCode`).set('OTHER TOUR'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/name`).set('Forged Name'));
  await assertFails(driverDb.ref(`drivers/${CLAIMED_DRIVER_ID}/assignments/OTHER_TOUR`).set(true));
});

test('driverAssignedTourId is server-owned even when a client proposes the current assignment', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(driverDb.ref(`users/${DRIVER_AUTH_UID}/driverAssignedTourId`).set('5203L_22'));
  await assertFails(driverDb.ref(`users/${DRIVER_AUTH_UID}/driverAssignedTourId`).set('OTHER_TOUR'));
});

test('claimed drivers cannot manufacture manifest assignment authority', async () => {
  const driverDb = dbFor(DRIVER_AUTH_UID);
  await assertFails(
    driverDb.ref(`tour_manifests/FORGED_TOUR/assigned_drivers/${CLAIMED_DRIVER_ID}`).set(true),
  );
  await assertFails(
    driverDb.ref(`tour_manifests/FORGED_TOUR/assigned_driver_codes/${CLAIMED_DRIVER_ID}`).set({
      driverId: CLAIMED_DRIVER_ID,
      tourId: 'FORGED_TOUR',
      tourCode: 'FORGED TOUR',
      assignedAt: '2026-08-12T10:00:00.000Z',
      assignedBy: DRIVER_AUTH_UID,
    }),
  );
});

test('allows a claimed driver to unlink only their own auth uid for account deletion', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${CLAIMED_DRIVER_ID}/authUid`).remove());
});
