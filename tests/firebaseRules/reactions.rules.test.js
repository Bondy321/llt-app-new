const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-rules';
const TOUR_ID = 'TOUR_001';
const MESSAGE_ID = 'MSG_001';
const MESSAGE_PATH = `chats/${TOUR_ID}/messages/${MESSAGE_ID}`;
const REACTION_PATH = `${MESSAGE_PATH}/reactions/👍`;

const parseHost = () => {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = value.split(':');
  const port = Number(portText);
  return { host, port, databaseURL: `http://${host}:${port}/?ns=${PROJECT_ID}` };
};

const rules = fs
  .readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8')
  .replace(/\\s/g, ' ');

let testEnv;
let dbUrl;

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

const seedMessage = async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref(MESSAGE_PATH).set({
      senderId: 'userB',
      senderName: 'User B',
      text: 'original text',
      timestamp: 1710000000000,
      isDriver: false,
      status: 'sent',
    });
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

  await seedMessage();
});

test.after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

test('allows user A to write own reaction leaf on message sent by user B', async () => {
  await assertSucceeds(dbFor('userA').ref(`${REACTION_PATH}/userA`).set(true));
});

test('allows user A to remove own reaction leaf', async () => {
  const ownLeaf = dbFor('userA').ref(`${REACTION_PATH}/userA`);
  await assertSucceeds(ownLeaf.set(true));
  await assertSucceeds(ownLeaf.remove());
});

test('denies user A writing reaction leaf for user B', async () => {
  await assertFails(dbFor('userA').ref(`${REACTION_PATH}/userB`).set(true));
});

test('denies user A overwriting emoji reaction object directly', async () => {
  await assertFails(dbFor('userA').ref(REACTION_PATH).set({ userA: true }));
});

test('denies user A editing message text on message by user B', async () => {
  await assertFails(dbFor('userA').ref(`${MESSAGE_PATH}/text`).set('tampered text'));
});

test('allows admin actions per existing policy (message text edit)', async () => {
  const adminTextRef = dbFor(ADMIN_UID).ref(`${MESSAGE_PATH}/text`);
  await assertSucceeds(adminTextRef.set('admin text update'));

  const snapshot = await adminTextRef.get();
  assert.equal(snapshot.val(), 'admin text update');
});
