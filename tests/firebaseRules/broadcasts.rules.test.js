const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-broadcast-rules';
const TOUR_ID = 'TOUR_1';
const CATEGORY_KEY = 'day_trips';
const OUTSIDER_UID = 'outsider-1';

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
    database: { host: emulator.host, port: emulator.port, rules },
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

const baseBroadcast = () => ({
  message: 'Coach departure is delayed by ten minutes.',
  createdAtMs: Date.now(),
  createdByUid: ADMIN_UID,
  source: 'web_admin',
  deliveryStatus: 'queued',
  deliveryUpdatedAtMs: Date.now(),
});

test('allows the admin portal to queue and update a tour broadcast delivery record', async () => {
  const record = dbFor(ADMIN_UID).ref(`broadcasts/${TOUR_ID}/broadcast_1`);
  await assertSucceeds(record.set(baseBroadcast()));
  await assertSucceeds(record.update({
    deliveryStatus: 'delivered',
    deliveryCompletedAtMs: Date.now(),
    recipientCount: 4,
    successCount: 4,
    errorCount: 0,
  }));
  await assertFails(record.update({ deliveryStatus: 'made_up_status' }));
});

test('allows queued category records but rejects invalid delivery counts and unauthorized writes', async () => {
  const payload = {
    ...baseBroadcast(),
    categoryKey: CATEGORY_KEY,
    categoryLabel: 'Day Trips',
  };
  const record = dbFor(ADMIN_UID).ref(`category_broadcasts/${CATEGORY_KEY}/broadcast_1`);
  await assertSucceeds(record.set(payload));
  await assertFails(record.update({ recipientCount: 1001 }));
  await assertFails(dbFor(OUTSIDER_UID).ref(`broadcasts/${TOUR_ID}/broadcast_2`).set({
    ...baseBroadcast(),
    createdByUid: OUTSIDER_UID,
  }));
});
