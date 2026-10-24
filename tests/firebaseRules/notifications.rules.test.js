const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { passengerAuthorityUpdates, driverAuthorityUpdates } = require('./sessionFixtures');

const PROJECT_ID = 'demo-llt-notification-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const TOUR_ID = 'NOTIFY_TOUR_1';
const PASSENGER_UID = 'notify-passenger';
const PASSENGER_PRINCIPAL_KEY = 'pax_v2_44444444444444444444444444444444';
const OTHER_PASSENGER_PRINCIPAL_KEY = 'pax_v2_55555555555555555555555555555555';
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

const dbFor = (uid) => testEnv.authenticatedContext(uid, uid === ADMIN_UID ? { firebase: { sign_in_second_factor: 'totp' } } : {}).database(databaseURL);
const loggedOutDb = () => testEnv.unauthenticatedContext().database(databaseURL);

const notificationDevice = (overrides = {}) => ({
  version: 1,
  authUid: PASSENGER_UID,
  status: 'active',
  operationalEligible: true,
  marketingEligible: true,
  marketingPreferences: { day_trips: true },
  updatedAtMs: 1786525200000,
  ...overrides,
});

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
      stablePassengerId: PASSENGER_PRINCIPAL_KEY,
      stablePassengerKey: PASSENGER_PRINCIPAL_KEY,
      privatePhotoOwnerId: PASSENGER_PRINCIPAL_KEY,
      privatePhotoOwnerKey: PASSENGER_PRINCIPAL_KEY,
      identityVersion: 'pax_v2',
      bookingRef: 'NOTIFY_BOOKING_1',
      principalType: 'passenger',
    });
    await db.ref(`users/${DRIVER_UID}`).set({ driverId: DRIVER_ID });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`tour_notifications/${TOUR_ID}/${NOTICE_ID}`).set(notice());
    await db.ref().update({
      [`notification_jobs_v2/job_notify_1`]: {
        version: 1,
        jobId: 'job_notify_1',
        status: 'queued',
        availableAtMs: 1786525200000,
        expiresAtMs: 1786611600000,
        updatedAtMs: 1786525200000,
        coalescingKey: 'tour:NOTIFY_TOUR_1:announcement',
      },
      [`notification_job_coalescing_v2/tour_NOTIFY_TOUR_1`]: { jobId: 'job_notify_1' },
      [`notification_job_token_claims_v2/job_notify_1/token_hash`]: { claimedAtMs: 1786525200000 },
      [`notification_delivery_attempts_v2/attempt_notify_1`]: {
        jobId: 'job_notify_1',
        status: 'receipt_pending',
        availableAtMs: 1786525200000,
        receiptDueAtMs: 1786526100000,
        expiresAtMs: 1786611600000,
        updatedAtMs: 1786525200000,
      },
      [`notification_delivery_warnings_v2/warning_notify_1`]: {
        status: 'open', severity: 'warning', updatedAtMs: 1786525200000,
      },
      [`notification_devices/${PASSENGER_UID}`]: notificationDevice(),
      [`notification_devices/${OUTSIDER_UID}`]: notificationDevice({
        authUid: OUTSIDER_UID,
        operationalEligible: false,
        marketingEligible: false,
      }),
      [`notification_consents/${PASSENGER_UID}`]: {
        version: 1, marketing: { day_trips: true }, updatedAtMs: 1786525200000,
      },
      [`notification_consents/${OUTSIDER_UID}`]: {
        version: 1, marketing: { day_trips: false }, updatedAtMs: 1786525200000,
      },
      'marketing_notification_details/marketing_notify_1': {
        version: 1,
        categoryKey: 'day_trips',
        status: 'active',
        expiresAtMs: 1786611600000,
        updatedAtMs: 1786525200000,
      },
    });
    await db.ref().update({
      ...passengerAuthorityUpdates({ uid: PASSENGER_UID, tourId: TOUR_ID, principalId: PASSENGER_PRINCIPAL_KEY, bookingRef: 'NOTIFY_BOOKING_1' }),
      ...driverAuthorityUpdates({ uid: DRIVER_UID, driverId: DRIVER_ID, tourId: TOUR_ID }),
    });
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
        .set(passengerAuthorityUpdates({ uid: PASSENGER_UID, tourId: TOUR_ID, principalId: PASSENGER_PRINCIPAL_KEY })[`tours/${TOUR_ID}/participants/${PASSENGER_UID}`]);
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

