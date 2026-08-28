'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-driver-device-policy',
  storageBucket: 'demo-llt-driver-device-policy.appspot.com',
});

const { __testables } = require('../functions/index.js');
const {
  recordDriverPolicyCleanupFailure,
} = require('../functions/src/domains/driver-auth/driverDevicePolicyFunctions');

const SESSION_A = `sess_v1_${'a'.repeat(32)}`;
const SESSION_B = `sess_v1_${'b'.repeat(32)}`;

const snapshot = (value) => ({
  val: () => value,
  exists: () => value !== null && value !== undefined,
});

test('missing policy is explicitly default-off while malformed saved policy fails closed', () => {
  assert.deepEqual(__testables.normalizeDriverLoginPolicy(null), {
    valid: true,
    isDefault: true,
    policy: {
      schemaVersion: 1,
      enforceSingleDevice: false,
      generation: 0,
      revision: 0,
      updatedAtMs: null,
    },
  });
  assert.equal(__testables.normalizeDriverLoginPolicy({ enforceSingleDevice: false }).valid, false);
  assert.equal(__testables.normalizeDriverLoginPolicy({
    schemaVersion: 1,
    enforceSingleDevice: false,
    generation: 1,
    revision: 1,
    updatedAtMs: 100,
    transitionPhase: 'surprise',
  }).valid, false);
});

test('binding is ignored only while policy is off and generation remains mandatory', () => {
  const off = { enforceSingleDevice: false, generation: 3 };
  const on = { enforceSingleDevice: true, generation: 4 };
  assert.equal(__testables.driverBindingAllowedByPolicy({
    policy: off, authUid: 'uid-b', claimedAuthUid: 'uid-a',
  }), true);
  assert.equal(__testables.driverBindingAllowedByPolicy({
    policy: on, authUid: 'uid-b', claimedAuthUid: 'uid-a',
  }), false);
  assert.equal(__testables.driverBindingAllowedByPolicy({
    policy: on, authUid: 'uid-a', claimedAuthUid: 'uid-a',
  }), true);
  assert.equal(__testables.driverSessionMatchesPolicyGeneration({ driverLoginPolicyGeneration: 3 }, off), true);
  assert.equal(__testables.driverSessionMatchesPolicyGeneration({ driverLoginPolicyGeneration: 3 }, on), false);
});

test('the first driver login materializes an explicit off policy without overwriting an existing policy', async () => {
  let stored = null;
  const db = {
    ref(path) {
      assert.equal(path, 'driver_login_policy/v1');
      return {
        async transaction(updater) {
          stored = updater(stored);
          return { committed: true, snapshot: snapshot(stored) };
        },
      };
    },
  };
  const initialized = await __testables.ensureDriverLoginPolicy({ db, nowMs: 1_000 });
  assert.equal(initialized.policy.enforceSingleDevice, false);
  assert.equal(initialized.policy.generation, 0);
  assert.equal(initialized.policy.revision, 1);

  stored = { ...stored, enforceSingleDevice: true, generation: 2, revision: 3, updatedAtMs: 2_000 };
  const preserved = await __testables.ensureDriverLoginPolicy({ db, nowMs: 3_000 });
  assert.equal(preserved.policy.enforceSingleDevice, true);
  assert.equal(preserved.policy.generation, 2);
  assert.equal(preserved.policy.revision, 3);
});

test('enabling queues every current driver session, clears every scalar claim and increments generation atomically', async () => {
  const db = {
    ref(path = '') {
      if (path === 'app_sessions') {
        return {
          orderByChild: () => ({
            equalTo: () => ({
              limitToFirst: () => ({ once: async () => snapshot({
                'uid-a': { sessionId: SESSION_A, principalType: 'driver' },
                'uid-b': { sessionId: SESSION_B, principalType: 'driver' },
              }) }),
            }),
          }),
        };
      }
      if (path === 'drivers') {
        return { once: async () => snapshot({ D1: { authUid: 'uid-a' }, D2: { authUid: 'uid-b' }, D3: {} }) };
      }
      if (path === 'driver_login_policy_events') return { push: () => ({ key: 'event-1' }) };
      throw new Error(`Unexpected ref: ${path}`);
    },
  };
  const result = await __testables.buildDriverLoginPolicyTransitionUpdates({
    db,
    current: {
      isDefault: true,
      policy: { schemaVersion: 1, enforceSingleDevice: false, generation: 0, revision: 0, updatedAtMs: null },
    },
    enforceSingleDevice: true,
    authUid: 'admin-uid',
    nowMs: 1_800_000_000_000,
  });
  assert.equal(result.nextPolicy.enforceSingleDevice, true);
  assert.equal(result.nextPolicy.generation, 1);
  assert.equal(result.nextPolicy.revision, 1);
  assert.equal(result.queuedSessionCount, 2);
  assert.equal(result.clearedClaimCount, 2);
  assert.equal(result.updates['drivers/D1/authUid'], null);
  assert.equal(result.updates['drivers/D2/authUid'], null);
  assert.equal(result.updates['driver_login_policy_cleanup/v1/uid-a'].sessionId, SESSION_A);
  assert.equal(result.updates['driver_login_policy_cleanup/v1/uid-b'].sessionId, SESSION_B);
  assert.equal(JSON.stringify(result.updates).includes('admin-uid'), false);
});

