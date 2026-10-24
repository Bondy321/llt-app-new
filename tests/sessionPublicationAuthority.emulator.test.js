'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A loopback Database emulator is required');
}
const projectId = 'demo-llt-publication';
process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
const admin = require('../functions/node_modules/firebase-admin');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const { issuePassengerAppSession, issueDriverAppSession } = require('../functions/src/domains/app-sessions/sessionIssuance');
const { captureInstallationAuthority, createRestrictedIssuer, supersedeInstallationAuthority } = require('../functions/lib/sessionPublicationAuthority');
const { issueStaffEnrolment, redeemStaffEnrolment, revokeStaffEnrolment, verifyStaffSessionAuthority } = require('../functions/src/domains/driver-auth/staffEnrolment');
const options = JSON.parse(process.env.FIREBASE_CONFIG);
const writer = admin.initializeApp(options, 'publication-writer');
const db = writer.database();
let count = 0;
const nextUid = () => `installation-${++count}`;
const snapshot = async path => (await db.ref(path).once('value')).val();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test.before(async () => { await installDemoDatabaseRules({ projectId }); });
test.after(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

const passenger = async (authUid, suffix, extra = {}) => {
  const bookingRef = `BOOK-${authUid}-${suffix}`; const tourId = `TOUR-${authUid}-${suffix}`;
  const principalId = `pax_v2_${String(suffix).padStart(32, '0')}`;
  await db.ref().update({ [`bookings/${bookingRef}`]: { tourId }, [`tours/${tourId}/isActive`]: true,
    [`passenger_identity_security/${bookingRef}/passengerPrincipalId`]: principalId });
  return issuePassengerAppSession({ db, authUid, principalId, tourId, bookingRef,
    identityUpdates: { [`users/${authUid}/bookingRef`]: bookingRef,
      [`users/${authUid}/stablePassengerId`]: principalId, [`users/${authUid}/identityVersion`]: 'pax_v2',
      [`passenger_identity_security/${bookingRef}/deviceAuthorizationVersion`]: 2,
      [`passenger_identity_security/${bookingRef}/authorizedAuthUids/${authUid}`]: true,
      [`identity_bindings/${principalId}/${authUid}`]: true },
    grantUpdates: { [`booking_access_grants/${bookingRef}/${authUid}`]: { bookingRef, tourId },
      [`tour_access_grants/${tourId}/${authUid}`]: { bookingRef, tourId } }, ...extra });
};
const pausedIssuer = () => {
  const queued = deferred(); let connection;
  return { queued: queued.promise, reconnect: () => connection.goOnline(),
    factory: args => {
      const real = createRestrictedIssuer(args); connection = real.db; connection.goOffline();
      return { ...real, db: { ref: () => ({ update: updates => {
        const result = real.db.ref().update(updates); queued.resolve(); return result;
      } }) } };
    } };
};

for (const successor of ['passenger', 'deletion']) test(`queued production passenger issuance cannot overwrite ${successor}`, async () => {
  const uid = nextUid(); const pause = pausedIssuer();
  await db.ref(`notification_devices/${uid}`).set({ schemaVersion: 1, registrationRevision: 1 });
  const first = passenger(uid, 'a', { createIssuer: pause.factory });
  const firstOutcome = first.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, first]);
  const old = await snapshot(`app_session_authority/${uid}`);
  let second;
  if (successor === 'passenger') {
    const later = Date.now() + 181000;
    second = await passenger(uid, 'b', { clock: () => later, nowMs: later });
  } else {
    await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: old.sessionId, deleted: true });
    await db.ref(`notification_device_tombstones/${uid}`).set({ permanent: true, registrationRevision: 2 });
  }
  const before = await snapshot('/');
  pause.reconnect();
  assert.equal(await firstOutcome, 'rejected');
  const after = await snapshot('/');
  for (const root of ['app_sessions', 'users', 'tours', 'booking_access_grants', 'tour_access_grants',
    'identity_bindings', 'notification_devices', 'notification_device_tombstones', 'app_session_authority']) {
    assert.deepEqual(after[root], before[root], root);
  }
  if (second) assert.equal(after.app_sessions[uid].sessionId, second.sessionId);
  else assert.equal(after.app_sessions?.[uid], undefined);
});

