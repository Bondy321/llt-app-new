const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-notification-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const TOUR_ID = 'NOTIFY_TOUR_1';
const PASSENGER_UID = 'notify-passenger';
const DRIVER_UID = 'notify-driver-auth';
const DRIVER_ID = 'D-NOTIFY';
const OUTSIDER_UID = 'notify-outsider';
const NOTICE_ID = 'ntf_0123456789abcdef0123456789abcdef';

const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

let testEnv;
let databaseURL;

const parseEmulator = () => {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!raw) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = raw.split(':');
  return { host, port: Number(portText) };
};

const dbFor = (uid) => testEnv.authenticatedContext(uid).database(databaseURL);

const notice = (overrides = {}) => ({
  noticeId: NOTICE_ID,
  version: 1,
  type: 'announcement',
  title: 'Loch Lomond Travel update',
  body: 'Pickup will now be ten minutes later.',
  tourId: TOUR_ID,
  screen: 'Chat',
  sourceId: 'broadcast_1',
  priority: 'high',
  createdAt: '2026-08-12T10:00:00.000Z',
  createdAtMs: 1786525200000,
  ...overrides,
});

test.before(async () => {
  const emulator = parseEmulator();
  databaseURL = `http://${emulator.host}:${emulator.port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(databaseURL);
    await db.ref(`tours/${TOUR_ID}`).set({
      name: 'Notification Tour',
      participants: { [PASSENGER_UID]: { userId: PASSENGER_UID } },
    });
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Driver Notify',
      authUid: DRIVER_UID,
      currentTourId: TOUR_ID,
    });
    await db.ref(`users/${DRIVER_UID}`).set({ driverId: DRIVER_ID });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`tour_notifications/${TOUR_ID}/${NOTICE_ID}`).set(notice());
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test('tour members and assigned drivers can read the durable tour notification feed', async () => {
  await assertSucceeds(dbFor(PASSENGER_UID).ref(`tour_notifications/${TOUR_ID}`).get());
  await assertSucceeds(dbFor(DRIVER_UID).ref(`tour_notifications/${TOUR_ID}`).get());
  await assertFails(dbFor(OUTSIDER_UID).ref(`tour_notifications/${TOUR_ID}`).get());
});

test('clients cannot forge tour notifications while admins retain operational access', async () => {
  const otherNoticeId = 'ntf_11111111111111111111111111111111';
  await assertFails(dbFor(PASSENGER_UID).ref(`tour_notifications/${TOUR_ID}/${otherNoticeId}`).set(notice({
    noticeId: otherNoticeId,
    sourceId: 'forged',
  })));
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tour_notifications/${TOUR_ID}/${otherNoticeId}`).set(notice({
    noticeId: otherNoticeId,
    sourceId: 'admin_recovery',
  })));
});

test('notification records accept a bounded exact chat target and reject malformed targets', async () => {
  const validId = 'ntf_22222222222222222222222222222222';
  await assertSucceeds(dbFor(ADMIN_UID).ref(`tour_notifications/${TOUR_ID}/${validId}`).set(notice({
    noticeId: validId,
    sourceId: 'broadcast_with_target',
    messageId: 'broadcast_with_target',
  })));

  const invalidId = 'ntf_33333333333333333333333333333333';
  await assertFails(dbFor(ADMIN_UID).ref(`tour_notifications/${TOUR_ID}/${invalidId}`).set(notice({
    noticeId: invalidId,
    sourceId: 'broadcast_bad_target',
    messageId: '',
  })));
});

test('users can mark only their own notification state with a valid timestamp', async () => {
  const readPath = `notification_read_state/${TOUR_ID}/${PASSENGER_UID}/${NOTICE_ID}`;
  await assertSucceeds(dbFor(PASSENGER_UID).ref(readPath).set(Date.now() - 1000));
  await assertSucceeds(dbFor(PASSENGER_UID).ref(readPath).get());
  await assertFails(dbFor(OUTSIDER_UID).ref(readPath).set(Date.now() - 500));
  await assertFails(dbFor(PASSENGER_UID).ref(readPath).set(Date.now() + 60_000));
});