test('cleanup progress counts only jobs from the policy generation being enabled', () => {
  assert.equal(__testables.countDriverLoginPolicyCleanupJobs({
    currentA: { policyGeneration: 4 },
    currentB: { policyGeneration: 4 },
    previous: { policyGeneration: 3 },
    malformed: { policyGeneration: '4' },
  }, 4), 2);
  assert.equal(__testables.countDriverLoginPolicyCleanupJobs(null, 4), 0);
});

test('repeated policy cleanup failures persist bounded attempt history for terminalization', async () => {
  const path = 'driver_login_policy_cleanup/v1/uid-retry';
  let value = {
    schemaVersion: 1,
    sessionId: SESSION_A,
    policyGeneration: 4,
    attemptCount: 0,
    createdAtMs: 1,
    expiresAtMs: 100,
  };
  const db = {
    ref(requestedPath) {
      assert.equal(requestedPath, path);
      return {
        async transaction(updater) {
          const next = updater(value);
          if (next === undefined) return { committed: false, snapshot: snapshot(value) };
          value = next;
          return { committed: true, snapshot: snapshot(value) };
        },
      };
    },
  };
  const job = { ...value };
  assert.equal(await recordDriverPolicyCleanupFailure({
    db, authUid: 'uid-retry', job, nowMs: 10, reason: 'NETWORK/DETAIL should be bounded',
  }), true);
  assert.equal(await recordDriverPolicyCleanupFailure({
    db, authUid: 'uid-retry', job, nowMs: 20, reason: 'SESSION_CLEANUP_RETRY',
  }), true);
  assert.equal(value.attemptCount, 2);
  assert.equal(value.firstAttemptAtMs, 10);
  assert.equal(value.lastAttemptAtMs, 20);
  assert.equal(value.lastFailureReason, 'session_cleanup_retry');
  assert.equal(JSON.stringify(value).includes('DETAIL should'), false);

  value = {
    ...value,
    terminalWarningId: `warning_v1_${'c'.repeat(32)}`,
    terminalizationStartedAtMs: 30,
  };
  const claimed = { ...value };
  assert.equal(await recordDriverPolicyCleanupFailure({
    db, authUid: 'uid-retry', job, nowMs: 40, reason: 'late_failure',
  }), false);
  assert.deepEqual(value, claimed);
});