test('normal Firebase custom token claims cannot manufacture internal override', async () => {
  const uid = nextUid();
  const app = admin.initializeApp({ ...options, databaseAuthVariableOverride: { uid,
    token: { lltSessionIssuer: true, issuanceOperationId: 'fake', issuanceEpoch: 'fake' } } }, 'forged-issuer');
  await assert.rejects(app.database().ref(`app_sessions/${uid}`).set({ status: 'active' }));
  await app.delete();
});

const approve = async (authUid, suffix = 'A') => {
  const driverId = `D-${suffix}`;
  await db.ref(`drivers/${driverId}`).update({ name: 'Synthetic staff' });
  await db.ref('driver_login_policy/v1').set({ schemaVersion: 1, generation: 0, revision: 1,
    enforceSingleDevice: false, updatedAtMs: Date.now() });
  const code = await issueStaffEnrolment({ db, driverId, adminUid: 'synthetic-admin' });
  const capturedAuthority = await captureInstallationAuthority({ db, authUid });
  const staffAuthorization = await redeemStaffEnrolment({ db, authUid, driverId, secret: code.secret, capturedAuthority });
  return { driverId, code, capturedAuthority, staffAuthorization };
};
const driver = (authUid, approval, extra = {}) => issueDriverAppSession({ db, authUid,
  driverId: approval.driverId, tourId: null, driverLoginPolicyGeneration: 0,
  staffAuthorization: approval.staffAuthorization, capturedAuthority: approval.capturedAuthority,
  profileUpdates: { [`users/${authUid}/driverId`]: approval.driverId,
    [`users/${authUid}/driverPrincipalId`]: `driver:${approval.driverId}`, [`users/${authUid}/principalType`]: 'driver' }, ...extra });

test('current HTTP staff authority rejects policy and assignment changes while canonical session remains', async () => {
  const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
  const uid = nextUid(); const approval = await approve(uid, `HTTP${count}`);
  const session = await driver(uid, approval);
  const check = () => verifyActiveAppSession({ db, authUid: uid, allowUnassignedDriver: true });
  assert.equal((await check()).allowed, true);
  await db.ref('driver_login_policy/v1/transitionPhase').set('draining');
  assert.equal((await check()).allowed, false);
  await db.ref('driver_login_policy/v1/transitionPhase').remove();
  await db.ref(`driver_assignment_active/v1/${approval.driverId}`).set(false);
  assert.equal((await check()).allowed, false);
  await db.ref(`driver_assignment_active/v1/${approval.driverId}`).remove();
  await db.ref(`drivers/${approval.driverId}/currentTourId`).set('NEW_TOUR');
  assert.equal((await check()).allowed, false);
  assert.equal((await snapshot(`app_sessions/${uid}`)).sessionId, session.sessionId);
});

test('public driver ID, wrong and expired secrets cannot authorize a phone', async () => {
  const uid = nextUid(); await db.ref('drivers/D-SECRET').set({ name: 'Synthetic staff' });
  await assert.rejects(driver(uid, { driverId: 'D-SECRET', capturedAuthority: { epoch: null } }), /Staff enrolment required/);
  await assert.rejects(redeemStaffEnrolment({ db, authUid: uid, driverId: 'D-SECRET', secret: 'D-SECRET' }));
  const code = await issueStaffEnrolment({ db, driverId: 'D-SECRET', adminUid: 'synthetic-admin' });
  await assert.rejects(redeemStaffEnrolment({ db, authUid: uid, driverId: 'D-SECRET', secret: code.secret, nowMs: code.expiresAtMs + 1 }));
});

