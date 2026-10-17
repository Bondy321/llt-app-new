'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const assignment = require('../functions/src/domains/driver-assignment/driverAssignment');
const sessions = require('../functions/lib/appSession');
const { driverLoginClaimAllowedByPolicy } = require('../functions/src/domains/driver-auth/driverDevicePolicy');

const UID = 'fixture-driver-phone';
const DRIVER = 'D-ASSIGNMENT';
const TOUR = 'FIXTURE_TOUR';
let context;
const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (!parent?.filename.endsWith('driverLoginFunction.js')) return originalLoad(request, parent, isMain);
  if (request === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (request.endsWith('/bootstrap/firebaseAdmin')) return { admin: { database: () => context.db } };
  if (request.endsWith('/bootstrap/legacyLibrary')) return { loadLegacyLibrary: () => sessions };
  if (request.endsWith('/auth/requestAuth')) return { verifyRequestAuthUid: async () => ({ success: true, uid: UID }) };
  if (request.endsWith('/logging/safeLogger')) return { log: { warn() {}, info() {}, error() {} } };
  if (request.endsWith('/app-sessions/public')) return {
    issueDriverAppSession: async options => {
      context.issued.push(options);
      return sessions.buildDriverSessionRecord({ ...options,
        sessionId: `sess_v1_${'a'.repeat(32)}`, expiresAtMs: options.nowMs + 3600000,
      });
    },
  };
  if (request.endsWith('/account-deletion/public')) return { ensureNoActiveAccountDeletion: async () => {} };
  if (request.endsWith('/driver-assignment/public')) return {
    ...assignment,
    acquireDriverAssignmentLoginAdmission: async () => ({ acquired: true, admissionId: 'assignment-admission' }),
    releaseDriverAssignmentLoginAdmission: async () => { context.assignmentReleased += 1; },
  };
  if (request === './driverLoginSecurity') return { authorizeDriverLoginSecurity: async () => ({ allowed: true }) };
  if (request === './driverDevicePolicy') return {
    readDriverLoginPolicy: async () => ({ policy: context.policy }),
    ensureDriverLoginPolicy: async () => ({ policy: context.policy }),
    acquireDriverLoginAdmission: async () => ({ acquired: true, admissionId: 'policy-admission', policy: context.policy }),
    completeDriverLoginAdmission: async () => { context.policyCompleted += 1; return true; },
    driverLoginClaimAllowedByPolicy,
    hashPolicyIdentifier: () => 'opaque-hash',
    releaseDriverLoginAdmission: async () => { context.policyReleased += 1; },
    reserveDriverLoginClaim: async () => ({ acquired: true, path: 'private-claim' }),
    releaseDriverLoginClaim: async () => { context.claimReleased += 1; },
  };
  return originalLoad(request, parent, isMain);
};
const { verifyDriverLogin } = require('../functions/src/domains/driver-auth/driverLoginFunction');
Module._load = originalLoad;

const fixture = overrides => ({
  [`drivers/${DRIVER}`]: { currentTourId: TOUR, currentTourCode: 'FIXTURE TOUR', name: 'Fixture Driver' },
  [`tours/${TOUR}`]: { name: 'Fixture tour', isActive: true, startDate: '2020-01-01' },
  [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: true,
  ...overrides,
});
const requestLogin = async (state, { enforceSingleDevice = false } = {}) => {
  context = {
    issued: [], assignmentReleased: 0, policyReleased: 0, policyCompleted: 0, claimReleased: 0,
    policy: { enforceSingleDevice, generation: 3 },
    db: { ref: path => ({
      once: async () => ({ val: () => structuredClone(state[path] ?? null),
        exists: () => state[path] !== undefined && state[path] !== null }),
    }) },
  };
  const result = { status: null, body: null };
  const response = { status: value => { result.status = value; return response; },
    json: value => { result.body = value; return value; } };
  await verifyDriverLogin({ method: 'POST', body: { driverId: DRIVER } }, response);
  return { ...result, ...context };
};

test('driver login rejects broken assignment state before issuing any app authority and releases admission', async () => {
  const cases = [
    fixture({ [`tours/${TOUR}`]: undefined }),
    fixture({ [`tours/${TOUR}`]: null }),
    fixture({ [`tours/${TOUR}`]: 'not-a-tour' }),
    fixture({ [`tours/${TOUR}`]: [] }),
    fixture({ [`tours/${TOUR}`]: { isActive: false } }),
    fixture({ [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: undefined }),
    fixture({ [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: false }),
    fixture({ [`tour_manifests/${TOUR}/assigned_drivers/${DRIVER}`]: 'true' }),
    fixture({ [`drivers/${DRIVER}`]: { currentTourId: 'fixture tour' } }),
    fixture({ [`drivers/${DRIVER}`]: { currentTourId: 123 } }),
  ];
  for (const state of cases) {
    const before = structuredClone(state);
    const result = await requestLogin(state);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { valid: false, reason: 'ASSIGNMENT_UNAVAILABLE' });
    assert.equal(result.issued.length, 0);
    assert.equal(result.assignmentReleased, 1);
    assert.equal(result.policyReleased, 1);
    assert.equal(result.policyCompleted, 0);
    assert.deepEqual(state, before);
  }
});

test('failed assignment validation releases a reserved single-device claim without claiming the business driver record', async () => {
  const state = fixture({ [`tours/${TOUR}`]: { isActive: false } });
  const before = structuredClone(state);
  const result = await requestLogin(state, { enforceSingleDevice: true });
  assert.equal(result.status, 503);
  assert.equal(result.claimReleased, 1);
  assert.equal(result.issued.length, 0);
  assert.deepEqual(state, before);
});

test('coherent active assignments allow past tour dates and use the canonical response key', async () => {
  const result = await requestLogin(fixture({
    [`tours/${TOUR}`]: { id: 'stale-stored-id', isActive: true, startDate: '2020-01-01', sourceRoster: { state: 'updating' } },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.valid, true);
  assert.equal(result.body.assignmentStatus, 'ASSIGNED');
  assert.equal(result.body.tour.id, TOUR);
  assert.equal(result.body.session.tourId, TOUR);
  assert.equal(result.issued.length, 1);
  assert.equal(result.issued[0].tourId, TOUR);
  assert.equal(result.issued[0].profileUpdates[`users/${UID}/driverAssignedTourId`], TOUR);
  assert.equal(result.policyCompleted, 1);
  assert.equal(result.assignmentReleased, 1);
});

test('genuinely unassigned drivers still receive an unassigned session without a tour grant', async () => {
  for (const currentTourId of [null, undefined, '', '   ']) {
    const result = await requestLogin(fixture({ [`drivers/${DRIVER}`]: { name: 'Fixture Driver', currentTourId } }));
    assert.equal(result.status, 200);
    assert.equal(result.body.valid, true);
    assert.equal(result.body.tour, null);
    assert.equal(result.body.assignmentStatus, 'UNASSIGNED');
    assert.equal(result.body.driver.hasAssignedTour, false);
    assert.equal(result.issued[0].tourId, null);
    assert.equal(result.issued[0].profileUpdates[`users/${UID}/driverAssignedTourId`], null);
  }
});