test('expired policy cleanup jobs become terminal warnings before source deletion', async () => {
  let updates = null;
  const cleanupJob = {
    schemaVersion: 1,
    authUidHash: 'already-hashed-auth',
    sessionId: SESSION_A,
    policyGeneration: 4,
    attemptCount: 3,
    firstAttemptAtMs: 40,
    lastAttemptAtMs: 80,
    lastFailureReason: 'SESSION_CLEANUP_RETRY',
    createdAtMs: 1,
    expiresAtMs: 100,
  };
  const values = {
    'driver_login_policy_cleanup/v1': { 'uid-old': cleanupJob },
    'driver_login_policy_cleanup/v1/uid-old': cleanupJob,
    driver_login_policy_events: { 'event-old': { expiresAtMs: 100 } },
  };
  const db = {
    values,
    ref(path = '') {
      if (path === '') return { update: async (value) => { updates = value; } };
      if (path.startsWith('operations_terminal_warnings/v1/')
        || path === 'driver_login_policy_cleanup/v1/uid-old') return {
        transaction: async (updater) => {
          const current = values[path] ?? null;
          const next = updater(current);
          if (next === undefined) return { committed: false, snapshot: snapshot(current) };
          if (next === null) delete values[path];
          else values[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
      return {
        orderByChild: (field) => {
          assert.equal(field, 'expiresAtMs');
          return {
            endAt: () => ({
              limitToFirst: (limit) => {
                assert.equal(limit, 25);
                return { once: async () => snapshot(values[path]) };
              },
            }),
          };
        },
      };
    },
  };
  assert.deepEqual(await __testables.cleanupExpiredDriverPolicyRecords({ db, nowMs: 200, limit: 25 }), {
    expiredCleanupJobsDeleted: 1,
    terminalWarnings: 1,
    terminalWarningFailures: 0,
    expiredAuditEventsDeleted: 1,
  });
  assert.deepEqual(updates, {
    'driver_login_policy_events/event-old': null,
  });
  assert.equal(values['driver_login_policy_cleanup/v1/uid-old'], undefined);
  const warning = Object.entries(values).find(([path]) => path.startsWith('operations_terminal_warnings/v1/'))?.[1];
  assert.ok(warning);
  assert.equal(warning.jobType, 'driver_policy_cleanup');
  assert.equal(warning.reason, 'retention_expired');
  assert.equal(warning.attemptCount, 3);
  assert.equal(warning.firstAttemptAtMs, 40);
  assert.equal(warning.lastAttemptAtMs, 80);
  assert.equal(warning.status, 'open');
  assert.equal(JSON.stringify(warning).includes('uid-old'), false);
  assert.equal(JSON.stringify(warning).includes(SESSION_A), false);
});

test('expiry cleanup cannot delete a replacement job for a newer exact session', async () => {
  let transactionCommitted = null;
  const db = {
    ref(path = '') {
      if (path === 'driver_login_policy_cleanup/v1') return {
        orderByChild: () => ({ endAt: () => ({ limitToFirst: () => ({
          once: async () => snapshot({ 'uid-raced': { sessionId: SESSION_A, expiresAtMs: 100 } }),
        }) }) }),
      };
      if (path === 'driver_login_policy_events') return {
        orderByChild: () => ({ endAt: () => ({ limitToFirst: () => ({ once: async () => snapshot({}) }) }) }),
      };
      if (path === 'driver_login_policy_cleanup/v1/uid-raced') return {
        transaction: async (updater) => {
          const replacement = { sessionId: SESSION_B, expiresAtMs: 500 };
          transactionCommitted = updater(replacement) !== undefined;
          return { committed: transactionCommitted };
        },
      };
      if (path.startsWith('operations_terminal_warnings/v1/')) {
        assert.fail('a replacement source job must not produce a terminal warning');
      }
      if (path === '') return { update: async () => assert.fail('no batch update expected') };
      throw new Error(`Unexpected ref: ${path}`);
    },
  };
  assert.equal((await __testables.cleanupExpiredDriverPolicyRecords({ db, nowMs: 200 })).expiredCleanupJobsDeleted, 0);
  assert.equal(transactionCommitted, false);
});

test('off-mode notification fanout includes every current driver handset but on-mode keeps the claim only', async () => {
  const nowMs = 1_800_000_000_000;
  const session = (authUid, generation) => ({
    schemaVersion: 1,
    sessionId: authUid === 'uid-a' ? SESSION_A : SESSION_B,
    authUid,
    principalId: 'driver:D1',
    principalType: 'driver',
    tourId: 'TOUR_1',
    driverId: 'D1',
    driverLoginPolicyGeneration: generation,
    status: 'active',
    issuedAtMs: nowMs - 1_000,
    lastAuthenticatedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 10_000,
    sessionRevision: 1,
  });
  let policy = {
    schemaVersion: 1, enforceSingleDevice: false, generation: 3, revision: 1, updatedAtMs: nowMs,
  };
  const profiles = {
    'uid-a': { driverId: 'D1', driverPrincipalId: 'driver:D1', principalType: 'driver', driverAssignedTourId: 'TOUR_1' },
    'uid-b': { driverId: 'D1', driverPrincipalId: 'driver:D1', principalType: 'driver', driverAssignedTourId: 'TOUR_1' },
  };
  const db = {
    ref(path) {
      if (path === 'app_sessions') return {
        orderByChild: () => ({ equalTo: () => ({ once: async () => snapshot({
          'uid-a': session('uid-a', 3), 'uid-b': session('uid-b', 3),
        }) }) }),
      };
      if (path === 'driver_login_policy/v1') return { once: async () => snapshot(policy) };
      if (path.startsWith('users/')) return { once: async () => snapshot(profiles[path.slice('users/'.length)]) };
      throw new Error(`Unexpected ref: ${path}`);
    },
  };
  const driverData = { authUid: 'uid-a', currentTourId: 'TOUR_1' };
  assert.deepEqual(await __testables.loadDriverSessionAuthUids('D1', {
    db, tourId: 'TOUR_1', driverData, nowMs,
  }), ['uid-a', 'uid-b']);

  policy = { ...policy, enforceSingleDevice: true };
  assert.deepEqual(await __testables.loadDriverSessionAuthUids('D1', {
    db, tourId: 'TOUR_1', driverData, nowMs,
  }), ['uid-a']);

  policy = { ...policy, generation: 4, revision: 2 };
  assert.deepEqual(await __testables.loadDriverSessionAuthUids('D1', {
    db, tourId: 'TOUR_1', driverData, nowMs,
  }), []);
});