for (const action of ['policy_change', 'policy_transition', 'assignment_change', 'assignment_transition', 'assignment_false_marker', 'secret_expiry']) test(`queued staff publication rejects ${action} at server arrival`, async () => {
  const uid = nextUid(); const approval = await approve(uid, `FENCE${count}`); const pause = pausedIssuer();
  const pending = driver(uid, approval, { createIssuer: pause.factory });
  const outcome = pending.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, pending]);
  if (action === 'policy_change') await db.ref('driver_login_policy/v1/generation').set(1);
  else if (action === 'policy_transition') await db.ref('driver_login_policy/v1/transitionPhase').set('draining');
  else if (action === 'assignment_change') await db.ref(`drivers/${approval.driverId}/currentTourId`).set('NEW_TOUR');
  else if (action === 'assignment_transition') await db.ref(`driver_assignment_active/v1/${approval.driverId}/transitionId`).set('new-transition');
  else if (action === 'assignment_false_marker') await db.ref(`driver_assignment_active/v1/${approval.driverId}`).set(false);
  else await db.ref(`driver_enrolments/${approval.staffAuthorization.secretHash}/expiresAtMs`).set(Date.now() - 1);
  pause.reconnect(); assert.equal(await outcome, 'rejected');
  assert.equal(await snapshot(`app_sessions/${uid}`), null);
});

for (const action of ['expired_assignment', 'replaced_assignment', 'expired_policy', 'replaced_policy']) test(`queued admitted staff publication rejects ${action}`, async () => {
  const uid = nextUid(); const approval = await approve(uid, `ADMITTED${count}`); const pause = pausedIssuer();
  const assignmentAdmissionId = 'exact-assignment-admission'; const policyAdmissionId = 'exact-policy-admission';
  const admissionAuthUidHash = 'a'.repeat(24);
  Object.assign(approval.staffAuthorization, { assignmentAdmissionId, policyAdmissionId, admissionAuthUidHash, admissionPolicyRevision: 1 });
  const assignmentPath = `driver_assignment_active/v1/${approval.driverId}`;
  await db.ref(assignmentPath).set({ schemaVersion: 1, loginAdmissions: { [assignmentAdmissionId]: {
    authUidHash: admissionAuthUidHash, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 } } });
  const policyPath = `driver_login_policy/v1/loginAdmissions/${policyAdmissionId}`;
  await db.ref(policyPath).set({ schemaVersion: 1, admissionType: 'driver_login', authUidHash: admissionAuthUidHash,
    generation: 0, policyRevision: 1, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 });
  const pending = driver(uid, approval, { createIssuer: pause.factory });
  const outcome = pending.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, pending]);
  if (action === 'expired_assignment') await db.ref(`${assignmentPath}/loginAdmissions/${assignmentAdmissionId}/expiresAtMs`).set(Date.now() - 1);
  else if (action === 'replaced_assignment') await db.ref(`${assignmentPath}/loginAdmissions/${assignmentAdmissionId}/authUidHash`).set('b'.repeat(24));
  else if (action === 'expired_policy') await db.ref(`${policyPath}/expiresAtMs`).set(Date.now() - 1);
  else await db.ref(`${policyPath}/authUidHash`).set('b'.repeat(24));
  pause.reconnect(); assert.equal(await outcome, 'rejected');
  assert.equal(await snapshot(`app_sessions/${uid}`), null);
});

for (const action of ['transfer', 'cancellation']) test(`queued passenger publication rejects booking ${action}`, async () => {
  const uid = nextUid(); const pause = pausedIssuer();
  const pending = passenger(uid, 'd', { createIssuer: pause.factory });
  const outcome = pending.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, pending]);
  await db.ref(`bookings/BOOK-${uid}-d/${action === 'transfer' ? 'tourId' : 'loginEligible'}`)
    .set(action === 'transfer' ? 'NEW_TOUR' : false);
  pause.reconnect(); assert.equal(await outcome, 'rejected');
  assert.equal(await snapshot(`app_sessions/${uid}`), null);
});

