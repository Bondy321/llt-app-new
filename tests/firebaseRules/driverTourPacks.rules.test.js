const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NODE_ENV = 'test';
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { createDriverTourPackActionService } = require('../../services/driverTourPackActionService');
const { driverAuthorityUpdates } = require('./sessionFixtures');

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
  hotelCompletion: {},
  issues: {},
});

const validIssue = (nowMs = Date.now(), issueId = 'issue_001') => ({
  schemaVersion: 1,
  issueId,
  category: 'vehicle',
  severity: 'warning',
  status: 'open',
  summary: 'Warning light is on',
  revision: 1,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
  statusUpdatedAtMs: nowMs,
  statusUpdatedBy: 'driver',
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
          schemaVersion: 1, revision: 1, tourId: '5001D_1', status: 'active', expiresAtMs: Date.now() + 60_000,
          pickups: { stop_1: { pickupId: 'stop_1' } },
          services: { service_1: { serviceId: 'service_1' } },
          hotels: { hotel_1: { hotelId: 'hotel_1' } },
        },
        [OTHER_DEPARTURE_KEY]: { schemaVersion: 1, revision: 1, tourId: '5002D_1', status: 'active', expiresAtMs: Date.now() + 60_000 },
        [EXPIRED_DEPARTURE_KEY]: { schemaVersion: 1, revision: 1, tourId: '5001D_1', status: 'active', expiresAtMs: Date.now() - 1 },
      },
      driver_tour_pack_tombstones: { [DEPARTURE_KEY]: { status: 'expired' } },
      driver_tour_pack_ingestion: { latestSuccessfulRun: { runId: 'server-owned-run' } },
      driver_tour_pack_admin_status: {
        [DEPARTURE_KEY]: {
          schemaVersion: 1, departureKey: DEPARTURE_KEY, tourId: '5001D_1', tourCode: '5001D 1',
          dateISO: '2026-09-10', status: 'active', qualityState: 'complete', revision: 1,
          publishedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, sourceSnapshotDate: '2026-08-20', runId: 'server-owned-run',
        },
      },
      driver_tour_pack_feature_flags: {
        global: false,
        testflight: false,
        drivers: { [DRIVER_ID]: true, 'D-OTHER': false },
      },
      driver_tour_pack_changes: {
        [DEPARTURE_KEY]: { latest: { schemaVersion: 1, departureKey: DEPARTURE_KEY, tourId: '5001D_1', revision: 1 } },
      },
      driver_tour_pack_progress: {
        [DEPARTURE_KEY]: { [DRIVER_ID]: { schemaVersion: 1, departureKey: DEPARTURE_KEY, driverId: DRIVER_ID, pickupCompleted: 1 } },
      },
      driver_tour_pack_issues: {
        issue_seed: { schemaVersion: 1, issueId: 'issue_seed', departureKey: DEPARTURE_KEY, driverId: DRIVER_ID, category: 'delay', severity: 'warning', status: 'open', updatedAtMs: Date.now() },
      },
      users: {
        [DRIVER_UID]: { driverId: DRIVER_ID },
        'forged-driver': { driverId: DRIVER_ID },
        'stale-driver': { driverId: 'D-STALE' },
        'other-driver': { driverId: 'D-OTHER' },
      },
      admin_users: { 'allowlisted-admin': true },
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
    await db.ref().update(driverAuthorityUpdates({ uid: DRIVER_UID, driverId: DRIVER_ID, tourId: '5001D_1' }));
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

test('only operations admins can list the PII-free driver Tour Pack admin status index', async () => {
  const primaryAdmin = testEnv.authenticatedContext('9CWQ4705gVRkfW5Xki5LyvrmVp23').database(databaseURL);
  await assertSucceeds(primaryAdmin.ref('driver_tour_pack_admin_status').get());
  await assertSucceeds(primaryAdmin.ref(`driver_tour_pack_admin_status/${DEPARTURE_KEY}`).get());
  await assertFails(primaryAdmin.ref(`driver_tour_pack_admin_status/${DEPARTURE_KEY}`).set({ forged: true }));
  await assertSucceeds(testEnv.authenticatedContext('allowlisted-admin').database(databaseURL)
    .ref('driver_tour_pack_admin_status').get());

  for (const uid of [DRIVER_UID, 'passenger', 'forged-driver']) {
    await assertFails(testEnv.authenticatedContext(uid).database(databaseURL).ref('driver_tour_pack_admin_status').get());
  }
  await assertFails(testEnv.unauthenticatedContext().database(databaseURL).ref('driver_tour_pack_admin_status').get());
});

