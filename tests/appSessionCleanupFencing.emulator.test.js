'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A local Realtime Database emulator is required');
}
const projectId = 'demo-llt-session-cleanup';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../functions/node_modules/firebase-admin');
const { enrolSyntheticDriver } = require('./helpers/enrolSyntheticDriver');
const { acquireAppSessionLock, releaseAppSessionLock, renewAppSessionLock } = require('../functions/lib/appSessionLock');
const { cleanupAppSession } = require('../functions/lib/appSessionCleanup');
const { verifyActiveAppSession } = require('../functions/lib/appSessionAccess');
const { issuePassengerAppSession, issueDriverAppSession, buildVerifiedLoginGrantUpdates,
  APP_SESSION_ISSUANCE_LOCK_TTL_MS } = require('../functions/src/domains/app-sessions/sessionIssuance');
const { verifyPassengerLogin } = require('../functions/src/domains/passenger-auth/passengerLoginFunction');
const { verifyDriverLogin } = require('../functions/src/domains/driver-auth/driverLoginFunction');
const { performDriverTrackingStop } = require('../functions/src/domains/live-state/driverTrackingStop');
const { reconcileTransitionSessionPage } = require('../functions/src/domains/driver-assignment/assignmentTransition');
const { processExpiredAppSessions } = require('../functions/src/domains/maintenance/scheduledCleanupFunctions');
const { processDriverLoginPolicyCleanupJobs } = require('../functions/src/domains/driver-auth/driverDevicePolicyFunctions');
const { resolveOperationalAuthority } = require('../functions/src/domains/notifications/notificationAudiencePage');
const { updateNotificationDevice } = require('../functions/src/domains/notifications/notificationDeviceFunctions');
const { installDemoDatabaseRules } = require('./helpers/installDemoDatabaseRules');
const writer = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), 'session-cleanup-fixtures');
const db = writer.database();
const principalId = `pax_v2_${'8'.repeat(32)}`;
const uid = 'synthetic-phone';
const tourId = 'SYNTHETIC_TOUR';
const driverId = 'D-SYNTHETIC';
let appCounter = 0;
let now;
const clock = () => now;
const read = async path => (await db.ref(path).get()).val();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Only asynchronous adapter boundaries are instrumented. Claims, cleanup,
// issuance and every transaction use the real Admin SDK and emulator server.
const interceptedDatabase = (database, hooks = {}) => ({ app: database.app, ref(path = '') {
  const wrap = ref => new Proxy(ref, { get(target, key) {
    if (key === 'once' || key === 'get') return async (...args) => {
      await hooks.beforeRead?.(path);
      return target[key](...args);
    };
    if (key === 'transaction') return async (...args) => {
      await hooks.beforeTransaction?.(path);
      const result = await target.transaction(...args);
      await hooks.afterTransaction?.(path, result);
      return result;
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
  const app = admin.initializeApp(JSON.parse(process.env.FIREBASE_CONFIG), `session-cleanup-cold-${++appCounter}`);
  try { return await operation(interceptedDatabase(app.database(), hooks)); }
  finally { await app.delete(); }
};
test.before(async () => { await installDemoDatabaseRules({ projectId }); });
test.beforeEach(async () => {
  now = Date.now();
  await db.ref().set(null);
  await db.ref().update({
    [`bookings/SYNTHETIC_BOOKING`]: { tourId, loginEligible: true },
    'passenger_identity_security/SYNTHETIC_BOOKING': { passengerPrincipalId: principalId,
      passengerIdentityVersion: 'pax_v2' },
    [`tours/${tourId}/isActive`]: true,
    [`drivers/${driverId}`]: { name: 'Synthetic driver', currentTourId: tourId },
    [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: now },
    [`notification_devices/${uid}`]: { schemaVersion: 1, authUid: uid, status: 'active',
      registrationRevision: 1, pushToken: 'ExponentPushToken[syntheticfixture]', operationalEligible: false },
  });
});
test.after(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

const issue = async (database = db, role = 'passenger', authUid = uid) => {
  if (role === 'driver') return issueDriverAppSession({ db: database, authUid, driverId, tourId,
    ...(await enrolSyntheticDriver({ db: database, authUid, driverId, nowMs: now })), driverLoginPolicyGeneration: 0,
    nowMs: now, clock, profileUpdates: {
      [`users/${authUid}/principalType`]: 'driver', [`users/${authUid}/driverId`]: driverId,
      [`users/${authUid}/driverPrincipalId`]: `driver:${driverId}`,
      [`users/${authUid}/driverAssignedTourId`]: tourId, [`users/${authUid}/lastUpdated`]: now,
    } });
  return issuePassengerAppSession({ db: database, authUid, principalId, tourId, nowMs: now, clock,
    identityUpdates: { [`users/${authUid}/bookingRef`]: 'SYNTHETIC_BOOKING',
      [`users/${authUid}/stablePassengerId`]: principalId, [`users/${authUid}/identityVersion`]: 'pax_v2',
      [`users/${authUid}/lastUpdated`]: now,
      [`passenger_identity_security/SYNTHETIC_BOOKING/deviceAuthorizationVersion`]: 2,
      [`passenger_identity_security/SYNTHETIC_BOOKING/authorizedAuthUids/${authUid}`]: true },
    grantUpdates: buildVerifiedLoginGrantUpdates({ authUid, bookingRef: 'SYNTHETIC_BOOKING', tourId, nowMs: now }),
  });
};
const enableDelivery = async session => db.ref().update({
  [`users/${uid}/pushToken`]: 'ExponentPushToken[syntheticreplacement]',
  [`users/${uid}/pushTokenStatus`]: 'ACTIVE',
  [`notification_devices/${uid}/operationalSessionId`]: session.sessionId,
  [`notification_devices/${uid}/operationalSessionRevision`]: session.sessionRevision,
  [`notification_devices/${uid}/operationalTourId`]: tourId,
  [`notification_devices/${uid}/operationalEligible`]: true,
  [`notification_devices/${uid}/pushToken`]: 'ExponentPushToken[syntheticreplacement]',
});
const publish = async session => {
  const key = `${session.sessionId}|track_synthetic`;
  const source = { schemaVersion: 2, authUid: uid, appSessionId: session.sessionId, driverId, tourId,
    isSharing: true, source: 'auto', mode: 'live', liveSharingSessionId: 'track_synthetic',
    latitude: 56, longitude: -4, accuracy: 5, timestamp: now, cleanupAtMs: now + 1800000 };
  await db.ref().update({ [`driver_location_sessions/${key}`]: source,
    [`driver_tracking_sessions/${key}`]: { schemaVersion: 1, authUid: uid, appSessionId: session.sessionId,
      driverId, tourId, liveSharingSessionId: 'track_synthetic', startedAtMs: now,
      expiresAtMs: session.expiresAtMs, status: 'active' },
  });
  return key;
};
const assertReplacement = async (session, role, sourceKey) => {
  const saved = await read(`app_sessions/${uid}`);
  assert.equal(saved.sessionId, session.sessionId);
  assert.equal(saved.sessionRevision, session.sessionRevision);
  assert.equal(saved.status, 'active');
  assert.equal((await verifyActiveAppSession({ db, authUid: uid, expectedTourId: tourId, nowMs: now })).allowed, true);
  const profile = await read(`users/${uid}`);
  assert.equal(profile.appSessionId, session.sessionId);
  assert.equal(profile.pushTokenStatus, 'ACTIVE');
  const device = await read(`notification_devices/${uid}`);
  assert.equal(device.operationalEligible, true);
  assert.equal(device.operationalSessionId, session.sessionId);
  assert.equal(device.pushToken, 'ExponentPushToken[syntheticreplacement]');
  assert.equal((await resolveOperationalAuthority(db, uid, profile, tourId, now)).allowed, true);
  if (role === 'passenger') {
    assert.equal((await read(`tours/${tourId}/participants/${uid}`)).sessionId, session.sessionId);
    assert.equal((await read(`tour_access_grants/${tourId}/${uid}`)).sessionId, session.sessionId);
    assert.equal((await read(`booking_access_grants/SYNTHETIC_BOOKING/${uid}`)).sessionId, session.sessionId);
  } else {
    assert.equal((await read(`driver_location_sessions/${sourceKey}`)).appSessionId, session.sessionId);
    assert.equal((await read(`driver_tracking_sessions/${sourceKey}`)).status, 'active');
  }
};

for (const role of ['passenger', 'driver']) {
  test(`expired cleanup lease cannot delete a real replacement ${role} session or derived authority`, async () => {
    const old = await issue(db, role);
    await enableDelivery(old);
    const paused = deferred(); const resume = deferred(); let intercepted = false;
    const oldWork = cold(async database => {
      const lock = await acquireAppSessionLock({ db: database, authUid: uid, operation: 'cleanup', nowMs: now });
      try {
        await cleanupAppSession({ db: database, session: lock.session, expectedSessionId: old.sessionId,
          eventType: 'expired', reason: 'test_expired', actorType: 'system', nowMs: now, clock, appSessionLock: lock });
      } finally { await releaseAppSessionLock({ db: database, authUid: uid, owner: lock.owner }); }
    }, { beforeRead: async path => {
      if (!intercepted && path === 'driver_location_sessions') {
        intercepted = true; paused.resolve(); await resume.promise;
      }
    } });
    const oldOutcome = oldWork.then(() => null, error => error);
    await paused.promise;
    now += 31000;
    const replacement = await cold(database => issue(database, role));
    await enableDelivery(replacement);
    const key = role === 'driver' ? await publish(replacement) : null;
    resume.resolve();
    assert.equal((await oldOutcome)?.code, 'SESSION_CHANGED');
    await assertReplacement(replacement, role, key);
  });
}

for (const state of ['partial', 'malformed', 'expired', 'missing']) {
  test(`real Stop retires exact retained tracking proof with ${state} canonical authority`, async () => {
    const session = await issue(db, 'driver');
    const key = await publish(session);
    const record = await read(`driver_tracking_sessions/${key}`);
    const canonical = state === 'partial' ? { sessionId: session.sessionId }
      : state === 'malformed' ? { sessionId: session.sessionId, sessionRevision: 'bad', status: 'revoked' }
        : state === 'expired' ? { ...session, expiresAtMs: now - 1 } : null;
    await db.ref(`app_sessions/${uid}`).set(canonical);
    const result = await cold(database => performDriverTrackingStop({ db: database, authUid: uid,
      input: { ...record, status: 'stopped' }, nowMs: now, clock }));
    assert.equal(result.status, 200);
    assert.equal(result.payload.withdrawalAcknowledged, true);
    assert.equal(await read(`driver_location_sessions/${key}`), null);
    assert.equal((await read(`driver_tracking_sessions/${key}`)).status, 'stopped');
    assert.deepEqual(await read(`app_sessions/${uid}`), canonical);
  });
}

test('replacement after cleanup has entered derived mutations survives every exact-owner leaf commit', async () => {
  const old = await issue();
  await enableDelivery(old);
  const paused = deferred(); const resume = deferred(); let intercepted = false;
  const oldWork = cold(async database => {
    const lock = await acquireAppSessionLock({ db: database, authUid: uid, operation: 'cleanup', nowMs: now });
    return cleanupAppSession({ db: database, session: lock.session, expectedSessionId: old.sessionId,
      eventType: 'expired', clock, nowMs: now, appSessionLock: lock });
  }, { beforeTransaction: async path => {
    if (!intercepted && path === `users/${uid}`) { intercepted = true; paused.resolve(); await resume.promise; }
  } });
  const outcome = oldWork.then(() => null, error => error);
  await paused.promise;
  now += 31000;
  const replacement = await cold(database => issue(database));
  await enableDelivery(replacement);
  resume.resolve();
  assert.equal((await outcome)?.code, 'SESSION_CHANGED');
  await assertReplacement(replacement, 'passenger', null);
});

test('failure halfway through owned cleanup retains ending scope and exact retry finishes', async () => {
  const old = await issue();
  await enableDelivery(old);
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now });
  let failed = false;
  const interrupted = interceptedDatabase(db, { beforeTransaction: path => {
    if (!failed && path === `tour_access_grants/${tourId}/${uid}`) {
      failed = true;
      throw new Error('synthetic adapter interruption');
    }
  } });
  await assert.rejects(cleanupAppSession({ db: interrupted, session: lock.session,
    expectedSessionId: old.sessionId, eventType: 'ended_by_user', clock, nowMs: now,
    appSessionLock: lock }), /synthetic adapter interruption/);
  assert.equal((await read(`app_sessions/${uid}`)).status, 'ending');
  assert.equal(await read(`tours/${tourId}/participants/${uid}`), null);
  await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner });
  const retry = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now });
  await cleanupAppSession({ db, session: retry.session, expectedSessionId: old.sessionId,
    eventType: 'ended_by_user', clock, nowMs: now, appSessionLock: retry });
  for (const path of [`app_sessions/${uid}`, `tour_access_grants/${tourId}/${uid}`,
    `booking_access_grants/SYNTHETIC_BOOKING/${uid}`]) assert.equal(await read(path), null, path);
  assert.equal((await read(`notification_devices/${uid}`)).operationalEligible, false);
});

test('transient audit persistence failure retains ending scope; exact retry writes one stable event before completion', async () => {
  const old = await issue();
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now });
  let failed = false;
  const interrupted = interceptedDatabase(db, { beforeTransaction: path => {
    if (!failed && path.startsWith('app_session_events/cleanup_v1_')) {
      failed = true;
      throw new Error('synthetic audit adapter interruption');
    }
  } });
  const input = { expectedSessionId: old.sessionId, eventType: 'ended_by_user', reason: 'user_logout',
    actorType: 'passenger', clock, createEventId: key => key };
  await assert.rejects(cleanupAppSession({ ...input, db: interrupted, session: lock.session,
    appSessionLock: lock, nowMs: now }), /synthetic audit adapter interruption/);
  assert.equal((await read(`app_sessions/${uid}`)).status, 'ending');
  await releaseAppSessionLock({ db, authUid: uid, owner: lock.owner });
  const retry = await acquireAppSessionLock({ db, authUid: uid, operation: 'end', nowMs: now });
  const completed = await cleanupAppSession({ ...input, db, session: retry.session,
    appSessionLock: retry, nowMs: now });
  assert.equal(await read(`app_sessions/${uid}`), null);
  const event = await read(`app_session_events/${completed.eventId}`);
  const events = await read('app_session_events');
  assert.equal(Object.keys(events).filter(key => key.startsWith('cleanup_v1_')).length, 1);
  now += 10;
  const repeated = await cleanupAppSession({ ...input, db, session: retry.session,
    appSessionLock: retry, nowMs: now });
  assert.equal(repeated.eventId, completed.eventId);
  assert.deepEqual(await read(`app_session_events/${completed.eventId}`), event);
});

