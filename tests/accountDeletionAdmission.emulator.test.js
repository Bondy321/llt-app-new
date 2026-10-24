'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A loopback Realtime Database emulator is required');
}
const projectId = 'demo-llt-deletion-admission';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const { enrolSyntheticDriver } = require('./helpers/enrolSyntheticDriver');
const { createRestrictedIssuer, supersedeInstallationAuthority } = require('../functions/lib/sessionPublicationAuthority');
const { issueDriverAppSession, issuePassengerAppSession, buildVerifiedLoginGrantUpdates } = require('../functions/src/domains/app-sessions/sessionIssuance');
const { updateNotificationDevice } = require('../functions/src/domains/notifications/notificationDeviceFunctions');
const { reserveAccountDeletion } = require('../functions/src/domains/account-deletion/accountDeletionFunctions');
const { deriveAccountDeletionId, derivePassengerAccountDeletionKey } = require('../functions/src/domains/account-deletion/accountDeletionBoundary');
const { reconcileTransitionSessionPage } = require('../functions/src/domains/driver-assignment/assignmentTransition');
const { resolveOperationalAuthority } = require('../functions/src/domains/notifications/notificationAudiencePage');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');

const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'deletion-admission-fixtures');
const db = writer.database();
const uid = 'synthetic-deletion-phone';
const siblingUid = 'synthetic-sibling-phone';
const driverId = 'D-SYNTHETIC';
const tourId = 'SYNTHETIC_TOUR';
const bookingRef = 'SYNTHETIC_BOOKING';
const principalId = `pax_v2_${'8'.repeat(32)}`;
const receipt = `delrec_v1_${'9'.repeat(64)}`;
const deletionId = deriveAccountDeletionId(receipt);
let now;
let appCounter = 0;
const read = async path => (await db.ref(path).get()).val();
const cold = async operation => {
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `deletion-admission-cold-${++appCounter}`);
  try { return await operation(app.database()); }
  finally { await app.delete(); }
};
const issue = (role, authUid = uid) => cold(async database => role === 'driver'
  ? issueDriverAppSession({ db: database, authUid, driverId, tourId, nowMs: now,
    ...(await enrolSyntheticDriver({ db: database, authUid, driverId, nowMs: now })), driverLoginPolicyGeneration: 0, profileUpdates: {
    [`users/${authUid}/principalType`]: 'driver', [`users/${authUid}/driverId`]: driverId,
    [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${authUid}/driverAssignedTourId`]: tourId,
  } })
  : issuePassengerAppSession({ db: database, authUid, principalId, tourId, bookingRef, nowMs: now,
    identityUpdates: {
      [`users/${authUid}/bookingRef`]: bookingRef,
      [`users/${authUid}/stablePassengerId`]: principalId,
      [`users/${authUid}/identityVersion`]: 'pax_v2',
      [`users/${authUid}/stablePassengerKey`]: principalId,
      [`users/${authUid}/privatePhotoOwnerKey`]: principalId,
      [`identity_bindings/${principalId}/${authUid}`]: true,
      [`passenger_identity_security/${bookingRef}/deviceAuthorizationVersion`]: 2,
      [`passenger_identity_security/${bookingRef}/authorizedAuthUids/${authUid}`]: true,
    },
    grantUpdates: buildVerifiedLoginGrantUpdates({ authUid, bookingRef, tourId, nowMs: now }),
  }));
const register = async session => {
  const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid, nowMs: now,
    input: { action: 'reconcile', registrationRevision: 10, appSessionId: session.sessionId,
      appSessionRevision: session.sessionRevision, tourId, operationalEligible: true,
      permissionState: 'granted', pushToken: 'ExponentPushToken[syntheticdeletion]' },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.device.operationalEligible, true);
};
const reserve = expectedSessionId => cold(database => reserveAccountDeletion({ db: database, authUid: uid,
  input: { expectedSessionId, deletionReceipt: receipt }, deletionId, nowMs: now,
}));

test('durable deletion intent recovers failed publication and permanently fences login', async () => {
  const session = await issue('passenger');
  await assert.rejects(reserveAccountDeletion({ db, authUid: uid,
    input: { expectedSessionId: session.sessionId, deletionReceipt: receipt }, deletionId, nowMs: now,
    createIssuer: () => ({ db: { ref: () => ({ update: async () => { throw new Error('synthetic admission interruption'); } }) }, close: async () => {} }),
  }), /synthetic admission interruption/);
  assert.equal((await read(`app_session_authority/${uid}`)).state, 'deletion_prepared');
  await assert.rejects(issue('passenger'), error => error.code === 'ACCOUNT_DELETION_IN_PROGRESS');
  const recovered = await reserve(session.sessionId);
  assert.equal(recovered.status, 202);
  assert.equal((await read(`app_session_authority/${uid}`)).state, 'deleted');
  assert.equal((await read(`app_session_authority/${uid}`)).deletionPublication, undefined);
  assert.equal((await read(`app_session_authority/${uid}`)).writePaths, undefined);
  assert.equal(await read(`app_sessions/${uid}`), null);
  assert.equal((await read(`account_deletion_jobs/v1/${deletionId}`)).privateScope.authUid, uid);
});

test('queued old deletion admission cannot reset a resumed job after worker progress', async () => {
  const session = await issue('passenger');
  let connection; let queued;
  const queuedPromise = new Promise(resolve => { queued = resolve; });
  const pending = reserveAccountDeletion({ db, authUid: uid,
    input: { expectedSessionId: session.sessionId, deletionReceipt: receipt }, deletionId, nowMs: now,
    createIssuer: args => {
      const real = createRestrictedIssuer(args); connection = real.db; connection.goOffline();
      return { ...real, db: { ref: () => ({ update: updates => {
        const result = real.db.ref().update(updates); queued(); return result;
      } }) } };
    },
  });
  await Promise.race([queuedPromise, pending]);
  const recovered = await reserve(session.sessionId);
  assert.equal(recovered.status, 202);
  await db.ref(`account_deletion_jobs/v1/${deletionId}`).update({ phase: 'group_media', attemptCount: 2 });
  const before = await read(`account_deletion_jobs/v1/${deletionId}`);
  connection.goOnline();
  assert.equal((await pending).status, 202);
  assert.deepEqual(await read(`account_deletion_jobs/v1/${deletionId}`), before);
});
const authoritySnapshot = async () => Object.fromEntries(await Promise.all([
  `app_sessions/${uid}`, `users/${uid}`, `notification_devices/${uid}`, `notification_consents/${uid}`,
  `tours/${tourId}/participants/${uid}`, `tour_access_grants/${tourId}/${uid}`,
  `booking_access_grants/${bookingRef}/${uid}`, `passenger_identity_security/${bookingRef}`,
  `identity_bindings/${principalId}`, `app_sessions/${siblingUid}`,
].map(async path => [path, await read(path)])));
const assertNoDeletion = async () => {
  for (const path of ['account_deletion_jobs', 'account_deletion_queue', 'account_deletion_active',
    'account_deletion_passenger_active', 'account_deletion_uid_tombstones', 'notification_device_tombstones']) {
    assert.equal(await read(path), null, `${path} must remain absent`);
  }
};

test.before(async () => { await installDemoDatabaseRules({ projectId }); });
test.beforeEach(async () => {
  now = Date.now();
  await db.ref().set({
    passenger_identity_security: { [bookingRef]: { passengerPrincipalId: principalId, passengerIdentityVersion: 'pax_v2' } },
    bookings: { [bookingRef]: { tourId, loginEligible: true } },
    tours: { [tourId]: { isActive: true } },
    drivers: { [driverId]: { currentTourId: tourId } },
    tour_manifests: { [tourId]: { assigned_drivers: { [driverId]: true } } },
    driver_login_policy: { v1: { schemaVersion: 1, enforceSingleDevice: false,
      generation: 0, revision: 1, updatedAtMs: now } },
  });
});
test.after(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

test('a superseded passenger epoch cannot admit deletion while old canonical cleanup is delayed', async () => {
  const session = await issue('passenger');
  await supersedeInstallationAuthority({ db, authUid: uid, expectedSessionId: session.sessionId });
  assert.equal((await read(`app_sessions/${uid}`)).sessionId, session.sessionId);
  assert.deepEqual(await reserve(session.sessionId), { status: 409, reason: 'SESSION_CHANGED' });
  await assertNoDeletion();
});

test('stale driver deletion preserves the complete successor and registration through actual assignment', async () => {
  const old = await issue('driver');
  const current = await issue('driver');
  await register(current);
  const before = await authoritySnapshot();
  assert.deepEqual(await reserve(old.sessionId), { status: 409, reason: 'SESSION_CHANGED' });
  const after = await authoritySnapshot();
  await assertNoDeletion();

  const nextTourId = 'SYNTHETIC_NEXT';
  await db.ref().update({ [`drivers/${driverId}/currentTourId`]: nextTourId,
    [`tours/${nextTourId}/isActive`]: true,
    [`tour_manifests/${nextTourId}/assigned_drivers/${driverId}`]: true });
  const assigned = await cold(database => reconcileTransitionSessionPage({ db: database,
    transitionId: 'synthetic-deletion-assignment', transition: { status: 'subject_sessions', driverId,
      operation: 'assign', tourId: nextTourId, policy: { enforceSingleDevice: false, generation: 0 },
      actorType: 'operations_admin' }, nowMs: now, pageSize: 25 }));
  assert.equal(assigned.progressed, true);
  const session = await read(`app_sessions/${uid}`);
  const device = await read(`notification_devices/${uid}`);
  assert.deepEqual({ after, assignment: {
    sessionId: session.sessionId, revision: session.sessionRevision, tourId: session.tourId,
    operationalEligible: device.operationalEligible, operationalSessionId: device.operationalSessionId,
    operationalSessionRevision: device.operationalSessionRevision, operationalTourId: device.operationalTourId,
  } }, { after: before, assignment: {
    sessionId: current.sessionId, revision: current.sessionRevision + 1, tourId: nextTourId,
    operationalEligible: true, operationalSessionId: current.sessionId,
    operationalSessionRevision: current.sessionRevision + 1, operationalTourId: nextTourId,
  } });
  assert.equal((await resolveOperationalAuthority(db, uid, await read(`users/${uid}`), nextTourId, now)).allowed, true);
});

test('stale passenger deletion preserves full successor authority, registration and sibling membership', async () => {
  const old = await issue('passenger');
  const current = await issue('passenger');
  await issue('passenger', siblingUid);
  await register(current);
  const before = await authoritySnapshot();
  assert.deepEqual(await reserve(old.sessionId), { status: 409, reason: 'SESSION_CHANGED' });
  assert.deepEqual(await authoritySnapshot(), before);
  await assertNoDeletion();
  assert.equal((await resolveOperationalAuthority(db, uid, await read(`users/${uid}`), tourId, now)).allowed, true);
});

for (const role of ['driver', 'passenger']) {
  test(`valid exact-session ${role} deletion remains accepted and replayable with preserved sibling authority`, async () => {
    const current = await issue(role);
    const sibling = await issue(role, siblingUid);
    await register(current);
    const siblingSession = await read(`app_sessions/${siblingUid}`);
    const siblingProfile = await read(`users/${siblingUid}`);
    const accepted = await reserve(current.sessionId);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.replay, false);
    assert.equal(accepted.job.privateScope.expectedSessionId, current.sessionId);
    assert.equal(await read(`app_sessions/${uid}`), null);
    assert.equal(await read(`notification_devices/${uid}`), null);
    assert.equal((await read(`notification_device_tombstones/${uid}`)).permanent, true);
    assert.equal((await read(`account_deletion_active/v1/${uid}`)).deletionId, deletionId);
    assert.equal((await read(`account_deletion_jobs/v1/${deletionId}`)).status, 'pending');
    if (role === 'passenger') {
      assert.equal((await read(`account_deletion_passenger_active/v1/${derivePassengerAccountDeletionKey(bookingRef)}`)).deletionId, deletionId);
      assert.equal((await read(`tours/${tourId}/participants/${siblingUid}`)).sessionId, sibling.sessionId);
    }
    assert.deepEqual(await read(`app_sessions/${siblingUid}`), siblingSession);
    assert.deepEqual(await read(`users/${siblingUid}`), siblingProfile);
    assert.equal((await read(`bookings/${bookingRef}`)).tourId, tourId);
    assert.equal((await read(`drivers/${driverId}`)).currentTourId, tourId);
    const replay = await reserve(current.sessionId);
    assert.equal(replay.status, 202);
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.job, await read(`account_deletion_jobs/v1/${deletionId}`));
    assert.equal(Object.keys(await read('account_deletion_jobs/v1')).length, 1);
  });
}

test('missing or malformed captured session IDs fail before revision-advancing admission', async () => {
  const current = await issue('driver');
  await register(current);
  const before = await authoritySnapshot();
  for (const expectedSessionId of [undefined, null, '', 'not-a-session', 42]) {
    assert.deepEqual(await reserve(expectedSessionId), { status: 400, reason: 'INVALID_INPUT' });
    assert.deepEqual(await authoritySnapshot(), before);
  }
  await assertNoDeletion();
  assert.equal(await read('app_session_locks'), null);
  assert.equal(await read('account_deletion_locks'), null);
});
