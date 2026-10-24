'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
for (const key of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[key] || '')) throw new Error('Local Auth and database emulators required');
}
const projectId = 'demo-llt-driver-first-claim';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
process.env.REQUIRE_APP_CHECK_FOR_LOGIN = 'false';
const admin = require('../functions/node_modules/firebase-admin');
const express = require('../functions/node_modules/express');
const { issueStaffEnrolment } = require('../functions/src/domains/driver-auth/staffEnrolment');
const { verifyDriverLogin } = require('../functions/src/domains/driver-auth/driverLoginFunction');
const { setDriverLoginPolicy, advanceDriverPolicyTransition, processDriverLoginPolicyCleanupJobs } = require('../functions/src/domains/driver-auth/driverDevicePolicyFunctions');
const { assignDriverToTour } = require('../functions/src/domains/driver-assignment/driverAssignmentFunction');
const { driverBindingAllowedByPolicy, readDriverLoginPolicy, beginDriverPolicyTransition } = require('../functions/src/domains/driver-auth/driverDevicePolicy');
const { loadDriverSessionAuthUids } = require('../functions/src/domains/notifications/notificationDelivery');
const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'first-claim-fixtures');
const db = writer.database();
let server; let origin; let operator; let assignmentResponseGate;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const eventually = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected realtime application state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

