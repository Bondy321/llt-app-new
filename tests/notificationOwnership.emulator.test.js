'use strict';

const { test, assert, acquireAppSessionLock, releaseAppSessionLock, cleanupAppSession,
  updateNotificationDevice, deleteNotificationAccountState, createNotificationPublisher,
  db, uid, token, clock, read, deferred, cold, issue, registration, register, state, advanceTime,
} = require('./helpers/notificationOwnershipFixture');

for (const scenario of [
  { label: 'absent first unassigned device before snapshot', assigned: false, seeded: false, boundary: 'read' },
  { label: 'absent first assigned but operationally ineligible device before snapshot', assigned: true, seeded: false, boundary: 'read' },
  { label: 'pre-existing device before derived transaction', assigned: false, seeded: true, boundary: 'transaction' },
]) {
  test(`full stale cleanup preserves ${scenario.label}`, { timeout: 20_000 }, async () => {
    const old = await issue();
    if (scenario.seeded) await register(old);
    else assert.equal(await read(`notification_devices/${uid}`), null, 'regression must genuinely start without a device');
    const paused = deferred(); const resume = deferred(); let intercepted = false;
    const pause = async path => {
      if (!intercepted && path === `notification_devices/${uid}`) {
        intercepted = true; paused.resolve(); await resume.promise;
      }
    };
    const oldWork = cold(async database => {
      const lock = await acquireAppSessionLock({ db: database, authUid: uid, operation: 'revoke', nowMs: clock(), clock });
      try { return await cleanupAppSession({ db: database, session: lock.session,
        expectedSessionId: old.sessionId, eventType: 'ended_by_admin', reason: 'synthetic-revoke',
        actorType: 'admin', nowMs: clock(), clock, appSessionLock: lock }); }
      finally { await releaseAppSessionLock({ db: database, authUid: uid, owner: lock.owner }); }
    }, scenario.boundary === 'read' ? { beforeRead: pause } : { beforeTransaction: pause });
    const outcome = oldWork.then(() => null, error => error);
    await paused.promise;
    advanceTime(31_001);
    const successor = await cold(database => issue(database, scenario.assigned));
    // Valid assignment can still have operational delivery disabled by the
    // device. Ownership must not depend on that opt-in state.
    assert.equal((await cold(database => register(successor, database,
      { operationalEligible: false }))).status, 200);
    const before = await state();
    resume.resolve();
    assert.equal((await outcome)?.code, 'SESSION_CHANGED');
    assert.deepEqual(await state(), before, 'cleanup must preserve all successor state, not just the canonical SID');
    assert.equal(before.device.authoritySessionId, successor.sessionId);
    assert.equal(before.device.operationalEligible, false);
    assert.equal(before.device.pushToken, token);
    assert.equal(before.device.status, 'active');
    assert.equal(before.device.marketingEligible, true);
    assert.equal(before.consent.marketingPreferences.day_trips, true);
  });
}

for (const boundary of ['read', 'publication']) {
  test(`stale registration paused before ${boundary} cannot overwrite successor ownership or consent`, { timeout: 20_000 }, async () => {
    const old = await issue();
    await register(old);
    const paused = deferred(); const resume = deferred(); let intercepted = false;
    const pause = async path => {
      const target = boundary === 'read' ? `app_sessions/${uid}` : `notification_mutation_authority/${uid}`;
      if (!intercepted && path === target) { intercepted = true; paused.resolve(); await resume.promise; }
    };
    const work = cold(database => register(old, database, { marketingPreferences: { day_trips: false } }),
      boundary === 'read' ? { beforeRead: pause } : { beforeTransaction: pause });
    await paused.promise;
    advanceTime(31_001);
    const successor = await cold(database => issue(database));
    await cold(database => register(successor, database));
    const before = await state();
    resume.resolve();
    await work;
    assert.deepEqual(await state(), before);
    assert.equal(before.device.authoritySessionId, successor.sessionId);
  });
}

test('invalid requested authority cannot mutate a successor while logged-out marketing remains supported', async () => {
  const successor = await issue(); await register(successor);
  const before = await state();
  for (const appSessionId of [`sess_v1_${'a'.repeat(32)}`, 'malformed']) {
    const result = await register(successor, db, { appSessionId, marketingPreferences: { day_trips: false } });
    assert.equal(result.body.ignored, true);
    assert.deepEqual(await state(), before);
  }
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(clock() - 1);
  const expiredBefore = await state();
  assert.equal((await register(successor, db, { marketingPreferences: { day_trips: false } })).body.ignored, true);
  assert.deepEqual(await state(), expiredBefore);
  await db.ref(`app_sessions/${uid}`).remove();
  const missingBefore = await state();
  assert.equal((await register(successor, db, { marketingPreferences: { day_trips: false } })).body.ignored, true);
  assert.deepEqual(await state(), missingBefore);
  const loggedOut = await register(null, db, { action: 'preferences', appSessionId: null });
  assert.equal(loggedOut.status, 200); assert.equal(loggedOut.body.ignored, undefined);
  const device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId ?? null, null);
  assert.equal(device.marketingEligible, true); assert.equal(device.operationalEligible, false);
});

test('logged-out marketing works but signed-in registration requires the exact current SID', async () => {
  assert.equal((await register(null)).status, 200);
  let device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId ?? null, null);
  assert.equal(device.marketingEligible, true);
  const session = await issue();
  // A stale legacy tag is data to replace from canonical authority, not proof.
  await db.ref(`notification_devices/${uid}/authoritySessionId`).set(`sess_v1_${'d'.repeat(32)}`);
  const before = await state();
  assert.equal((await register(null, db, { action: 'preferences' })).body.reason, 'STALE_APP_SESSION');
  assert.deepEqual(await state(), before);
  await register(session);
  device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId, session.sessionId);
  assert.equal(device.operationalEligible, false);
  assert.equal(device.marketingEligible, true);
  assert.equal((await read(`app_sessions/${uid}`)).sessionRevision, session.sessionRevision);
});

test('unowned legacy marketing survives full cleanup because snapshot equality is not ownership', async () => {
  const session = await issue();
  await register(session);
  await db.ref(`notification_devices/${uid}/authoritySessionId`).remove();
  const before = await read(`notification_devices/${uid}`);
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'revoke', nowMs: clock(), clock });
  try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
    eventType: 'ended_by_admin', reason: 'legacy-owner-unknown', nowMs: clock(), clock, appSessionLock: lock }); }
  finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
  assert.equal(await read(`app_sessions/${uid}`), null);
  assert.deepEqual(await read(`notification_devices/${uid}`), before);
});

for (const successorKind of ['session', 'deletion']) {
  test(`already-queued atomic registration cannot commit after ${successorKind}`, { timeout: 25000 }, async () => {
    const session = await issue(); await register(session);
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
    await queued.promise;
    advanceTime(31_001);
    if (successorKind === 'session') { const successor = await cold(database => issue(database)); await register(successor); }
    else await deleteNotificationAccountState({ db, authUid: uid, nowMs: clock() });
    const before = await state(); const tombstone = await read(`notification_device_tombstones/${uid}`);
    publisher.db.goOnline();
    assert.equal((await pending).body.ignored, true);
    assert.deepEqual(await state(), before);
    assert.deepEqual(await read(`notification_device_tombstones/${uid}`), tombstone);
  });
}