test('a cleanup outliving its lease cannot commit even without a successor; exact retry completes', async () => {
  const old = await issue();
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'cleanup', nowMs: now });
  let elapsed = false;
  const slow = interceptedDatabase(db, { beforeRead: path => {
    if (!elapsed && path === 'driver_location_sessions') { elapsed = true; now += 31000; }
  } });
  await assert.rejects(cleanupAppSession({ db: slow, session: lock.session, expectedSessionId: old.sessionId,
    eventType: 'expired', clock, nowMs: now, appSessionLock: lock }), error => error.code === 'SESSION_CHANGED');
  assert.equal((await read(`app_sessions/${uid}`)).status, 'ending');
  const retry = await acquireAppSessionLock({ db, authUid: uid, operation: 'cleanup', nowMs: now });
  assert.equal(retry.acquired, true);
  await cleanupAppSession({ db, session: retry.session, expectedSessionId: old.sessionId,
    eventType: 'expired', clock, nowMs: now, appSessionLock: retry });
  assert.equal(await read(`app_sessions/${uid}`), null);
  assert.equal(await read(`tours/${tourId}/participants/${uid}`), null);
  assert.equal((await read(`notification_devices/${uid}`)).operationalEligible, false);
  assert.equal((await cleanupAppSession({ db, session: retry.session, expectedSessionId: old.sessionId,
    eventType: 'expired', clock, nowMs: now, appSessionLock: retry })).alreadyEnded, true);
});