// The Auth emulator deliberately accepts unsigned JWTs and verifies that the
// actual emulated user exists. Keep this namespace isolated from parallel files.
const identity = async ({ mfa = false } = {}) => {
  const uid = `synthetic-${randomUUID()}`;
  await writer.auth().createUser({ uid });
  const now = Math.floor(Date.now() / 1000);
  const token = [ { alg: 'none', typ: 'JWT' }, {
    iss: `https://securetoken.google.com/${projectId}`, aud: projectId, sub: uid,
    user_id: uid, auth_time: now, iat: now, exp: now + 3600,
    firebase: { identities: {}, sign_in_provider: mfa ? 'password' : 'anonymous', ...(mfa ? { sign_in_second_factor: 'totp' } : {}) },
  } ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.';
  return { uid, token };
};
const idle = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [policy, assignments] = await Promise.all([
      db.ref('driver_login_policy/v1/loginAdmissions').get(), db.ref('driver_assignment_active/v1').get(),
    ]);
    if (!policy.exists() && !Object.values(assignments.val() || {}).some(entry => entry.loginAdmissions)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Real login handlers did not release their admissions');
};
const request = async (route, actor, body) => {
  if (route === 'driver' && !body.enrolmentSecret) {
    const approval = await issueStaffEnrolment({ db, driverId: body.driverId, adminUid: operator.uid });
    body = { ...body, enrolmentSecret: approval.secret };
  }
  const response = await fetch(`${origin}/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
};
const login = async actor => {
  const response = await request('driver', actor, { driverId: 'D-SYNTHETIC' });
  await idle();
  return response;
};
const policy = async enabled => {
  const current = (await readDriverLoginPolicy({ db })).policy;
  const result = await request('policy', operator, { enforceSingleDevice: enabled, expectedRevision: current.revision });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await readDriverLoginPolicy({ db })).transition.phase === 'stable') break;
    await advanceDriverPolicyTransition({ db });
  }
  assert.equal((await readDriverLoginPolicy({ db })).transition.phase, 'stable');
  return (await readDriverLoginPolicy({ db })).policy;
};

test.before(async () => {
  await installDemoDatabaseRules({ projectId });
  const app = express(); app.use(express.json());
  app.post('/driver', verifyDriverLogin); app.post('/policy', setDriverLoginPolicy);
  app.post('/assignment', (req, res, next) => {
    const gate = assignmentResponseGate;
    if (gate) {
      const json = res.json.bind(res);
      res.json = body => {
        gate.captured.resolve(body);
        void gate.release.promise.then(() => json(body));
        return res;
      };
    }
    return assignDriverToTour(req, res, next);
  });
  app.use((error, _req, res, _next) => res.status(500).json({ harnessError: error.message }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  operator = await identity({ mfa: true });
});
test.beforeEach(async () => {
  await idle();
  await db.ref().set({
    admin_users: { [operator.uid]: true },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false, generation: 0,
      revision: 1, updatedAtMs: Date.now(), transitionPhase: 'stable' } },
    drivers: { 'D-SYNTHETIC': { name: 'Synthetic Driver', authUid: 'obsolete-installation' } },
    tours: { SYNTHETIC_TOUR: { name: 'Synthetic Tour', isActive: true, tourCode: 'SYNTHETIC TOUR', startDate: '2026-10-19' } },
  });
});
test.after(async () => {
  await idle();
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.all(admin.apps.map(app => app.delete()));
});

test('normal enforcement transition clears old claims, then the first handset claims and same-UID login remains valid', async () => {
  const activePolicy = await policy(true);
  assert.equal(activePolicy.generation, 1);
  assert.equal((await db.ref('drivers/D-SYNTHETIC/authUid').get()).exists(), false);
  const first = await identity();
  assert.equal(driverBindingAllowedByPolicy({ policy: activePolicy, authUid: first.uid }), false,
    'unclaimed driver must remain ineligible for established-authority consumers');
  const result = await login(first);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.valid, true);
  assert.equal((await db.ref(`app_sessions/${first.uid}/driverLoginPolicyGeneration`).get()).val(), activePolicy.generation);
  assert.equal((await db.ref('drivers/D-SYNTHETIC/authUid').get()).val(), first.uid);
  assert.equal((await verifyActiveAppSession({ db, authUid: first.uid, expectedSessionId: result.body.session.sessionId, allowUnassignedDriver: true })).allowed, true);
  const repeated = await login(first);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.notEqual(repeated.body.session.sessionId, result.body.session.sessionId);
  const second = await identity();
  const denied = await login(second);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'DRIVER_ALREADY_LINKED');
  assert.equal((await db.ref(`app_sessions/${second.uid}`).get()).exists(), false);
  assert.equal((await db.ref(`users/${second.uid}/driverId`).get()).exists(), false);
});

test('same enrolment receipt recovers the committed session through its new exact login admission', async () => {
  const actor = await identity();
  const approval = await issueStaffEnrolment({ db, driverId: 'D-SYNTHETIC', adminUid: operator.uid });
  const body = { driverId: 'D-SYNTHETIC', enrolmentSecret: approval.secret };
  const first = await request('driver', actor, body);
  await idle();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await request('driver', actor, body);
  await idle();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.session.sessionId, first.body.session.sessionId);
});

test('two concurrent first-handset logins have exactly one winner and leave no losing authority', async () => {
  await policy(true);
  const candidates = await Promise.all([identity(), identity()]);
  const results = await Promise.all(candidates.map(actor => request('driver', actor, { driverId: 'D-SYNTHETIC' })));
  await idle();
  assert.equal(results.filter(result => result.status === 200 && result.body.valid).length, 1, JSON.stringify(results));
  const winningIndex = results.findIndex(result => result.body.valid === true);
  const loser = candidates[1 - winningIndex]; const winner = candidates[winningIndex];
  assert.ok([403, 409].includes(results[1 - winningIndex].status));
  assert.equal((await db.ref('drivers/D-SYNTHETIC/authUid').get()).val(), winner.uid);
  for (const path of [`app_sessions/${loser.uid}`, `users/${loser.uid}/driverId`, `notification_devices/${loser.uid}`]) {
    assert.equal((await db.ref(path).get()).exists(), false, path);
  }
  assert.equal((await db.ref('driver_login_claim_reservations').get()).exists(), false);
  assert.equal((await login(loser)).body.reason, 'DRIVER_ALREADY_LINKED');
  assert.equal((await verifyActiveAppSession({ db, authUid: winner.uid, expectedSessionId: results[winningIndex].body.session.sessionId, allowUnassignedDriver: true })).allowed, true);
});

test('a newly created code can receive its first claim under enforcement and policy-off still allows multiple phones', async () => {
  await policy(true);
  await db.ref('drivers/D-SYNTHETIC').set({ name: 'New synthetic driver' });
  const first = await identity(); const second = await identity();
  assert.equal((await login(first)).status, 200);
  await policy(false);
  const other = await login(second);
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const sessions = (await db.ref('app_sessions').get()).val();
  assert.ok(sessions[first.uid] && sessions[second.uid]);
  for (const actor of [first, second]) {
    assert.equal((await verifyActiveAppSession({ db, authUid: actor.uid, expectedSessionId: sessions[actor.uid].sessionId, allowUnassignedDriver: true })).allowed, true);
  }
});

test('login admission does not make an unclaimed assigned session eligible for notifications', async () => {
  await policy(true);
  await db.ref().update({ 'drivers/D-SYNTHETIC/currentTourId': 'SYNTHETIC_TOUR',
    'tour_manifests/SYNTHETIC_TOUR/assigned_drivers/D-SYNTHETIC': true });
  const handset = await identity();
  assert.equal((await login(handset)).status, 200);
  const load = async () => loadDriverSessionAuthUids('D-SYNTHETIC', { db, tourId: 'SYNTHETIC_TOUR',
    driverData: (await db.ref('drivers/D-SYNTHETIC').get()).val() });
  assert.deepEqual(await load(), [handset.uid]);
  await db.ref('drivers/D-SYNTHETIC/authUid').remove();
  assert.deepEqual(await load(), [], 'strict established binding is unchanged');
  await db.ref('drivers/D-SYNTHETIC/authUid').set(handset.uid);
  assert.deepEqual(await load(), [handset.uid]);
});

test('an admitted login linearizes before a policy drain; a later claim survives obsolete cleanup', async t => {
  await policy(false);
  const first = await identity(); const next = await identity();
  let reached; let resume;
  const paused = new Promise(resolve => { reached = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  const productionDb = admin.database(); const originalRef = productionDb.ref.bind(productionDb);
  let armed = true;
  t.mock.method(productionDb, 'ref', (path = '') => {
    const ref = path ? originalRef(path) : originalRef();
    if (path === 'drivers/D-SYNTHETIC') {
      const once = ref.once.bind(ref);
      ref.once = async (...args) => {
        const snapshot = await once(...args);
        if (armed) { armed = false; reached(); await released; }
        return snapshot;
      };
    }
    return ref;
  });
  const pending = request('driver', first, { driverId: 'D-SYNTHETIC' });
  try {
    await Promise.race([paused, new Promise((_, reject) => setTimeout(() => reject(new Error('Login pause not reached')), 10000).unref())]);
    const current = (await readDriverLoginPolicy({ db })).policy;
    assert.equal((await beginDriverPolicyTransition({ db, enforceSingleDevice: true,
      expectedRevision: current.revision, actorHash: 'synthetic-operator' })).started, true);
    assert.equal((await advanceDriverPolicyTransition({ db })).status, 'draining');
    const late = await request('driver', next, { driverId: 'D-SYNTHETIC' });
    assert.equal(late.body.reason, 'DRIVER_POLICY_CHANGE_IN_PROGRESS');
  } finally { resume(); }
  assert.equal((await pending).status, 200);
  await idle();
  for (let i = 0; i < 4; i += 1) await advanceDriverPolicyTransition({ db });
  assert.equal((await readDriverLoginPolicy({ db })).transition.phase, 'stable');
  assert.equal((await login(next)).status, 200);
  await processDriverLoginPolicyCleanupJobs({ db });
  const replacement = (await db.ref(`app_sessions/${next.uid}`).get()).val();
  assert.equal((await verifyActiveAppSession({ db, authUid: next.uid, expectedSessionId: replacement.sessionId, allowUnassignedDriver: true })).allowed, true);
  assert.equal((await db.ref('drivers/D-SYNTHETIC/authUid').get()).val(), next.uid);
});

test('enforcement, first claim, realtime-before-HTTP assignment and stale cleanup preserve one usable application scope', async () => {
  const { createDriverSessionReconciliationHarness } = require('./helpers/driverSessionReconciliationHarness');
  await policy(true);
  const handset = await identity();
  const initial = await login(handset);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.session.tourId, null);
  const reader = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'combined-mobile-reader');
  const harness = await createDriverSessionReconciliationHarness(initial.body.session, {
    database: reader.database(), authUid: handset.uid, initialNowMs: Date.now(),
  });
  const gate = { captured: deferred(), release: deferred() };
  assignmentResponseGate = gate;
  let responseDelivered = false;
  const response = request('assignment', handset, { driverId: 'D-SYNTHETIC', tourId: 'SYNTHETIC_TOUR',
    expectedSessionId: initial.body.session.sessionId, expectedSessionRevision: initial.body.session.sessionRevision,
    idempotencyKey: 'synthetic-combined-realtime-before-http' }).then(result => { responseDelivered = true; return result; });
  try {
    const payload = await gate.captured.promise;
    assert.equal(payload.success, true, JSON.stringify(payload));
    await eventually(() => harness.state.session.tourId === 'SYNTHETIC_TOUR');
    await harness.settle();
    assert.equal(responseDelivered, false, 'the real session event was applied before HTTP delivery');
    assert.equal(harness.state.screen, 'DriverHome');
    assert.equal(harness.state.booking.assignedTourId, 'SYNTHETIC_TOUR');
    assert.equal(harness.state.tour.id, 'SYNTHETIC_TOUR');
    assert.deepEqual(harness.revoked, []);
    gate.release.resolve();
    const returned = await response;
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    await harness.accept(returned.body.session);
    await harness.settle();
    assert.equal((await harness.service.readSession()).tourId, 'SYNTHETIC_TOUR');
    assert.equal(JSON.parse(harness.values.get('tour')).id, 'SYNTHETIC_TOUR');
    assert.equal(JSON.parse(harness.values.get('booking')).assignedTourId, 'SYNTHETIC_TOUR');
    const driver = (await db.ref('drivers/D-SYNTHETIC').get()).val();
    assert.deepEqual(await loadDriverSessionAuthUids('D-SYNTHETIC', { db, driverData: driver, tourId: 'SYNTHETIC_TOUR' }), [handset.uid]);
    // A genuine credential reverification creates a new session. An exact old
    // policy cleanup job must not remove that new session or its delivery scope.
    harness.unsubscribe();
    const replacement = await login(handset);
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.session.sessionId, initial.body.session.sessionId);
    await db.ref(`driver_login_policy_cleanup/v1/${handset.uid}`).set({ schemaVersion: 1,
      sessionId: initial.body.session.sessionId, policyGeneration: 1, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 });
    const cleaned = await processDriverLoginPolicyCleanupJobs({ db });
    assert.equal(cleaned.obsolete, 1);
    assert.equal(cleaned.cleaned, 0);
    assert.equal((await verifyActiveAppSession({ db, authUid: handset.uid, expectedSessionId: replacement.body.session.sessionId })).allowed, true);
    assert.deepEqual(await loadDriverSessionAuthUids('D-SYNTHETIC', { db,
      driverData: (await db.ref('drivers/D-SYNTHETIC').get()).val(), tourId: 'SYNTHETIC_TOUR' }), [handset.uid]);
    assert.equal((await db.ref(`users/${handset.uid}/driverAssignedTourId`).get()).val(), 'SYNTHETIC_TOUR');
    assert.equal((await db.ref('tour_manifests/SYNTHETIC_TOUR/assigned_drivers/D-SYNTHETIC').get()).val(), true);
  } finally {
    assignmentResponseGate = null; gate.release.resolve();
    await response.catch(() => {});
    harness.unsubscribe(); await reader.delete();
  }
});
