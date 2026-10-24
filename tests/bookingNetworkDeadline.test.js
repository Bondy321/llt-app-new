'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const clearBookingServiceCache = require('./helpers/clearBookingServiceCache');
const contextPath = path.resolve(__dirname, '../services/booking/bookingServiceContext.js');
const firebasePath = path.resolve(__dirname, '../firebase.js');
const servicePath = path.resolve(__dirname, '../services/bookingServiceRealtime.js');
const load = (auth, getCurrentAppCheckToken) => {
  const previousEnv = process.env.NODE_ENV;
  const previousFirebase = require.cache[firebasePath];
  clearBookingServiceCache(servicePath);
  process.env.NODE_ENV = 'development';
  require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
    exports: { auth, getCurrentAppCheckToken } };
  const service = require(contextPath);
  process.env.NODE_ENV = previousEnv;
  return { service, restore: () => {
    clearBookingServiceCache(servicePath);
    if (previousFirebase) require.cache[firebasePath] = previousFirebase;
    else delete require.cache[firebasePath];
  } };
};

test('stalled native attestation gives a bounded login decision and never returns late headers', async t => {
  let resolveToken;
  const pendingToken = new Promise(resolve => { resolveToken = resolve; });
  const { service, restore } = load({ currentUser: { getIdToken: async () => 'synthetic-auth' } }, () => pendingToken);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = service.getFirebaseAuthHeaderValue();
    t.mock.timers.tick(5001);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.reason, 'AUTH_TOKEN_FETCH_FAILED');
    resolveToken('late-synthetic-attestation');
    await Promise.resolve();
    assert.equal(result.token, undefined);
  } finally { t.mock.timers.reset(); restore(); }
});

test('same-UID replacement during token acquisition cannot reuse old headers', async () => {
  let release;
  const user = { uid: 'same-device', getIdToken: () => new Promise(resolve => { release = resolve; }) };
  const auth = { currentUser: user };
  const { service, restore } = load(auth, async () => 'synthetic-attestation');
  try {
    const pending = service.getFirebaseAuthHeaderValue();
    await Promise.resolve();
    auth.currentUser = { uid: 'same-device', getIdToken: async () => 'successor' };
    release('old-auth');
    assert.equal((await pending).reason, 'AUTH_USER_CHANGED');
  } finally { restore(); }
});

for (const phase of ['headers', 'body']) test(`booking HTTP ${phase} stall is bounded even when transport ignores abort`, async t => {
  const { service, restore } = load({ currentUser: null }, async () => null);
  const previousFetch = global.fetch;
  let release; let signal;
  const stalled = new Promise(resolve => { release = resolve; });
  global.fetch = async (_, options) => {
    signal = options.signal;
    return phase === 'headers' ? stalled : { ok: true, status: 200, json: () => stalled };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const outcome = assert.rejects(service.fetchJsonWithTimeout('https://example.invalid', {}, 1000), { name: 'AbortError' });
    await Promise.resolve();
    t.mock.timers.tick(1001);
    await outcome;
    assert.equal(signal.aborted, true);
    release(phase === 'headers' ? { json: async () => ({ valid: true }) } : { valid: true });
    await Promise.resolve();
  } finally { t.mock.timers.reset(); global.fetch = previousFetch; restore(); }
});

test('expired login budget dispatches no HTTP request', async () => {
  const { service, restore } = load({ currentUser: null }, async () => null);
  const previousFetch = global.fetch;
  global.fetch = () => { throw new Error('Expired request dispatched'); };
  try { await assert.rejects(service.fetchJsonWithTimeout('https://example.invalid', {}, 0), { name: 'AbortError' }); }
  finally { global.fetch = previousFetch; restore(); }
});

const { createTripApi } = require('../services/passenger-trip/tripApi');
for (const phase of ['token', 'appCheck', 'fetch', 'body']) test(`passenger snapshot ${phase} stall is bounded and late work cannot publish`, async () => {
  let release; let calls = 0;
  const stalled = new Promise(resolve => { release = resolve; });
  const user = { uid: 'trip-user', getIdToken: () => phase === 'token' ? stalled : Promise.resolve('auth') };
  const firebase = { auth: { currentUser: user }, getCurrentAppCheckToken: () => phase === 'appCheck' ? stalled : Promise.resolve('attestation') };
  const api = createTripApi({ getFirebase: () => firebase, endpoint: () => 'https://synthetic.invalid/trip', timeoutMs: 15,
    fetchFn: async () => { calls++; return phase === 'fetch' ? stalled : { ok: true, json: () => phase === 'body' ? stalled : Promise.resolve({ success: true }) }; } });
  await assert.rejects(api.request({ scope: { authUid: user.uid, sessionId: 'session' }, parts: [] }), { code: 'REQUEST_TIMEOUT' });
  const callsAtDeadline = calls;
  release(phase === 'fetch' ? { ok: true, json: async () => ({ success: true }) } : phase === 'body' ? { success: true } : 'late-token');
  await new Promise(setImmediate);
  assert.equal(calls, callsAtDeadline);
});
test('passenger snapshot rejects same-UID auth replacement before dispatch', async () => {
  let release; let calls = 0;
  const user = { uid: 'trip-user', getIdToken: () => new Promise(resolve => { release = resolve; }) };
  const firebase = { auth: { currentUser: user }, getCurrentAppCheckToken: async () => 'attestation' };
  const api = createTripApi({ getFirebase: () => firebase, endpoint: () => 'https://synthetic.invalid/trip', fetchFn: async () => { calls++; } });
  const request = api.request({ scope: { authUid: user.uid, sessionId: 'session' }, parts: [] });
  await Promise.resolve(); firebase.auth.currentUser = { ...user }; release('auth');
  await assert.rejects(request, /AUTH_UID_CHANGED/); assert.equal(calls, 0);
});
