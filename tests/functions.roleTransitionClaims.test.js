'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE_TRANSITION_CLAIM_ROOT,
  buildPassengerRoleClaimJob,
  processPassengerRoleClaimJobs,
  recordPassengerRoleClaimFailure,
  reconcilePassengerRoleClaimJob,
} = require('../functions/src/domains/app-sessions/roleTransition');
const {
  buildPassengerCustomClaims,
} = require('../functions/src/domains/passenger-auth/passengerLoginWorkflow');

const AUTH_UID = 'uid-role-claim';
const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;
const OWNER_KEY = `pax_v2_${'b'.repeat(32)}`;
const FORMER_SESSION_ID = `sess_v1_${'d'.repeat(32)}`;
const FORMER_DRIVER_ID = 'D-ROLE';

const snapshot = (value) => ({
  val: () => value ?? null,
  exists: () => value !== null && value !== undefined,
});

const createDb = (initial = {}) => {
  const state = { ...initial };
  return {
    state,
    ref(path) {
      const ref = {
        orderByChild() { return ref; },
        limitToFirst() { return ref; },
        once: async () => snapshot(state[path]),
        transaction: async (updater) => {
          const next = updater(state[path] ?? null);
          if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) };
          if (next === null) delete state[path];
          else state[path] = next;
          return { committed: true, snapshot: snapshot(next) };
        },
      };
      return ref;
    },
  };
};

const passengerSession = () => ({
  authUid: AUTH_UID,
  principalType: 'passenger',
  sessionId: SESSION_ID,
});

const formerDriverSession = () => ({
  authUid: AUTH_UID,
  principalType: 'driver',
  principalId: `driver:${FORMER_DRIVER_ID}`,
  driverId: FORMER_DRIVER_ID,
  sessionId: FORMER_SESSION_ID,
});

test('passenger role claim job is exact-session scoped and bounded', () => {
  const job = buildPassengerRoleClaimJob({
    authUid: AUTH_UID,
    session: passengerSession(),
    replacedSession: formerDriverSession(),
    privatePhotoOwnerKey: OWNER_KEY,
    nowMs: 1_800_000_000_000,
  });
  assert.deepEqual(job, {
    schemaVersion: 2,
    authUid: AUTH_UID,
    appSessionId: SESSION_ID,
    privatePhotoOwnerKey: OWNER_KEY,
    formerDriverId: FORMER_DRIVER_ID,
    replacedAppSessionId: FORMER_SESSION_ID,
    attemptCount: 0,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_802_592_000_000,
  });
});

test('policy-on transition releases only the former uid scalar and delayed cleanup cannot remove its successor', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const job = buildPassengerRoleClaimJob({
    authUid: AUTH_UID,
    session: passengerSession(),
    replacedSession: formerDriverSession(),
    privatePhotoOwnerKey: OWNER_KEY,
    nowMs: 1,
  });
  const db = createDb({
    [jobPath]: job,
    [`app_sessions/${AUTH_UID}`]: passengerSession(),
    [`drivers/${FORMER_DRIVER_ID}/authUid`]: AUTH_UID,
    'driver_login_policy/v1': {
      schemaVersion: 1, enforceSingleDevice: true, generation: 4, revision: 5, updatedAtMs: 1,
    },
  });
  const auth = {
    getUser: async () => ({ customClaims: { isDriver: true } }),
    setCustomUserClaims: async () => {},
  };

  assert.deepEqual(await reconcilePassengerRoleClaimJob({
    db, auth, authUid: AUTH_UID, buildClaims: buildPassengerCustomClaims, nowMs: 2,
  }), { status: 'completed', completed: true, driverClaimReleased: true });
  assert.equal(db.state[`drivers/${FORMER_DRIVER_ID}/authUid`], undefined);

  db.state[`drivers/${FORMER_DRIVER_ID}/authUid`] = 'uid-successor';
  db.state[jobPath] = job;
  assert.deepEqual(await reconcilePassengerRoleClaimJob({
    db, auth, authUid: AUTH_UID, buildClaims: buildPassengerCustomClaims, nowMs: 3,
  }), { status: 'completed', completed: true, driverClaimReleased: false });
  assert.equal(db.state[`drivers/${FORMER_DRIVER_ID}/authUid`], 'uid-successor');
  assert.equal(db.state[`drivers/${FORMER_DRIVER_ID}/currentTourId`], undefined);
});