test('earlier batch work consuming 31 seconds cannot issue an already-expired later-candidate lease', async () => {
  const first = await issue(db, 'passenger', 'synthetic-first');
  const second = await issue();
  now = Math.max(first.expiresAtMs, second.expiresAtMs) + 1;
  let delayed = false; let secondLockCreatedAt;
  const database = interceptedDatabase(db, {
    beforeRead: path => {
      if (!delayed && path === 'driver_location_sessions') { delayed = true; now += 31000; }
    },
    afterTransaction: (path, result) => {
      if (path === `app_session_locks/${uid}` && result.snapshot.val()?.operation === 'cleanup') {
        secondLockCreatedAt = result.snapshot.val().createdAtMs;
      }
    },
  });
  const summary = await processExpiredAppSessions({ db: database, clock });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.expired, 1, 'first overlong cleanup retries, later candidate completes');
  assert.equal(summary.failed, 1);
  assert.equal(secondLockCreatedAt, now);
  assert.equal(await read(`app_sessions/${uid}`), null);
});

test('driver-policy stale cleanup resumes after real issuance without revoking the winner', async () => {
  const old = await issue(db, 'driver');
  await enableDelivery(old);
  await db.ref(`driver_login_policy_cleanup/v1/${uid}`).set({ schemaVersion: 1,
    sessionId: old.sessionId, policyGeneration: 1, createdAtMs: now, expiresAtMs: now + 86400000 });
  const paused = deferred(); const resume = deferred(); let intercepted = false;
  const oldWork = cold(database => processDriverLoginPolicyCleanupJobs({ db: database, nowMs: now, clock }), {
    beforeRead: async path => {
      if (!intercepted && path === 'driver_location_sessions') { intercepted = true; paused.resolve(); await resume.promise; }
    },
  });
  await paused.promise;
  now += 31000;
  const replacement = await cold(database => issue(database, 'driver'));
  await enableDelivery(replacement);
  const key = await publish(replacement);
  resume.resolve();
  const result = await oldWork;
  assert.equal(result.cleaned, 0);
  assert.equal(result.failed, 1);
  await assertReplacement(replacement, 'driver', key);
  const replay = await cold(database => processDriverLoginPolicyCleanupJobs({ db: database, nowMs: now, clock }));
  assert.equal(replay.obsolete, 1);
  assert.equal(await read(`driver_login_policy_cleanup/v1/${uid}`), null);
  await assertReplacement(replacement, 'driver', key);
});

