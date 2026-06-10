const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-content-report-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const ADMIN_ROLE_UID = 'admin-role-content-1';
const TOUR_ID = 'TOUR_REPORT_001';
const PASSENGER_UID = 'passenger-report-1';
const OUTSIDER_UID = 'outsider-report-1';
const DRIVER_AUTH_UID = 'driver-report-auth-1';
const DRIVER_ID = 'D-REPORT';

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

const buildReport = (overrides = {}) => ({
  schemaVersion: 1,
  reportId: 'report_passenger_1',
  tourId: TOUR_ID,
  contentType: 'chat_message',
  contentId: 'message_1',
  chatScope: 'group',
  reason: 'harassment',
  status: 'open',
  reporterId: PASSENGER_UID,
  reporterAuthUid: PASSENGER_UID,
  reporterName: 'Passenger Reporter',
  contentOwnerId: 'passenger-other',
  contentOwnerName: 'Other Passenger',
  contentPreview: 'Reported message preview',
  sourcePath: `chats/${TOUR_ID}/messages/message_1`,
  details: '',
  createdAt: '2026-06-10T12:00:00.000Z',
  createdAtMs: 1781092800000,
  updatedAt: '2026-06-10T12:00:00.000Z',
  updatedAtMs: 1781092800000,
  ...overrides,
});

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

    await db.ref(`admin_users/${ADMIN_ROLE_UID}`).set(true);
    await db.ref(`tours/${TOUR_ID}/participants/${PASSENGER_UID}`).set({
      userId: PASSENGER_UID,
      joinedAt: 1781090000000,
    });
    await db.ref(`drivers/${DRIVER_ID}`).set({
      name: 'Report Driver',
      authUid: DRIVER_AUTH_UID,
    });
    await db.ref(`users/${DRIVER_AUTH_UID}`).set({
      driverId: DRIVER_ID,
      principalType: 'driver',
    });
    await db.ref(`tour_manifests/${TOUR_ID}/assigned_drivers/${DRIVER_ID}`).set(true);
    await db.ref(`chats/${TOUR_ID}/messages/message_1`).set({
      senderId: 'passenger-other',
      senderStableId: 'passenger-other',
      senderName: 'Other Passenger',
      text: 'Reported message preview',
      timestamp: 1781090000001,
      isDriver: false,
      status: 'sent',
    });
    await db.ref(`group_tour_photos/${TOUR_ID}/photo_1`).set({
      sourceUrl: 'https://example.com/source.jpg',
      userId: 'passenger-other',
      caption: 'Reported photo',
      timestamp: 1781090000002,
    });
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('allows tour participants and assigned drivers to create valid content reports', async () => {
  await assertSucceeds(
    dbFor(PASSENGER_UID).ref('content_reports/report_passenger_1').set(buildReport()),
  );

  await assertSucceeds(
    dbFor(DRIVER_AUTH_UID).ref('content_reports/report_driver_1').set(buildReport({
      reportId: 'report_driver_1',
      reporterId: `driver:${DRIVER_ID}`,
      reporterAuthUid: DRIVER_AUTH_UID,
      reporterName: 'Report Driver',
      contentType: 'group_photo',
      contentId: 'photo_1',
      sourcePath: `group_tour_photos/${TOUR_ID}/photo_1`,
    })),
  );
});

test('denies content report creation by users outside the tour', async () => {
  await assertFails(
    dbFor(OUTSIDER_UID).ref('content_reports/report_outsider_1').set(buildReport({
      reportId: 'report_outsider_1',
      reporterId: OUTSIDER_UID,
      reporterAuthUid: OUTSIDER_UID,
    })),
  );
});

test('keeps reporter reports read-only after creation while allowing admin review', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref('content_reports/report_review_1').set(buildReport({
      reportId: 'report_review_1',
    }));
  });

  await assertSucceeds(dbFor(PASSENGER_UID).ref('content_reports/report_review_1').get());
  await assertFails(dbFor(OUTSIDER_UID).ref('content_reports/report_review_1').get());
  await assertFails(dbFor(PASSENGER_UID).ref('content_reports/report_review_1/status').set('dismissed'));
  await assertSucceeds(dbFor(ADMIN_ROLE_UID).ref('content_reports/report_review_1/status').set('reviewing'));
});

test('allows admin users to remove reported chat messages and group photos', async () => {
  await assertSucceeds(dbFor(ADMIN_ROLE_UID).ref(`chats/${TOUR_ID}/messages/message_1`).remove());
  await assertSucceeds(dbFor(ADMIN_ROLE_UID).ref(`group_tour_photos/${TOUR_ID}/photo_1`).remove());
});

test('denies malformed or status-mutated report creation', async () => {
  await assertFails(
    dbFor(PASSENGER_UID).ref('content_reports/report_bad_type').set(buildReport({
      reportId: 'report_bad_type',
      contentType: 'private_photo',
    })),
  );

  await assertFails(
    dbFor(PASSENGER_UID).ref('content_reports/report_bad_status').set(buildReport({
      reportId: 'report_bad_status',
      status: 'reviewing',
    })),
  );
});

test('allows the hardcoded admin to inspect the moderation queue', async () => {
  await assertSucceeds(dbFor(ADMIN_UID).ref('content_reports').get());
});