test('claim reconciliation scrubs driver claims and completes exactly once', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const db = createDb({
    [jobPath]: buildPassengerRoleClaimJob({
      authUid: AUTH_UID,
      session: passengerSession(),
      privatePhotoOwnerKey: OWNER_KEY,
      nowMs: 1,
    }),
    [`app_sessions/${AUTH_UID}`]: passengerSession(),
  });
  const writes = [];
  const auth = {
    getUser: async () => ({ customClaims: { isDriver: true, driverId: 'D-OLD', durable: 'kept' } }),
    setCustomUserClaims: async (uid, claims) => writes.push({ uid, claims }),
  };
  const result = await reconcilePassengerRoleClaimJob({
    db, auth, authUid: AUTH_UID, buildClaims: buildPassengerCustomClaims, nowMs: 2,
  });
  assert.deepEqual(result, { status: 'completed', completed: true });
  assert.equal(db.state[jobPath], undefined);
  assert.deepEqual(writes, [{
    uid: AUTH_UID,
    claims: {
      durable: 'kept',
      privatePhotoOwnerKey: OWNER_KEY,
      passengerIdentityVersion: 'pax_v2',
    },
  }]);
  assert.deepEqual(await reconcilePassengerRoleClaimJob({
    db, auth, authUid: AUTH_UID, buildClaims: buildPassengerCustomClaims, nowMs: 2,
  }), { status: 'missing', completed: false });
  assert.equal(writes.length, 1);
});

test('a stale role claim job cannot touch a replacement session', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const db = createDb({
    [jobPath]: buildPassengerRoleClaimJob({
      authUid: AUTH_UID,
      session: passengerSession(),
      privatePhotoOwnerKey: OWNER_KEY,
      nowMs: 1,
    }),
    [`app_sessions/${AUTH_UID}`]: { ...passengerSession(), sessionId: `sess_v1_${'c'.repeat(32)}` },
  });
  let writes = 0;
  const result = await reconcilePassengerRoleClaimJob({
    db,
    auth: {
      getUser: async () => { throw new Error('must not read auth'); },
      setCustomUserClaims: async () => { writes += 1; },
    },
    authUid: AUTH_UID,
    buildClaims: buildPassengerCustomClaims,
    nowMs: 2,
  });
  assert.deepEqual(result, { status: 'stale', completed: false });
  assert.equal(db.state[jobPath], undefined);
  assert.equal(writes, 0);
});

test('bounded worker retains an exact current job when Auth is retryable', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const job = buildPassengerRoleClaimJob({
    authUid: AUTH_UID,
    session: passengerSession(),
    privatePhotoOwnerKey: OWNER_KEY,
    nowMs: 1,
  });
  const db = createDb({
    [ROLE_TRANSITION_CLAIM_ROOT]: { [AUTH_UID]: job },
    [jobPath]: job,
    [`app_sessions/${AUTH_UID}`]: passengerSession(),
  });
  const result = await processPassengerRoleClaimJobs({
    db,
    auth: {
      getUser: async () => ({ customClaims: {} }),
      setCustomUserClaims: async () => { throw Object.assign(new Error('retry'), { code: 'AUTH_RETRY' }); },
    },
    buildClaims: buildPassengerCustomClaims,
    limit: 10,
    nowMs: 2,
  });
  assert.deepEqual(result, {
    scanned: 1, completed: 0, retryable: 1, stale: 0, expired: 0, terminalWarnings: 0,
  });
  assert.equal(db.state[jobPath].attemptCount, 1);
  assert.equal(db.state[jobPath].firstAttemptAtMs, 2);
  assert.equal(db.state[jobPath].lastAttemptAtMs, 2);
  assert.equal(db.state[jobPath].lastFailureReason, 'auth_retry');
});