test('obsolete cleanup admission leaves a registered successor revision coherent through actual assignment reconciliation', async () => {
  const old = await issue(db, 'driver');
  const current = await issue(db, 'driver');
  const registered = await cold(database => updateNotificationDevice({ db: database, authUid: uid,
    nowMs: now, input: { action: 'reconcile', registrationRevision: 10,
      appSessionId: current.sessionId, appSessionRevision: current.sessionRevision, tourId,
      operationalEligible: true, permissionState: 'granted', pushToken: 'ExponentPushToken[syntheticreplacement]' },
  }));
  assert.equal(registered.status, 200);
  await db.ref(`driver_login_policy_cleanup/v1/${uid}`).set({ sessionId: old.sessionId,
    policyGeneration: 1, createdAtMs: now, expiresAtMs: now + 86400000 });
  const obsolete = await cold(database => processDriverLoginPolicyCleanupJobs({ db: database, nowMs: now, clock }));
  assert.equal(obsolete.obsolete, 1);
  assert.equal((await read(`app_sessions/${uid}`)).sessionRevision, current.sessionRevision);
  assert.equal((await read(`notification_devices/${uid}`)).operationalSessionRevision, current.sessionRevision);
  const nextTourId = 'SYNTHETIC_NEXT';
  await db.ref().update({ [`drivers/${driverId}/currentTourId`]: nextTourId,
    [`tours/${nextTourId}/isActive`]: true,
    [`tour_manifests/${nextTourId}/assigned_drivers/${driverId}`]: true });
  const assigned = await cold(database => reconcileTransitionSessionPage({ db: database,
    transitionId: 'synthetic-assignment', transition: { status: 'subject_sessions', driverId,
      operation: 'assign', tourId: nextTourId, policy: { enforceSingleDevice: false, generation: 0 },
      actorType: 'operations_admin' }, nowMs: now, pageSize: 25, clock }));
  assert.equal(assigned.progressed, true);
  const session = await read(`app_sessions/${uid}`);
  const device = await read(`notification_devices/${uid}`);
  assert.equal(session.sessionRevision, current.sessionRevision + 1);
  assert.equal(session.tourId, nextTourId);
  assert.equal(device.operationalEligible, true);
  assert.equal(device.operationalSessionId, session.sessionId);
  assert.equal(device.operationalSessionRevision, session.sessionRevision);
  assert.equal(device.operationalTourId, nextTourId);
});

