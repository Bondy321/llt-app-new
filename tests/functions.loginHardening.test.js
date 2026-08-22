'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-login-hardening',
  storageBucket: 'demo-llt-login-hardening.appspot.com',
});
const { __testables } = require('../functions/index.js');

const createSharedTransactionalDatabase = () => {
  const state = {};
  const queues = new Map();
  const makeSnapshot = (value) => ({ val: () => value });
  return {
    state,
    ref(path) {
      return {
        async transaction(updater) {
          const previous = queues.get(path) || Promise.resolve();
          let release;
          const current = new Promise((resolve) => { release = resolve; });
          queues.set(path, previous.then(() => current));
          await previous;
          try {
            state[path] = updater(state[path] || null);
            return { committed: true, snapshot: makeSnapshot(state[path]) };
          } finally {
            release();
          }
        },
      };
    },
  };
};

test('independent Functions instances enforce one shared atomic login quota', async () => {
  const database = createSharedTransactionalDatabase();
  const instanceA = __testables.createDistributedLoginRateLimiter({ database, now: () => 1000 });
  const instanceB = __testables.createDistributedLoginRateLimiter({ database, now: () => 1000 });

  const outcomes = await Promise.all(Array.from({ length: 10 }, (_, index) => (
    (index % 2 ? instanceA : instanceB)('passenger_account_deadbeef', 8, 60000)
  )));

  assert.equal(outcomes.filter(Boolean).length, 8);
  assert.equal(outcomes.filter((allowed) => !allowed).length, 2);
  assert.equal(database.state['login_rate_limits/v1/passenger_account_deadbeef'].count, 9);
});

test('distributed limiter resets only after the shared window expires', async () => {
  const database = createSharedTransactionalDatabase();
  let nowMs = 1000;
  const limiter = __testables.createDistributedLoginRateLimiter({ database, now: () => nowMs });
  assert.equal(await limiter('driver_account_cafebabe', 1, 60000), true);
  assert.equal(await limiter('driver_account_cafebabe', 1, 60000), false);
  nowMs = 61000;
  assert.equal(await limiter('driver_account_cafebabe', 1, 60000), true);
});

test('distributed limiter rejects raw or path-unsafe bucket keys', async () => {
  const database = createSharedTransactionalDatabase();
  const limiter = __testables.createDistributedLoginRateLimiter({ database });
  await assert.rejects(() => limiter('passenger@example.test', 1, 60000), /opaque key/);
  await assert.rejects(() => limiter('network/203.0.113.1', 1, 60000), /opaque key/);
});

test('production App Check is fail-closed unless explicitly enabled', () => {
  assert.equal(__testables.shouldRequireLoginAppCheck({ NODE_ENV: 'test' }), false);
  assert.equal(__testables.shouldRequireLoginAppCheck({
    K_SERVICE: 'verifypassengerlogin',
    REQUIRE_APP_CHECK_FOR_LOGIN: 'true',
  }), true);
  assert.throws(
    () => __testables.shouldRequireLoginAppCheck({ K_SERVICE: 'verifypassengerlogin' }),
    (error) => error.code === 'LOGIN_APP_CHECK_CONFIGURATION_REQUIRED',
  );
  assert.throws(
    () => __testables.shouldRequireLoginAppCheck({
      K_SERVICE: 'verifypassengerlogin',
      REQUIRE_APP_CHECK_FOR_LOGIN: 'false',
    }),
    (error) => error.code === 'LOGIN_APP_CHECK_CONFIGURATION_REQUIRED',
  );
});

test('K_SERVICE dominates test and emulator markers while a real local emulator may opt out', () => {
  assert.throws(() => __testables.shouldRequireLoginAppCheck({
    K_SERVICE: 'verifypassengerlogin', NODE_ENV: 'test', FUNCTIONS_EMULATOR: 'true',
    REQUIRE_APP_CHECK_FOR_LOGIN: 'false',
  }), (error) => error.code === 'LOGIN_APP_CHECK_CONFIGURATION_REQUIRED');
  assert.equal(__testables.shouldRequireLoginAppCheck({
    FUNCTIONS_EMULATOR: 'true',
    REQUIRE_APP_CHECK_FOR_LOGIN: 'false',
  }), false);
});