test('role failure recorder refuses a job already claimed for terminalization', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const job = {
    ...buildPassengerRoleClaimJob({
      authUid: AUTH_UID,
      session: passengerSession(),
      privatePhotoOwnerKey: OWNER_KEY,
      nowMs: 1,
    }),
    attemptCount: 3,
    terminalWarningId: `warning_v1_${'a'.repeat(32)}`,
    terminalizationStartedAtMs: 40,
  };
  const db = createDb({ [jobPath]: job });
  assert.equal(await recordPassengerRoleClaimFailure({
    db, authUid: AUTH_UID, appSessionId: SESSION_ID, nowMs: 50, reason: 'late_failure',
  }), false);
  assert.deepEqual(db.state[jobPath], job);
});

test('bounded worker terminalizes an expired role claim job before removing it', async () => {
  const jobPath = `${ROLE_TRANSITION_CLAIM_ROOT}/${AUTH_UID}`;
  const job = buildPassengerRoleClaimJob({
    authUid: AUTH_UID,
    session: passengerSession(),
    replacedSession: formerDriverSession(),
    privatePhotoOwnerKey: OWNER_KEY,
    nowMs: 1,
  });
  job.attemptCount = 3;
  job.firstAttemptAtMs = 10;
  job.lastAttemptAtMs = 20;
  job.lastFailureReason = 'AUTH_RETRY';
  const db = createDb({
    [ROLE_TRANSITION_CLAIM_ROOT]: { [AUTH_UID]: job },
    [jobPath]: job,
    [`app_sessions/${AUTH_UID}`]: passengerSession(),
  });
  const result = await processPassengerRoleClaimJobs({
    db,
    auth: {
      getUser: async () => { throw new Error('must not read auth'); },
      setCustomUserClaims: async () => { throw new Error('must not write auth'); },
    },
    buildClaims: buildPassengerCustomClaims,
    limit: 10,
    nowMs: job.expiresAtMs + 1,
  });
  assert.deepEqual(result, {
    scanned: 1, completed: 0, retryable: 0, stale: 0, expired: 1, terminalWarnings: 1,
  });
  assert.equal(db.state[jobPath], undefined);
  const warningEntry = Object.entries(db.state)
    .find(([path]) => path.startsWith('operations_terminal_warnings/v1/'));
  assert.ok(warningEntry);
  const [warningPath, warning] = warningEntry;
  assert.match(warningPath, /^operations_terminal_warnings\/v1\/warning_v1_[a-f0-9]{32}$/);
  assert.equal(warning.jobType, 'passenger_role_claim');
  assert.equal(warning.reason, 'retention_expired');
  assert.equal(warning.attemptCount, 3);
  assert.equal(warning.firstAttemptAtMs, 10);
  assert.equal(warning.lastAttemptAtMs, 20);
  assert.equal(warning.expiresAtMs, job.expiresAtMs);
  assert.equal(warning.status, 'open');
  assert.equal(warning.acknowledged, false);
  assert.equal(warning.resolved, false);
  assert.ok(warning.retainUntilMs > warning.createdAtMs);
  assert.deepEqual(Object.keys(warning.identifierHashes).sort(), [
    'appSessionId', 'authUid', 'driverId', 'replacedAppSessionId',
  ]);
  assert.equal(JSON.stringify(warning).includes(AUTH_UID), false);
  assert.equal(JSON.stringify(warning).includes(FORMER_DRIVER_ID), false);
  assert.equal(JSON.stringify(warning).includes(FORMER_SESSION_ID), false);
});
