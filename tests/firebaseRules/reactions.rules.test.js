const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { sendInternalDriverMessage } = require('../../services/chatService');

const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const PROJECT_ID = 'demo-llt-rules';
const TOUR_ID = 'TOUR_001';
const MESSAGE_ID = 'MSG_001';
const MESSAGE_PATH = `chats/${TOUR_ID}/messages/${MESSAGE_ID}`;
const REACTION_PATH = `${MESSAGE_PATH}/reactions/👍`;
const DRIVER_AUTH_UID = 'driver-auth-1';
const DRIVER_PRINCIPAL_ID = 'driver:BONDY';
const INTERNAL_TOUR_ID = 'TOUR_INTERNAL_001';

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

    await context.database(dbUrl).ref(`identity_bindings/${DRIVER_PRINCIPAL_ID}/${DRIVER_AUTH_UID}`).set(true);
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

test('service-generated internal driver message payload is accepted by rules', async () => {
  const senderInfo = {
    name: 'Driver Bondy',
    principalId: DRIVER_PRINCIPAL_ID,
    principalType: 'driver',
    isDriver: true,
  };

  const result = await sendInternalDriverMessage(
    INTERNAL_TOUR_ID,
    'Internal operations update',
    senderInfo,
    dbFor(DRIVER_AUTH_UID),
    { messageId: 'int_rules_001' }
  );

  assert.equal(result.success, true);
  const written = await dbFor(DRIVER_AUTH_UID).ref(`internal_chats/${INTERNAL_TOUR_ID}/messages/int_rules_001`).get();
  assert.equal(written.exists(), true);
  assert.equal(written.child('senderType').val(), 'driver');
  assert.equal(written.child('senderStableId').val(), DRIVER_PRINCIPAL_ID);
});