test('feature flags are exact-read, coherent-driver canaries with admin-only boolean writes', async () => {
  const assigned = testEnv.authenticatedContext(DRIVER_UID).database(databaseURL);
  const other = testEnv.authenticatedContext('other-driver').database(databaseURL);
  const passenger = testEnv.authenticatedContext('passenger').database(databaseURL);
  const forged = testEnv.authenticatedContext('forged-driver').database(databaseURL);
  const primaryAdmin = testEnv.authenticatedContext('9CWQ4705gVRkfW5Xki5LyvrmVp23').database(databaseURL);
  const allowlistedAdmin = testEnv.authenticatedContext('allowlisted-admin').database(databaseURL);

  await assertSucceeds(assigned.ref('driver_tour_pack_feature_flags/global').get());
  await assertFails(passenger.ref('driver_tour_pack_feature_flags/global').get());
  await assertSucceeds(assigned.ref('driver_tour_pack_feature_flags/testflight').get());
  await assertSucceeds(assigned.ref(`driver_tour_pack_feature_flags/drivers/${DRIVER_ID}`).get());
  await assertFails(other.ref('driver_tour_pack_feature_flags/drivers/D-OTHER').get());
  await assertFails(assigned.ref('driver_tour_pack_feature_flags').get());
  await assertFails(assigned.ref('driver_tour_pack_feature_flags/drivers').get());
  await assertFails(assigned.ref('driver_tour_pack_feature_flags/drivers/D-OTHER').get());
  await assertFails(passenger.ref(`driver_tour_pack_feature_flags/drivers/${DRIVER_ID}`).get());
  await assertFails(forged.ref(`driver_tour_pack_feature_flags/drivers/${DRIVER_ID}`).get());
  await assertFails(testEnv.unauthenticatedContext().database(databaseURL)
    .ref('driver_tour_pack_feature_flags/global').get());

  await assertSucceeds(primaryAdmin.ref('driver_tour_pack_feature_flags/global').set(true));
  await assertSucceeds(primaryAdmin.ref('driver_tour_pack_feature_flags/testflight').set(true));
  await assertSucceeds(allowlistedAdmin.ref(`driver_tour_pack_feature_flags/drivers/${DRIVER_ID}`).set(false));
  await assertFails(primaryAdmin.ref('driver_tour_pack_feature_flags/global').set({ enabled: true }));
  await assertFails(assigned.ref('driver_tour_pack_feature_flags/global').set(false));
  await assertFails(assigned.ref('driver_tour_pack_feature_flags/testflight').set(false));
  await assertFails(assigned.ref(`driver_tour_pack_feature_flags/drivers/${DRIVER_ID}`).set(true));
});

