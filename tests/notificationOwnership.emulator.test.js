'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A loopback Realtime Database emulator is required');
}
const projectId = 'demo-llt-notification-ownership';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const { acquireAppSessionLock, releaseAppSessionLock } = require('../functions/lib/appSessionLock');
const { cleanupAppSession } = require('../functions/lib/appSessionCleanup');
const { issueDriverAppSession } = require('../functions/src/domains/app-sessions/sessionIssuance');
const { updateNotificationDevice, deleteNotificationAccountState } = require('../functions/src/domains/notifications/notificationDeviceFunctions');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const fixtureApp = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'ownership-fixtures');
const db = fixtureApp.database();
const uid = 'synthetic-phone';
const driverId = 'D-SYNTHETIC';
const tourId = 'SYNTHETIC_TOUR';
const token = 'ExponentPushToken[syntheticownership]';
let now; let appCounter = 0;
const clock = () => now;
const read = async path => (await db.ref(path).get()).val();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Only asynchronous adapter boundaries are paused. Every transaction, issuance,
// registration, cleanup decision and server comparison uses production code.
const interceptedDatabase = (database, hooks = {}) => ({ ref(path = '') {
  const wrap = ref => new Proxy(ref, { get(target, key) {
    if (key === 'once' || key === 'get') return async (...args) => {
      await hooks.beforeRead?.(path);
      return target[key](...args);
    };
    if (key === 'transaction') return async (...args) => {
      await hooks.beforeTransaction?.(path);
      return target.transaction(...args);
    };
    if (typeof target[key] !== 'function') return target[key];
    if (['orderByChild', 'orderByKey', 'equalTo', 'startAt', 'endAt', 'limitToFirst'].includes(key)) {
      return (...args) => wrap(target[key](...args));
    }
    return target[key].bind(target);
  } });
  return wrap(path ? database.ref(path) : database.ref());
} });
const cold = async (operation, hooks = {}) => {
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `ownership-cold-${++appCounter}`);
  try { return await operation(interceptedDatabase(app.database(), hooks)); }
  finally { await app.delete(); }
};
const issue = (database = db, assigned = false) => issueDriverAppSession({ db: database, authUid: uid,
  driverId, tourId: assigned ? tourId : null, nowMs: now, clock, profileUpdates: {
    [`users/${uid}/principalType`]: 'driver', [`users/${uid}/driverId`]: driverId,
    [`users/${uid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${uid}/driverAssignedTourId`]: assigned ? tourId : null,
  } });
const registration = session => ({ action: 'reconcile', appSessionId: session?.sessionId,
  appSessionRevision: session?.sessionRevision, tourId: session?.tourId, operationalEligible: false,
  permissionState: 'granted', pushToken: token, marketingPreferences: { day_trips: true } });
const register = (session, database = db, changes = {}) => updateNotificationDevice({
  db: database, authUid: uid, input: { ...registration(session), ...changes }, nowMs: now, clock,
});
const state = async () => ({ session: await read(`app_sessions/${uid}`),
  device: await read(`notification_devices/${uid}`), consent: await read(`notification_consents/${uid}`),
  audience: await read('notification_marketing_audience') });
test.before(async () => installDemoDatabaseRules({ projectId }));
test.beforeEach(async () => {
  now = Date.now();
  await db.ref().set(null);
  await db.ref().update({ [`drivers/${driverId}`]: { currentTourId: tourId },
    [`tours/${tourId}/isActive`]: true, [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: now },
  });
});
test.after(async () => Promise.all(admin.apps.map(app => app.delete())));

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
      const lock = await acquireAppSessionLock({ db: database, authUid: uid, operation: 'revoke', nowMs: now, clock });
      try { return await cleanupAppSession({ db: database, session: lock.session,
        expectedSessionId: old.sessionId, eventType: 'ended_by_admin', reason: 'synthetic-revoke',
        actorType: 'admin', nowMs: now, clock, appSessionLock: lock }); }
      finally { await releaseAppSessionLock({ db: database, authUid: uid, owner: lock.owner }); }
    }, scenario.boundary === 'read' ? { beforeRead: pause } : { beforeTransaction: pause });
    const outcome = oldWork.then(() => null, error => error);
    await paused.promise;
    now += 31_001;
    const successor = await cold(database => issue(database, scenario.assigned));
    if (scenario.assigned) {
      // The canonical assigned session remains valid, but operational authority
      // fails the real manifest check; ownership must not depend on that result.
      await db.ref(`tour_manifests/${tourId}/assigned_drivers/${driverId}`).remove();
    }
    assert.equal((await cold(database => register(successor, database,
      { operationalEligible: scenario.assigned }))).status, 200);
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

