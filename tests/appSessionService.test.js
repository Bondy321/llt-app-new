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
  assert.deepEqual(validateAppSession({
    ...SESSION,
    authUid: 'passenger-auth-uid',
    status: 'active',
    lastAuthenticatedAtMs: 1_000,
    driverId: undefined,
  }, { nowMs: 2_000 }), null);
  const { driverId: _firebaseOmittedDriverId, ...firebasePassengerSession } = SESSION;
  assert.equal(validateAppSession(firebasePassengerSession, { nowMs: 2_000 }), null);
  assert.deepEqual(validateAppSession({
    ...firebasePassengerSession,
    authUid: 'passenger-auth-uid',
    status: 'active',
    lastAuthenticatedAtMs: 1_000,
  }, { nowMs: 2_000 }), SESSION);
  const firebaseUnassignedDriver = {
    schemaVersion: 1,
    sessionId: `sess_v1_${'c'.repeat(32)}`,
    authUid: 'driver-auth-uid',
    principalId: 'driver:BONDY',
    principalType: 'driver',
    driverId: 'BONDY',
    status: 'active',
    issuedAtMs: 1_000,
    lastAuthenticatedAtMs: 1_000,
    expiresAtMs: 20_000,
    sessionRevision: 1,
  };
  assert.equal(validateAppSession(firebaseUnassignedDriver, { nowMs: 2_000 }).tourId, null);
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
  await service.completeEnd({ expectedSessionId: SESSION.sessionId });
  assert.equal(storage.values.has(APP_SESSION_KEY), false);
  assert.equal(storage.values.has(PENDING_SESSION_END_KEY), false);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flushMicrotasks = async () => { for (let turn = 0; turn < 32; turn += 1) await Promise.resolve(); };

test('late completion cannot clear a newer session or pending logout operation', async () => {
  const storage = memoryStorage();
  const service = createAppSessionService({ storage, now: () => 2000 });
  await service.persistSession(SESSION);
  await service.persistPendingEnd({ authUid: 'uid-a', session: SESSION });
  assert.equal(await service.completeEnd(), false, 'completion must identify its acknowledged session');
  const newer = { ...SESSION, sessionId: `sess_v1_${'c'.repeat(32)}` };
  await service.persistSession(newer);
  assert.equal(await service.completeEnd({ expectedSessionId: SESSION.sessionId }), false);
  assert.equal((await service.readSession()).sessionId, newer.sessionId);
  await service.persistPendingEnd({ authUid: 'uid-a', session: newer });
  assert.equal(await service.completeEnd({ expectedSessionId: SESSION.sessionId }), false);
  assert.equal((await service.readPendingEnd()).sessionId, newer.sessionId);
  assert.equal(await service.completeEnd({ expectedSessionId: newer.sessionId }), true);
  assert.equal(await service.readPendingEnd(), null);
  assert.equal(await service.readSession(), null);
});
const successfulEndResponse = () => ({ ok: true, status: 200,
  json: async () => ({ success: true, reason: 'ENDED' }) });
const controlledTimers = () => {
  const timers = new Map();
  return { timers,
    scheduleTimer: (callback, delay) => { const key = Symbol('deadline'); timers.set(key, { callback, delay }); return key; },
    cancelTimer: (key) => timers.delete(key),
    expire: () => {
      assert.equal(timers.size, 1);
      [...timers.values()][0].callback();
    },
  };
};

test('stalled logout times out, retries its exact durable marker and cannot complete a later role logout', async () => {
  const storage = memoryStorage();
  const clock = controlledTimers();
  const oldFetch = deferred();
  const newFetch = deferred();
  const requests = [];
  const service = createAppSessionService({ storage, now: () => 2_000, ...clock,
    getFirebase: () => ({ auth: { currentUser: { uid: 'uid-a', getIdToken: async () => 'id-token' } } }),
    fetchFn: async (_url, options) => {
      requests.push(options);
      if (requests.length === 1) return oldFetch.promise;
      if (requests.length === 2) return successfulEndResponse();
      return newFetch.promise;
    },
  });
  const first = service.endSession({ authUid: 'uid-a', session: SESSION });
  await flushMicrotasks();
  assert.equal(requests.length, 1);
  assert.equal([...clock.timers.values()][0].delay, 15_000);
  clock.expire();
  const timedOut = await first;
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.reason, 'NETWORK_ERROR');
  assert.equal(requests[0].signal.aborted, true);
  const pending = await service.readPendingEnd();
  assert.deepEqual(pending, { authUid: 'uid-a', sessionId: SESSION.sessionId, tourId: SESSION.tourId,
    principalType: 'passenger', requestedAtMs: 2_000, attemptCount: 1 });
  assert.equal(clock.timers.size, 0);

  const retry = await service.retryPendingEnd();
  assert.equal(retry.success, true);
  assert.equal(retry.pending.sessionId, SESSION.sessionId);
  assert.equal(retry.pending.attemptCount, 2);
  await service.completeEnd({ expectedSessionId: SESSION.sessionId });
  const driverSession = { ...SESSION, sessionId: `sess_v1_${'d'.repeat(32)}`,
    principalId: 'driver:D-SYNTHETIC', principalType: 'driver', driverId: 'D-SYNTHETIC' };
  await service.persistSession(driverSession);
  let laterCompleted = false;
  const later = service.endSession({ authUid: 'uid-a', session: driverSession })
    .then((result) => { laterCompleted = true; return result; });
  await flushMicrotasks();
  assert.equal(requests.length, 3);
  oldFetch.resolve(successfulEndResponse()); // Simulates a native fetch ignoring abort.
  await flushMicrotasks();
  assert.equal(laterCompleted, false);
  assert.equal((await service.readPendingEnd()).sessionId, driverSession.sessionId);
  assert.equal((await service.readSession()).sessionId, driverSession.sessionId);
  assert.equal(JSON.parse(requests[2].body).expectedSessionId, driverSession.sessionId);
  newFetch.resolve(successfulEndResponse());
  assert.equal((await later).success, true);
  assert.equal(clock.timers.size, 0);
  await service.completeEnd({ expectedSessionId: driverSession.sessionId });
});

