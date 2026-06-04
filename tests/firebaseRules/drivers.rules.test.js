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

test('allows an existing unclaimed driver record to be claimed by the authenticated driver', async () => {
  await assertSucceeds(dbFor(DRIVER_AUTH_UID).ref(`drivers/${DRIVER_ID}`).update({
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
