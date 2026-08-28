'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acquireDriverLoginAdmission,
  beginDriverPolicyTransition,
  completeDriverLoginAdmission,
} = require('../functions/src/domains/driver-auth/driverDevicePolicy');
const {
  advanceDriverPolicyTransition,
} = require('../functions/src/domains/driver-auth/driverDevicePolicyFunctions');

const snapshot = (value) => ({
  val: () => value,
  exists: () => value !== null && value !== undefined,
});

const createPolicyDb = (initial) => {
  let value = initial;
  let queue = Promise.resolve();
  return {
    read: () => value,
    ref(path) {
      assert.equal(path, 'driver_login_policy/v1');
      return {
        once: async () => snapshot(value),
        transaction(updater) {
          const work = queue.then(() => {
            const next = updater(value);
            if (next === undefined) return { committed: false, snapshot: snapshot(value) };
            value = next;
            return { committed: true, snapshot: snapshot(value) };
          });
          queue = work.then(() => undefined);
          return work;
        },
      };
    },
  };
};

const offPolicy = () => ({
  schemaVersion: 1,
  enforceSingleDevice: false,
  generation: 4,
  revision: 7,
  updatedAtMs: 1_800_000_000_000,
  transitionPhase: 'stable',
});

test('policy-off admissions do not serialize unrelated or same-driver handsets', async () => {
  const db = createPolicyDb(offPolicy());
  const [first, second, third] = await Promise.all([
    acquireDriverLoginAdmission({ db, authUid: 'uid-a', driverId: 'D-ONE', admissionId: 'login-a', nowMs: 100 }),
    acquireDriverLoginAdmission({ db, authUid: 'uid-b', driverId: 'D-TWO', admissionId: 'login-b', nowMs: 100 }),
    acquireDriverLoginAdmission({ db, authUid: 'uid-c', driverId: 'D-ONE', admissionId: 'login-c', nowMs: 100 }),
  ]);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  assert.equal(third.acquired, true);
  assert.deepEqual(Object.keys(db.read().loginAdmissions).sort(), ['login-a', 'login-b', 'login-c']);
});

test('an atomic draining phase fences new driver logins with the dedicated reason', async () => {
  const db = createPolicyDb(offPolicy());
  const transition = await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: true,
    expectedRevision: 7,
    actorHash: 'actor-hash',
    transitionId: 'transition-1',
    nowMs: 200,
  });
  assert.equal(transition.started, true);
  assert.equal(db.read().transitionPhase, 'draining');

  const login = await acquireDriverLoginAdmission({
    db, authUid: 'uid-late', driverId: 'D-LATE', admissionId: 'login-late', nowMs: 201,
  });
  assert.deepEqual(login, {
    acquired: false,
    reason: 'DRIVER_POLICY_CHANGE_IN_PROGRESS',
  });
});

test('an admitted login linearizes before a concurrently started policy drain barrier', async () => {
  const db = createPolicyDb(offPolicy());
  const admission = await acquireDriverLoginAdmission({
    db, authUid: 'uid-admitted', driverId: 'D-ONE', admissionId: 'login-admitted', nowMs: 100,
  });
  const transition = await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: true,
    expectedRevision: 7,
    actorHash: 'admin-hash',
    transitionId: 'transition-race',
    nowMs: 101,
  });
  assert.equal(transition.started, true);
  assert.equal(db.read().transitionPhase, 'draining');

  assert.equal(await completeDriverLoginAdmission({
    db, admissionId: admission.admissionId, policy: admission.policy,
  }), true);
  assert.equal(db.read().loginAdmissions, null);

  const barrier = await db.ref('driver_login_policy/v1').transaction((current) => {
    if (Object.keys(current.loginAdmissions || {}).length) return undefined;
    return { ...current, generation: current.generation + 1, transitionPhase: 'cleanup' };
  });
  assert.equal(barrier.committed, true);
  assert.equal(db.read().generation, 5);
});

test('enabling from a missing policy materializes a complete draining record', async () => {
  const db = createPolicyDb(null);
  const result = await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: true,
    expectedRevision: 0,
    actorHash: 'actor-hash',
    transitionId: 'transition-from-default',
    nowMs: 500,
  });

  assert.equal(result.started, true);
  assert.equal(db.read().schemaVersion, 1);
  assert.equal(db.read().enforceSingleDevice, false);
  assert.equal(db.read().generation, 0);
  assert.equal(db.read().revision, 1);
  assert.equal(db.read().updatedAtMs, 500);
  assert.equal(db.read().transitionPhase, 'draining');
});

test('disabling is atomic and non-destructive for current generation and admissions', async () => {
  const current = offPolicy();
  current.enforceSingleDevice = true;
  current.loginAdmissions = {
    active: { authUidHash: 'hash', driverIdHash: 'driver-hash', generation: 4, createdAtMs: 100 },
  };
  const db = createPolicyDb(current);
  const result = await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: false,
    expectedRevision: 7,
    actorHash: 'actor-hash',
    transitionId: 'transition-disable',
    nowMs: 300,
  });

  assert.equal(result.completed, true);
  assert.equal(db.read().enforceSingleDevice, false);
  assert.equal(db.read().generation, 4);
  assert.ok(db.read().loginAdmissions.active);
});