test('logout deadline includes stalled Auth and App Check token preparation without late network requests', async () => {
  for (const stage of ['auth', 'appcheck']) {
    const storage = memoryStorage();
    const clock = controlledTimers();
    const token = deferred();
    let fetches = 0;
    let prepareStalls = true;
    const service = createAppSessionService({ storage, now: () => 2_000, ...clock,
      getFirebase: () => ({
        auth: { currentUser: { uid: 'uid-a', getIdToken: async () => stage === 'auth' && prepareStalls ? token.promise : 'id-token' } },
        getCurrentAppCheckToken: async () => stage === 'appcheck' && prepareStalls ? token.promise : 'app-check-token',
      }),
      fetchFn: async () => { fetches += 1; return successfulEndResponse(); },
    });
    const request = service.endSession({ authUid: 'uid-a', session: SESSION });
    await flushMicrotasks();
    assert.equal(fetches, 0, stage);
    clock.expire();
    assert.equal((await request).reason, 'NETWORK_ERROR', stage);
    assert.equal((await service.readPendingEnd()).sessionId, SESSION.sessionId, stage);
    prepareStalls = false;
    assert.equal((await service.retryPendingEnd()).success, true, stage);
    assert.equal(fetches, 1, stage);
    const markerAfterRetry = storage.values.get(PENDING_SESSION_END_KEY);
    token.resolve('late-token');
    await flushMicrotasks();
    assert.equal(fetches, 1, stage);
    assert.equal(storage.values.get(PENDING_SESSION_END_KEY), markerAfterRetry, stage);
    assert.equal(clock.timers.size, 0, stage);
    await service.completeEnd({ expectedSessionId: SESSION.sessionId });
  }
});

test('logout deadline also bounds a stalled response body and releases its timer on ordinary failures', async () => {
  const storage = memoryStorage();
  const clock = controlledTimers();
  const body = deferred();
  let stallBody = true;
  const service = createAppSessionService({ storage, now: () => 2_000, ...clock,
    getFirebase: () => ({ auth: { currentUser: { uid: 'uid-a', getIdToken: async () => 'id-token' } } }),
    fetchFn: async () => {
      if (!stallBody) throw new Error('Synthetic connection failure');
      return { ok: true, status: 200, json: () => body.promise };
    },
  });
  const request = service.endSession({ authUid: 'uid-a', session: SESSION });
  await flushMicrotasks();
  clock.expire();
  assert.equal((await request).reason, 'NETWORK_ERROR');
  assert.equal(clock.timers.size, 0);
  stallBody = false;
  assert.equal((await service.retryPendingEnd()).reason, 'NETWORK_ERROR');
  assert.equal(clock.timers.size, 0);
  body.resolve({ success: true });
  await flushMicrotasks();
  assert.equal((await service.readPendingEnd()).attemptCount, 2);
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

const expiryHarness = () => {
  let nowMs = 2_000;
  let remoteListener;
  let foreground;
  let foregroundRemoved = false;
  const timers = new Map();
  const revoked = [];
  const service = createAppSessionService({
    now: () => nowMs,
    scheduleTimer: (callback, delay) => { const key = Symbol('timer'); timers.set(key, { callback, delay }); return key; },
    cancelTimer: (key) => timers.delete(key),
    getFirebase: () => ({ realtimeDb: { ref: () => ({
      on: (_event, callback) => { remoteListener = callback; }, off() {},
    }) } }),
  });
  const unsubscribe = service.subscribe({ authUid: 'uid-a', expectedSession: SESSION,
    onRevoked: (event) => revoked.push(event),
    subscribeToForeground: (callback) => { foreground = callback; return () => { foregroundRemoved = true; }; },
  });
  return { timers, revoked, unsubscribe, setNow: (value) => { nowMs = value; },
    foreground: () => foreground(), remote: (value) => remoteListener({ val: () => value }),
    foregroundRemoved: () => foregroundRemoved };
};

test('session expiry closes an offline open session without waiting for a remote database event', () => {
  const harness = expiryHarness();
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, 18_000);
  harness.setNow(20_000);
  timer.callback();
  assert.deepEqual(harness.revoked, [{ reason: 'SESSION_EXPIRED' }]);
  harness.remote(null);
  harness.foreground();
  assert.equal(harness.revoked.length, 1);
  assert.equal(harness.timers.size, 0);
  harness.unsubscribe();
});

test('foreground immediately checks an expired session after suspended timers', () => {
  const harness = expiryHarness();
  harness.setNow(21_000);
  harness.foreground();
  assert.deepEqual(harness.revoked, [{ reason: 'SESSION_EXPIRED' }]);
  assert.equal(harness.timers.size, 0);
  harness.unsubscribe();
  assert.equal(harness.foregroundRemoved(), true);
});

test('foreground before expiry replaces its timer without duplicate expiry callbacks', () => {
  const harness = expiryHarness();
  harness.setNow(10_000);
  harness.foreground();
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, 10_000);
  assert.deepEqual(harness.revoked, []);
  harness.unsubscribe();
  assert.equal(harness.timers.size, 0);
  harness.setNow(21_000);
  harness.foreground();
  assert.deepEqual(harness.revoked, []);
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