for (const boundary of ['read', 'device', 'consent', 'audience']) {
  test(`stale registration paused before ${boundary} cannot overwrite successor ownership or consent`, { timeout: 20_000 }, async () => {
    const old = await issue();
    await register(old);
    const paused = deferred(); const resume = deferred(); let intercepted = false;
    const pause = async path => {
      const target = boundary === 'read' ? `app_sessions/${uid}` : boundary === 'device' ? `notification_devices/${uid}`
        : boundary === 'consent' ? `notification_consents/${uid}` : `notification_marketing_audience/v1/day_trips/${uid}`;
      if (!intercepted && path === target) { intercepted = true; paused.resolve(); await resume.promise; }
    };
    const work = cold(database => register(old, database, { marketingPreferences: { day_trips: false } }),
      boundary === 'read' ? { beforeRead: pause } : { beforeTransaction: pause });
    await paused.promise;
    now += 31_001;
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
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(now - 1);
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

test('first logged-out marketing and legacy no-session-ID registration use only verified server ownership', async () => {
  assert.equal((await register(null)).status, 200);
  let device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId ?? null, null);
  assert.equal(device.marketingEligible, true);
  const session = await issue();
  // A stale legacy tag is data to replace from canonical authority, not proof.
  await db.ref(`notification_devices/${uid}/authoritySessionId`).set(`sess_v1_${'d'.repeat(32)}`);
  assert.equal((await register(null, db, { action: 'preferences' })).status, 200);
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
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'revoke', nowMs: now, clock });
  try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
    eventType: 'ended_by_admin', reason: 'legacy-owner-unknown', nowMs: now, clock, appSessionLock: lock }); }
  finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
  assert.equal(await read(`app_sessions/${uid}`), null);
  assert.deepEqual(await read(`notification_devices/${uid}`), before);
});

test('a delayed registration cannot recreate device or consent after permanent deletion', { timeout: 20_000 }, async () => {
  const session = await issue(); await register(session);
  const paused = deferred(); const resume = deferred(); let intercepted = false;
  const work = cold(database => register(session, database), { beforeTransaction: async path => {
    if (!intercepted && path === `notification_devices/${uid}`) {
      intercepted = true; paused.resolve(); await resume.promise;
    }
  } });
  await paused.promise;
  now += 31_001;
  await cold(database => deleteNotificationAccountState({ db: database, authUid: uid, nowMs: now }));
  const tombstone = await read(`notification_device_tombstones/${uid}`);
  assert.equal(tombstone.permanent, true);
  resume.resolve();
  assert.equal((await work).body.ignored, true);
  for (const path of [`notification_devices/${uid}`, `notification_consents/${uid}`,
    `notification_marketing_audience/v1/day_trips/${uid}`]) assert.equal(await read(path), null);
  assert.deepEqual(await read(`notification_device_tombstones/${uid}`), tombstone);
  assert.equal((await register(session)).body.reason, 'DEVICE_DELETED');
});

for (const consent of [false, true]) {
  test(`real session end followed by exact notification logout preserves marketing=${consent}`, async () => {
    const session = await issue();
    await register(session, db, { marketingPreferences: { day_trips: consent } });
    const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now, clock });
    try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
      eventType: 'ended_by_user', reason: 'user_logout', nowMs: now, clock, appSessionLock: lock }); }
    finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
    assert.equal(await read(`app_sessions/${uid}`), null);
    const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid,
      input: { action: 'logout', appSessionId: session.sessionId }, nowMs: now, clock }));
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
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(now - 1);
  let result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId, pushToken: 'ExponentPushToken[untrustedrenewal]',
      marketingPreferences: { day_trips: true } }, nowMs: now, clock });
  assert.equal(result.body.ignored, undefined);
  assert.equal((await read(`notification_devices/${uid}`)).pushToken ?? null, null);
  assert.equal((await read(`notification_devices/${uid}`)).marketingPreferences.day_trips, false);
  const successor = await issue(); await register(successor);
  const before = await state();
  result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId }, nowMs: now, clock });
  assert.equal(result.body.reason, 'STALE_APP_SESSION');
  assert.deepEqual(await state(), before);
  await db.ref(`app_sessions/${uid}/expiresAtMs`).set(now - 1);
  const expiredSuccessor = await state();
  result = await updateNotificationDevice({ db, authUid: uid,
    input: { action: 'logout', appSessionId: old.sessionId }, nowMs: now, clock });
  assert.equal(result.body.reason, 'STALE_APP_SESSION');
  assert.deepEqual(await state(), expiredSuccessor);
});

test('post-end logout retries repair consent after its exact device commit', async () => {
  const session = await issue(); await register(session);
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now, clock });
  try { await cleanupAppSession({ db, session: lock.session, expectedSessionId: session.sessionId,
    eventType: 'ended_by_user', reason: 'user_logout', nowMs: now, clock, appSessionLock: lock }); }
  finally { await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner }); }
  const input = { action: 'logout', appSessionId: session.sessionId, registrationRevision: 10 };
  await assert.rejects(cold(database => updateNotificationDevice({ db: database, authUid: uid,
    input, nowMs: now, clock }), { beforeTransaction: path => {
    if (path === `notification_consents/${uid}`) throw new Error('synthetic consent interruption');
  } }), /synthetic consent interruption/);
  const device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId ?? null, null);
  assert.equal(device.lastMutationAction, 'logout');
  assert.equal(device.lastMutationSessionId, session.sessionId);
  const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid, input, nowMs: now, clock }));
  assert.equal(result.body.reason, 'ALREADY_APPLIED');
  assert.deepEqual(await read(`notification_devices/${uid}`), device);
  assert.equal((await read(`notification_consents/${uid}`)).registrationRevision, 10);
  assert.equal((await read(`notification_marketing_audience/v1/day_trips/${uid}`)).registrationRevision, 10);
});
