const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-account-deletion';

const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (request.endsWith('/firebase') || request === '../firebase') {
    return {
      auth: { currentUser: null },
      authHelpers: {},
      getCurrentAppCheckToken: async () => null,
    };
  }
  if (request.endsWith('/persistenceProvider') || request === './persistenceProvider') {
    return { createPersistenceProvider: () => makeStorage() };
  }
  return originalLoad(request, parent, isMain);
};

const serviceModule = require('../services/accountDeletionService');
Module._load = originalLoad;

const {
  ACCOUNT_DELETION_PENDING_KEY,
  createAccountDeletionService,
  generateDeletionReceipt,
  validateAccountDeletionResponse,
  validatePendingAccountDeletion,
} = serviceModule;

const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;
const RECEIPT = `delrec_v1_${'b'.repeat(64)}`;

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const events = [];
  return {
    events,
    values,
    async setItemAsync(key, value) { events.push(['set', key, value]); values.set(key, value); },
    async getItemAsync(key) { events.push(['get', key]); return values.get(key) ?? null; },
    async deleteItemAsync(key) { events.push(['delete', key]); values.delete(key); },
  };
}

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const firebaseBoundary = ({ currentUser, replaceWithFreshAnonymous } = {}) => ({
  auth: { currentUser: currentUser || { uid: 'auth-old', getIdToken: async () => 'token-old' } },
  authHelpers: { replaceWithFreshAnonymous },
  getCurrentAppCheckToken: async () => null,
});

test('receipt uses 32 CSPRNG bytes and a typed 256-bit representation', () => {
  const calls = [];
  const deletionReceipt = generateDeletionReceipt({
    cryptoObject: {
      getRandomValues(bytes) {
        calls.push(bytes.length);
        bytes.forEach((_, index) => { bytes[index] = index; });
        return bytes;
      },
    },
  });
  assert.deepEqual(calls, [32]);
  assert.match(deletionReceipt, /^delrec_v1_[a-f0-9]{64}$/u);
  assert.equal(deletionReceipt.slice('delrec_v1_'.length, 'delrec_v1_'.length + 8), '00010203');
});

test('request persists its receipt before networking and sends no deletion scope', async () => {
  const storage = makeStorage();
  const events = storage.events;
  const api = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => RECEIPT,
    now: () => 100,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async (_url, options) => {
      events.push(['fetch', JSON.parse(options.body)]);
      assert.equal(storage.values.has(ACCOUNT_DELETION_PENDING_KEY), true);
      return response(202, { success: true, status: 'accepted', phase: 'reserved', retryable: true });
    },
  });

  const result = await api.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(result.success, true);
  const body = events.find(([kind]) => kind === 'fetch')[1];
  assert.deepEqual(body, { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT });
  assert.ok(events.findIndex(([kind]) => kind === 'set') < events.findIndex(([kind]) => kind === 'fetch'));
  const pending = await api.readPending();
  assert.equal(pending.schemaVersion, 2);
  assert.equal(pending.originalAuthUid, 'auth-old');
  assert.equal(pending.state, 'accepted');
  assert.equal(Object.prototype.hasOwnProperty.call(pending, 'expectedSessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'originalAuthUid'), false);
});

test('request fails closed before persistence or networking without one valid original Auth UID', async () => {
  for (const uid of [null, '', 'contains/slash', 'x'.repeat(129)]) {
    const storage = makeStorage();
    let fetchCalls = 0;
    const api = createAccountDeletionService({
      persistence: storage,
      generateReceipt: () => RECEIPT,
      getFirebase: () => ({
        auth: { currentUser: uid == null ? null : { uid, getIdToken: async () => 'token' } },
        authHelpers: {},
        getCurrentAppCheckToken: async () => null,
      }),
      fetchFn: async () => { fetchCalls += 1; return response(500, {}); },
    });
    const result = await api.requestDeletion({ expectedSessionId: SESSION_ID });
    assert.equal(result.reason, 'AUTH_UNAVAILABLE', String(uid));
    assert.equal(storage.values.has(ACCOUNT_DELETION_PENDING_KEY), false, String(uid));
    assert.equal(fetchCalls, 0, String(uid));
  }
});

