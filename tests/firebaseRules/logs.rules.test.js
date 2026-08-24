const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { passengerAuthorityUpdates } = require('./sessionFixtures');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const USER_UID = 'mobile-log-user-1';
const OTHER_UID = 'mobile-log-user-2';
const PROJECT_ID = 'demo-llt-log-rules';
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

let testEnv;
let dbUrl;

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().update(passengerAuthorityUpdates({ uid: USER_UID, tourId: 'LOG_TOUR' }));
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test('denies every unauthenticated log write, including the legacy anonymous route', async () => {
  const unauthenticatedDb = testEnv.unauthenticatedContext().database(dbUrl);
  await assertFails(unauthenticatedDb.ref('logs/anonymous/session/event').set({ message: 'blocked' }));
  await assertFails(unauthenticatedDb.ref(`logs/${USER_UID}/session/event`).set({ message: 'blocked' }));
});

test('allows authenticated users to write only below their own log branch', async () => {
  const userDb = testEnv.authenticatedContext(USER_UID).database(dbUrl);
  await assertSucceeds(userDb.ref(`logs/${USER_UID}/session/event`).set({ message: 'safe' }));
  await assertFails(userDb.ref(`logs/${OTHER_UID}/session/event`).set({ message: 'blocked' }));
  await assertFails(userDb.ref('logs/anonymous/session/event').set({ message: 'blocked' }));
});

test('keeps operations-admin log access intact', async () => {
  const adminDb = testEnv.authenticatedContext(ADMIN_UID).database(dbUrl);
  await assertSucceeds(adminDb.ref(`logs/${OTHER_UID}/session/event`).set({ message: 'admin diagnostic' }));
  await assertSucceeds(adminDb.ref(`logs/${OTHER_UID}/session/event`).once('value'));
});
