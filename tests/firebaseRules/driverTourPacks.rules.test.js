const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-llt-driver-tour-pack-rules';
const rules = fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8');
const DEPARTURE_KEY = '2026-09-10::5001D_1';
const OTHER_DEPARTURE_KEY = '2026-09-11::5002D_1';
const EXPIRED_DEPARTURE_KEY = '2026-09-12::5003D_1';
const DRIVER_UID = 'assigned-driver';
const DRIVER_ID = 'D-100';

let testEnv;
let databaseURL;

const validAction = (nowMs = Date.now()) => ({
  schemaVersion: 1,
  packRevision: 1,
  updatedAtMs: nowMs,
  revisionAcknowledged: 1,
  pickupStops: {
    stop_1: { state: 'COMPLETED', updatedAtMs: nowMs },
  },
  serviceCompletion: {},
  issues: {},
});

const writeLeafAction = async (db, action) => {
  const base = `driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}`;
  await Promise.all([
    db.ref(`${base}/schemaVersion`).set(action.schemaVersion),
    db.ref(`${base}/packRevision`).set(action.packRevision),
    db.ref(`${base}/updatedAtMs`).set(action.updatedAtMs),
    db.ref(`${base}/revisionAcknowledged`).set(action.revisionAcknowledged),
    db.ref(`${base}/pickupStops/stop_1/state`).set(action.pickupStops.stop_1.state),
    db.ref(`${base}/pickupStops/stop_1/updatedAtMs`).set(action.pickupStops.stop_1.updatedAtMs),
  ]);
};

test.before(async () => {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!raw) throw new Error('FIREBASE_DATABASE_EMULATOR_HOST missing');
  const [host, portText] = raw.split(':');
  const port = Number(portText);
  databaseURL = `http://${host}:${port}/?ns=${PROJECT_ID}`;
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { host, port, rules },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(databaseURL);
    await db.ref('/').set({
      driver_tour_packs: {
        [DEPARTURE_KEY]: {
          schemaVersion: 1, tourId: '5001D_1', status: 'active', expiresAtMs: Date.now() + 60_000,
          pickups: { stop_1: { pickupId: 'stop_1' } }, services: {},
        },
        [OTHER_DEPARTURE_KEY]: { schemaVersion: 1, tourId: '5002D_1', status: 'active', expiresAtMs: Date.now() + 60_000 },
        [EXPIRED_DEPARTURE_KEY]: { schemaVersion: 1, tourId: '5001D_1', status: 'active', expiresAtMs: Date.now() - 1 },
      },
      driver_tour_pack_tombstones: { [DEPARTURE_KEY]: { status: 'expired' } },
      driver_tour_pack_ingestion: { latestSuccessfulRun: { runId: 'server-owned-run' } },
      users: {
        [DRIVER_UID]: { driverId: DRIVER_ID },
        'forged-driver': { driverId: DRIVER_ID },
        'stale-driver': { driverId: 'D-STALE' },
        'other-driver': { driverId: 'D-OTHER' },
      },
      drivers: {
        [DRIVER_ID]: { authUid: DRIVER_UID },
        'D-STALE': { authUid: 'stale-driver' },
        'D-OTHER': { authUid: 'other-driver' },
      },
      tour_manifests: {
        '5001D_1': { assigned_drivers: { [DRIVER_ID]: true } },
        '5002D_1': { assigned_drivers: {} },
      },
    });
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test('only a coherently assigned driver can read one exact source pack', async () => {
  const assigned = testEnv.authenticatedContext(DRIVER_UID).database(databaseURL);
  await assertSucceeds(assigned.ref(`driver_tour_packs/${DEPARTURE_KEY}`).get());
  await assertFails(assigned.ref('driver_tour_packs').get());
  await assertFails(assigned.ref(`driver_tour_packs/${OTHER_DEPARTURE_KEY}`).get());
  await assertFails(assigned.ref(`driver_tour_packs/${EXPIRED_DEPARTURE_KEY}`).get());

  for (const uid of ['passenger', 'forged-driver', 'stale-driver', 'other-driver']) {
    await assertFails(testEnv.authenticatedContext(uid).database(databaseURL).ref(`driver_tour_packs/${DEPARTURE_KEY}`).get());
  }
  await assertFails(testEnv.unauthenticatedContext().database(databaseURL).ref(`driver_tour_packs/${DEPARTURE_KEY}`).get());
});

test('clients can never write source packs or read server-only ingestion and tombstone roots', async () => {
  const contexts = [
    testEnv.unauthenticatedContext(),
    testEnv.authenticatedContext(DRIVER_UID),
    testEnv.authenticatedContext('passenger'),
    testEnv.authenticatedContext('9CWQ4705gVRkfW5Xki5LyvrmVp23'),
  ];
  for (const context of contexts) {
    const db = context.database(databaseURL);
    await assertFails(db.ref(`driver_tour_packs/${DEPARTURE_KEY}`).set({ forged: true }));
    await assertFails(db.ref(`driver_tour_pack_tombstones/${DEPARTURE_KEY}`).get());
    await assertFails(db.ref(`driver_tour_pack_tombstones/${DEPARTURE_KEY}`).set({ forged: true }));
    await assertFails(db.ref('driver_tour_pack_ingestion/latestSuccessfulRun').get());
    await assertFails(db.ref('driver_tour_pack_ingestion/latestSuccessfulRun').set({ forged: true }));
  }
});

test('driver action writes are exact-principal, bounded, closed-schema records', async () => {
  const assigned = testEnv.authenticatedContext(DRIVER_UID).database(databaseURL);
  await assertSucceeds(writeLeafAction(assigned, validAction()));
  await assertSucceeds(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}`).get());
  await assertFails(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}`).get());
  await assertFails(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/D-OTHER`).set(validAction()));

  const unknown = validAction();
  unknown.unapproved = true;
  await assertFails(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/unapproved`).set(true));

  const invalid = validAction();
  invalid.pickupStops.stop_1.state = 'WHATEVER';
  await assertFails(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/pickupStops/stop_1/state`).set(invalid.pickupStops.stop_1.state));

  const oversized = validAction();
  oversized.issues = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`issue_${index}`, {
    type: 'DELAY', status: 'OPEN', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }]));
  await assertFails(assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/issues/issue_21/type`).set('DELAY'));

  for (const uid of ['passenger', 'forged-driver', 'stale-driver']) {
    await assertFails(testEnv.authenticatedContext(uid).database(databaseURL)
      .ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/schemaVersion`).set(1));
  }
});