test('request refuses an Auth identity change after durable recovery state is written', async () => {
  const storage = makeStorage();
  let currentUser = { uid: 'auth-old', getIdToken: async () => 'token-old' };
  let fetchCalls = 0;
  const api = createAccountDeletionService({
    persistence: {
      ...storage,
      async setItemAsync(key, value) {
        await storage.setItemAsync(key, value);
        currentUser = { uid: 'auth-replacement', getIdToken: async () => 'token-replacement' };
      },
    },
    generateReceipt: () => RECEIPT,
    getFirebase: () => firebaseBoundary({ currentUser }),
    fetchFn: async () => { fetchCalls += 1; return response(500, {}); },
  });
  const result = await api.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(result.reason, 'AUTH_UNAVAILABLE');
  assert.equal(fetchCalls, 0);
  assert.equal((await api.readPending()).originalAuthUid, 'auth-old');
});

test('transport failure and service recreation reuse the same persisted receipt', async () => {
  const storage = makeStorage();
  const bodies = [];
  const first = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => RECEIPT,
    now: () => 100,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async (_url, options) => { bodies.push(JSON.parse(options.body)); throw new Error('offline'); },
  });
  const failed = await first.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(failed.reason, 'NETWORK_ERROR');

  const restarted = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => { throw new Error('must not regenerate'); },
    now: () => 200,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (url.includes('getAccountDeletionStatus')) {
        return response(404, { success: false, reason: 'ACCOUNT_DELETION_STATUS_UNAVAILABLE' });
      }
      return response(202, { success: true, status: 'accepted', phase: 'reserved', retryable: true });
    },
  });
  const accepted = await restarted.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(accepted.success, true);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].deletionReceipt, RECEIPT);
  assert.deepEqual(bodies[1], { deletionReceipt: RECEIPT });
  assert.equal(bodies[2].deletionReceipt, RECEIPT);
});

test('lost accepted response recovers requesting state by receipt after Auth replacement', async () => {
  const storage = makeStorage();
  let backendAccepted = false;
  const endpoints = [];
  const beforeRestart = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => RECEIPT,
    now: () => 100,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async (url) => {
      endpoints.push(url);
      backendAccepted = true;
      throw new Error('accepted response was lost');
    },
  });
  const lost = await beforeRestart.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(lost.reason, 'NETWORK_ERROR');
  assert.equal((await beforeRestart.readPending()).state, 'requesting');

  const staleReplacement = { uid: 'replacement-auth', getIdToken: async () => 'stale-token' };
  const freshReplacement = { uid: 'fresh-recovery-auth', getIdToken: async () => 'fresh-token' };
  let currentUser = staleReplacement;
  let replacements = 0;
  let statusCalls = 0;
  const restarted = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => { throw new Error('must not generate a second receipt'); },
    now: () => 200,
    getFirebase: () => firebaseBoundary({
      currentUser,
      replaceWithFreshAnonymous: async () => {
        replacements += 1;
        currentUser = freshReplacement;
        return freshReplacement;
      },
    }),
    fetchFn: async (url, options) => {
      endpoints.push(url);
      assert.equal(url.includes('getAccountDeletionStatus'), true);
      assert.deepEqual(JSON.parse(options.body), { deletionReceipt: RECEIPT });
      statusCalls += 1;
      if (statusCalls === 1) return response(401, { success: false, reason: 'INVALID_CREDENTIALS' });
      assert.equal(backendAccepted, true);
      return response(200, { success: true, status: 'pending', phase: 'chat_scrub', retryable: true });
    },
  });

  const recovered = await restarted.requestDeletion({ expectedSessionId: SESSION_ID });
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.pending.deletionReceipt, RECEIPT);
  assert.equal(replacements, 1);
  assert.equal(endpoints.filter((url) => url.includes('requestAccountDeletion')).length, 1);
  assert.equal(endpoints.filter((url) => url.includes('getAccountDeletionStatus')).length, 2);
});