test('trusted network key ignores attacker-controlled client fingerprints and prepended XFF values', () => {
  const base = {
    ip: 'proxy-address',
    headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.2' },
  };
  assert.equal(__testables.getTrustedRequestNetworkKey({
    ...base,
    headers: { ...base.headers, 'x-client-id': 'rotated-a', 'user-agent': 'agent-a' },
  }), '198.51.100.20');
  assert.equal(__testables.getTrustedRequestNetworkKey({
    ...base,
    headers: { 'x-forwarded-for': 'attacker-spoof, 198.51.100.20, 10.0.0.2', 'x-client-id': 'rotated-b' },
  }), '198.51.100.20');
});

test('login bucket paths never contain raw identity or network dimensions', async () => {
  const keys = [];
  const result = await __testables.checkPassengerLoginRateLimits({
    authUid: 'raw-auth-uid',
    clientKey: '203.0.113.40:raw-client-id',
    bookingRef: 'RAW-BOOKING-REF',
    email: 'raw-email@example.test',
    limiter: async (key) => {
      keys.push(key);
      return true;
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(keys.length, 3);
  assert.ok(keys.every((key) => /^[a-z_]+[a-f0-9]{24}$/.test(key)));
  assert.ok(keys.every((key) => !/raw|203|example/i.test(key)));
});

const createCleanupDatabase = (initial, { beforeTransaction } = {}) => {
  const state = { ...initial };
  return {
    state,
    ref(path) {
      const key = path.split('/').at(-1);
      return {
        orderByChild: () => ({
          endAt: (nowMs) => ({
            limitToFirst: (limit) => ({
              once: async () => ({
                val: () => Object.fromEntries(Object.entries(state)
                  .filter(([, record]) => record && record.expiresAtMs <= nowMs)
                  .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)
                  .slice(0, limit)),
              }),
            }),
          }),
        }),
        async transaction(updater) {
          if (beforeTransaction) await beforeTransaction({ key, state });
          const next = updater(state[key] || null);
          if (next === undefined) return { committed: false, snapshot: { val: () => state[key] } };
          if (next === null) delete state[key];
          else state[key] = next;
          return { committed: true, snapshot: { val: () => next } };
        },
      };
    },
  };
};

test('expired limiter cleanup compare-and-delete preserves a bucket reset after its query', async () => {
  const expired = { version: 1, count: 3, resetAtMs: 100, expiresAtMs: 200, lastAttemptAtMs: 50 };
  let raced = false;
  const database = createCleanupDatabase({ passenger_account_deadbeef: expired }, {
    beforeTransaction: ({ key, state }) => {
      if (!raced) {
        raced = true;
        state[key] = { ...expired, count: 1, resetAtMs: 9000, expiresAtMs: 19000 };
      }
    },
  });
  const result = await __testables.cleanupExpiredLoginRateLimits({ database, nowMs: 1000, limit: 2 });
  assert.equal(result.deletedCount, 0);
  assert.equal(result.retainedCount, 1);
  assert.equal(database.state.passenger_account_deadbeef.resetAtMs, 9000);
});

test('expired limiter cleanup drains several batches but exposes a hard-ceiling backlog', async () => {
  const record = (offset) => ({
    version: 1, count: 1, resetAtMs: 100 + offset, expiresAtMs: 200 + offset, lastAttemptAtMs: 50,
  });
  const database = createCleanupDatabase(Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`bucket_${index}`, record(index)]),
  ));
  const result = await __testables.cleanupExpiredLoginRateLimits({
    database,
    nowMs: 123456,
    limit: 2,
    maxBatches: 2,
  });
  assert.deepEqual(result, {
    deletedCount: 4, retainedCount: 0, scannedCount: 4, batchCount: 2, hasMore: true,
  });
  assert.equal(Object.keys(database.state).length, 1);
});

test('expired limiter cleanup rejects attempts to exceed its invocation ceiling', async () => {
  const database = createCleanupDatabase({});
  await assert.rejects(
    () => __testables.cleanupExpiredLoginRateLimits({ database, limit: 501 }),
    /limit cannot exceed 500/,
  );
  await assert.rejects(
    () => __testables.cleanupExpiredLoginRateLimits({ database, maxBatches: 6 }),
    /maxBatches cannot exceed 5/,
  );
});
