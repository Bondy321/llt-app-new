const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertFails, assertSucceeds, initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { reconcileCoachTrackingTour, runCoachTrackingBackfill } = require('../../functions/src/domains/admin-dashboard/coachTrackingFunctions');

const PROJECT_ID = 'demo-llt-coach-tracking-rules';
const ADMIN_UID = 'coach-tracking-admin';
const PASSENGER_UID = 'coach-tracking-passenger';
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
let testEnv;
let databaseURL;
const trusted = async operation => {
  let result;
  await testEnv.withSecurityRulesDisabled(async context => { result = await operation(context.database(databaseURL)); });
  return result;
};

function parseEmulator() {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!raw) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = raw.split(':');
  return { host, port: Number(portText) };
}

function dbFor(uid) { return testEnv.authenticatedContext(uid).database(databaseURL); }

test.before(async () => {
  const emulator = parseEmulator();
  databaseURL = `http://${emulator.host}:${emulator.port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host: emulator.host, port: emulator.port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL).ref().update({
      [`admin_users/${ADMIN_UID}`]: true,
      'admin_dashboard/v1/coach_tracking/T1': {
        schemaVersion: 1, listed: true, tourId: 'T1', assignedDrivers: [], assignmentOverflow: false,
        location: { isSharing: true, latitude: 55, longitude: -4, timestamp: 1 },
      },
      'admin_dashboard/v1/coach_tracking_status': { schemaVersion: 1, state: 'ready', completedAtMs: 1 },
    });
  });
});

test.after(async () => { await testEnv?.cleanup(); });

test('coach tracking rows and readiness are readable only by operations admins', async () => {
  for (const pathName of ['admin_dashboard/v1/coach_tracking', 'admin_dashboard/v1/coach_tracking_status']) {
    await assertFails(dbFor(PASSENGER_UID).ref(pathName).get());
    await assertSucceeds(dbFor(ADMIN_UID).ref(pathName).get());
  }
});

test('coach tracking rows and readiness reject client writes', async () => {
  await assertFails(dbFor(ADMIN_UID).ref('admin_dashboard/v1/coach_tracking/T1').set({ forged: true }));
  await assertFails(dbFor(ADMIN_UID).ref('admin_dashboard/v1/coach_tracking_status').set({ state: 'ready' }));
  await assertFails(dbFor(PASSENGER_UID).ref('admin_dashboard/v1/coach_tracking/T1').set({ forged: true }));
});

test('admins can enumerate only listed rows through the indexed field', async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.database(databaseURL).ref('admin_dashboard/v1/coach_tracking/T2').set({
      schemaVersion: 1, listed: false, deleted: true, tourId: 'T2',
    });
  });
  const rows = await dbFor(ADMIN_UID).ref('admin_dashboard/v1/coach_tracking')
    .orderByChild('listed').equalTo(true).get();
  assert.deepEqual(Object.keys(rows.val()), ['T1']);
});

test('private driver location sources remain unreadable to admins and passengers', async () => {
  for (const uid of [ADMIN_UID, PASSENGER_UID]) {
    await assertFails(dbFor(uid).ref('driver_location_sessions').get());
    await assertFails(dbFor(uid).ref('driver_tracking_sessions').get());
  }
});

test('real web subscription reflects fresh publication, Stop and assignment changes without passenger fields', async () => {
  const { subscribeCoachTracking } = await import('../../web-admin/src/services/coachTrackingService.js');
  const { buildCoachRows } = await import('../../web-admin/src/utils/coachTrackingPresentation.js');
  // Use the admin package's actual Firebase version. Mixing a compat instance
  // from the mobile package with a different modular SDK is not production.
  const appApi = await import('../../web-admin/node_modules/firebase/app/dist/index.mjs');
  const databaseApi = await import('../../web-admin/node_modules/firebase/database/dist/index.mjs');
  const app = appApi.initializeApp({ projectId: PROJECT_ID, databaseURL }, `coach-web-test-${Date.now()}`);
  const client = databaseApi.getDatabase(app);
  const { host, port } = parseEmulator();
  databaseApi.connectDatabaseEmulator(client, host, port, { mockUserToken: { sub: ADMIN_UID, user_id: ADMIN_UID } });
  const now = Date.now();
  await trusted(db => db.ref().update({
    'tours/COACH_TOUR': { name: 'Coach integration tour', tourCode: 'COACH_TOUR', isActive: true,
      driverLocation: { schemaVersion: 1, isSharing: true, mode: 'live', source: 'auto', latitude: 56.1, longitude: -4.2, timestamp: now, accuracy: 10 },
      participants: { private_passenger: { name: 'never expose passenger', email: 'private@example.test' } } },
    'drivers/D_COACH': { name: 'Integration driver', currentTourId: 'COACH_TOUR', authUid: 'never expose uid', phone: 'never expose phone' },
  }));
  let latest;
  let error;
  const unsubscribe = subscribeCoachTracking(client, {
    onRows: value => { latest = value; }, onError: value => { error = value; },
    onStatus: () => {}, onClock: () => {}, onConnection: () => {},
  }, { batchSize: 2, maxRows: 10 });
  const waitFor = async predicate => {
    const deadline = Date.now() + 15_000;
    while (!predicate() && Date.now() < deadline && !error) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(error, undefined); assert.ok(predicate(), `expected subscribed feed state; rows: ${JSON.stringify(Object.keys(latest?.rows || {}))}`);
  };
  try {
    await trusted(db => reconcileCoachTrackingTour({ db, tourId: 'COACH_TOUR' }));
    await waitFor(() => latest?.rows?.COACH_TOUR?.location?.latitude === 56.1);
    assert.equal(buildCoachRows(latest.rows, Date.now()).find(row => row.tourId === 'COACH_TOUR').state, 'live');
    assert.doesNotMatch(JSON.stringify(latest.rows), /never expose|private@example/);
    await trusted(async db => {
      await db.ref('tours/COACH_TOUR/driverLocation').remove();
      await reconcileCoachTrackingTour({ db, tourId: 'COACH_TOUR' });
    });
    await waitFor(() => latest?.rows?.COACH_TOUR && !latest.rows.COACH_TOUR.location);
    assert.equal(buildCoachRows(latest.rows, Date.now()).find(row => row.tourId === 'COACH_TOUR').position, null);
    await trusted(async db => {
      await db.ref('drivers/D_COACH/currentTourId').set('OTHER_TOUR');
      await reconcileCoachTrackingTour({ db, tourId: 'COACH_TOUR' });
    });
    await waitFor(() => latest && !latest.rows.COACH_TOUR);
  } finally { unsubscribe(); databaseApi.goOffline(client); await appApi.deleteApp(app); }
});

test('real backfill completes after indexed scans and removes obsolete rows, then can repeat', async () => {
  await trusted(db => db.ref().update({
    'tours/BACKFILL_TOUR': { name: 'Legacy ISO tour', driverLocation: { latitude: 56, longitude: -4, source: 'auto', timestamp: new Date().toISOString() } },
    'admin_dashboard/v1/coach_tracking/OBSOLETE_TOUR': { schemaVersion: 1, tourId: 'OBSOLETE_TOUR', listed: true, projectionRevision: 1 },
  }));
  const first = await trusted(db => runCoachTrackingBackfill({ db, apply: true, dryRun: false, pageSize: 1, concurrency: 1 }));
  assert.equal(first.complete, true);
  const state = await trusted(async db => ({
    status: (await db.ref('admin_dashboard/v1/coach_tracking_status').once('value')).val(),
    legacy: (await db.ref('admin_dashboard/v1/coach_tracking/BACKFILL_TOUR').once('value')).val(),
    obsolete: (await db.ref('admin_dashboard/v1/coach_tracking/OBSOLETE_TOUR').once('value')).val(),
  }));
  assert.equal(state.status.state, 'ready');
  assert.equal(state.legacy.listed, true); assert.equal(state.obsolete.listed, false);
  const second = await trusted(db => runCoachTrackingBackfill({ db, apply: true, dryRun: false, pageSize: 2, concurrency: 1 }));
  assert.equal(second.complete, true);
});
