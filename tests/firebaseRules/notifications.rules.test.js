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
const PASSENGER_PRINCIPAL_KEY = 'pax_v1:BOOKING1:passenger_40_example_2E_com';
const OTHER_PASSENGER_PRINCIPAL_KEY = 'pax_v1:BOOKING2:other_40_example_2E_com';
const DRIVER_UID = 'notify-driver-auth';
const DRIVER_ID = 'D-NOTIFY';
const DRIVER_PRINCIPAL_KEY = `driver:${DRIVER_ID}`;
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
    await db.ref(`users/${PASSENGER_UID}`).set({
      stablePassengerId: 'pax_v1:BOOKING1:passenger@example.com',
      stablePassengerKey: PASSENGER_PRINCIPAL_KEY,
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
  const readPath = `notification_read_state/${TOUR_ID}/${PASSENGER_PRINCIPAL_KEY}/${NOTICE_ID}`;
  await assertSucceeds(dbFor(PASSENGER_UID).ref(readPath).set(Date.now() - 1000));
  await assertSucceeds(dbFor(PASSENGER_UID).ref(readPath).get());
  await assertFails(dbFor(OUTSIDER_UID).ref(readPath).set(Date.now() - 500));
  await assertFails(dbFor(PASSENGER_UID).ref(readPath).set(Date.now() + 60_000));
  await assertFails(dbFor(PASSENGER_UID).ref(
    `notification_read_state/${TOUR_ID}/${PASSENGER_PRINCIPAL_KEY}/missing_notice`
  ).set(Date.now() - 100));
  await assertFails(dbFor(PASSENGER_UID).ref(
    `notification_read_state/${TOUR_ID}/${PASSENGER_UID}/${NOTICE_ID}`
  ).get());
  await assertFails(dbFor(PASSENGER_UID).ref(
    `notification_read_state/${TOUR_ID}/${OTHER_PASSENGER_PRINCIPAL_KEY}/${NOTICE_ID}`
  ).set(Date.now() - 100));
  await assertFails(dbFor(OUTSIDER_UID).ref(
    `notification_read_state/${TOUR_ID}/${OUTSIDER_UID}/${NOTICE_ID}`
  ).set(Date.now() - 100));
});

test('verified assigned drivers can write read state and lose access immediately when unassigned', async () => {
  const readPath = `notification_read_state/${TOUR_ID}/${DRIVER_PRINCIPAL_KEY}/${NOTICE_ID}`;
  await assertSucceeds(dbFor(DRIVER_UID).ref(readPath).set(Date.now() - 1000));
  await assertSucceeds(dbFor(DRIVER_UID).ref(readPath).get());

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL)
      .ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`)
      .remove();
  });
  try {
    await assertFails(dbFor(DRIVER_UID).ref(readPath).get());
    await assertFails(dbFor(DRIVER_UID).ref(readPath).set(Date.now() - 500));
  } finally {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.database(databaseURL)
        .ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`)
        .set(true);
    });
  }
});

test('passenger read state becomes inaccessible after tour membership is removed', async () => {
  const readPath = `notification_read_state/${TOUR_ID}/${PASSENGER_PRINCIPAL_KEY}/${NOTICE_ID}`;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL).ref(`tours/${TOUR_ID}/participants/${PASSENGER_UID}`).remove();
  });
  try {
    await assertFails(dbFor(PASSENGER_UID).ref(readPath).get());
    await assertFails(dbFor(PASSENGER_UID).ref(readPath).set(Date.now() - 100));
  } finally {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.database(databaseURL)
        .ref(`tours/${TOUR_ID}/participants/${PASSENGER_UID}`)
        .set({ userId: PASSENGER_UID });
    });
  }
});