test('requesting status not-found retries the reservation only for the original Auth UID', async () => {
  const originalPending = {
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: 'auth-old',
    state: 'requesting',
    expectedSessionId: SESSION_ID,
    createdAtMs: 100,
    updatedAtMs: 100,
    requestAttempts: 1,
    statusAttempts: 0,
    localCleanupComplete: false,
    completionHandled: false,
  };
  const originalStorage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify(originalPending) });
  const originalEndpoints = [];
  const originalApi = createAccountDeletionService({
    persistence: originalStorage,
    now: () => 200,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async (url, options) => {
      originalEndpoints.push({ url, body: JSON.parse(options.body) });
      return url.includes('getAccountDeletionStatus')
        ? response(404, { success: false, reason: 'ACCOUNT_DELETION_STATUS_UNAVAILABLE' })
        : response(202, { success: true, status: 'accepted', phase: 'reserved', retryable: true });
    },
  });
  const retried = await originalApi.pollStatus();
  assert.equal(retried.status, 'accepted');
  assert.equal(originalEndpoints.length, 2);
  assert.deepEqual(originalEndpoints[0].body, { deletionReceipt: RECEIPT });
  assert.deepEqual(originalEndpoints[1].body, { expectedSessionId: SESSION_ID, deletionReceipt: RECEIPT });
  assert.equal(retried.pending.requestAttempts, 2);

  const changedStorage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify(originalPending) });
  const changedEndpoints = [];
  const changedApi = createAccountDeletionService({
    persistence: changedStorage,
    now: () => 300,
    getFirebase: () => firebaseBoundary({
      currentUser: { uid: 'changed-auth', getIdToken: async () => 'changed-token' },
    }),
    fetchFn: async (url, options) => {
      changedEndpoints.push({ url, body: JSON.parse(options.body) });
      return response(404, { success: false, reason: 'ACCOUNT_DELETION_STATUS_UNAVAILABLE' });
    },
  });
  const fenced = await changedApi.retryDeletion();
  assert.equal(fenced.success, false);
  assert.equal(fenced.reason, 'ACCOUNT_DELETION_STATUS_UNAVAILABLE');
  assert.equal(fenced.pending.state, 'requesting');
  assert.equal(fenced.pending.deletionReceipt, RECEIPT);
  assert.equal(fenced.pending.requestAttempts, 1);
  assert.equal(changedEndpoints.length, 1);
  assert.equal(changedEndpoints[0].url.includes('getAccountDeletionStatus'), true);
  assert.deepEqual(changedEndpoints[0].body, { deletionReceipt: RECEIPT });

  const opaqueStorage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify(originalPending) });
  let opaqueCalls = 0;
  const opaqueApi = createAccountDeletionService({
    persistence: opaqueStorage,
    now: () => 350,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async () => {
      opaqueCalls += 1;
      return response(404, {});
    },
  });
  const opaque = await opaqueApi.pollStatus();
  assert.equal(opaque.reason, 'ACCOUNT_DELETION_STATUS_UNAVAILABLE');
  assert.equal(opaque.pending.state, 'requesting');
  assert.equal(opaque.pending.requestAttempts, 1);
  assert.equal(opaqueCalls, 1, 'an opaque 404 is not proof that the receipt is absent');
});

