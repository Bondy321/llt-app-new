import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackingRestRepository } from '../services/driver-tracking/trackingRestRepository.js';

const SID = `sess_v1_${'a'.repeat(32)}`;
const intent = { schemaVersion: 1, status: 'active', startedAtMs: 1800000000000, liveSharingSessionId: 'track_session_one',
  scope: { role: 'driver', principalId: 'driver:D-TEST', authUid: 'test-driver', sessionId: SID,
    cacheOwnerId: 'D-TEST', tourId: 'TOUR_TEST', expiresAtMs: 1800003600000 } };
const sample = () => ({ timestamp: intent.startedAtMs, coords: { latitude: 56, longitude: -4, accuracy: 12 } });
const harness = overrides => {
  const calls = []; const sdkCalls = [];
  const auth = { authStateReady: async () => {}, currentUser: { uid: 'test-driver', getIdToken: async () => 'synthetic-token' } };
  const database = { ref: target => { sdkCalls.push(target); throw Error('RTDB socket unavailable'); } };
  const fetchFn = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ success: true, withdrawalAcknowledged: true }) }; };
  return { calls, sdkCalls, auth, repository: createTrackingRestRepository({ auth, database, fetchFn,
    getAppCheckToken: async () => 'synthetic-app-check',
    baseUrl: 'https://synthetic.firebaseio.test', retireEndpoint: 'https://synthetic.functions.test/stopDriverTrackingSession',
    timeoutMs: 25, now: () => intent.startedAtMs, ...overrides }) };
};

test('GPS, authority reads, fences and retirement work with an entirely unavailable RTDB SDK', async () => {
  const h = harness();
  const result = await h.repository.publish(intent, sample());
  await h.repository.writeFence(intent, 'active');
  await h.repository.readCurrentSession('test-driver');
  await h.repository.retireSession(intent);
  assert.equal(h.calls.length, 4); assert.equal(h.sdkCalls.length, 0);
  for (const [, options] of h.calls) assert.equal(options.headers['X-Firebase-AppCheck'], 'synthetic-app-check');
  assert.equal(result.publicationAcknowledged, true);
  assert.equal(h.calls[0][1].method, 'PUT');
  assert.equal(new URL(h.calls[0][0]).pathname, `/${encodeURIComponent('driver_location_sessions')}/${encodeURIComponent(`${SID}|track_session_one`)}.json`);
  assert.equal(new URL(h.calls[0][0]).searchParams.get('auth'), 'synthetic-token');
  assert.equal(JSON.parse(h.calls[1][1].body).status, 'active');
  assert.equal(h.calls[2][1].method, 'GET');
  assert.equal(new URL(h.calls[2][0]).pathname, '/app_sessions/test-driver.json');
  assert.equal(Object.hasOwn(h.calls[2][1], 'body'), false);
  const payload = JSON.parse(h.calls[0][1].body);
  assert.deepEqual(payload.timestamp, { '.sv': 'timestamp' });
  assert.equal(payload.cleanupAtMs, intent.startedAtMs + 1800000);
  await assert.rejects(() => h.repository.readCurrentSession('../another-user'), /AUTH_UID_CHANGED/);
  await assert.rejects(() => h.repository.readCurrentSession('another-user'), /AUTH_UID_CHANGED/);
  assert.equal(h.calls.length, 4);
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

test('token, App Check, auth restoration, HTTP response and body parsing share one bounded deadline', async () => {
  const never = () => new Promise(() => {});
  const cases = [
    { auth: { authStateReady: never } },
    { auth: { currentUser: { uid: 'test-driver', getIdToken: never } } },
    { getAppCheckToken: never },
    { fetchFn: never },
    { fetchFn: async () => ({ ok: true, json: never }) },
  ];
  for (const overrides of cases) {
    const h = harness(overrides); const started = Date.now();
    await assert.rejects(() => h.repository.retireSession(intent), /TRACKING_NETWORK_ERROR/);
    assert.ok(Date.now() - started < 1000);
  }
  const h = harness({ fetchFn: async () => ({ ok: true, json: never }) });
  await assert.rejects(() => h.repository.readCurrentSession('test-driver'), /TRACKING_NETWORK_ERROR/);
});

test('HTTP/network failures never leak tokens, URLs or payloads and never retry coordinates automatically', async () => {
  let count = 0;
  const h = harness({ fetchFn: async () => { count += 1; throw new Error('private https://synthetic.test?auth=synthetic-token latitude=56'); } });
  await assert.rejects(() => h.repository.publish(intent, sample()), error => {
    assert.equal(error.message, 'TRACKING_NETWORK_ERROR'); assert.doesNotMatch(String(error), /synthetic|latitude|auth=/); return true;
  });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(count, 1);
  const denied = harness({ fetchFn: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => denied.repository.publish(intent, sample()), { code: 'PERMISSION_DENIED' });
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
      : () => h.repository.publish(intent, sample(), () => current);
    await assert.rejects(operation, /START_INTERRUPTED/);
    assert.equal(h.calls.length, 0);
  }
});

test('sample expiry during token wait and a late token after deadline never dispatch coordinates', async () => {
  let time = intent.startedAtMs;
  const expired = harness({ now: () => time, auth: { currentUser: { uid: 'test-driver', getIdToken: async () => {
    time += 90001; return 'synthetic-token';
  } } } });
  await assert.rejects(() => expired.repository.publish(intent, sample()), /START_INTERRUPTED/);
  assert.equal(expired.calls.length, 0);
  let finish;
  const late = harness({ auth: { currentUser: { uid: 'test-driver', getIdToken: () => new Promise(resolve => { finish = resolve; }) } } });
  await assert.rejects(() => late.repository.publish(intent, sample()), /TRACKING_NETWORK_ERROR/);
  finish('synthetic-token');
  await new Promise(setImmediate);
  assert.equal(late.calls.length, 0);
});

test('a response arriving after Stop cannot acknowledge an obsolete GPS publication', async () => {
  let current = true;
  const h = harness({ fetchFn: async () => { current = false; return { ok: true }; } });
  await assert.rejects(() => h.repository.publish(intent, sample(), () => current), /START_INTERRUPTED/);
});

test('an auth replacement during HTTP cannot acknowledge the former driver publication', async () => {
  const h = harness({ fetchFn: async () => { h.auth.currentUser = { uid: 'replacement' }; return { ok: true }; } });
  await assert.rejects(() => h.repository.publish(intent, sample()), /AUTH_UID_CHANGED/);
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