test('changed lease owner and same-session revised assignment both fence canonical cleanup', async () => {
  const old = await issue(db, 'driver');
  const lock = await acquireAppSessionLock({ db, authUid: uid, operation: 'cleanup', nowMs: now });
  await db.ref(`app_session_locks/${uid}/owner`).set('successor-owner');
  await assert.rejects(cleanupAppSession({ db, session: lock.session, expectedSessionId: old.sessionId,
    eventType: 'expired', clock, appSessionLock: lock }), error => error.code === 'SESSION_CHANGED');
  await db.ref(`app_session_locks/${uid}/owner`).set(lock.owner);
  await db.ref(`app_sessions/${uid}`).update({ sessionRevision: lock.session.sessionRevision + 1,
    tourId: 'SYNTHETIC_OTHER' });
  await assert.rejects(cleanupAppSession({ db, session: lock.session, expectedSessionId: old.sessionId,
    eventType: 'expired', clock, appSessionLock: lock }), error => error.code === 'SESSION_CHANGED');
  assert.equal((await read(`app_sessions/${uid}`)).tourId, 'SYNTHETIC_OTHER');
});

test('expired/taken-over owner cannot renew its revision fence or release its successor', async () => {
  await issue();
  const old = await acquireAppSessionLock({ db, authUid: uid, operation: 'cleanup', nowMs: now });
  now += 31000;
  assert.equal(await renewAppSessionLock({ db, authUid: uid, owner: old.owner, nowMs: now }), false);
  const next = await cold(database => acquireAppSessionLock({ db: database, authUid: uid, operation: 'issue', nowMs: now }));
  assert.equal(next.acquired, true);
  assert.equal(await releaseAppSessionLock({ db, authUid: uid, owner: old.owner }), false);
  assert.equal((await read(`app_sessions/${uid}`)).sessionRevision, next.session.sessionRevision);
  assert.equal((await read(`app_session_locks/${uid}`)).owner, next.owner);
});