test('queued first claim cannot overwrite a successor approved phone claim', async () => {
  const uid = nextUid(); const approval = await approve(uid, 'CLAIM'); const pause = pausedIssuer();
  await db.ref('driver_login_policy/v1/enforceSingleDevice').set(true);
  const pending = driver(uid, approval, { createIssuer: pause.factory, profileUpdates: {
    [`users/${uid}/driverId`]: approval.driverId, [`users/${uid}/driverPrincipalId`]: `driver:${approval.driverId}`,
    [`users/${uid}/principalType`]: 'driver', [`drivers/${approval.driverId}/authUid`]: uid,
    [`drivers/${approval.driverId}/authUidStaffGeneration`]: approval.staffAuthorization.generation,
  } });
  const outcome = pending.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, pending]);
  await db.ref(`drivers/${approval.driverId}`).update({ authUid: 'successor-phone',
    authUidStaffGeneration: approval.staffAuthorization.generation });
  pause.reconnect(); assert.equal(await outcome, 'rejected');
  assert.equal(await snapshot(`drivers/${approval.driverId}/authUid`), 'successor-phone');
});

test('passenger HTTP authority stops immediately when logout advances epoch before canonical cleanup', async () => {
  const uid = nextUid(); const session = await passenger(uid, 'e');
  const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
  const { createPassengerTripSnapshotHandler } = require('../functions/src/domains/passenger-trip/passengerTripFunctions');
  const { verifyCurrentTourPhotoAccess } = require('../functions/src/domains/media/mediaAccess');
  assert.equal((await verifyActiveAppSession({ db, authUid: uid })).allowed, true);
  assert.equal((await verifyCurrentTourPhotoAccess({ db, authUid: uid, tourId: session.tourId })).allowed, true);
  await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: session.sessionId });
  assert.equal((await snapshot(`app_sessions/${uid}`)).sessionId, session.sessionId);
  assert.equal((await verifyActiveAppSession({ db, authUid: uid })).reason, 'SESSION_AUTHORITY_CHANGED');
  assert.equal((await verifyCurrentTourPhotoAccess({ db, authUid: uid, tourId: session.tourId })).allowed, false);
  let status; let body;
  const res = { status: value => { status = value; return res; }, json: value => { body = value; return value; } };
  const handler = createPassengerTripSnapshotHandler({ dbFactory: () => db,
    authorizeRequest: async () => ({ uid }), snapshotReader: async () => { throw new Error('Must never read private trip'); } });
  await handler({ method: 'POST', headers: {}, body: { expectedSessionId: session.sessionId, parts: ['booking'] } }, res);
  assert.equal(status, 403); assert.equal(body.reason, 'SESSION_SCOPE_MISMATCH');
});

test('actual client SDK cannot read passenger profile or group media after authority supersession', async () => {
  const uid = nextUid(); const session = await passenger(uid, 'f');
  await db.ref(`group_tour_photos/${session.tourId}/synthetic`).set({ userId: session.principalId });
  let reads = 0;
  const readClient = async path => {
    const app = admin.initializeApp({ ...options, databaseAuthVariableOverride: { uid,
      token: { firebase: { sign_in_provider: 'anonymous' } } } }, `passenger-read-${++reads}`);
    try { return await app.database(options.databaseURL).ref(path).once('value'); }
    finally { await app.delete(); }
  };
  assert.ok((await readClient(`users/${uid}`)).exists());
  assert.ok((await readClient(`group_tour_photos/${session.tourId}`)).exists());
  await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: session.sessionId });
  await assert.rejects(readClient(`users/${uid}`));
  await assert.rejects(readClient(`group_tour_photos/${session.tourId}`));
  for (const state of ['prepared', 'deletion_prepared', 'deleted']) {
    await db.ref(`app_session_authority/${uid}/state`).set(state);
    await assert.rejects(readClient(`group_tour_photos/${session.tourId}`));
  }
});

