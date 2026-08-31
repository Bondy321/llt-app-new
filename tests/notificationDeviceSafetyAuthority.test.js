'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-device-safety-authority',
  storageBucket: 'demo-llt-device-safety-authority.appspot.com',
});

const {
  readSafetyAlertDetail,
  updateNotificationDevice,
  updateSafetyAlertStatus,
} = require('../functions/src/domains/notifications/notificationDeviceFunctions');
const {
  buildAppSessionCleanupUpdates,
} = require('../functions/lib/appSessionCleanup');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const parts = (path) => String(path || '').split('/').filter(Boolean);
const getAt = (root, path) => parts(path).reduce((value, key) => value?.[key], root);
const setAt = (root, path, value) => {
  const keys = parts(path);
  if (!keys.length) {
    Object.keys(root).forEach((key) => delete root[key]);
    Object.assign(root, clone(value || {}));
    return;
  }
  let target = root;
  keys.slice(0, -1).forEach((key) => { target[key] ||= {}; target = target[key]; });
  if (value === null) delete target[keys.at(-1)];
  else target[keys.at(-1)] = clone(value);
};
const snapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => clone(value),
});
const memoryDb = (initial = {}) => {
  const data = clone(initial);
  return {
    data,
    ref(path = '') {
      return {
        once: async () => snapshot(getAt(data, path)),
        update: async (updates) => Object.entries(updates).forEach(([key, value]) => setAt(data, path ? `${path}/${key}` : key, value)),
        set: async (value) => setAt(data, path, value),
        remove: async () => setAt(data, path, null),
        transaction: async (updater) => {
          const current = clone(getAt(data, path));
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          setAt(data, path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      };
    },
  };
};

const nowMs = 1_800_000_000_000;
const token = 'ExponentPushToken[device-authority-token]';
const session = {
  schemaVersion: 1,
  sessionId: `sess_v1_${'a'.repeat(32)}`,
  authUid: 'passenger-1',
  principalId: `pax_v2_${'b'.repeat(32)}`,
  principalType: 'passenger',
  tourId: 'TOUR_1',
  driverId: null,
  status: 'active',
  issuedAtMs: nowMs - 1_000,
  lastAuthenticatedAtMs: nowMs - 1_000,
  expiresAtMs: nowMs + 60_000,
  sessionRevision: 2,
};
const participant = {
  schemaVersion: 2,
  userId: session.authUid,
  principalId: session.principalId,
  sessionId: session.sessionId,
  sessionExpiresAtMs: session.expiresAtMs,
};
const device = (overrides = {}) => ({
  schemaVersion: 1,
  authUid: session.authUid,
  pushToken: token,
  tokenHash: 'old-hash',
  status: 'active',
  permissionState: 'granted',
  operationalEligible: true,
  operationalTourId: session.tourId,
  operationalSessionId: session.sessionId,
  operationalSessionRevision: session.sessionRevision,
  marketingEligible: true,
  marketingPreferences: { day_trips: true },
  registrationRevision: 5,
  createdAtMs: nowMs - 5_000,
  updatedAtMs: nowMs - 1_000,
  ...overrides,
});

test('explicit null token is authoritative and cannot retain operational eligibility', async () => {
  const db = memoryDb({
    app_sessions: { [session.authUid]: session },
    users: { [session.authUid]: {} },
    tours: { TOUR_1: { participants: { [session.authUid]: participant } } },
    notification_devices: { [session.authUid]: device() },
  });
  const result = await updateNotificationDevice({
    db,
    authUid: session.authUid,
    nowMs,
    input: {
      action: 'reconcile',
      registrationRevision: 6,
      appSessionId: session.sessionId,
      appSessionRevision: session.sessionRevision,
      tourId: session.tourId,
      operationalEligible: true,
      pushToken: null,
      permissionState: 'granted',
    },
  });
  assert.equal(result.status, 200);
  assert.equal(db.data.notification_devices[session.authUid].pushToken, null);
  assert.equal(db.data.notification_devices[session.authUid].operationalEligible, false);
  assert.equal(db.data.notification_devices[session.authUid].registrationRevision, 6);
});

test('old-session reconcile and logout cannot mutate a replacement session device', async () => {
  const db = memoryDb({
    app_sessions: { [session.authUid]: session },
    notification_devices: { [session.authUid]: device() },
  });
  const oldSessionId = `sess_v1_${'c'.repeat(32)}`;
  for (const action of ['reconcile', 'logout']) {
    const result = await updateNotificationDevice({
      db,
      authUid: session.authUid,
      nowMs,
      input: {
        action,
        registrationRevision: action === 'reconcile' ? 6 : 7,
        appSessionId: oldSessionId,
        appSessionRevision: 1,
        tourId: session.tourId,
        operationalEligible: action === 'reconcile',
        permissionState: 'granted',
      },
    });
    assert.equal(result.body.reason, 'STALE_APP_SESSION');
  }
  assert.equal(db.data.notification_devices[session.authUid].operationalSessionId, session.sessionId);
  assert.equal(db.data.notification_devices[session.authUid].registrationRevision, 5);
});

test('normal cleanup preserves consented marketing while security cleanup disables all delivery', () => {
  const normal = buildAppSessionCleanupUpdates({
    session,
    userProfile: {},
    notificationDevice: device(),
    nowMs,
  });
  assert.equal(normal[`notification_devices/${session.authUid}/operationalEligible`], false);
  assert.equal(normal[`notification_devices/${session.authUid}/operationalSessionId`], null);
  assert.equal(normal[`notification_devices/${session.authUid}/registrationRevision`], 6);
  assert.equal(Object.hasOwn(normal, `notification_devices/${session.authUid}/pushToken`), false);
  assert.equal(Object.hasOwn(normal, `notification_devices/${session.authUid}/marketingEligible`), false);

  const revoked = buildAppSessionCleanupUpdates({
    session,
    userProfile: {},
    notificationDevice: device(),
    disableAllNotificationDelivery: true,
    nowMs,
  });
  assert.equal(revoked[`notification_devices/${session.authUid}/pushToken`], null);
  assert.equal(revoked[`notification_devices/${session.authUid}/marketingEligible`], false);
  assert.equal(revoked[`notification_devices/${session.authUid}/status`], 'revoked');
});

test('account deletion leaves a permanent server tombstone that blocks delayed recreation', async () => {
  const db = memoryDb({
    app_sessions: { [session.authUid]: session },
    notification_devices: { [session.authUid]: device() },
  });
  const deleted = await updateNotificationDevice({
    db, authUid: session.authUid, nowMs, input: { action: 'delete', registrationRevision: 6 },
  });
  assert.equal(deleted.body.deleted, true);
  assert.equal(db.data.notification_devices?.[session.authUid], undefined);
  assert.equal(db.data.notification_device_tombstones[session.authUid].permanent, true);
  const delayed = await updateNotificationDevice({
    db,
    authUid: session.authUid,
    nowMs: nowMs + 1,
    input: { action: 'reconcile', registrationRevision: 7, permissionState: 'granted', pushToken: token },
  });
  assert.equal(delayed.body.reason, 'DEVICE_DELETED');
  assert.equal(db.data.notification_devices?.[session.authUid], undefined);
});

test('security revoke clears the token and both operational and marketing delivery', async () => {
  const db = memoryDb({
    app_sessions: { [session.authUid]: session },
    notification_devices: { [session.authUid]: device() },
  });
  const result = await updateNotificationDevice({
    db,
    authUid: session.authUid,
    nowMs,
    input: { action: 'security_revoke', registrationRevision: 6 },
  });
  assert.equal(result.status, 200);
  const revoked = db.data.notification_devices[session.authUid];
  assert.equal(revoked.pushToken, null);
  assert.equal(revoked.operationalEligible, false);
  assert.equal(revoked.marketingEligible, false);
  assert.equal(revoked.status, 'revoked');
});

test('an already-applied device mutation repairs consent and marketing membership', async () => {
  const canonical = device({
    operationalEligible: false,
    operationalTourId: null,
    operationalSessionId: null,
    operationalSessionRevision: null,
    registrationRevision: 6,
    lastMutationAction: 'preferences',
    lastMutationSessionId: session.sessionId,
  });
  const db = memoryDb({
    app_sessions: { [session.authUid]: session },
    notification_devices: { [session.authUid]: canonical },
  });
  const result = await updateNotificationDevice({
    db,
    authUid: session.authUid,
    nowMs,
    input: {
      action: 'preferences',
      registrationRevision: 6,
      appSessionId: session.sessionId,
      permissionState: 'granted',
      marketingPreferences: { day_trips: true },
    },
  });
  assert.equal(result.body.reason, 'ALREADY_APPLIED');
  assert.equal(db.data.notification_consents[session.authUid].registrationRevision, 6);
  assert.deepEqual(
    db.data.notification_marketing_audience.v1.day_trips[session.authUid],
    { schemaVersion: 1, registrationRevision: 6 },
  );
});

test('safety transitions update every existing mirror atomically and reject regressions', async () => {
  const adminUid = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
  const alert = {
    schemaVersion: 2,
    eventId: 'event_1',
    clientEventId: 'event_1',
    tourId: 'TOUR_1',
    reporterAuthUid: 'passenger-1',
    userId: 'passenger-1',
    category: 'medical',
    severity: 'critical',
    status: 'pending',
    message: 'Sanitised summary',
    receivedAtMs: nowMs,
  };
  const db = memoryDb({
    users: { [adminUid]: {} },
    tours: { TOUR_1: { safetyAlerts: { event_1: alert } } },
    globalSafetyAlerts: { event_1: { ...alert, tourAlertId: 'tours/TOUR_1/safetyAlerts/event_1' } },
    logs: { 'passenger-1': { safety: { event_1: alert } } },
  });
  const acknowledged = await updateSafetyAlertStatus({
    db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_1', action: 'acknowledge', notes: 'Responder assigned', nowMs,
  });
  assert.equal(acknowledged.status, 200);
  const copies = [
    db.data.tours.TOUR_1.safetyAlerts.event_1,
    db.data.globalSafetyAlerts.event_1,
    db.data.logs['passenger-1'].safety.event_1,
  ];
  copies.forEach((copy) => assert.deepEqual(
    [copy.status, copy.statusUpdatedAtMs, copy.statusUpdatedBy, copy.statusNotes],
    ['acknowledged', nowMs, adminUid, 'Responder assigned'],
  ));

  await updateSafetyAlertStatus({
    db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_1', action: 'start_response', nowMs: nowMs + 1,
  });
  const regression = await updateSafetyAlertStatus({
    db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_1', action: 'acknowledge', nowMs: nowMs + 2,
  });
  assert.equal(regression.status, 409);
  assert.equal(regression.body.reason, 'INVALID_TRANSITION');
  copies.forEach((_copy, index) => {
    const live = [
      db.data.tours.TOUR_1.safetyAlerts.event_1,
      db.data.globalSafetyAlerts.event_1,
      db.data.logs['passenger-1'].safety.event_1,
    ][index];
    assert.equal(live.status, 'in_progress');
  });
});

test('escalated safety alerts can enter active response but cannot regress to acknowledged', async () => {
  const adminUid = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
  const alert = {
    eventId: 'event_2', tourId: 'TOUR_1', reporterAuthUid: 'passenger-1',
    status: 'escalated', message: 'Summary', receivedAtMs: nowMs,
  };
  const db = memoryDb({
    users: { [adminUid]: {} },
    tours: { TOUR_1: { safetyAlerts: { event_2: alert } } },
  });
  const started = await updateSafetyAlertStatus({
    db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_2', action: 'start_response', nowMs,
  });
  assert.equal(started.status, 200);
  assert.equal(db.data.tours.TOUR_1.safetyAlerts.event_2.status, 'in_progress');
  const regression = await updateSafetyAlertStatus({
    db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_2', action: 'acknowledge', nowMs: nowMs + 1,
  });
  assert.equal(regression.status, 409);
});

test('safety detail authorizes sessionless operations and current assigned drivers only', async () => {
  const adminUid = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
  const driverUid = 'driver-auth-1';
  const driverSession = {
    ...session,
    authUid: driverUid,
    sessionId: `sess_v1_${'d'.repeat(32)}`,
    principalId: 'driver:D1',
    principalType: 'driver',
    driverId: 'D1',
    driverLoginPolicyGeneration: 0,
  };
  const db = memoryDb({
    users: {
      [adminUid]: {},
      [session.authUid]: {},
      [driverUid]: {
        driverId: 'D1',
        driverPrincipalId: 'driver:D1',
        principalType: 'driver',
        driverAssignedTourId: 'TOUR_1',
      },
    },
    app_sessions: { [session.authUid]: session, [driverUid]: driverSession },
    driver_login_policy: {
      v1: {
        schemaVersion: 1,
        enforceSingleDevice: false,
        generation: 0,
        revision: 1,
        updatedAtMs: nowMs - 1_000,
      },
    },
    drivers: { D1: { authUid: driverUid, currentTourId: 'TOUR_1' } },
    tour_manifests: { TOUR_1: { assigned_drivers: { D1: true } } },
    tours: { TOUR_1: { safetyAlerts: { event_1: { status: 'pending', message: 'Summary' } } } },
  });
  assert.equal((await readSafetyAlertDetail({ db, authUid: adminUid, tourId: 'TOUR_1', eventId: 'event_1' })).status, 200);
  assert.equal((await readSafetyAlertDetail({ db, authUid: driverUid, tourId: 'TOUR_1', eventId: 'event_1' })).status, 200);
  assert.equal((await readSafetyAlertDetail({ db, authUid: session.authUid, tourId: 'TOUR_1', eventId: 'event_1' })).status, 403);
  db.data.tour_manifests.TOUR_1.assigned_drivers.D1 = false;
  assert.equal((await readSafetyAlertDetail({ db, authUid: driverUid, tourId: 'TOUR_1', eventId: 'event_1' })).status, 403);
});
