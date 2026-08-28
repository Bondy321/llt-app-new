const assert = require('node:assert/strict');
const test = require('node:test');

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-safety-delivery',
  storageBucket: 'demo-llt-safety-delivery.appspot.com',
});

const { __testables } = require('../functions/index.js');
const { enqueueSafetyEvent, isValidSafetyAlert } = require('../functions/src/domains/notifications/safetyNotificationFunction');

const baseInput = (overrides = {}) => ({
  clientEventId: 'safety_event_1',
  tourId: 'TOUR_1',
  role: 'passenger',
  category: 'incident',
  severity: 'high',
  message: 'Safety assistance requested',
  customMessage: 'Please meet me at the pickup point.',
  clientCreatedAtMs: 1786636800000,
  ...overrides,
});

test('safety submissions normalize bounded data and force SOS to critical', () => {
  const normalized = __testables.normalizeSafetySubmissionInput(baseInput({
    category: 'sos',
    severity: 'low',
    isSOS: true,
    coords: { latitude: 56.1, longitude: -4.6, accuracy: 12 },
  }), 1786636801000);

  assert.equal(normalized.severity, 'critical');
  assert.equal(normalized.isSOS, true);
  assert.deepEqual(normalized.coords, { latitude: 56.1, longitude: -4.6, accuracy: 12 });
  assert.throws(
    () => __testables.normalizeSafetySubmissionInput(baseInput({ customMessage: 'x'.repeat(1001) }), 1786636801000),
    (error) => error?.code === 'INVALID_DETAILS',
  );
  assert.throws(
    () => __testables.normalizeSafetySubmissionInput(baseInput({ coords: { latitude: 100, longitude: 0, accuracy: 1 } }), 1786636801000),
    (error) => error?.code === 'INVALID_LOCATION',
  );
});

test('canonical safety write plan mirrors one server-owned event id atomically', () => {
  const input = __testables.normalizeSafetySubmissionInput(baseInput({
    category: 'medical',
    severity: 'critical',
  }), 1786636801000);
  const record = __testables.buildCanonicalSafetyRecord({
    input,
    authUid: 'passenger-auth',
    principalId: 'pax_v1:BOOKING:person@example.com',
    nowMs: 1786636801000,
  });
  const updates = __testables.buildSafetySubmissionUpdates({
    record,
    lockPath: 'safety_submission_locks/TOUR_1/safety_event_1',
  });

  assert.equal(record.schemaVersion, 2);
  assert.equal(record.reporterAuthUid, 'passenger-auth');
  assert.equal(record.timestampMs, 1786636801000);
  assert.equal(updates['logs/passenger-auth/safety/safety_event_1'].eventId, 'safety_event_1');
  assert.equal(updates['tours/TOUR_1/safetyAlerts/safety_event_1'].eventId, 'safety_event_1');
  assert.equal(updates['globalSafetyAlerts/safety_event_1'].eventId, 'safety_event_1');
  assert.equal(updates['safety_submission_locks/TOUR_1/safety_event_1'], null);
});

test('safety notification copy is urgent but does not expose report details on the lock screen', () => {
  const content = __testables.buildSafetyNotificationContent({
    tourName: 'Highland Explorer',
    alert: {
      category: 'medical',
      severity: 'critical',
      customMessage: 'Sensitive medical details must stay private',
    },
  });
  assert.match(content.title, /Urgent safety alert/);
  assert.match(content.body, /critical medical report/);
  assert.doesNotMatch(content.body, /Sensitive medical details/);
  assert.equal(content.priority, 'high');
});

test('malformed safety category or severity is deliberately skipped before enqueue', async () => {
  const buildEvent = (alert) => ({
    params: { tourId: 'TOUR_1', eventId: 'safety_event_1' },
    data: { val: () => alert },
  });
  const validShape = {
    schemaVersion: 2,
    eventId: 'safety_event_1',
    tourId: 'TOUR_1',
    status: 'pending',
    category: 'incident',
    severity: 'high',
  };

  assert.equal(isValidSafetyAlert({ tourId: 'TOUR_1', eventId: 'safety_event_1', alert: { ...validShape, category: null } }), false);
  assert.equal(isValidSafetyAlert({ tourId: 'TOUR_1', eventId: 'safety_event_1', alert: { ...validShape, severity: { invalid: true } } }), false);
  assert.equal(await enqueueSafetyEvent(buildEvent({ ...validShape, category: null })), null);
  assert.equal(await enqueueSafetyEvent(buildEvent({ ...validShape, severity: { invalid: true } })), null);
});