test('one secret selects one installation; original winner recovers consumption interruption', async () => {
  await db.ref('drivers/D-RACE').set({ name: 'Synthetic staff' });
  const code = await issueStaffEnrolment({ db, driverId: 'D-RACE', adminUid: 'synthetic-admin' });
  const uids = [nextUid(), nextUid()];
  const results = await Promise.allSettled(uids.map(authUid => redeemStaffEnrolment({ db, authUid, driverId: 'D-RACE', secret: code.secret })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.findIndex(r => r.status === 'fulfilled');
  const repeated = await redeemStaffEnrolment({ db, authUid: uids[winner], driverId: 'D-RACE', secret: code.secret });
  assert.equal(repeated.redemptionId, results[winner].value.redemptionId);
  const proof = await snapshot(`driver_enrolments/${repeated.secretHash}`);
  assert.equal(proof.authUid, undefined);
  assert.match(proof.authUidHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(proof).includes(uids[winner]), false);
  await supersedeInstallationAuthority({ db, authUid: uids[winner], reason: 'logical_user_switch' });
  await assert.rejects(redeemStaffEnrolment({ db, authUid: uids[winner], driverId: 'D-RACE', secret: code.secret }));
});

for (const action of ['logout', 'role_switch', 'revoke', 'replace', 'deletion']) test(`queued production driver publication cannot survive ${action}`, async () => {
  const uid = nextUid(); const approval = await approve(uid, `R${count}`); const pause = pausedIssuer();
  const pending = driver(uid, approval, { createIssuer: pause.factory });
  const outcome = pending.then(() => 'success', () => 'rejected');
  await Promise.race([pause.queued, pending]);
  if (action === 'revoke') await revokeStaffEnrolment({ db, driverId: approval.driverId, adminUid: 'synthetic-admin' });
  else if (action === 'replace') await issueStaffEnrolment({ db, driverId: approval.driverId, adminUid: 'synthetic-admin', replace: true });
  else if (action === 'role_switch') {
    const later = Date.now() + 181000;
    await passenger(uid, 'c', { clock: () => later, nowMs: later });
  } else {
    const authority = await snapshot(`app_session_authority/${uid}`);
    await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: authority.sessionId, deleted: action === 'deletion' });
  }
  const before = await snapshot('/'); pause.reconnect();
  assert.equal(await outcome, 'rejected');
  const after = await snapshot('/');
  for (const root of ['app_sessions', 'users', 'tours', 'driver_device_authorizations', 'notification_devices']) {
    assert.deepEqual(after[root], before[root], root);
  }
  await assert.rejects(redeemStaffEnrolment({ db, authUid: uid, driverId: approval.driverId, secret: approval.code.secret }));
});

test('current staff session works; server revocation immediately removes authority', async () => {
  const uid = nextUid(); const approval = await approve(uid, 'VALID');
  const session = await driver(uid, approval);
  assert.equal(await verifyStaffSessionAuthority({ db, authUid: uid, session }), true);
  await revokeStaffEnrolment({ db, driverId: approval.driverId, adminUid: 'synthetic-admin' });
  assert.equal(await verifyStaffSessionAuthority({ db, authUid: uid, session }), false);
});

