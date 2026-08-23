const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-safety-alert-rules';
const ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const DELEGATED_ADMIN_UID = 'delegated-admin-1';
const PASSENGER_UID = 'safety-passenger-1';
const OUTSIDER_UID = 'safety-outsider-1';
const TOUR_ID = 'TOUR_1';
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
const dbFor = (uid) => testEnv.authenticatedContext(uid).database(dbUrl);

test.before(async () => {
  const emulator = parseHost();
  dbUrl = emulator.databaseURL;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(dbUrl).ref().set({
      admin_users: { [DELEGATED_ADMIN_UID]: true },
      tours: {
        [TOUR_ID]: {
          tourCode: 'TOUR 1',
          participants: { [PASSENGER_UID]: { joinedAt: '2026-08-12T10:00:00.000Z' } },
          safetyAlerts: { 'event-1': pendingAlert() },
        },
      },
      globalSafetyAlerts: {
        'event-1': pendingAlert(),
      },
      logs: {
        [PASSENGER_UID]: {
          safety: { 'event-1': pendingAlert() },
        },
      },
    });
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

const pendingAlert = (userId = PASSENGER_UID) => ({
  eventId: 'event-1',
  tourId: TOUR_ID,
  timestamp: '2026-08-12T10:00:00.000Z',
  status: 'pending',
  userId,
  severity: 'critical',
  category: 'incident',
  message: 'Safety assistance requested',
  isSOS: false,
});

const versionedAlert = () => ({
  schemaVersion: 2,
  eventId: 'event-v2',
  clientEventId: 'event-v2',
  tourId: TOUR_ID,
  reporterAuthUid: PASSENGER_UID,
  userId: PASSENGER_UID,
  principalId: 'pax_v1:BOOKING:passenger@example.com',
  role: 'passenger',
  category: 'medical',
  severity: 'critical',
  message: 'Medical assistance requested',
  isSOS: false,
  status: 'pending',
  timestamp: '2026-08-14T10:00:00.000Z',
  timestampMs: 1786701600000,
  clientCreatedAt: '2026-08-14T09:59:55.000Z',
  clientCreatedAtMs: 1786701595000,
  receivedAt: '2026-08-14T10:00:00.000Z',
  receivedAtMs: 1786701600000,
  processedFromQueue: false,
});

test('participants cannot bypass the authenticated safety Function with direct legacy writes', async () => {
  await assertFails(dbFor(PASSENGER_UID).ref(`tours/${TOUR_ID}/safetyAlerts/event-1`).set(pendingAlert()));
  await assertFails(dbFor(PASSENGER_UID).ref('globalSafetyAlerts/event-1').set(pendingAlert()));
});

test('participants cannot acknowledge, resolve, or rewrite safety ownership', async () => {
  const passengerDb = dbFor(PASSENGER_UID);
  await assertFails(passengerDb.ref(`tours/${TOUR_ID}/safetyAlerts/event-1/status`).set('resolved'));
  await assertFails(passengerDb.ref('globalSafetyAlerts/event-1/status').set('acknowledged'));
  await assertFails(passengerDb.ref(`tours/${TOUR_ID}/safetyAlerts/forged`).set(pendingAlert(OUTSIDER_UID)));
  await assertFails(passengerDb.ref(`tours/${TOUR_ID}/safetyAlerts/event-v2`).set(versionedAlert()));
});

test('backend-shaped versioned safety records remain valid for operations status and delivery updates', async () => {
  const record = versionedAlert();
  await assertSucceeds(dbFor(ADMIN_UID).ref().update({
    [`tours/${TOUR_ID}/safetyAlerts/event-v2`]: record,
    'globalSafetyAlerts/event-v2': {
      ...record,
      tourAlertId: `tours/${TOUR_ID}/safetyAlerts/event-v2`,
    },
  }));
  await assertSucceeds(dbFor(DELEGATED_ADMIN_UID).ref().update({
    [`tours/${TOUR_ID}/safetyAlerts/event-v2/status`]: 'acknowledged',
    [`tours/${TOUR_ID}/safetyAlerts/event-v2/notificationDeliveryStatus`]: 'accepted',
    'globalSafetyAlerts/event-v2/status': 'acknowledged',
    'globalSafetyAlerts/event-v2/notificationDeliveryStatus': 'accepted',
  }));
});

test('delegated and primary operations admins can update both safety copies', async () => {
  const updates = {
    [`tours/${TOUR_ID}/safetyAlerts/event-1/status`]: 'acknowledged',
    [`tours/${TOUR_ID}/safetyAlerts/event-1/statusUpdatedBy`]: 'web-admin',
    'globalSafetyAlerts/event-1/status': 'acknowledged',
    'globalSafetyAlerts/event-1/statusUpdatedBy': 'web-admin',
    [`logs/${PASSENGER_UID}/safety/event-1/status`]: 'acknowledged',
    [`logs/${PASSENGER_UID}/safety/event-1/statusUpdatedAt`]: '2026-08-12T10:05:00.000Z',
    [`logs/${PASSENGER_UID}/safety/event-1/statusUpdatedBy`]: 'web-admin',
  };
  await assertSucceeds(dbFor(DELEGATED_ADMIN_UID).ref().update(updates));
  await assertSucceeds(dbFor(ADMIN_UID).ref().update({
    [`tours/${TOUR_ID}/safetyAlerts/event-1/status`]: 'resolved',
    'globalSafetyAlerts/event-1/status': 'resolved',
  }));
});

test('outsiders cannot create or update safety records', async () => {
  await assertFails(dbFor(OUTSIDER_UID).ref(`tours/${TOUR_ID}/safetyAlerts/outsider`).set(pendingAlert(OUTSIDER_UID)));
  await assertFails(dbFor(OUTSIDER_UID).ref('globalSafetyAlerts/outsider').set({
    ...pendingAlert(OUTSIDER_UID),
    eventId: 'outsider',
  }));
  await assertFails(dbFor(OUTSIDER_UID).ref('globalSafetyAlerts/event-1/status').set('resolved'));
  await assertFails(dbFor(OUTSIDER_UID).ref(`logs/${PASSENGER_UID}/safety/event-1/status`).set('resolved'));
});

test('distributed safety quota buckets stay server-private', async () => {
  const passengerDb = dbFor(PASSENGER_UID);
  await assertFails(passengerDb.ref('safety_rate_limits/v1/safety_uid_probe').get());
  await assertFails(passengerDb.ref('safety_rate_limits/v1/safety_uid_probe').set({
    version: 1,
    count: 1,
    resetAtMs: Date.now() + 60000,
    expiresAtMs: Date.now() + 3600000,
  }));
});