test('policy change cannot enter an assignment and drain retains a durable admission beyond fifteen minutes', async () => {
  const db = createPolicyDb(offPolicy());
  const admission = await acquireDriverLoginAdmission({
    db,
    authUid: 'assignment-actor',
    driverId: 'D-ONE',
    admissionId: 'assignment-durable',
    durable: true,
    nowMs: 100,
  });
  assert.equal(admission.acquired, true);
  const blocked = await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: true,
    expectedRevision: 7,
    actorHash: 'admin-hash',
    transitionId: 'policy-waits-for-assignment',
    nowMs: 200,
  });
  assert.equal(blocked.reason, 'DRIVER_POLICY_CHANGE_IN_PROGRESS');
  assert.equal(db.read().transitionPhase, 'stable');

  const drainingPolicy = {
    ...offPolicy(),
    transitionPhase: 'draining',
    transitionId: 'policy-defensive-drain',
    targetEnforceSingleDevice: true,
    loginAdmissions: db.read().loginAdmissions,
  };
  const drainingDb = createPolicyDb(drainingPolicy);
  const result = await advanceDriverPolicyTransition({ db: drainingDb, nowMs: 1_000_000, pageSize: 100 });
  assert.equal(result.status, 'draining');
  assert.equal(drainingDb.read().generation, 4);
  assert.equal(drainingDb.read().transitionPhase, 'draining');
  assert.equal(drainingDb.read().loginAdmissions['assignment-durable'].durableUntilExplicitRelease, true);
});

const setPathValue = (root, path, value) => {
  const parts = path.split('/').filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor[parts[index]] ||= {};
    cursor = cursor[parts[index]];
  }
  if (value === null) delete cursor[parts.at(-1)];
  else cursor[parts.at(-1)] = value;
};

const getPathValue = (root, path) => path.split('/').filter(Boolean)
  .reduce((value, part) => value?.[part], root);

const createPagedPolicyDb = (state) => ({
  state,
  ref(path = '') {
    const makeQuery = (startKey = null) => ({
      startAt(key) { return makeQuery(key); },
      limitToFirst(limit) {
        return {
          once: async () => {
            const source = getPathValue(state, path) || {};
            const keys = Object.keys(source).sort()
              .filter((key) => startKey === null || key >= startKey)
              .slice(0, limit);
            return snapshot(Object.fromEntries(keys.map((key) => [key, source[key]])));
          },
        };
      },
    });
    if (!path) return {
      update: async (updates) => Object.entries(updates).forEach(([target, value]) => setPathValue(state, target, value)),
    };
    return {
      once: async () => snapshot(getPathValue(state, path)),
      orderByKey: () => makeQuery(),
      transaction: async (updater) => {
        const current = getPathValue(state, path);
        const next = updater(current);
        if (next === undefined) return { committed: false, snapshot: snapshot(current) };
        setPathValue(state, path, next);
        return { committed: true, snapshot: snapshot(next) };
      },
    };
  },
});

test('a policy transition resumes beyond 500 records after more than 60 seconds', async () => {
  const sessionId = (index) => `sess_v1_${index.toString(16).padStart(32, '0')}`;
  const appSessions = {};
  const drivers = {};
  for (let index = 0; index < 601; index += 1) {
    const authUid = `uid-${index.toString().padStart(4, '0')}`;
    const driverId = `D-${index.toString().padStart(4, '0')}`;
    appSessions[authUid] = {
      sessionId: sessionId(index),
      principalType: 'driver',
      driverLoginPolicyGeneration: 0,
    };
    drivers[driverId] = { authUid };
  }
  const db = createPagedPolicyDb({
    driver_login_policy: { v1: offPolicy() },
    app_sessions: appSessions,
    drivers,
  });
  await beginDriverPolicyTransition({
    db,
    enforceSingleDevice: true,
    expectedRevision: 7,
    actorHash: 'actor-hash',
    transitionId: 'transition-large',
    nowMs: 1_000,
  });

  let result;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await advanceDriverPolicyTransition({ db, nowMs: 121_000 + attempt, pageSize: 100 });
    if (result.status === 'stable') break;
  }

  assert.equal(result.status, 'stable');
  assert.equal(db.state.driver_login_policy.v1.transitionPhase, 'stable');
  assert.equal(db.state.driver_login_policy.v1.generation, 5);
  assert.equal(db.state.driver_login_policy.v1.transitionSessionsScanned, 601);
  assert.equal(db.state.driver_login_policy.v1.transitionDriversScanned, 601);
  assert.equal(Object.keys(db.state.driver_login_policy_cleanup.v1).length, 601);
  assert.equal(Object.values(db.state.drivers).some((driver) => driver.authUid), false);
});