test('interrupted staff publication recovers the exact receipt, then logout forbids reuse', async () => {
  const uid = nextUid(); const approval = await approve(uid, 'RECOVERY');
  await assert.rejects(driver(uid, approval, { createIssuer: () => ({
    db: { ref: () => ({ update: async () => { throw new Error('synthetic connection failure before dispatch'); } }) },
    close: async () => {},
  }) }), /synthetic connection failure/);
  assert.equal(await snapshot(`app_sessions/${uid}`), null);
  const pending = await snapshot(`app_session_authority/${uid}`);
  const capturedAuthority = await captureInstallationAuthority({ db, authUid: uid });
  const staffAuthorization = await redeemStaffEnrolment({ db, authUid: uid, driverId: approval.driverId,
    secret: approval.code.secret, capturedAuthority });
  const session = await driver(uid, { ...approval, capturedAuthority, staffAuthorization });
  assert.equal(session.sessionId, pending.sessionId);
  assert.equal(await verifyStaffSessionAuthority({ db, authUid: uid, session }), true);
  const committed = await captureInstallationAuthority({ db, authUid: uid });
  assert.equal(committed.value.publication, undefined);
  assert.equal(committed.value.writePaths, undefined);
  const retryApproval = await redeemStaffEnrolment({ db, authUid: uid, driverId: approval.driverId,
    secret: approval.code.secret, capturedAuthority: committed });
  const retried = await driver(uid, { ...approval, capturedAuthority: committed, staffAuthorization: retryApproval });
  assert.equal(retried.sessionId, session.sessionId);
  await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: session.sessionId });
  await assert.rejects(redeemStaffEnrolment({ db, authUid: uid, driverId: approval.driverId, secret: approval.code.secret }));
  assert.equal(await verifyStaffSessionAuthority({ db, authUid: uid, session }), false);
});

for (const proofState of ['current', 'expired', 'replaced', 'wrong_revision']) test(`interrupted admitted publication during policy drain: ${proofState} proof`, async () => {
  const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
  const uid = nextUid(); const approval = await approve(uid, `DRAIN${count}`);
  const admission = { assignmentAdmissionId: 'recovery-assignment', policyAdmissionId: 'recovery-policy',
    admissionAuthUidHash: 'a'.repeat(24), admissionPolicyRevision: 1 };
  Object.assign(approval.staffAuthorization, admission);
  await db.ref(`driver_assignment_active/v1/${approval.driverId}`).set({ schemaVersion: 1,
    loginAdmissions: { [admission.assignmentAdmissionId]: { authUidHash: admission.admissionAuthUidHash,
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 } } });
  const policyPath = `driver_login_policy/v1/loginAdmissions/${admission.policyAdmissionId}`;
  await db.ref(policyPath).set({ schemaVersion: 1, admissionType: 'driver_login', authUidHash: admission.admissionAuthUidHash,
    generation: 0, policyRevision: 1, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 });
  await assert.rejects(driver(uid, approval, { createIssuer: () => ({
    db: { ref: () => ({ update: async () => { throw new Error('synthetic interrupted admitted publication'); } }) },
    close: async () => {},
  }) }), /synthetic interrupted/);
  const pending = await snapshot(`app_session_authority/${uid}`);
  await db.ref('driver_login_policy/v1').update({ transitionPhase: 'draining', revision: 2 });
  if (proofState === 'expired') await db.ref(`${policyPath}/expiresAtMs`).set(Date.now() - 1);
  else if (proofState === 'replaced') await db.ref(`${policyPath}/authUidHash`).set('b'.repeat(24));
  else if (proofState === 'wrong_revision') await db.ref(`${policyPath}/policyRevision`).set(2);
  const capturedAuthority = await captureInstallationAuthority({ db, authUid: uid });
  const staffAuthorization = { ...await redeemStaffEnrolment({ db, authUid: uid, driverId: approval.driverId,
    secret: approval.code.secret, capturedAuthority }), ...admission };
  const recover = () => driver(uid, { ...approval, capturedAuthority, staffAuthorization });
  if (proofState !== 'current') {
    await assert.rejects(recover());
    assert.equal(await snapshot(`app_sessions/${uid}`), null);
    return;
  }
  const session = await recover();
  assert.equal(session.sessionId, pending.sessionId);
  assert.equal((await snapshot(`app_session_authority/${uid}`)).state, 'committed');
  assert.equal((await verifyActiveAppSession({ db, authUid: uid, allowUnassignedDriver: true })).allowed, false,
    'ordinary access must not inherit the private admission recovery exception');
  await db.ref(`driver_assignment_active/v1/${approval.driverId}`).remove();
  assert.equal((await verifyActiveAppSession({ db, authUid: uid, allowUnassignedDriver: true })).reason, 'DRIVER_POLICY_MISMATCH');
});
