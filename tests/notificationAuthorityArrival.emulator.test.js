'use strict';

const { test, assert, updateNotificationDevice, createNotificationPublisher, revokeStaffEnrolment, db, uid, driverId, clock, read, deferred, issue, issuePassenger, passengerBookingRef, registration, register, state } = require('./helpers/notificationOwnershipFixture');

for (const change of ['staff-revoked', 'driver-reassigned', 'assignment-transition', 'malformed-assignment-marker', 'policy-transition', 'booking-transferred', 'booking-cancelled', 'roster-withdrawn']) {
  test(`queued notification registration rejects ${change} without waiting for session cleanup`, { timeout: 25000 }, async () => {
    const passenger = change.startsWith('booking') || change === 'roster-withdrawn';
    const session = passenger ? await issuePassenger() : await issue(db, true);
    assert.equal((await register(session)).body.ignored, undefined);
    const queued = deferred(); let publisher;
    const createPublisher = options => {
      publisher = createNotificationPublisher(options); publisher.db.goOffline();
      const database = publisher.db;
      return { close: publisher.close, db: { ref: () => ({ update: updates => {
        const pending = database.ref().update(updates); queued.resolve(); return pending;
      } }) } };
    };
    const pending = updateNotificationDevice({ db, authUid: uid,
      input: { ...registration(session), marketingPreferences: { day_trips: false } }, nowMs: clock(), clock, createPublisher });
    await Promise.race([queued.promise, pending.then(result => { throw new Error(`Publication never queued: ${JSON.stringify(result)}`); })]);
    if (change === 'staff-revoked') await revokeStaffEnrolment({ db, driverId, adminUid: 'synthetic-admin', nowMs: clock() });
    if (change === 'assignment-transition') await db.ref(`driver_assignment_active/v1/${driverId}`).set({ transitionId: 'synthetic-transition' });
    if (change === 'malformed-assignment-marker') await db.ref(`driver_assignment_active/v1/${driverId}`).set(false);
    if (change === 'policy-transition') await db.ref('driver_login_policy/v1/transitionPhase').set('transitioning');
    if (change === 'driver-reassigned') await db.ref(`drivers/${driverId}/currentTourId`).set('OTHER_SYNTHETIC_TOUR');
    if (change === 'booking-transferred') await db.ref(`bookings/${passengerBookingRef}/tourId`).set('OTHER_SYNTHETIC_TOUR');
    if (change === 'booking-cancelled') await db.ref(`bookings/${passengerBookingRef}/loginEligible`).set(false);
    if (change === 'roster-withdrawn') await db.ref(`bookings/${passengerBookingRef}/sourceRoster`).set({ schemaVersion: 1, state: 'withdrawn' });
    const before = await state();
    assert.equal(before.session.sessionId, session.sessionId, 'canonical session intentionally remains present');
    publisher.db.goOnline();
    assert.equal((await pending).body.ignored, true);
    assert.deepEqual(await state(), before, 'queued mutation must not alter device, consent or audience');
  });
}


test('public notification deletion cannot erase a successor registration or create a permanent tombstone', async () => {
  const previous = await issue(db, true);
  await register(previous);
  const successor = await issue(db, true);
  await register(successor);
  const before = await state();
  for (const session of [previous, successor]) {
    const result = await updateNotificationDevice({ db, authUid: uid, nowMs: clock(), clock,
      input: { action: 'delete', appSessionId: session.sessionId, registrationRevision: 999 } });
    assert.equal(result.status, 400);
    assert.equal(result.body.reason, 'INVALID_ACTION');
    assert.deepEqual(await state(), before);
    assert.equal(await read(`notification_device_tombstones/${uid}`), null);
  }
});
