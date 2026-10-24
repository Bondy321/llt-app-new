'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_DATABASE_EMULATOR_HOST || '')) {
  throw new Error('A loopback Realtime Database emulator is required');
}
const projectId = 'demo-llt-notification-ownership';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
process.env.GCLOUD_PROJECT = projectId;
const admin = require('../../functions/node_modules/firebase-admin');
const { acquireAppSessionLock, releaseAppSessionLock } = require('../../functions/lib/appSessionLock');
const { cleanupAppSession } = require('../../functions/lib/appSessionCleanup');
const { issueDriverAppSession, issuePassengerAppSession } = require('../../functions/src/domains/app-sessions/sessionIssuance');
const { updateNotificationDevice, deleteNotificationAccountState } = require('../../functions/src/domains/notifications/notificationDeviceFunctions');
const { createNotificationPublisher } = require('../../functions/src/domains/notifications/notificationMutationPublication');
const { enrolSyntheticDriver } = require('./enrolSyntheticDriver');
const { revokeStaffEnrolment } = require('../../functions/src/domains/driver-auth/staffEnrolment');
const { installDemoDatabaseRules } = require('./installDemoDatabaseRules');
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
const interceptedDatabase = (database, hooks = {}) => ({ app: database.app, ref(path = '') {
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
const issue = async (database = db, assigned = false) => {
  await database.ref(`drivers/${driverId}/currentTourId`).set(assigned ? tourId : null);
  return issueDriverAppSession({ db: database, authUid: uid,
  ...(await enrolSyntheticDriver({ db: database, authUid: uid, driverId, nowMs: now })), driverLoginPolicyGeneration: 0,
  driverId, tourId: assigned ? tourId : null, nowMs: now, clock, profileUpdates: {
    [`users/${uid}/principalType`]: 'driver', [`users/${uid}/driverId`]: driverId,
    [`users/${uid}/driverPrincipalId`]: `driver:${driverId}`,
    [`users/${uid}/driverAssignedTourId`]: assigned ? tourId : null,
  } });
};
const passengerBookingRef = 'SYNTHETIC-BOOKING';
const issuePassenger = async () => {
  const principalId = `pax_v2_${'a'.repeat(32)}`;
  await db.ref().update({ [`bookings/${passengerBookingRef}`]: { tourId },
    [`passenger_identity_security/${passengerBookingRef}/passengerPrincipalId`]: principalId });
  return issuePassengerAppSession({ db, authUid: uid, principalId, tourId, bookingRef: passengerBookingRef,
    nowMs: now, clock, identityUpdates: {
      [`users/${uid}/bookingRef`]: passengerBookingRef,
      [`users/${uid}/stablePassengerId`]: principalId, [`users/${uid}/identityVersion`]: 'pax_v2',
      [`passenger_identity_security/${passengerBookingRef}/deviceAuthorizationVersion`]: 2,
      [`passenger_identity_security/${passengerBookingRef}/authorizedAuthUids/${uid}`]: true,
      [`identity_bindings/${principalId}/${uid}`]: true,
    }, grantUpdates: {
      [`booking_access_grants/${passengerBookingRef}/${uid}`]: { bookingRef: passengerBookingRef, tourId },
      [`tour_access_grants/${tourId}/${uid}`]: { bookingRef: passengerBookingRef, tourId },
    } });
};
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
  await db.ref().update({ [`drivers/${driverId}`]: { name: 'Synthetic driver', currentTourId: tourId },
    [`tours/${tourId}/isActive`]: true, [`tour_manifests/${tourId}/assigned_drivers/${driverId}`]: true,
    'driver_login_policy/v1': { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 1, updatedAtMs: now },
  });
});
test.after(async () => Promise.all(admin.apps.map(app => app.delete())));

const advanceTime = milliseconds => { now += milliseconds; };
module.exports = { test, assert, acquireAppSessionLock, releaseAppSessionLock, cleanupAppSession, updateNotificationDevice, deleteNotificationAccountState, createNotificationPublisher, revokeStaffEnrolment, db, uid, driverId, tourId, token, clock, read, deferred, cold, issue, issuePassenger, passengerBookingRef, registration, register, state, advanceTime };
