'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const {
  APP_SESSION_KEY,
  PENDING_SESSION_END_KEY,
  createAppSessionService,
  validateAppSession,
} = require('../services/appSessionService');
const { createLocalSessionCleanupService } = require('../services/localSessionCleanupService');

const SESSION = {
  schemaVersion: 1,
  sessionId: `sess_v1_${'a'.repeat(32)}`,
  tourId: 'TOUR_A',
  principalId: `pax_v2_${'b'.repeat(32)}`,
  principalType: 'passenger',
  driverId: null,
  issuedAtMs: 1_000,
  expiresAtMs: 20_000,
  sessionRevision: 1,
};

const memoryStorage = () => {
  const values = new Map();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
    multiRemove: async (keys) => { keys.forEach((key) => values.delete(key)); },
  };
};

test('mobile session validation rejects credentials, extras and expired records', () => {
  assert.deepEqual(validateAppSession(SESSION, { nowMs: 2_000 }), SESSION);
  assert.equal(validateAppSession({ ...SESSION, bookingRef: 'SECRET' }, { nowMs: 2_000 }), null);
  assert.equal(validateAppSession({ ...SESSION, email: 'person@example.test' }, { nowMs: 2_000 }), null);
  assert.equal(validateAppSession(SESSION, { nowMs: 20_000 }), null);
});

test('logout persists a safe pending marker and sends Auth, App Check and expectedSessionId once', async () => {
  const storage = memoryStorage();
  const requests = [];
  const service = createAppSessionService({
    storage,
    now: () => 2_000,
    getFirebase: () => ({
      auth: { currentUser: { uid: 'uid-a', getIdToken: async () => 'id-token' } },
      getCurrentAppCheckToken: async () => 'app-check-token',
    }),
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true, reason: 'ENDED' }) };
    },
  });
  process.env.EXPO_PUBLIC_END_APP_SESSION_URL = 'https://example.test/endAppSession';
  const [first, second] = await Promise.all([
    service.endSession({ authUid: 'uid-a', session: SESSION }),
    service.endSession({ authUid: 'uid-a', session: SESSION }),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer id-token');
  assert.equal(requests[0].options.headers['x-firebase-appcheck'], 'app-check-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    expectedSessionId: SESSION.sessionId,
    reason: 'user_logout',
  });
  const pending = JSON.parse(storage.values.get(PENDING_SESSION_END_KEY));
  assert.deepEqual(Object.keys(pending).sort(), [
    'attemptCount', 'authUid', 'principalType', 'requestedAtMs', 'sessionId', 'tourId',
  ]);
  assert.equal(JSON.stringify(pending).includes('pax_v2'), false);
});

test('logout compare failure preserves the pending marker and cannot end a newer session', async () => {
  const storage = memoryStorage();
  const service = createAppSessionService({
    storage,
    now: () => 2_000,
    getFirebase: () => ({
      auth: { currentUser: { uid: 'uid-a', getIdToken: async () => 'id-token' } },
      getCurrentAppCheckToken: async () => 'app-check-token',
    }),
    fetchFn: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ success: false, reason: 'SESSION_CHANGED' }),
    }),
  });
  const result = await service.endSession({ authUid: 'uid-a', session: SESSION });
  assert.equal(result.reason, 'SESSION_CHANGED');
  assert.ok(storage.values.has(PENDING_SESSION_END_KEY));
  await service.completeEnd();
  assert.equal(storage.values.has(APP_SESSION_KEY), false);
  assert.equal(storage.values.has(PENDING_SESSION_END_KEY), false);
});

test('remote session subscription reports deletion or replacement immediately', () => {
  let listener;
  let detached = false;
  const revoked = [];
  const service = createAppSessionService({
    now: () => 2_000,
    getFirebase: () => ({
      realtimeDb: {
        ref: () => ({
          on: (_event, callback) => { listener = callback; },
          off: () => { detached = true; },
        }),
      },
    }),
  });
  const unsubscribe = service.subscribe({
    authUid: 'uid-a',
    expectedSession: SESSION,
    onRevoked: (event) => revoked.push(event),
  });
  listener({ val: () => null });
  assert.deepEqual(revoked, [{ reason: 'SESSION_ENDED' }]);
  unsubscribe();
  assert.equal(detached, true);
});

test('central local cleanup stops replay and reports any durable purge failure', async () => {
  const calls = [];
  const service = createLocalSessionCleanupService({
    storage: { multiRemove: async () => { calls.push('storage'); }, removeItem: async () => {} },
    offline: {
      setActiveSessionScope: () => { calls.push('stop'); },
      purgeTourPack: async () => ({ success: true }),
      purgeActionsForScope: async () => ({ success: false, error: 'disk unavailable' }),
    },
    driverLifecycle: { purge: async () => ({ success: true }) },
    clearNotifications: async () => 1,
    photoCache: { clearPhotoViewerCache: async () => ({ success: true }) },
  });
  const result = await service.cleanup({
    authUid: 'uid-a', appSession: SESSION, bookingData: { id: 'BOOK-1' }, tourData: { id: 'TOUR_A' },
  });
  assert.equal(calls[0], 'stop');
  assert.equal(result.success, false);
  assert.deepEqual(result.failures, [{ name: 'clearQueuedActions', error: 'disk unavailable' }]);
});