test('semantic change metadata is exact-assignment readable and operational projections are admin-only', async () => {
  const assigned = testEnv.authenticatedContext(DRIVER_UID).database(databaseURL);
  const passenger = testEnv.authenticatedContext('passenger').database(databaseURL);
  const admin = testEnv.authenticatedContext('allowlisted-admin').database(databaseURL);

  await assertSucceeds(assigned.ref(`driver_tour_pack_changes/${DEPARTURE_KEY}/latest`).get());
  await assertFails(assigned.ref('driver_tour_pack_changes').get());
  await assertFails(passenger.ref(`driver_tour_pack_changes/${DEPARTURE_KEY}/latest`).get());
  await assertFails(assigned.ref(`driver_tour_pack_changes/${OTHER_DEPARTURE_KEY}`).get());
  await assertFails(assigned.ref(`driver_tour_pack_changes/${DEPARTURE_KEY}/latest`).set({ forged: true }));

  await assertSucceeds(admin.ref('driver_tour_pack_progress').get());
  await assertSucceeds(admin.ref('driver_tour_pack_issues').get());
  await assertFails(assigned.ref('driver_tour_pack_progress').get());
  await assertFails(assigned.ref('driver_tour_pack_issues').get());
  await assertFails(admin.ref(`driver_tour_pack_progress/${DEPARTURE_KEY}/${DRIVER_ID}`).set({ forged: true }));
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

  const base = `driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}`;
  const stamp = Date.now();
  await assertSucceeds(assigned.ref(base).update({
    packRevision: 1,
    updatedAtMs: stamp,
    'serviceCompletion/service_1/state': 'COMPLETED',
    'serviceCompletion/service_1/updatedAtMs': stamp,
    'hotelCompletion/hotel_1/state': 'COMPLETED',
    'hotelCompletion/hotel_1/updatedAtMs': stamp,
  }));
  await assertFails(assigned.ref(`${base}/hotelCompletion/unknown/state`).set('COMPLETED'));

  const issue = validIssue(stamp);
  await assertSucceeds(assigned.ref(base).update({
    packRevision: 1,
    updatedAtMs: stamp,
    ...Object.fromEntries(Object.entries(issue).map(([field, value]) => [`issues/issue_001/${field}`, value])),
  }));
  const emailIssue = {
    ...validIssue(stamp, 'issue_002'),
    summary: 'Contact passenger@example.com',
  };
  await assertFails(assigned.ref(base).update(Object.fromEntries(
    Object.entries(emailIssue).map(([field, value]) => [`issues/issue_002/${field}`, value]),
  )));
  await assertFails(assigned.ref(`${base}/issues/issue_001/category`).set('other'));

  const admin = testEnv.authenticatedContext('allowlisted-admin').database(databaseURL);
  await assertSucceeds(admin.ref(base).update({
    'issues/issue_001/status': 'acknowledged',
    'issues/issue_001/updatedAtMs': stamp + 1,
    'issues/issue_001/statusUpdatedAtMs': stamp + 1,
    'issues/issue_001/statusUpdatedBy': 'operations',
  }));
  await assertFails(admin.ref(`${base}/issues/issue_001/summary`).set('Changed by admin'));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database(databaseURL);
    const issues = Object.fromEntries(Array.from({ length: 99 }, (_, index) => {
      const issueId = `issue_${String(index + 2).padStart(3, '0')}`;
      return [issueId, validIssue(stamp, issueId)];
    }));
    await db.ref(`${base}/issues`).update(issues);
  });
  const overflowIssue = validIssue(stamp, 'issue_101');
  await assertFails(assigned.ref(base).update(Object.fromEntries(
    Object.entries(overflowIssue).map(([field, value]) => [`issues/issue_101/${field}`, value]),
  )));

  for (const uid of ['passenger', 'forged-driver', 'stale-driver']) {
    await assertFails(testEnv.authenticatedContext(uid).database(databaseURL)
      .ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/schemaVersion`).set(1));
  }
});

test('the mobile action service writes progress through the permitted leaves', async () => {
  const assigned = testEnv.authenticatedContext(DRIVER_UID).database(databaseURL);
  const service = createDriverTourPackActionService({ now: () => Date.now() });
  const result = await service.submitDirect({
    authUid: DRIVER_UID,
    driverId: DRIVER_ID,
    departureKey: DEPARTURE_KEY,
    tourId: '5001D_1',
    packRevision: 1,
    kind: 'pickup',
    targetId: 'stop_1',
    state: 'SKIPPED',
    clientUpdatedAtMs: Date.now(),
  }, assigned);

  assert.equal(result.success, true);
  assert.equal((await assigned.ref(`driver_tour_pack_actions/${DEPARTURE_KEY}/${DRIVER_ID}/pickupStops/stop_1/state`).get()).val(), 'SKIPPED');
});