test('normal real notification reconcile preserves session revision and operational authority without a registration loop', async () => {
  const session = await issue();
  for (const revision of [2, 3]) {
    const result = await cold(database => updateNotificationDevice({ db: database, authUid: uid, nowMs: now,
      input: { action: 'reconcile', registrationRevision: revision, appSessionId: session.sessionId,
        appSessionRevision: session.sessionRevision, tourId, operationalEligible: true,
        permissionState: 'granted', pushToken: 'ExponentPushToken[syntheticreplacement]' },
    }));
    assert.equal(result.status, 200);
    assert.equal((await read(`app_sessions/${uid}`)).sessionRevision, session.sessionRevision);
    const device = await read(`notification_devices/${uid}`);
    assert.equal(device.operationalEligible, true);
    assert.equal(device.operationalSessionRevision, session.sessionRevision);
    assert.equal(device.authoritySessionId, session.sessionId);
  }
});

test('unassigned replacement notification registration retains its issuance-owned cleanup fence', async () => {
  const old = await issue(db, 'driver');
  const paused = deferred(); const resume = deferred(); let intercepted = false;
  const oldWork = cold(async database => {
    const lock = await acquireAppSessionLock({ db: database, authUid: uid, operation: 'cleanup', nowMs: now });
    return cleanupAppSession({ db: database, session: lock.session, expectedSessionId: old.sessionId,
      eventType: 'ended_by_admin', disableAllNotificationDelivery: true, clock, nowMs: now, appSessionLock: lock });
  }, { beforeTransaction: async path => {
    if (!intercepted && path === `users/${uid}`) { intercepted = true; paused.resolve(); await resume.promise; }
  } });
  const outcome = oldWork.then(() => null, error => error);
  await paused.promise;
  now += 31000;
  await db.ref(`drivers/${driverId}/currentTourId`).remove();
  const replacement = await cold(async database => issueDriverAppSession({ db: database, authUid: uid,
    ...(await enrolSyntheticDriver({ db: database, authUid: uid, driverId, nowMs: now })), driverLoginPolicyGeneration: 0,
    driverId, tourId: null, nowMs: now, clock, profileUpdates: {
      [`users/${uid}/driverId`]: driverId, [`users/${uid}/driverPrincipalId`]: `driver:${driverId}`,
      [`users/${uid}/driverAssignedTourId`]: null, [`users/${uid}/principalType`]: 'driver',
    } }));
  const registered = await cold(database => updateNotificationDevice({ db: database, authUid: uid,
    nowMs: now, input: { action: 'reconcile', registrationRevision: 10,
      appSessionId: replacement.sessionId, appSessionRevision: replacement.sessionRevision,
      operationalEligible: false, permissionState: 'granted', marketingPreferences: { day_trips: true },
      pushToken: 'ExponentPushToken[syntheticreplacement]' },
  }));
  assert.equal(registered.status, 200);
  resume.resolve();
  assert.equal((await outcome)?.code, 'SESSION_CHANGED');
  const device = await read(`notification_devices/${uid}`);
  assert.equal(device.authoritySessionId, replacement.sessionId);
  assert.equal(device.marketingEligible, true);
  assert.equal(device.pushToken, 'ExponentPushToken[syntheticreplacement]');
  assert.equal((await verifyActiveAppSession({ db, authUid: uid, allowUnassignedDriver: true, nowMs: now })).allowed, true);
});

