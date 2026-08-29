const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-account-deletion-startup';

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const { runInitializeApp } = require('../src/app/session/sessionBootstrapRunners');
const { runPurgePendingAccountDeletion } = require('../src/app/session/accountDeletionRunners');
const { APP_SESSION_KEY, createAppSessionService } = require('../services/appSessionService');
const { createAccountDeletionService } = require('../services/accountDeletionService');

const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;
const PASSENGER_ID = `pax_v2_${'b'.repeat(32)}`;
const RECEIPT = `delrec_v1_${'c'.repeat(64)}`;
const ORIGINAL_AUTH_UID = 'original-auth-uid';

const createAppStorage = () => {
  const values = new Map();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
    multiGet: async (keys) => keys.map((key) => [key, values.get(key) ?? null]),
    multiRemove: async (keys) => { keys.forEach((key) => values.delete(key)); },
  };
};

const createDeletionPersistence = () => {
  const values = new Map();
  return {
    values,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  };
};

const PENDING = {
  state: 'pending',
  phase: 'chat_scrub',
  retryable: true,
  localCleanupComplete: false,
  originalAuthUid: ORIGINAL_AUTH_UID,
};

test('startup checks pending deletion before normal Auth/session restoration', async () => {
  const calls = [];
  const state = {};
  const unsubscribe = () => {};
  const result = await runInitializeApp({
    SESSION_KEYS: {},
    STARTUP_CONNECTION_ERROR_MESSAGE: 'offline',
    SessionStorage: {},
    accountDeletionService: { readPending: async () => { calls.push('pending'); return PENDING; } },
    appSessionService: {},
    authHelpers: {
      ensureAuthenticated: async () => { calls.push('auth'); return { uid: 'recovery' }; },
      onAuthStateChanged: () => unsubscribe,
    },
    authUnsubscribeRef: { current: null },
    handleAuthStateChange: () => {},
    hydrateIdentityBindingForCurrentUser: async () => { throw new Error('must not hydrate'); },
    localSessionCleanupService: {},
    logger: { error: () => {}, info: () => {}, setUserId: () => {} },
    maskIdentifier: (value) => value,
    recordCrashBreadcrumb: () => {},
    restoreSession: async () => { calls.push('restore'); },
    setAccountDeletionStatus: (value) => { state.deletion = value; },
    setAppSession: (value) => { state.session = value; },
    setAuthError: () => {},
    setDiagnosticsAuthUid: () => {},
    setInitializing: (value) => { state.initializing = value; },
    setLogoutStatus: () => {},
    setUser: (value) => { state.user = value; },
    toAccountDeletionUiState: (pending) => ({ state: pending.state, phase: pending.phase }),
  });

  assert.equal(result, unsubscribe);
  assert.deepEqual(calls, ['pending', 'auth']);
  assert.equal(state.deletion.state, 'pending');
  assert.equal(state.session, null);
  assert.equal(state.user.uid, 'recovery');
  assert.equal(state.initializing, false);
});