test('safety reporter access distinguishes attached passengers and coherent assigned drivers', async () => {
  const makeDb = ({
    participant = false,
    user = {},
    manifest = {},
    driver = {},
    session = null,
    policy = null,
  }) => ({
    ref: (path) => ({
      once: async () => {
        let value = null;
        if (path.includes('/participants/')) value = participant ? true : null;
        else if (path.startsWith('app_sessions/')) value = session;
        else if (path === 'driver_login_policy/v1') value = policy;
        else if (path.startsWith('users/')) value = user;
        else if (path.startsWith('tour_manifests/') && path.includes('/assigned_drivers/')) {
          value = manifest?.assigned_drivers?.[path.split('/').at(-1)] ?? null;
        }
        else if (path.startsWith('tour_manifests/')) value = manifest;
        else if (path.startsWith('drivers/')) value = driver;
        return { exists: () => value !== null, val: () => value };
      },
    }),
  });

  const passenger = await __testables.resolveSafetyReporterAccess({
    db: makeDb({ participant: true, user: { stablePassengerId: 'pax_v1:one' } }),
    authUid: 'passenger-auth',
    tourId: 'TOUR_1',
    requestedRole: 'passenger',
  });
  assert.deepEqual(passenger, { allowed: true, role: 'passenger', principalId: 'pax_v1:one' });

  const assignedDriver = await __testables.resolveSafetyReporterAccess({
    db: makeDb({
      user: {
        driverId: 'BONDY',
        driverPrincipalId: 'driver:BONDY',
        principalType: 'driver',
        driverAssignedTourId: 'TOUR_1',
      },
      manifest: { assigned_drivers: { BONDY: true } },
      driver: { authUid: 'driver-auth', currentTourId: 'TOUR_1' },
      session: {
        schemaVersion: 1,
        sessionId: `sess_v1_${'a'.repeat(32)}`,
        authUid: 'driver-auth',
        principalId: 'driver:BONDY',
        principalType: 'driver',
        tourId: 'TOUR_1',
        driverId: 'BONDY',
        status: 'active',
        issuedAtMs: 1,
        lastAuthenticatedAtMs: 1,
        expiresAtMs: 4_000_000_000_000,
        sessionRevision: 1,
        driverLoginPolicyGeneration: 0,
      },
      policy: {
        schemaVersion: 1,
        enforceSingleDevice: false,
        generation: 0,
        revision: 1,
        updatedAtMs: 1,
      },
    }),
    authUid: 'driver-auth',
    tourId: 'TOUR_1',
    requestedRole: 'driver',
  });
  assert.deepEqual(assignedDriver, { allowed: true, role: 'driver', principalId: 'driver:BONDY' });

  const outsider = await __testables.resolveSafetyReporterAccess({
    db: makeDb({}),
    authUid: 'outsider',
    tourId: 'TOUR_1',
    requestedRole: 'passenger',
  });
  assert.equal(outsider.allowed, false);
});

test('safety submission quota uses one opaque authenticated-user bucket', async () => {
  const calls = [];
  const allowed = await __testables.checkSafetySubmissionRateLimit({
    authUid: 'private-auth-user',
    limiter: async (...args) => {
      calls.push(args);
      return true;
    },
  });

  assert.equal(allowed, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /^safety_uid_[a-f0-9]{24}$/);
  assert.doesNotMatch(calls[0][0], /private-auth-user/);
  assert.equal(calls[0][1], 20);
  assert.equal(calls[0][2], 60000);
  assert.equal(await __testables.checkSafetySubmissionRateLimit({ authUid: '', limiter: async () => true }), false);
});