test('new notification delivery roots are server-owned and unreadable to ordinary clients', async () => {
  const serverRoots = [
    'notification_jobs_v2/job_notify_1',
    'notification_job_coalescing_v2/tour_NOTIFY_TOUR_1',
    'notification_job_token_claims_v2/job_notify_1/token_hash',
    'notification_delivery_attempts_v2/attempt_notify_1',
    'notification_delivery_warnings_v2/warning_notify_1',
    'marketing_notification_details/marketing_notify_1',
  ];

  for (const rootPath of serverRoots) {
    await assertFails(dbFor(PASSENGER_UID).ref(rootPath).get());
    await assertFails(dbFor(PASSENGER_UID).ref(rootPath).set({ forged: true }));
    await assertFails(loggedOutDb().ref(rootPath).get());
  }

  await assertFails(dbFor(PASSENGER_UID).ref(`notification_devices/${PASSENGER_UID}`).set(notificationDevice()));
  for (const caller of [PASSENGER_UID, ADMIN_UID]) {
    await assertFails(dbFor(caller).ref(`notification_devices/${PASSENGER_UID}/authoritySessionId`)
      .set(`sess_v1_${'f'.repeat(32)}`));
    await assertFails(dbFor(caller).ref(`notification_devices/${PASSENGER_UID}`)
      .update({ authoritySessionId: null }));
  }
  await assertFails(dbFor(PASSENGER_UID).ref(`notification_consents/${PASSENGER_UID}`).set({ forged: true }));
});

test('retention work and rollout state remain private even from authenticated administrators', async () => {
  const privatePaths = [
    'notification_retention/v2/jobs/job_notify_1',
    'notification_retention/v2/queue/0000000000001_job_notify_1',
    'notification_retention/v2/repair/orphan_attempts',
    'notification_retention/v2/preparation',
    'notification_retention/v2/evidence/run_1',
    'notification_retention_rollout/v2',
  ];
  for (const rootPath of privatePaths) {
    await assertFails(loggedOutDb().ref(rootPath).get());
    await assertFails(dbFor(PASSENGER_UID).ref(rootPath).get());
    await assertFails(dbFor(PASSENGER_UID).ref(rootPath).set({ forged: true }));
    await assertFails(dbFor(ADMIN_UID).ref(rootPath).get());
    await assertFails(dbFor(ADMIN_UID).ref(rootPath).set({ forged: true }));
  }
});

test('only self can read private notification device and consent records', async () => {
  await assertSucceeds(dbFor(PASSENGER_UID).ref(`notification_devices/${PASSENGER_UID}`).get());
  await assertSucceeds(dbFor(PASSENGER_UID).ref(`notification_consents/${PASSENGER_UID}`).get());
  await assertFails(dbFor(PASSENGER_UID).ref(`notification_devices/${OUTSIDER_UID}`).get());
  await assertFails(dbFor(PASSENGER_UID).ref(`notification_consents/${OUTSIDER_UID}`).get());
  await assertFails(dbFor(PASSENGER_UID).ref('notification_devices').get());
  await assertFails(dbFor(PASSENGER_UID).ref('notification_consents').get());
  await assertFails(loggedOutDb().ref(`notification_devices/${PASSENGER_UID}`).get());
  await assertFails(loggedOutDb().ref(`notification_consents/${PASSENGER_UID}`).get());
});

