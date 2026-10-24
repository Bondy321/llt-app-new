'use strict';

const { test, assert, acquireAppSessionLock, releaseAppSessionLock, cleanupAppSession,
  updateNotificationDevice, db, uid, token, clock, read, cold, issue, register, state,
} = require('./helpers/notificationOwnershipFixture');

for (const consent of [false, true]) {
  test(`real session end followed by exact notification logout preserves marketing=${consent}`, async () => {
    const session = await issue();
    await register(session, db, { marketingPreferences: { day_trips: consent } });
    const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: clock(), clock });
    try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
      eventType: 'ended_by_user', reason: 'user_logout', nowMs: clock(), clock, appSessionLock: lock }); }
    finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
    assert.equal(await read(`app_sessions/${uid}`), null);
    const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid,
      input: { action: 'logout', appSessionId: session.sessionId }, nowMs: clock(), clock }));
    assert.equal(result.status, 200); assert.equal(result.body.ignored, undefined);
    const device = await read(`notification_devices/${uid}`);
    assert.equal(device.authoritySessionId ?? null, null);
    assert.equal(device.operationalEligible, false);
    assert.equal(device.marketingEligible, consent);
    assert.equal(device.pushToken ?? null, consent ? token : null);
    assert.equal(device.marketingPreferences.day_trips, consent);
    assert.equal((await read(`notification_consents/${uid}`)).marketingPreferences.day_trips, consent);
  });
}

test('expired exact-owned logout reduces delivery but stale logout cannot touch a successor', async () => {
  const old = await issue(); await register(old, db, { marketingPreferences: { day_trips: false } });
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(clock() - 1);
  let result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId, pushToken: 'ExponentPushToken[untrustedrenewal]',
      marketingPreferences: { day_trips: true } }, nowMs: clock(), clock });
  assert.equal(result.body.ignored, undefined);
  assert.equal((await read(`notification_devices/${uid}`)).pushToken ?? null, null);
  assert.equal((await read(`notification_devices/${uid}`)).marketingPreferences.day_trips, false);
  const successor = await issue(); await register(successor);
  const before = await state();
  result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId }, nowMs: clock(), clock });
  assert.equal(result.body.reason, 'STALE_APP_SESSION');
  assert.deepEqual(await state(), before);
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(clock() - 1);
  const expiredSuccessor = await state();
  result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId }, nowMs: clock(), clock });
  assert.equal(result.body.reason, 'STALE_APP_SESSION');
  assert.deepEqual(await state(), expiredSuccessor);
});

test('post-end logout retry is idempotent across all three atomic projections', async () => {
  const session = await issue(); await register(session);
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: clock(), clock });
  try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
    eventType: 'ended_by_user', reason: 'user_logout', nowMs: clock(), clock, appSessionLock: lock }); }
  finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
  const input = { action: 'logout', appSessionId: session.sessionId, registrationRevision: 10 };
  await updateNotificationDevice({ db, authUid: uid, input, nowMs: clock(), clock });
  const before = await state();
  const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid, input, nowMs: clock(), clock }));
  assert.equal(result.body.reason, 'ALREADY_APPLIED');
  assert.deepEqual(await state(), before);
  assert.equal(before.consent.registrationRevision, 10);
  assert.equal(before.audience.v1.day_trips[uid].registrationRevision, 10);
});
