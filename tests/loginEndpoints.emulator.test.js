'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
for (const name of ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env[name] || '')) throw new Error(`${name} must point to a local emulator`);
}
const projectId = 'demo-llt-login';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
process.env.REQUIRE_APP_CHECK_FOR_LOGIN = 'false';
const admin = require('../functions/node_modules/firebase-admin');
const express = require('../functions/node_modules/express');
const { verifyPassengerLogin } = require('../functions/src/domains/passenger-auth/passengerLoginFunction');
const { verifyDriverLogin } = require('../functions/src/domains/driver-auth/driverLoginFunction');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'login-fixture-writer');
const db = writer.database();
let server; let origin;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/passenger', verifyPassengerLogin);
  app.post('/driver', verifyDriverLogin);
  app.use((error, _req, res, _next) => res.status(500).json({ testHandlerError: error.message }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  // HTTP handlers finish their finally blocks after sending the response.
  await handlersIdle();
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.all(admin.apps.map((app) => app.delete()));
});
const newIdentity = async () => {
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { uid: body.localId, token: body.idToken };
};
const login = async (kind, identity, body) => {
  const response = await fetch(`${origin}/${kind}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = { status: response.status, body: await response.json() };
  await handlersIdle();
  return result;
};

// Wait for the driver's post-response admission cleanup through the real DB.
const handlersIdle = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [policy, assignment] = await Promise.all([
      db.ref('driver_login_policy/v1/loginAdmissions').once('value'),
      db.ref('driver_assignment_active/v1').once('value'),
    ]);
    if (!policy.exists() && !Object.values(assignment.val() || {}).some((entry) => entry.loginAdmissions)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Driver login admissions were not released');
};
const seedBooking = (ref) => db.ref().update({
  [`booking_identities/${ref}`]: { bookingRef: ref, email: 'passenger@example.invalid', tourId: 'LOGIN_TOUR' },
  [`bookings/${ref}`]: { bookingRef: ref, tourId: 'LOGIN_TOUR', passengerNames: ['Synthetic Passenger'] },
});
const passengerBody = (ref) => ({ bookingRef: ref, email: 'passenger@example.invalid' });
const seedPolicy = (enforceSingleDevice) => db.ref('driver_login_policy/v1').set({
  schemaVersion: 1, enforceSingleDevice, generation: 1, revision: 1,
  updatedAtMs: Date.now(), transitionPhase: 'stable',
});
test.beforeEach(() => seedPolicy(false));

test('passenger HTTP login issues a complete session and supports an immediate repeat', async () => {
  const identity = await newIdentity();
  await db.ref().update({
    'booking_identities/LOGIN123': { bookingRef: 'LOGIN123', email: 'passenger@example.invalid', tourId: 'LOGIN_TOUR' },
    'bookings/LOGIN123': { bookingRef: 'LOGIN123', tourId: 'LOGIN_TOUR', passengerNames: ['Synthetic Passenger'] },
    'tours/LOGIN_TOUR': { isActive: true, name: 'Synthetic Tour', startDate: '14/09/2026', endDate: '20/09/2026' },
  });
  let previous;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await login('passenger', identity, { bookingRef: 'LOGIN123', email: 'passenger@example.invalid' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.valid, true, JSON.stringify(result.body));
    assert.equal(result.body.session.principalType, 'passenger');
    assert.notEqual(result.body.session.sessionId, previous);
    previous = result.body.session.sessionId;
    const session = (await db.ref(`app_sessions/${identity.uid}`).once('value')).val();
    assert.equal(session.sessionId, previous);
    assert.equal((await db.ref(`tours/LOGIN_TOUR/participants/${identity.uid}/sessionId`).once('value')).val(), previous);
    assert.equal((await db.ref(`app_session_locks/${identity.uid}`).once('value')).exists(), false);
    assert.equal((await db.ref('account_deletion_passenger_locks').once('value')).exists(), false);
    assert.equal((await db.ref(`app_session_role_claim_jobs/v1/${identity.uid}`).once('value')).exists(), false);
    const claims = (await writer.auth().getUser(identity.uid)).customClaims;
    assert.match(claims.privatePhotoOwnerKey, /^pax_v2_/);
  }
});

test('passenger rejects a second installation without changing the active session', async () => {
  await seedBooking('DEVICE123');
  const first = await newIdentity();
  const second = await newIdentity();
  assert.equal((await login('passenger', first, passengerBody('DEVICE123'))).status, 200);
  const before = (await db.ref(`app_sessions/${first.uid}`).once('value')).val();
  const rejected = await login('passenger', second, passengerBody('DEVICE123'));
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.reason, 'REAUTHORIZE_REQUIRED');
  assert.deepEqual((await db.ref(`app_sessions/${first.uid}`).once('value')).val(), before);
  assert.equal((await db.ref(`app_sessions/${second.uid}`).once('value')).exists(), false);
  assert.equal((await db.ref(`app_session_locks/${second.uid}`).once('value')).exists(), false);
  assert.equal((await db.ref('account_deletion_passenger_locks').once('value')).exists(), false);
});

test('passenger contention preserves the other owner and succeeds immediately after release', async () => {
  const identity = await newIdentity();
  await seedBooking('BUSY123');
  const lock = { owner: 'other-operation', operation: 'issue', expiresAtMs: Date.now() + 60000 };
  await db.ref(`app_session_locks/${identity.uid}`).set(lock);
  const blocked = await login('passenger', identity, passengerBody('BUSY123'));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.reason, 'SESSION_IN_PROGRESS');
  assert.deepEqual((await db.ref(`app_session_locks/${identity.uid}`).once('value')).val(), lock);
  await db.ref(`app_session_locks/${identity.uid}`).remove();
  assert.equal((await login('passenger', identity, passengerBody('BUSY123'))).status, 200);
});

test('assigned driver can repeat login while single-device policy rejects a different installation', async () => {
  await seedPolicy(true);
  const identity = await newIdentity();
  await db.ref().update({
    'drivers/D-ASSIGNED': { name: 'Synthetic Assigned Driver', currentTourId: 'LOGIN_TOUR', authUid: identity.uid },
    'tour_manifests/LOGIN_TOUR/assigned_drivers/D-ASSIGNED': true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await login('driver', identity, { driverId: 'D-ASSIGNED' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.session.tourId, 'LOGIN_TOUR');
    assert.equal(result.body.identityClaimed, true);
  }
  const rejected = await login('driver', await newIdentity(), { driverId: 'D-ASSIGNED' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.reason, 'DRIVER_ALREADY_LINKED');
  assert.equal((await db.ref('driver_login_claim_reservations').once('value')).exists(), false);
  await seedPolicy(false);
  assert.equal((await login('driver', await newIdentity(), { driverId: 'D-ASSIGNED' })).status, 200);
});

test('driver contention and unknown driver return structured failures and release admissions', async () => {
  const identity = await newIdentity();
  await db.ref('drivers/D-BUSY').set({ name: 'Synthetic Driver' });
  await db.ref(`app_session_locks/${identity.uid}`).set({ owner: 'another', operation: 'issue', expiresAtMs: Date.now() + 60000 });
  const busy = await login('driver', identity, { driverId: 'D-BUSY' });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.reason, 'SESSION_IN_PROGRESS');
  await db.ref(`app_session_locks/${identity.uid}`).remove();
  assert.equal((await login('driver', identity, { driverId: 'D-BUSY' })).status, 200);
  const unknown = await login('driver', await newIdentity(), { driverId: 'D-UNKNOWN' });
  assert.equal(unknown.body.valid, false);
  assert.notEqual(unknown.status, 500);
});

test('switching passenger to driver and back removes former driver authority and completes claims', async () => {
  await seedPolicy(true);
  const identity = await newIdentity();
  await seedBooking('SWITCH123');
  await db.ref('drivers/D-SWITCH').set({ name: 'Synthetic Driver', authUid: identity.uid });
  assert.equal((await login('passenger', identity, passengerBody('SWITCH123'))).status, 200);
  assert.equal((await login('driver', identity, { driverId: 'D-SWITCH' })).status, 200);
  await writer.auth().setCustomUserClaims(identity.uid, { driverId: 'D-SWITCH', isDriver: true, unrelated: true });
  const result = await login('passenger', identity, passengerBody('SWITCH123'));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await db.ref('drivers/D-SWITCH/authUid').once('value')).exists(), false);
  assert.equal((await db.ref(`users/${identity.uid}/driverId`).once('value')).exists(), false);
  assert.equal((await db.ref(`app_session_role_claim_jobs/v1/${identity.uid}`).once('value')).exists(), false);
  assert.equal((await db.ref('driver_login_claim_reservations').once('value')).exists(), false);
  const claims = (await writer.auth().getUser(identity.uid)).customClaims;
  assert.equal(claims.isDriver, undefined);
  assert.equal(claims.driverId, undefined);
  assert.equal(claims.unrelated, true);
  await seedPolicy(false);
});

test('driver HTTP login issues a complete session and supports an immediate repeat', async () => {
  await db.ref('driver_login_policy/v1').remove();
  const identity = await newIdentity();
  await db.ref('drivers/D-LOGIN').set({ name: 'Synthetic Driver' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await login('driver', identity, { driverId: 'D-LOGIN' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.valid, true, JSON.stringify(result.body));
    assert.equal(result.body.session.principalType, 'driver');
    assert.equal((await db.ref(`app_sessions/${identity.uid}/sessionId`).once('value')).val(), result.body.session.sessionId);
    assert.equal((await db.ref(`app_session_locks/${identity.uid}`).once('value')).exists(), false);
    assert.equal((await db.ref('driver_login_policy/v1/loginAdmissions').once('value')).exists(), false);
  }
});

test('a transient Auth claim failure releases login locks and the next passenger attempt recovers', async (t) => {
  await seedBooking('CLAIM123');
  const identity = await newIdentity();
  const auth = admin.auth();
  const original = auth.setCustomUserClaims.bind(auth);
  let fail = true;
  t.mock.method(auth, 'setCustomUserClaims', async (...args) => {
    if (fail) { fail = false; throw Object.assign(new Error('Synthetic transient Auth failure'), { code: 'auth/internal-error' }); }
    return original(...args);
  });
  const failed = await login('passenger', identity, passengerBody('CLAIM123'));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.reason, 'ROLE_TRANSITION_IN_PROGRESS');
  assert.equal((await db.ref(`app_session_locks/${identity.uid}`).once('value')).exists(), false);
  assert.equal((await db.ref('account_deletion_passenger_locks').once('value')).exists(), false);
  const job = (await db.ref(`app_session_role_claim_jobs/v1/${identity.uid}`).once('value')).val();
  assert.equal(job.attemptCount, 1);
  assert.equal((await login('passenger', identity, passengerBody('CLAIM123'))).status, 200);
  assert.equal((await db.ref(`app_session_role_claim_jobs/v1/${identity.uid}`).once('value')).exists(), false);
});

test('cold-cache lease renewal and release preserve foreign owners and reject missing or expired leases', async () => {
  const { renewAppSessionLock, releaseAppSessionLock } = require('../functions/lib/appSessionLock');
  const { acquirePassengerAccountDeletionLock, renewPassengerAccountDeletionLock, releasePassengerAccountDeletionLock } = require('../functions/src/domains/account-deletion/accountDeletionCoordination');
  const reader = admin.database();
  const nowMs = Date.now();
  for (const [key, owner, expiresAtMs, expected] of [
    ['held', 'mine', nowMs + 60000, true], ['foreign', 'someone-else', nowMs + 60000, false],
    ['expired', 'mine', nowMs - 1000, false], ['missing', null, null, false],
  ]) {
    const authUid = `lease-${key}`;
    const record = owner ? { owner, operation: 'issue', expiresAtMs } : null;
    await db.ref(`app_session_locks/${authUid}`).set(record);
    assert.equal(await renewAppSessionLock({ db: reader, authUid, owner: 'mine', nowMs }), expected);
    if (!expected) assert.deepEqual((await db.ref(`app_session_locks/${authUid}`).once('value')).val(), record);
    if (key === 'foreign') {
      assert.equal(await releaseAppSessionLock({ db: reader, authUid, owner: 'mine' }), false);
      assert.deepEqual((await db.ref(`app_session_locks/${authUid}`).once('value')).val(), record);
    }
  }
  const held = await acquirePassengerAccountDeletionLock({ db, bookingRef: 'LEASE123', ownerId: 'mine', nowMs });
  const cold = { ...held, ref: reader.ref('account_deletion_passenger_locks/v1').child(held.key) };
  assert.equal(await renewPassengerAccountDeletionLock({ lock: cold, nowMs }), true);
  assert.equal(await releasePassengerAccountDeletionLock({ lock: { ...cold, ownerId: 'foreign' } }), false);
  assert.equal(await releasePassengerAccountDeletionLock({ lock: cold }), true);
  assert.equal(await renewPassengerAccountDeletionLock({ lock: cold, nowMs }), false);
});
