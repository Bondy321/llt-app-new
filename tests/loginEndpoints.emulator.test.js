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
const { createManualPassengerBooking } = require('../functions/src/domains/administration/administrationFunctions');
const { acquireManualBookingLock, releaseManualBookingLock } = require('../functions/src/infrastructure/database/operationLock');
const { recomputeTourProjection } = require('../functions/src/domains/admin-dashboard/dashboardProjectionFunctions');
const { getTourManifest } = require('../functions/src/domains/manifests/manifestFunction');
const { endAppSession } = require('../functions/src/domains/app-sessions/sessionFunctions');
const { updateNotificationDeviceRegistration, updateNotificationDevice } = require('../functions/src/domains/notifications/notificationDeviceFunctions');
const { verifyCurrentTourPhotoAccess } = require('../functions/src/domains/media/mediaAccess');
const {
  acquireManualSourceRosterLease,
  releaseManualSourceRosterLease,
} = require('../functions/src/domains/administration/manualPassengerBooking');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'login-fixture-writer');
const db = writer.database();
let server; let origin;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/passenger', verifyPassengerLogin);
  app.post('/driver', verifyDriverLogin);
  app.post('/manifest', getTourManifest);
  app.post('/manual', createManualPassengerBooking);
  app.post('/end', endAppSession);
  app.post('/notifications', updateNotificationDeviceRegistration);
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
const login = async (kind, identity, body, extraHeaders = {}) => {
  const response = await fetch(`${origin}/${kind}`, { method: 'POST',
    headers: { ...extraHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = { status: response.status, body: await response.json() };
  await handlersIdle();
  return result;
};

const waitForManualMutationCleanup = async (tourId, bookingRefs = []) => {
  let clearReads = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [tourLock, control, ...bookingLocks] = await Promise.all([
      admin.database().ref(`manual_booking_creation_locks/tours/${tourId}`).once('value'),
      admin.database().ref(`sync_roster_control/${tourId}`).once('value'),
      ...bookingRefs.map(ref => admin.database().ref(`manual_booking_creation_locks/bookings/${ref}`).once('value')),
    ]);
    if (!tourLock.exists() && !control.val()?.owner && bookingLocks.every(lock => !lock.exists())) {
      clearReads += 1;
      if (clearReads >= 3) return;
    } else {
      clearReads = 0;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Manual booking mutation fences were not released');
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

test('retained credentials do not admit roster-only or superseded source bookings', async () => {
  await db.ref('tours/LOGIN_TOUR').set({isActive:true,name:'Synthetic tour'});
  for (const [ref,patch] of [['ROSTER_ONLY',{loginEligible:false}],
    ['ROSTER_OLD',{sourceRoster:{schemaVersion:1,state:'not_in_report',revision:'a'.repeat(64)}}]]) {
    await seedBooking(ref);
    await db.ref(`bookings/${ref}`).update(patch);
    const identity=await newIdentity();
    const result=await login('passenger',identity,passengerBody(ref));
    assert.equal(result.status,401);
    assert.equal(result.body.reason,'INVALID_CREDENTIALS');
    assert.equal((await db.ref(`app_sessions/${identity.uid}`).once('value')).exists(),false);
    assert.equal((await db.ref(`bookings/${ref}`).once('value')).exists(),true);
  }
});

test('full roster HTTP endpoint is driver-only and keeps roster-only passengers available to the assigned driver', async () => {
  const ids=['a','b'].map(char=>`srcpax_v1_${char.repeat(64)}`);
  const rev='c'.repeat(64);
  await db.ref().update({
    'tours/LOGIN_TOUR':{isActive:true,name:'Synthetic tour',rosterSync:{schemaVersion:1,state:'ready',generation:rev,reportDate:'2026-10-10'}},
    'bookings/HTTP_ROSTER':{tourId:'LOGIN_TOUR',loginEligible:false,
      passengerDetails:[{name:'Synthetic A'},{name:'Synthetic B'}],
      sourceRoster:{schemaVersion:1,state:'active',revision:rev,passengerIds:ids,
        passengerCount:2,passengerIdsJson:JSON.stringify(ids)}},
    'tour_manifests/LOGIN_TOUR/bookings/HTTP_ROSTER':{
      rosterRevision:rev,passengerIdsJson:JSON.stringify(ids),passengerStatusCodes:'BP'},
  });
  await seedBooking('HTTP_PASSENGER');
  const passenger=await newIdentity();
  assert.equal((await login('passenger',passenger,passengerBody('HTTP_PASSENGER'))).status,200);
  const denied=await login('manifest',passenger,{tourId:'LOGIN_TOUR'});
  assert.equal(denied.status,403);
  assert.equal(denied.body.reason,'NOT_AUTHORIZED');
  assert.equal(Object.hasOwn(denied.body,'bookings'),false);
  const driver=await newIdentity();
  await db.ref().update({
    'drivers/D-HTTP-ROSTER':{name:'Synthetic Driver',currentTourId:'LOGIN_TOUR',authUid:driver.uid},
    'tour_manifests/LOGIN_TOUR/assigned_drivers/D-HTTP-ROSTER':true,
  });
  assert.equal((await login('driver',driver,{driverId:'D-HTTP-ROSTER'})).status,200);
  const allowed=await login('manifest',driver,{tourId:'LOGIN_TOUR'});
  assert.equal(allowed.status,200);
  const booking=allowed.body.bookings.find(row=>row.id==='HTTP_ROSTER');
  assert.deepEqual(booking.passengerNames,['Synthetic A','Synthetic B']);
  assert.deepEqual(booking.passengerStatus,['BOARDED','PENDING']);
  assert.equal(booking.rosterRevision,rev);
  assert.equal(Object.hasOwn(booking,'sourceRoster'),false);
  assert.equal(Object.hasOwn(booking,'loginEligible'),false);
  await db.ref('tours/LOGIN_TOUR/rosterSync').remove();
});
test.beforeEach(() => seedPolicy(false));

test('manual source-roster lease contends across Admin connections and releases a cold-cache owner safely', async () => {
  const contenderApp = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'manual-lease-contender');
  const releaseApp = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'manual-lease-cold-release');
  const staleReaderApp = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'manual-lease-stale-reader');
  const contenderDb = contenderApp.database();
  const releaseDb = releaseApp.database();
  const staleReaderDb = staleReaderApp.database();
  const tourId = `LEASE_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const leaseRef = db.ref(`sync_roster_control/${tourId}`);
  await leaseRef.set({
    schemaVersion: 1, completedGeneration: 'fixture-generation', completedReportDate: '2026-10-09',
  });

  assert.equal(await acquireManualSourceRosterLease({ db, tourId, owner: 'manual-owner' }), true);
  assert.equal(await acquireManualSourceRosterLease({ db: contenderDb, tourId, owner: 'publisher-owner' }), false);
  const held = (await leaseRef.once('value')).val();
  assert.equal(held.owner, 'manual-owner');
  assert.equal(held.completedGeneration, 'fixture-generation');
  assert.equal(held.completedReportDate, '2026-10-09');

  // Warm another connection with the old owner before that owner releases.
  const staleHeld = await staleReaderDb.ref(`sync_roster_control/${tourId}`).get();
  assert.equal(staleHeld.val().owner, 'manual-owner');

  // A new Admin app has not read this path; release must still read the server
  // state before its transaction so it cannot mistake the owner for null.
  await releaseManualSourceRosterLease({ db: releaseDb, tourId, owner: 'manual-owner' });
  const released = (await leaseRef.once('value')).val();
  assert.equal(Object.hasOwn(released, 'owner'), false);
  assert.equal(Object.hasOwn(released, 'leaseUntilMs'), false);
  assert.equal(released.completedGeneration, 'fixture-generation');
  assert.equal(released.completedReportDate, '2026-10-09');
  assert.equal(await acquireManualSourceRosterLease({ db: staleReaderDb, tourId, owner: 'publisher-owner' }), true);
  await releaseManualSourceRosterLease({ db: db, tourId, owner: 'publisher-owner' });

  const operationLockPath = `manual_booking_creation_locks/tours/${tourId}`;
  assert.equal(await acquireManualBookingLock({
    db, path: operationLockPath, owner: 'manual-owner', nowMs: Date.now(),
  }), true);
  const staleOperationLock = await staleReaderDb.ref(operationLockPath).get();
  assert.equal(staleOperationLock.val().owner, 'manual-owner');
  await releaseManualBookingLock({ db: releaseDb, path: operationLockPath, owner: 'manual-owner' });
  assert.equal(await acquireManualBookingLock({
    db: staleReaderDb, path: operationLockPath, owner: 'publisher-owner', nowMs: Date.now(),
  }), true);
  await releaseManualBookingLock({ db, path: operationLockPath, owner: 'publisher-owner' });
  await leaseRef.remove();
  await db.ref(operationLockPath).remove();
});

test('manual HTTP creation is lease-fenced, preserves source counts, and separates login eligibility from the driver roster', async () => {
  const adminIdentity = await newIdentity();
  const adminUid = adminIdentity.uid;
  const tourId = `MANUAL_HTTP_${Date.now()}`;
  const generation = 'd'.repeat(64);
  const sourceBookingRef = `SOURCE_${Date.now()}`;
  const absentBookingRef = `ABSENT_${Date.now()}`;
  const rosterOnlyRef = `ROSTER_${Date.now()}`;
  const loginEligibleRef = `EMAIL_${Date.now()}`;
  const heldLeaseRef = `HELD_${Date.now()}`;
  const updatingRef = `UPDATING_${Date.now()}`;
  await db.ref().update({
    [`admin_users/${adminUid}`]: true,
    [`tours/${tourId}`]: {
      tourCode: tourId.replaceAll('_', ' '), name: 'Synthetic manual test tour',
      isActive: true, startDate: '01/11/2026', endDate: '01/11/2026',
      maxParticipants: 53, sold: 1, bookedPassengerCount: 1, manifestPassengerCount: 1,
      manualPassengerCount: 0, currentParticipants: 0,
      rosterSync: { schemaVersion: 1, state: 'ready', generation, reportDate: '2026-10-10' },
    },
    [`bookings/${sourceBookingRef}`]: {
      bookingRef: sourceBookingRef, tourId, passengerNames: ['Synthetic source passenger'], seatNumbers: [1],
    },
    [`bookings/${absentBookingRef}`]: {
      bookingRef: absentBookingRef, tourId, passengerNames: ['Synthetic absent passenger'], seatNumbers: [2],
      sourceRoster: { schemaVersion: 1, state: 'not_in_report', revision: 'e'.repeat(64) },
    },
    [`tour_manifests/${tourId}/bookings/${sourceBookingRef}`]: { status: 'PENDING' },
    [`sync_roster_control/${tourId}`]: {
      schemaVersion: 1, completedGeneration: generation, completedReportDate: '2026-10-10',
    },
  });

  const manualCreate = (bookingRef, seatNumber, email = '') => login('manual', adminIdentity, {
    tourId, bookingRef, email, pickupDate: '2026-11-01', pickupTime: '08:30',
    pickupLocation: 'Synthetic Test Stop',
    passengers: [{ name: `Synthetic ${bookingRef}`, phone: '+44 7700 900001', seatNumber }],
  }, { Origin: 'http://localhost' });

  const activeSeat = await manualCreate(`ACTIVE_${Date.now()}`, 1);
  assert.equal(activeSeat.status, 409);
  assert.equal(activeSeat.body.reason, 'SEAT_ALREADY_ASSIGNED');
  await waitForManualMutationCleanup(tourId, []);
  const absentSeat = await manualCreate(rosterOnlyRef, 2);
  assert.equal(absentSeat.status, 201, JSON.stringify(absentSeat.body));
  assert.equal(absentSeat.body.loginEligible, false);
  await waitForManualMutationCleanup(tourId, [rosterOnlyRef]);
  const rosterOnlyBooking = (await db.ref(`bookings/${rosterOnlyRef}`).once('value')).val();
  assert.equal(rosterOnlyBooking.loginEligible, false);
  assert.equal((await db.ref(`booking_identities/${rosterOnlyRef}`).once('value')).exists(), false);
  assert.equal((await db.ref(`tours/${tourId}/manualPassengerCount`).once('value')).val(), 1);

  const emailBooking = await manualCreate(loginEligibleRef, 3, 'manual-passenger@example.invalid');
  assert.equal(emailBooking.status, 201, JSON.stringify(emailBooking.body));
  assert.equal(emailBooking.body.loginEligible, true);
  await waitForManualMutationCleanup(tourId, [loginEligibleRef]);
  const identityRecord = (await db.ref(`booking_identities/${loginEligibleRef}`).once('value')).val();
  assert.equal(identityRecord.normalizedEmail, 'manual-passenger@example.invalid');
  const passengerIdentity = await newIdentity();
  assert.equal((await login('passenger', passengerIdentity, {
    bookingRef: loginEligibleRef, email: 'manual-passenger@example.invalid',
  })).status, 200);

  const driverIdentity = await newIdentity();
  const driverId = `D_MANUAL_${Date.now()}`;
  await db.ref().update({
    [`drivers/${driverId}`]: { name: 'Synthetic test driver', currentTourId: tourId, authUid: driverIdentity.uid },
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
  });
  assert.equal((await login('driver', driverIdentity, { driverId })).status, 200);
  const driverManifest = await login('manifest', driverIdentity, { tourId });
  assert.equal(driverManifest.status, 200, JSON.stringify(driverManifest.body));
  const driverBooking = driverManifest.body.bookings.find(booking => booking.id === rosterOnlyRef);
  assert.ok(driverBooking);
  assert.deepEqual(driverBooking.passengerNames, [`Synthetic ${rosterOnlyRef}`]);
  assert.deepEqual(driverBooking.seatNumbers, [2]);

  const tourAfterCreates = (await db.ref(`tours/${tourId}`).once('value')).val();
  assert.equal(tourAfterCreates.manualPassengerCount, 2);
  assert.equal(tourAfterCreates.sold, 1);
  assert.equal(tourAfterCreates.bookedPassengerCount, 1);
  assert.equal(tourAfterCreates.manifestPassengerCount, 1);
  assert.equal(tourAfterCreates.currentParticipants, 0);
  await recomputeTourProjection({
    db: admin.database(), tourId,
    order: { sourceEventAtMs: Date.now(), sourceEventId: `manual-count-test:${tourId}` },
  });
  const adminProjection = (await db.ref(`admin_dashboard/v1/tours/${tourId}`).once('value')).val();
  assert.equal(adminProjection.passengerCount, 3);
  assert.equal(adminProjection.passengerCountSource, 'tour.sold+tour.manualPassengerCount');
  const completedControl = (await db.ref(`sync_roster_control/${tourId}`).once('value')).val();
  assert.equal(completedControl.completedGeneration, generation);
  assert.equal(completedControl.completedReportDate, '2026-10-10');
  assert.equal(Object.hasOwn(completedControl, 'owner'), false);
  assert.equal(Object.hasOwn(completedControl, 'leaseUntilMs'), false);

  await db.ref(`sync_roster_control/${tourId}`).update({ owner: 'synthetic-publisher', leaseUntilMs: Date.now() + 60000 });
  const heldLease = await manualCreate(heldLeaseRef, 4);
  assert.equal(heldLease.status, 409);
  assert.equal(heldLease.body.reason, 'ROSTER_SYNC_IN_PROGRESS');
  assert.equal((await db.ref(`bookings/${heldLeaseRef}`).once('value')).exists(), false);
  assert.equal((await db.ref(`sync_roster_control/${tourId}/owner`).once('value')).val(), 'synthetic-publisher');
  await db.ref(`sync_roster_control/${tourId}`).update({ owner: null, leaseUntilMs: null });
  await waitForManualMutationCleanup(tourId, [heldLeaseRef]);

  await db.ref(`tours/${tourId}/rosterSync/state`).set('updating');
  const updating = await manualCreate(updatingRef, 4);
  assert.equal(updating.status, 409);
  assert.equal(updating.body.reason, 'ROSTER_SYNC_IN_PROGRESS');
  assert.equal((await db.ref(`bookings/${updatingRef}`).once('value')).exists(), false);
  await waitForManualMutationCleanup(tourId, [heldLeaseRef, updatingRef]);
  await db.ref().update({
    [`admin_users/${adminUid}`]: null,
    [`tours/${tourId}`]: null,
    [`bookings/${sourceBookingRef}`]: null,
    [`bookings/${absentBookingRef}`]: null,
    [`bookings/${rosterOnlyRef}`]: null,
    [`bookings/${loginEligibleRef}`]: null,
    [`booking_identities/${loginEligibleRef}`]: null,
    [`tour_manifests/${tourId}`]: null,
    [`sync_roster_control/${tourId}`]: null,
    [`drivers/${driverId}`]: null,
    [`app_sessions/${driverIdentity.uid}`]: null,
    [`app_sessions/${passengerIdentity.uid}`]: null,
  });
});

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
    assert.equal(Object.hasOwn(session, 'driverId'), false, 'RTDB removes null fields');
    const mediaAccess = await verifyCurrentTourPhotoAccess({ db, authUid: identity.uid, tourId: 'LOGIN_TOUR' });
    assert.equal(mediaAccess.allowed, true, mediaAccess.reason);
    assert.equal(mediaAccess.principalId, session.principalId);
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

test('chat status projection finalizes and releases leases from fresh Admin SDK caches', async () => {
  const { reconcileChatActorStatus } = require('../functions/lib/chatPresenceProjection');
  const { buildPassengerSessionRecord, buildPassengerParticipantRecord } = require('../functions/lib/appSession');
  const nowMs = Date.now();
  const session = buildPassengerSessionRecord({ authUid: 'chat-cache-test', principalId: `pax_v2_${'e'.repeat(32)}`, tourId: 'CHAT_TEST', nowMs });
  const record = { schemaVersion: 2, authUid: session.authUid, appSessionId: session.sessionId, principalId: session.principalId, principalType: 'passenger', actorKey: session.principalId, tourId: session.tourId, tourActorKey: `${session.tourId}|${session.principalId}`, scope: 'group', name: 'Synthetic passenger', isDriver: false, timestamp: nowMs, expiresAtMs: nowMs + 300000 };
  await db.ref().update({
    [`app_sessions/${session.authUid}`]: session,
    [`tours/${session.tourId}/participants/${session.authUid}`]: buildPassengerParticipantRecord({ session }),
    [`chat_presence_sessions/group/${session.sessionId}`]: record,
    [`chat_typing_sessions/group/${session.sessionId}`]: record,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `chat-fresh-${attempt}`);
    try {
      const result = await reconcileChatActorStatus({ database: fresh.database(), tourId: session.tourId, actorKey: session.principalId, nowMs });
      assert.equal(result.ok, true);
      assert.equal(result.presence.online, true);
      assert.equal(result.typing.timestamp, nowMs);
      const state = (await db.ref(`chat_status_projection_state/group/${session.tourId}/${session.principalId}`).once('value')).val();
      assert.equal(state.leaseOwner, undefined);
      assert.equal(state.revision, attempt + 1);
    } finally { await fresh.delete(); }
  }
});

test('media mutation locks release from a fresh cache and cannot release a foreign owner', async () => {
  const { acquireMediaRecordLock, releaseMediaRecordLock } = require('../functions/src/domains/media/groupMediaFunctions');
  const fresh = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'media-fresh-cache');
  try {
    for (const visibility of ['group', 'private']) {
      const acquired = await acquireMediaRecordLock({ db: fresh.database(), visibility, tourId: 'MEDIA_TEST', photoId: 'photo1', ownerKey: 'owner1', owner: 'first' });
      assert.equal(acquired.acquired, true);
      assert.equal(await releaseMediaRecordLock(acquired), true);
      assert.equal((await acquired.ref.once('value')).exists(), false);
      const foreign = await acquireMediaRecordLock({ db, visibility, tourId: 'MEDIA_TEST', photoId: 'photo1', ownerKey: 'owner1', owner: 'foreign' });
      assert.equal(await releaseMediaRecordLock({ ref: foreign.ref, owner: 'wrong' }), false);
      assert.equal((await foreign.ref.once('value')).val().owner, 'foreign');
    }
  } finally { await fresh.delete(); }
});

test('driver notification saves release locks and logout allows immediate re-login with live chat and location', async () => {
  const identity = await newIdentity();
  const tourId = 'DRIVER_CYCLE'; const driverId = 'D-CYCLE';
  await db.ref().update({
    [`drivers/${driverId}`]: { name: 'Synthetic Driver', currentTourId: tourId },
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    [`tours/${tourId}`]: { name: 'Synthetic Tour', isActive: true },
  });
  const signedIn = await login('driver', identity, { driverId });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const session = signedIn.body.session;
  const input = { action: 'reconcile', permissionState: 'granted', pushToken: 'ExponentPushToken[synthetic-cycle-token]',
    operationalEligible: true, tourId, appSessionId: session.sessionId, appSessionRevision: session.sessionRevision };
  for (let index = 0; index < 3; index += 1) {
    const saved = await login('notifications', identity, { ...input, action: index ? 'preferences' : 'reconcile' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.device.operationalEligible, true);
    assert.equal((await db.ref(`notification_device_locks/${identity.uid}`).once('value')).exists(), false);
  }
  const nowMs = Date.now();
  const record = { schemaVersion: 2, authUid: identity.uid, appSessionId: session.sessionId, principalId: session.principalId,
    principalType: 'driver', actorKey: driverId, tourId, tourActorKey: `${tourId}|${driverId}`, scope: 'group',
    name: 'Synthetic Driver', isDriver: true, timestamp: nowMs, expiresAtMs: nowMs + 300000 };
  const { reconcileChatActorStatus } = require('../functions/lib/chatPresenceProjection');
  const { reconcileDriverLocationProjection } = require('../functions/lib/driverLocationProjection');
  await db.ref().update({
    [`chat_presence_sessions/group/${session.sessionId}`]: record,
    [`chat_typing_sessions/group/${session.sessionId}`]: record,
    [`driver_location_sessions/${session.sessionId}`]: { ...record, source: 'auto', mode: 'live', driverId, latitude: 56, longitude: -4 },
  });
  // Independent SDK connections reproduce competing source triggers during logout.
  const fresh = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'driver-cycle-projections');
  try {
    await Promise.all([
      reconcileChatActorStatus({ database: fresh.database(), tourId, actorKey: driverId }),
      reconcileChatActorStatus({ database: db, tourId, actorKey: driverId }),
      reconcileDriverLocationProjection({ database: fresh.database(), tourId }),
    ]);
    const ended = await login('end', identity, { expectedSessionId: session.sessionId, reason: 'user_logout' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal((await db.ref(`app_sessions/${identity.uid}`).once('value')).exists(), false);
    assert.equal((await db.ref(`chat_presence_sessions/group/${session.sessionId}`).once('value')).exists(), false);
    assert.equal((await db.ref(`driver_location_sessions/${session.sessionId}`).once('value')).exists(), false);
    const repeated = await login('driver', identity, { driverId });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.notEqual(repeated.body.session.sessionId, session.sessionId);
  } finally { await fresh.delete(); }
});

test('notification mutation holds both locks until persistence completes and cannot release another owner', async () => {
  const { releaseNotificationDeviceLock } = require('../functions/lib/appSessionCleanup');
  const fresh = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'notification-lock-cache');
  const authUid = 'notification-lock-test';
  const lockRef = db.ref(`notification_device_locks/${authUid}`);
  try {
    await lockRef.set({ owner: 'foreign', expiresAtMs: Date.now() + 30000 });
    assert.equal(await releaseNotificationDeviceLock({ lockRef: fresh.database().ref(`notification_device_locks/${authUid}`), owner: 'wrong' }), false);
    assert.equal((await lockRef.once('value')).val().owner, 'foreign');
    assert.equal(await releaseNotificationDeviceLock({ lockRef: fresh.database().ref(`notification_device_locks/${authUid}`), owner: 'foreign' }), true);
    let proceed; let entered;
    const held = new Promise((resolve) => { proceed = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const database = fresh.database();
    const wrapped = { ref: (path) => {
      const ref = database.ref(path);
      if (path === `notification_devices/${authUid}`) {
        const original = ref.once.bind(ref);
        ref.once = async (...args) => { entered(); await held; return original(...args); };
      }
      return ref;
    } };
    const operation = updateNotificationDevice({ db: wrapped, authUid, input: { action: 'preferences', permissionState: 'denied' } });
    await started;
    try {
      assert.equal((await lockRef.once('value')).exists(), true);
      assert.equal((await db.ref(`app_session_locks/${authUid}`).once('value')).exists(), true);
    } finally { proceed(); }
    assert.equal((await operation).status, 200);
    assert.equal((await lockRef.once('value')).exists(), false);
  } finally { await fresh.delete(); }
});

test('group and private photo variants reach ready across cold-cache transactions', async () => {
  const { generatePhotoVariantsForRecord } = require('../functions/src/domains/media/photoVariants');
  const sharp = require('../functions/node_modules/sharp');
  const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#23439a' } }).png().toBuffer();
  for (const visibility of ['group', 'private']) {
    const collection = visibility === 'group' ? 'group_tour_photos/VARIANT_TEST' : 'private_tour_photos/VARIANT_TEST/owner1';
    const record = { storagePath: `${collection}/source.png`, userId: 'owner1', variantStatus: 'processing' };
    await db.ref(`${collection}/photo1`).set(record);
    const saved = new Map();
    const bucket = { file: (objectPath) => ({
      download: async () => [source],
      getMetadata: async () => [{ generation: '1', metadata: {} }],
      setMetadata: async () => {},
      save: async (buffer) => saved.set(objectPath, buffer),
      delete: async () => saved.delete(objectPath),
    }) };
    const fresh = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `variant-${visibility}`);
    try {
      const result = await generatePhotoVariantsForRecord({ bucketName: 'synthetic', visibility, tourId: 'VARIANT_TEST', ownerKey: visibility === 'private' ? 'owner1' : null, photoId: 'photo1', photoRecord: record, database: fresh.database(), dbRoot: fresh.database().ref(collection), storageBucket: bucket });
      assert.equal(result.status, 'ready', JSON.stringify(result));
      const stored = (await db.ref(`${collection}/photo1`).once('value')).val();
      assert.equal(stored.variantStatus, 'ready');
      assert.ok(saved.get(stored.viewerStoragePath)?.length);
      assert.ok(saved.get(stored.thumbnailStoragePath)?.length);
    } finally { await fresh.delete(); }
  }
});