test('admins can inspect reporting roots but cannot client-write server-owned notification records', async () => {
  const reportingRoots = [
    'notification_jobs_v2/job_notify_1',
    'notification_delivery_attempts_v2/attempt_notify_1',
    'notification_delivery_warnings_v2/warning_notify_1',
    'marketing_notification_details/marketing_notify_1',
  ];
  for (const rootPath of reportingRoots) {
    await assertSucceeds(dbFor(ADMIN_UID).ref(rootPath).get());
    await assertFails(dbFor(ADMIN_UID).ref(rootPath).set({ forged: true }));
  }
  await assertFails(dbFor(ADMIN_UID).ref('notification_job_coalescing_v2/tour_NOTIFY_TOUR_1').get());
  await assertFails(dbFor(ADMIN_UID).ref('notification_job_token_claims_v2/job_notify_1').get());
  await assertFails(dbFor(ADMIN_UID).ref('notification_devices').get());
  await assertFails(dbFor(ADMIN_UID).ref(`notification_devices/${PASSENGER_UID}`).get());
  await assertFails(dbFor(ADMIN_UID).ref(`notification_consents/${PASSENGER_UID}`).get());
});

test('notification delivery indexes and server-mediated marketing-preference projection remain explicit', () => {
  const parsed = JSON.parse(rules).rules;
  for (const [root, indexes] of Object.entries({
    notification_jobs_v2: ['status', 'availableAtMs', 'completedAtMs', 'expiresAtMs', 'retentionDueAtMs', 'updatedAtMs', 'coalescingKey'],
    notification_delivery_attempts_v2: ['jobId', 'status', 'availableAtMs', 'receiptDueAtMs', 'expiresAtMs', 'retentionDueAtMs', 'updatedAtMs'],
    notification_delivery_warnings_v2: ['status', 'updatedAtMs', 'severity'],
    marketing_notification_details: ['categoryKey', 'status', 'expiresAtMs', 'retentionDueAtMs', 'updatedAtMs'],
  })) {
    for (const index of indexes) assert.ok(parsed[root]['.indexOn'].includes(index), `missing ${root} index ${index}`);
  }
  assert.ok(rules.includes('"marketingPreferences/day_trips"'));
  assert.ok(rules.includes('"notification_devices"'));
  assert.ok(rules.includes('"notification_consents"'));
  assert.ok(rules.includes('"notification_retention"'));
  assert.ok(rules.includes('"notification_retention_rollout"'));
  assert.ok(rules.includes('".write": false'));
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


test('shared notice acknowledgement follows passenger-to-driver switch under the same Auth UID', async () => {
  const { acknowledgeCurrentNotice } = require('../../services/notificationInboxService');
  const uid = 'notice-role-switch'; const driverId = 'D-SWITCH';
  let updates = passengerAuthorityUpdates({ uid, tourId: TOUR_ID });
  const clientSession = raw => Object.fromEntries(['schemaVersion', 'sessionId', 'tourId', 'principalId', 'principalType', 'driverId', 'issuedAtMs', 'expiresAtMs', 'sessionRevision'].map(key => [key, raw[key] ?? null]));
  let session = clientSession(updates[`app_sessions/${uid}`]);
  await testEnv.withSecurityRulesDisabled(context => context.database(databaseURL).ref().update(updates));
  const db = dbFor(uid);
  const options = { getContext: () => ({ authUid: uid, appSession: session }), tourId: TOUR_ID,
    noticeId: NOTICE_ID, db, auth: { currentUser: { uid } } };
  await assertSucceeds(acknowledgeCurrentNotice(options));
  const passengerPrincipal = session.principalId;
  updates = driverAuthorityUpdates({ uid, driverId, tourId: TOUR_ID });
  session = clientSession(updates[`app_sessions/${uid}`]);
  await testEnv.withSecurityRulesDisabled(context => context.database(databaseURL).ref().update(updates));
  await assertSucceeds(acknowledgeCurrentNotice(options));
  await assertFails(db.ref(`notification_read_state/${TOUR_ID}/${passengerPrincipal}/${NOTICE_ID}`).set(Date.now()));
  await assertFails(db.ref(`notification_read_state/${TOUR_ID}/${uid}/${NOTICE_ID}`).set(Date.now()));
  await assertSucceeds(db.ref(`notification_read_state/${TOUR_ID}/${session.principalId}/${NOTICE_ID}`).get());
});
