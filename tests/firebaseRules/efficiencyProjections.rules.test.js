const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-efficiency-projection-rules';
const PRIMARY_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const DIRECTORY_ADMIN_UID = 'efficiency-admin';
const PASSENGER_UID = 'efficiency-passenger';
const DRIVER_UID = 'efficiency-driver';
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');

let testEnv;
let databaseURL;

function parseEmulator() {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!raw) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = raw.split(':');
  return { host, port: Number(portText) };
}

function dbFor(uid) {
  return testEnv.authenticatedContext(uid).database(databaseURL);
}

test.before(async () => {
  const emulator = parseEmulator();
  databaseURL = `http://${emulator.host}:${emulator.port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL).ref().update({
      [`admin_users/${DIRECTORY_ADMIN_UID}`]: true,
      'notification_marketing_audience/v1/day_trips/device-a': {
        schemaVersion: 1,
        registrationRevision: 4,
      },
      'notification_audience_rollout/v1': {
        schemaVersion: 1,
        phase: 'legacy_scan',
        revision: 1,
        updatedAtMs: 1788170400000,
      },
      'admin_dashboard/v1/tours/tour-a': {
        schemaVersion: 1,
        tourId: 'tour-a',
        startAtMs: 1788170400000,
        projectionRevision: 1,
      },
      'admin_dashboard/v1/safety_attention/event-a': {
        schemaVersion: 1,
        eventId: 'event-a',
        attentionSortKey: '3:1788170400000:event-a',
        projectionRevision: 1,
      },
      'admin_dashboard/v1/recent_broadcasts/broadcast-a': {
        schemaVersion: 1,
        broadcastId: 'broadcast-a',
        createdAtMs: 1788170400000,
        projectionRevision: 1,
      },
      'admin_dashboard/v1/summary': {
        schemaVersion: 1,
        currentUpcomingTourCount: 1,
        projectionRevision: 1,
      },
      'admin_dashboard/v1/internal/manifest_booking_counts/tour-a/opaque-a': 2,
      'admin_dashboard_rollout/v1': {
        schemaVersion: 1,
        phase: 'legacy',
        revision: 1,
        updatedAtMs: 1788170400000,
      },
    });
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test('notification audience indexes and rollout remain private and server-owned', async () => {
  const protectedPaths = [
    'notification_marketing_audience/v1/day_trips/device-a',
    'notification_audience_rollout/v1',
  ];

  for (const uid of [PASSENGER_UID, DRIVER_UID, DIRECTORY_ADMIN_UID, PRIMARY_ADMIN_UID]) {
    for (const protectedPath of protectedPaths) {
      await assertFails(dbFor(uid).ref(protectedPath).get());
      await assertFails(dbFor(uid).ref(protectedPath).set({ forged: true }));
    }
  }
});

test('only authorised administrators can read public dashboard projections', async () => {
  const publicPaths = [
    'admin_dashboard/v1/tours',
    'admin_dashboard/v1/safety_attention',
    'admin_dashboard/v1/recent_broadcasts',
    'admin_dashboard/v1/summary',
  ];

  for (const publicPath of publicPaths) {
    await assertFails(dbFor(PASSENGER_UID).ref(publicPath).get());
    await assertFails(dbFor(DRIVER_UID).ref(publicPath).get());
    await assertSucceeds(dbFor(DIRECTORY_ADMIN_UID).ref(publicPath).get());
    await assertSucceeds(dbFor(PRIMARY_ADMIN_UID).ref(publicPath).get());
  }

  await assertFails(dbFor(PASSENGER_UID).ref('admin_dashboard_rollout/v1').get());
  await assertFails(dbFor(DRIVER_UID).ref('admin_dashboard_rollout/v1').get());
  await assertSucceeds(dbFor(DIRECTORY_ADMIN_UID).ref('admin_dashboard_rollout/v1').get());
  await assertSucceeds(dbFor(PRIMARY_ADMIN_UID).ref('admin_dashboard_rollout/v1').get());
});

test('clients cannot forge dashboard rows, internal summaries, rollout, or counts', async () => {
  const protectedWrites = [
    ['admin_dashboard/v1/tours/forged', { schemaVersion: 1, tourId: 'forged', startAtMs: 1 }],
    ['admin_dashboard/v1/summary/currentUpcomingTourCount', 999999],
    ['admin_dashboard/v1/internal/manifest_booking_counts/tour-a/opaque-a', 999999],
    ['admin_dashboard_rollout/v1/phase', 'projection'],
  ];

  for (const uid of [PASSENGER_UID, DRIVER_UID, DIRECTORY_ADMIN_UID, PRIMARY_ADMIN_UID]) {
    for (const [protectedPath, value] of protectedWrites) {
      await assertFails(dbFor(uid).ref(protectedPath).set(value));
    }
  }

  await assertFails(dbFor(DIRECTORY_ADMIN_UID).ref('admin_dashboard/v1/internal').get());
  await assertFails(dbFor(PRIMARY_ADMIN_UID).ref('admin_dashboard/v1/internal').get());
});