test('declared passenger/driver handler deadlines stay strictly below the issuance lease', () => {
  for (const endpoint of [verifyPassengerLogin, verifyDriverLogin]) {
    assert.equal(endpoint.__endpoint.timeoutSeconds, 60);
    assert.ok(endpoint.__endpoint.timeoutSeconds * 1000 < APP_SESSION_ISSUANCE_LOCK_TTL_MS);
  }
});

for (const role of ['passenger', 'driver']) {
  test(`${role} issuance aborts an expired final dispatch and preserves a legitimate winner`, async () => {
    let lockMutations = 0; let winner;
    const delayed = interceptedDatabase(db, { afterTransaction: async path => {
      if (path !== `app_session_locks/${uid}` || ++lockMutations !== 4) return;
      // Advance beyond the final renewed lease, then use actual issuance on an
      // independent connection before the old invocation dispatches its write.
      now += APP_SESSION_ISSUANCE_LOCK_TTL_MS + 1;
      winner = await cold(database => issue(database, role));
    } });
    await assert.rejects(issue(delayed, role), error => error.code === 'SESSION_IN_PROGRESS');
    assert.ok(winner);
    assert.equal((await read(`app_sessions/${uid}`)).sessionId, winner.sessionId);
    assert.equal((await verifyActiveAppSession({ db, authUid: uid, expectedTourId: tourId, nowMs: now })).allowed, true);
  });
}