test('push and device metadata accept canonical bounded values and reject storage abuse', async () => {
  const validProfilePatch = {
    [`users/${PASSENGER_UID}/pushToken`]: 'ExponentPushToken[valid_token-1]',
    [`users/${PASSENGER_UID}/pushTokenStatus`]: 'ACTIVE',
    [`users/${PASSENGER_UID}/pushTokenProvider`]: 'expo',
    [`users/${PASSENGER_UID}/pushPermissionState`]: 'granted',
    [`users/${PASSENGER_UID}/deviceOS`]: 'ios',
    [`users/${PASSENGER_UID}/deviceModel`]: 'iPhone Test',
    [`users/${PASSENGER_UID}/appVersion`]: '1.0.4',
    [`users/${PASSENGER_UID}/appBuild`]: '3',
    [`users/${PASSENGER_UID}/osVersion`]: '18.6',
  };
  await assertSucceeds(dbFor(PASSENGER_UID).ref().update(validProfilePatch));
  await assertFails(dbFor(PASSENGER_UID).ref(`users/${PASSENGER_UID}/pushToken`).set('https://example.com/not-a-token'));
  await assertFails(dbFor(PASSENGER_UID).ref(`users/${PASSENGER_UID}/deviceModel`).set('x'.repeat(121)));
  await assertFails(dbFor(PASSENGER_UID).ref(`users/${PASSENGER_UID}/pushTokenProvider`).set('arbitrary-provider'));
});

test('notification read cleanup jobs remain server private', async () => {
  const job = {
    version: 1,
    jobId: 'nrc_0123456789abcdef0123456789abcdef',
    tourId: TOUR_ID,
    noticeId: NOTICE_ID,
    createdAtMs: Date.now(),
  };
  await assertFails(dbFor(PASSENGER_UID).ref(`notification_read_cleanup_jobs/${job.jobId}`).get());
  await assertFails(dbFor(ADMIN_UID).ref(`notification_read_cleanup_jobs/${job.jobId}`).set(job));
  await assertFails(dbFor(PASSENGER_UID).ref('notification_read_legacy_cleanup_state/v1').get());
  await assertFails(dbFor(ADMIN_UID).ref('notification_read_legacy_cleanup_state/v1').set({
    version: 1, seeded: true, completed: false,
  }));
  await assertFails(dbFor(PASSENGER_UID).ref(
    `notification_read_legacy_cleanup_queue/${TOUR_ID}`
  ).get());
  await assertFails(dbFor(ADMIN_UID).ref(
    `notification_read_legacy_cleanup_queue/${TOUR_ID}`
  ).set({ version: 1, afterPrincipalId: null }));
});

test('legacy read-state migration requests are bound to the active canonical principal', async () => {
  const passengerRequestPath = `notification_read_migration_requests/${TOUR_ID}/${PASSENGER_UID}`;
  await assertSucceeds(dbFor(PASSENGER_UID).ref(passengerRequestPath).set({
    version: 1,
    principalId: PASSENGER_PRINCIPAL_KEY,
    requestedAtMs: Date.now(),
  }));
  await assertFails(dbFor(PASSENGER_UID).ref(passengerRequestPath).set({
    version: 1,
    principalId: OTHER_PASSENGER_PRINCIPAL_KEY,
    requestedAtMs: Date.now(),
  }));
  await assertFails(dbFor(OUTSIDER_UID).ref(
    `notification_read_migration_requests/${TOUR_ID}/${PASSENGER_UID}`
  ).set({
    version: 1,
    principalId: PASSENGER_PRINCIPAL_KEY,
    requestedAtMs: Date.now(),
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL).ref(
      `users/${PASSENGER_UID}/notificationReadStateUpgradedTours/${TOUR_ID}`
    ).set(true);
  });
  await assertFails(dbFor(PASSENGER_UID).ref(passengerRequestPath).set({
    version: 1,
    principalId: PASSENGER_PRINCIPAL_KEY,
    requestedAtMs: Date.now(),
  }));
  await assertSucceeds(dbFor(PASSENGER_UID).ref(passengerRequestPath).remove());
  await assertFails(dbFor(PASSENGER_UID).ref(
    `users/${PASSENGER_UID}/notificationReadStateUpgradedTours/${TOUR_ID}`
  ).remove());
  await assertSucceeds(dbFor(DRIVER_UID).ref(
    `notification_read_migration_requests/${TOUR_ID}/${DRIVER_UID}`
  ).set({
    version: 1,
    principalId: DRIVER_PRINCIPAL_KEY,
    requestedAtMs: Date.now(),
  }));
});
