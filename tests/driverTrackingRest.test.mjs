import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackingRestRepository } from '../services/driver-tracking/trackingRestRepository.js';

const SID = `sess_v1_${'a'.repeat(32)}`;
const path = `driver_location_sessions/${SID}|track_session_one`;
const intent = { schemaVersion: 1, startedAtMs: 1800000000000, liveSharingSessionId: 'track_session_one',
  scope: { authUid: 'test-driver', sessionId: SID, cacheOwnerId: 'D-TEST', tourId: 'TOUR_TEST', expiresAtMs: 1800003600000 } };
const harness = overrides => {
  const calls = []; const sdkCalls = [];
  const auth = { authStateReady: async () => {}, currentUser: { uid: 'test-driver', getIdToken: async () => 'synthetic-token' } };
  const database = { ref: target => ({ set: () => { throw Error('SDK must not queue GPS'); },
    once: async () => ({ val: () => 0 }), onDisconnect: () => ({ remove: async () => sdkCalls.push(target), cancel: async () => {} }) }) };
  const fetchFn = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ success: true, withdrawalAcknowledged: true }) }; };
  return { calls, sdkCalls, auth, repository: createTrackingRestRepository({ auth, database, fetchFn,
    baseUrl: 'https://synthetic.firebaseio.test', retireEndpoint: 'https://synthetic.functions.test/stopDriverTrackingSession',
    timeoutMs: 25, ...overrides }) };
};

test('GPS and fences use acknowledged HTTP writes; SDK is used only for disconnect cleanup/clock metadata', async () => {
  const h = harness();
  await h.repository.database.ref(path).onDisconnect().remove();
  await h.repository.database.ref(path).set({ authUid: 'test-driver', latitude: 56 });
  await h.repository.writeFence(intent, 'active');
  assert.equal(h.calls.length, 2); assert.equal(h.sdkCalls.length, 1);
  assert.equal(h.calls[0][1].method, 'PUT');
  assert.equal(new URL(h.calls[0][0]).pathname, `/${encodeURIComponent('driver_location_sessions')}/${encodeURIComponent(`${SID}|track_session_one`)}.json`);
  assert.equal(new URL(h.calls[0][0]).searchParams.get('auth'), 'synthetic-token');
  assert.equal(JSON.parse(h.calls[1][1].body).status, 'active');
  assert.throws(() => h.repository.database.ref('driver_locations/TOUR_TEST'), /INVALID_TRACKING_PATH/);
  assert.throws(() => h.repository.database.ref(`driver_location_sessions/${SID}|loc_old`), /INVALID_TRACKING_PATH/);
});

test('server retirement uses Bearer auth and exact intent, accepting only full stop acknowledgement', async () => {
  const h = harness(); const result = await h.repository.retireSession(intent);
  assert.equal(result.withdrawalAcknowledged, true);
  const [url, options] = h.calls[0]; assert.equal(url.includes('auth='), false);
  assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  const body = JSON.parse(options.body);
  assert.equal(body.status, 'stopped'); assert.equal(body.appSessionId, SID);
  assert.equal(Object.hasOwn(body, 'scope'), false); assert.equal(Object.hasOwn(body, 'latitude'), false);
  const partial = harness({ fetchFn: async () => ({ ok: true, json: async () => ({ success: true }) }) });
  await assert.rejects(() => partial.repository.retireSession(intent), /TRACKING_NETWORK_ERROR/);
});

test('authority changes during token retrieval prevent dispatch', async () => {
  const auth = { authStateReady: async () => {}, currentUser: { uid: 'test-driver', getIdToken: async () => {
    auth.currentUser = { uid: 'replacement-user' }; return 'old-token';
  } } };
  const h = harness({ auth }); await assert.rejects(() => h.repository.writeFence(intent, 'active'), /AUTH_UID_CHANGED/);
  assert.equal(h.calls.length, 0);
  const wrongUser = harness({ auth: { currentUser: { uid: 'wrong-user' } } });
  await assert.rejects(() => wrongUser.repository.retireSession(intent), /AUTH_UID_CHANGED/);
});

test('token, auth restoration, HTTP response, body parsing and SDK metadata waits are all bounded', async () => {
  const never = () => new Promise(() => {});
  const cases = [
    { auth: { authStateReady: never } },
    { auth: { currentUser: { uid: 'test-driver', getIdToken: never } } },
    { fetchFn: never },
    { fetchFn: async () => ({ ok: true, json: never }) },
  ];
  for (const overrides of cases) {
    const h = harness(overrides); const started = Date.now();
    await assert.rejects(() => h.repository.retireSession(intent), /TRACKING_NETWORK_ERROR/);
    assert.ok(Date.now() - started < 1000);
  }
  const h = harness({ database: { ref: () => ({ once: never, onDisconnect: () => ({ remove: never, cancel: never }) }) } });
  await assert.rejects(() => h.repository.database.ref('.info/serverTimeOffset').once('value'), /TRACKING_NETWORK_ERROR/);
  await assert.rejects(() => h.repository.database.ref(path).onDisconnect().remove(), /TRACKING_NETWORK_ERROR/);
  await assert.rejects(() => h.repository.database.ref(path).onDisconnect().cancel(), /TRACKING_NETWORK_ERROR/);
});

test('HTTP/network failures never leak tokens, URLs or payloads and never retry coordinates automatically', async () => {
  let count = 0;
  const h = harness({ fetchFn: async () => { count += 1; throw new Error('private https://synthetic.test?auth=synthetic-token latitude=56'); } });
  await assert.rejects(() => h.repository.database.ref(path).set({ authUid: 'test-driver', latitude: 56 }), error => {
    assert.equal(error.message, 'TRACKING_NETWORK_ERROR'); assert.doesNotMatch(String(error), /synthetic|latitude|auth=/); return true;
  });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(count, 1);
  const denied = harness({ fetchFn: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => denied.repository.database.ref(path).set({ authUid: 'test-driver' }), { code: 'PERMISSION_DENIED' });
});

test('database emulator namespace is retained when constructing authenticated REST path', async () => {
  const h = harness({ baseUrl: 'http://127.0.0.1:9000/?ns=demo-llt-tracking-service' });
  await h.repository.writeFence(intent, 'active');
  assert.equal(new URL(h.calls[0][0]).searchParams.get('ns'), 'demo-llt-tracking-service');
});

test('Stop or an expired sample during token retrieval prevents GPS and active fence dispatch', async () => {
  for (const fence of [false, true]) {
    let current = true;
    const auth = { currentUser: { uid: 'test-driver', getIdToken: async () => {
      current = false; return 'synthetic-token';
    } } };
    const h = harness({ auth });
    const operation = fence
      ? () => h.repository.writeFence(intent, 'active', () => current)
      : () => h.repository.withPublicationGuard(intent, () => current,
        () => h.repository.database.ref(path).set({ authUid: 'test-driver' }));
    await assert.rejects(operation, /START_INTERRUPTED/);
    assert.equal(h.calls.length, 0);
  }
});

test('auth restoration and token exceptions are sanitized before reaching UI or task logs', async () => {
  const privateFailure = async () => { throw Error('private https://synthetic.test?auth=synthetic-token'); };
  for (const auth of [{ authStateReady: privateFailure },
    { currentUser: { uid: 'test-driver', getIdToken: privateFailure } }]) {
    const h = harness({ auth });
    await assert.rejects(() => h.repository.writeFence(intent, 'active'), error => {
      assert.equal(error.message, 'TRACKING_NETWORK_ERROR');
      assert.doesNotMatch(String(error), /synthetic|auth=/); return true;
    });
    assert.equal(h.calls.length, 0);
  }
});