test('requesting reconciliation preserves its receipt across network, Auth and service failures', async () => {
  const basePending = {
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: 'auth-old',
    state: 'requesting',
    expectedSessionId: SESSION_ID,
    createdAtMs: 100,
    updatedAtMs: 100,
    requestAttempts: 1,
    statusAttempts: 0,
    localCleanupComplete: false,
    completionHandled: false,
  };
  const cases = [
    {
      name: 'network',
      getFirebase: () => firebaseBoundary(),
      fetchFn: async () => { throw new Error('offline'); },
      reason: 'NETWORK_ERROR',
    },
    {
      name: 'auth',
      getFirebase: () => ({
        auth: { currentUser: null },
        authHelpers: { replaceWithFreshAnonymous: async () => null },
        getCurrentAppCheckToken: async () => null,
      }),
      fetchFn: async () => { throw new Error('must not call'); },
      reason: 'AUTH_UNAVAILABLE',
    },
    {
      name: 'service',
      getFirebase: () => firebaseBoundary(),
      fetchFn: async () => response(503, {
        success: false,
        reason: 'ACCOUNT_DELETION_TEMPORARILY_UNAVAILABLE',
      }),
      reason: 'ACCOUNT_DELETION_TEMPORARILY_UNAVAILABLE',
    },
  ];
  for (const failureCase of cases) {
    const storage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify(basePending) });
    const api = createAccountDeletionService({
      persistence: storage,
      generateReceipt: () => { throw new Error('must not generate a replacement receipt'); },
      now: () => 400,
      getFirebase: failureCase.getFirebase,
      fetchFn: failureCase.fetchFn,
    });
    const result = await api.pollStatus();
    assert.equal(result.reason, failureCase.reason, failureCase.name);
    assert.equal(result.pending.state, 'requesting', failureCase.name);
    assert.equal(result.pending.deletionReceipt, RECEIPT, failureCase.name);
    assert.equal(result.pending.requestAttempts, 1, failureCase.name);
  }
});

test('concurrent request taps share one reservation request', async () => {
  const storage = makeStorage();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => RECEIPT,
    now: () => 100,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async () => {
      calls += 1;
      await gate;
      return response(202, { success: true, status: 'accepted', phase: 'reserved', retryable: true });
    },
  });
  const first = api.requestDeletion({ expectedSessionId: SESSION_ID });
  const second = api.requestDeletion({ expectedSessionId: SESSION_ID });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('status polling during the first reservation shares the in-flight request', async () => {
  const storage = makeStorage();
  let calls = 0;
  let enteredFetch;
  let releaseFetch;
  const fetchEntered = new Promise((resolve) => { enteredFetch = resolve; });
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const api = createAccountDeletionService({
    persistence: storage,
    generateReceipt: () => RECEIPT,
    now: () => 100,
    getFirebase: () => firebaseBoundary(),
    fetchFn: async () => {
      calls += 1;
      enteredFetch();
      await fetchGate;
      return response(202, { success: true, status: 'accepted', phase: 'reserved', retryable: true });
    },
  });
  const request = api.requestDeletion({ expectedSessionId: SESSION_ID });
  await fetchEntered;
  const status = api.pollStatus();
  releaseFetch();
  assert.deepEqual(await request, await status);
  assert.equal(calls, 1);
});

test('status replaces a deleted original Auth identity and remains receipt-only', async () => {
  const pending = {
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: 'auth-old',
    state: 'accepted',
    phase: 'auth_delete',
    retryable: true,
    createdAtMs: 100,
    updatedAtMs: 100,
    requestAttempts: 1,
    statusAttempts: 0,
    localCleanupComplete: true,
    completionHandled: false,
  };
  const storage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify(pending) });
  const oldUser = { uid: 'old', getIdToken: async () => 'stale-token' };
  const freshUser = { uid: 'fresh', getIdToken: async () => 'fresh-token' };
  let currentUser = oldUser;
  let replacements = 0;
  const bodies = [];
  const api = createAccountDeletionService({
    persistence: storage,
    now: () => 200,
    getFirebase: () => firebaseBoundary({
      currentUser,
      replaceWithFreshAnonymous: async () => { replacements += 1; currentUser = freshUser; return freshUser; },
    }),
    fetchFn: async (_url, options) => {
      bodies.push({ authorization: options.headers.Authorization, body: JSON.parse(options.body) });
      if (bodies.length === 1) return response(401, { reason: 'INVALID_CREDENTIALS' });
      return response(200, {
        success: true,
        status: 'completed',
        phase: 'completed',
        retryable: false,
        completedAtMs: 199,
        summary: {
          recordsRemoved: 4,
          storageObjectsRemoved: 3,
          chatMessagesScrubbed: 2,
          reactionsRemoved: 1,
        },
      });
    },
  });

  const result = await api.pollStatus();
  assert.equal(result.status, 'completed');
  assert.equal(replacements, 1);
  assert.deepEqual(bodies.map(({ body }) => body), [
    { deletionReceipt: RECEIPT },
    { deletionReceipt: RECEIPT },
  ]);
  assert.equal(bodies[1].authorization, 'Bearer fresh-token');
});

