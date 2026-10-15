const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
process.env.NODE_ENV = 'test';
require('@babel/register')({ extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request.endsWith('/notificationDeviceApiService')) return { endNotificationDeviceSession: async () => ({ success: true }) };
  return originalLoad(request, parent, isMain);
};
const { runHandleLogout, runPurgeLocalSession } = require('../src/app/session/logoutRunners');
const { createAppSessionService, PENDING_SESSION_END_KEY, APP_SESSION_KEY } = require('../services/appSessionService');
const { createLocalSessionCleanupService } = require('../services/localSessionCleanupService');
test.after(() => { Module._load = originalLoad; });

const session = { schemaVersion: 1, sessionId: `sess_v1_${'a'.repeat(32)}`, tourId: 'TOUR_A',
  principalId: `pax_v2_${'b'.repeat(32)}`, principalType: 'passenger', driverId: null,
  issuedAtMs: 1000, expiresAtMs: 20000, sessionRevision: 1 };
const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)); } };
};

test('session termination and notification logout never compete for their shared server lock', async () => {
  const events = [];
  let releaseEnd;
  const gate = new Promise(resolve => { releaseEnd = resolve; });
  const operation = runHandleLogout({ appSession: session, auth: { currentUser: { uid: 'phone-a' } },
    logger: { warn: () => {} }, logoutContextRef: { current: null }, setLogoutStatus: () => {},
    appSessionService: { endSession: async () => { events.push('end-start'); await gate; events.push('end-ack'); return { success: true }; },
      completeEnd: async () => { events.push('complete'); } },
    notificationDeviceEnd: async input => {
      assert.equal(input.appSessionId, session.sessionId);
      assert.deepEqual(events, ['end-start', 'end-ack']);
      events.push('notifications');
      throw new Error('Notification delivery temporarily unavailable');
    },
    purgeLocalSession: async () => { events.push('purge'); return { success: true }; } });
  await Promise.resolve();
  assert.deepEqual(events, ['end-start']);
  releaseEnd();
  await operation;
  assert.deepEqual(events, ['end-start', 'end-ack', 'notifications', 'purge', 'complete'],
    'a notification failure cannot override acknowledged session termination');
});

for (const failure of ['SESSION_IN_PROGRESS', 'NETWORK_ERROR']) {
  test(`actual logout cleanup preserves the exact retry operation after ${failure}`, async () => {
    const storage = memoryStorage();
    const requests = [];
    let reachable = false;
    const createSessionService = () => createAppSessionService({ storage, now: () => 2000,
      getFirebase: () => ({ auth: { currentUser: { uid: 'phone-a', getIdToken: async () => 'fixture-token' } } }),
      fetchFn: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (!reachable && failure === 'NETWORK_ERROR') throw new Error('offline');
        return { ok: reachable, status: reachable ? 200 : 409,
          json: async () => reachable ? { success: true, endedSessionId: session.sessionId }
            : { success: false, reason: failure } };
      } });
    const oldEndpoint = process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
    process.env.EXPO_PUBLIC_END_APP_SESSION_URL = 'https://example.invalid/end';
    const cleanup = createLocalSessionCleanupService({ storage,
      offline: { setActiveSessionScope: async () => {}, purgeTourPack: async () => ({ success: true }), purgeActionsForScope: async () => ({ success: true }) },
      driverLifecycle: { purge: async () => ({ success: true }) }, clearNotifications: async () => 0,
      photoCache: null, tripLifecycle: { stopPassengerTrip: () => {}, purgePassengerTrip: async () => {} } });
    const statuses = [];
    const service = createSessionService();
    const deps = { appSession: session, appSessionService: service, auth: { currentUser: { uid: 'phone-a' } },
      user: { uid: 'phone-a' }, bookingData: { id: 'BOOK_A', stablePassengerId: session.principalId }, tourData: { id: 'TOUR_A' },
      logger: { warn: () => {} }, logoutContextRef: { current: null }, setAppSession: () => {},
      setLogoutStatus: status => statuses.push(status),
      localSessionCleanupService: cleanup, clearSessionState: async () => {},
      setDriverSessionGeneration: () => {}, previousDriverOperationalScopeRef: { current: null }, driverLifecyclePurgeRef: { current: null } };
    deps.purgeLocalSession = options => runPurgeLocalSession(deps, options);
    try {
      await service.persistSession(session);
      await runHandleLogout(deps);
      assert.equal(statuses.at(-1).state, 'pending_network');
      assert.equal(storage.values.has(APP_SESSION_KEY), false, 'private local session is cleared');
      const pending = await service.readPendingEnd();
      assert.equal(pending?.sessionId, session.sessionId, 'unacknowledged logout survives local purge');
      assert.equal(pending.authUid, 'phone-a');
      reachable = true;
      const restarted = createSessionService();
      const result = await restarted.retryPendingEnd();
      assert.equal(result.success, true);
      assert.equal(requests.length, 2, 'restart really contacts the server instead of assuming success');
      assert.deepEqual(requests[1], requests[0]);
      await restarted.completeEnd({ expectedSessionId: session.sessionId });
      assert.equal(storage.values.has(PENDING_SESSION_END_KEY), false);
    } finally {
      if (oldEndpoint === undefined) delete process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
      else process.env.EXPO_PUBLIC_END_APP_SESSION_URL = oldEndpoint;
    }
  });
}