test('real persisted session projection uses the secure pending UID for cleanup and restart recovery', async () => {
  const calls = [];
  const appStorage = createAppStorage();
  const beforeRestartAppSessions = createAppSessionService({ storage: appStorage, now: () => 2_000 });
  await beforeRestartAppSessions.persistSession({
    schemaVersion: 1,
    sessionId: SESSION_ID,
    authUid: ORIGINAL_AUTH_UID,
    principalType: 'passenger',
    principalId: PASSENGER_ID,
    tourId: 'tour-1',
    status: 'active',
    issuedAtMs: 1_000,
    lastAuthenticatedAtMs: 1_000,
    expiresAtMs: 20_000,
    sessionRevision: 1,
  });
  const projectedBeforeRestart = await beforeRestartAppSessions.readSession({ allowExpired: true });
  assert.equal(Object.prototype.hasOwnProperty.call(projectedBeforeRestart, 'authUid'), false);
  assert.equal(JSON.parse(appStorage.values.get(APP_SESSION_KEY)).authUid, undefined);

  await appStorage.setItem('tour', JSON.stringify({ id: 'tour-1' }));
  await appStorage.setItem('booking', JSON.stringify({ id: 'booking-1' }));
  const deletionPersistence = createDeletionPersistence();
  const beforeRestartDeletion = createAccountDeletionService({
    persistence: deletionPersistence,
    now: () => 100,
  });
  await beforeRestartDeletion.writePending({
    schemaVersion: 2,
    deletionReceipt: RECEIPT,
    originalAuthUid: ORIGINAL_AUTH_UID,
    state: 'accepted',
    phase: 'reserved',
    retryable: true,
    createdAtMs: 100,
    updatedAtMs: 100,
    requestAttempts: 1,
    statusAttempts: 0,
    localCleanupComplete: false,
    completionHandled: false,
  });

  const appSessionService = createAppSessionService({ storage: appStorage, now: () => 2_000 });
  const accountDeletionService = createAccountDeletionService({
    persistence: deletionPersistence,
    now: () => 200,
    getFirebase: () => ({
      auth: { currentUser: { uid: 'replacement-anonymous-uid', getIdToken: async () => 'recovery-token' } },
      authHelpers: {},
      getCurrentAppCheckToken: async () => null,
    }),
    fetchFn: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { deletionReceipt: RECEIPT });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, status: 'pending', phase: 'live_state_cleanup', retryable: true }),
      };
    },
  });
  const result = await runPurgePendingAccountDeletion({
    SESSION_KEYS: { TOUR_DATA: 'tour', BOOKING_DATA: 'booking' },
    SessionStorage: appStorage,
    accountDeletionService,
    appSessionService,
    authHelpers: {
      replaceWithFreshAnonymous: async () => {
        assert.equal((await accountDeletionService.readPending()).localCleanupComplete, true);
        calls.push('fresh-auth');
        return { uid: 'fresh-auth' };
      },
    },
    localSessionCleanupService: {
      cleanup: async (scope) => {
        assert.equal((await accountDeletionService.readPending()).originalAuthUid, ORIGINAL_AUTH_UID);
        calls.push(['cleanup', scope]);
        return { success: true };
      },
    },
    setAppSession: (value) => calls.push(['app-session', value]),
    setUser: (value) => calls.push(['user', value.uid]),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0][0], 'cleanup');
  assert.equal(calls[0][1].authUid, ORIGINAL_AUTH_UID);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0][1].appSession, 'authUid'), false);
  assert.equal(calls.at(-1)[0], 'user');
  const afterCleanup = await accountDeletionService.readPending();
  assert.equal(afterCleanup.localCleanupComplete, true);
  assert.equal(afterCleanup.originalAuthUid, ORIGINAL_AUTH_UID);
  const status = await accountDeletionService.pollStatus();
  assert.equal(status.status, 'pending');
  assert.equal(status.pending.originalAuthUid, ORIGINAL_AUTH_UID);
});

test('missing or malformed pending original UID cannot select a cleanup scope', async () => {
  for (const originalAuthUid of [undefined, '', 'contains/slash', 'x'.repeat(129)]) {
    let cleanupCalled = false;
    const result = await runPurgePendingAccountDeletion({
      SESSION_KEYS: { TOUR_DATA: 'tour', BOOKING_DATA: 'booking' },
      SessionStorage: { multiGet: async () => [['tour', null], ['booking', null]] },
      accountDeletionService: { readPending: async () => ({ ...PENDING, originalAuthUid }) },
      appSessionService: { readSession: async () => null },
      authHelpers: { replaceWithFreshAnonymous: async () => ({ uid: 'must-not-run' }) },
      localSessionCleanupService: { cleanup: async () => { cleanupCalled = true; return { success: true }; } },
      setAppSession: () => {},
      setUser: () => {},
    });
    assert.equal(result.success, false, String(originalAuthUid));
    assert.equal(cleanupCalled, false, String(originalAuthUid));
  }
});

test('failed local purge retains pending recovery state and does not replace Auth', async () => {
  let marked = false;
  let replaced = false;
  const result = await runPurgePendingAccountDeletion({
    SESSION_KEYS: { TOUR_DATA: 'tour', BOOKING_DATA: 'booking' },
    SessionStorage: { multiGet: async () => [['tour', null], ['booking', null]] },
    accountDeletionService: {
      readPending: async () => PENDING,
      markLocalCleanupComplete: async () => { marked = true; },
    },
    appSessionService: { readSession: async () => null, completeEnd: async () => {} },
    authHelpers: { replaceWithFreshAnonymous: async () => { replaced = true; } },
    localSessionCleanupService: { cleanup: async () => ({ success: false, failures: [{ name: 'cache' }] }) },
    setAppSession: () => {},
    setUser: () => {},
  });
  assert.equal(result.success, false);
  assert.equal(marked, false);
  assert.equal(replaced, false);
});