test('receipt is cleared only by the explicit post-cleanup completion step', async () => {
  const storage = makeStorage();
  const api = createAccountDeletionService({ persistence: storage, getFirebase: () => firebaseBoundary() });
  const record = {
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: 'auth-old',
    state: 'completed',
    phase: 'completed',
    retryable: false,
    createdAtMs: 100,
    updatedAtMs: 200,
    requestAttempts: 1,
    statusAttempts: 1,
    localCleanupComplete: true,
    completionHandled: false,
    completedAtMs: 200,
  };
  await api.writePending(record);
  await api.markCompletionHandled();
  assert.deepEqual(
    { completionHandled: (await api.readPending()).completionHandled, originalAuthUid: (await api.readPending()).originalAuthUid },
    { completionHandled: true, originalAuthUid: 'auth-old' },
  );
  await api.clearPending();
  assert.equal(await api.readPending(), null);
});

test('strict boundaries reject unknown properties and malformed server progress', () => {
  const valid = {
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: 'auth-old',
    state: 'requesting',
    expectedSessionId: SESSION_ID,
    createdAtMs: 100,
    updatedAtMs: 100,
    requestAttempts: 0,
    statusAttempts: 0,
    localCleanupComplete: false,
    completionHandled: false,
  };
  assert.ok(validatePendingAccountDeletion(valid));
  assert.equal(validatePendingAccountDeletion({ ...valid, bookingRef: 'B123' }), null);
  assert.equal(validatePendingAccountDeletion({ ...valid, deletionReceipt: 'weak' }), null);
  assert.equal(validatePendingAccountDeletion({ ...valid, originalAuthUid: 'contains/slash' }), null);
  assert.equal(validatePendingAccountDeletion({ ...valid, originalAuthUid: 'x'.repeat(129) }), null);
  const { originalAuthUid: _missingOriginalAuthUid, ...missingOriginalAuthUid } = valid;
  assert.equal(validatePendingAccountDeletion(missingOriginalAuthUid), null);
  assert.equal(validatePendingAccountDeletion({ ...valid, schemaVersion: 1 }), null);
  assert.equal(validateAccountDeletionResponse({
    success: true, status: 'pending', phase: 'chat_scrub', retryable: true, authUid: 'secret',
  }), null);
  assert.equal(validateAccountDeletionResponse({
    success: true, status: 'completed', phase: 'auth_delete', retryable: false, completedAtMs: 200,
  }), null);
});

test('malformed persisted recovery state fails closed and is never silently cleared', async () => {
  const storage = makeStorage({ [ACCOUNT_DELETION_PENDING_KEY]: JSON.stringify({ deletionReceipt: 'weak' }) });
  const api = createAccountDeletionService({ persistence: storage, getFirebase: () => firebaseBoundary() });
  await assert.rejects(api.readPending(), { code: 'ACCOUNT_DELETION_RECOVERY_CORRUPT' });
  assert.equal(storage.values.has(ACCOUNT_DELETION_PENDING_KEY), true);
  assert.equal(storage.events.some(([kind]) => kind === 'delete'), false);
});

test('mobile account deletion source has no remote deletion-authority imports', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'services', 'accountDeletionService.js'),
    'utf8',
  );
  for (const forbidden of [
    'firebase/database',
    "from 'firebase/auth'",
    'photoService',
    'deleteNotificationDevice',
    'endSession(',
    'deleteUser(',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
