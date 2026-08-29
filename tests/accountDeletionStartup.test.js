const test = require('node:test');
const assert = require('node:assert/strict');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const { runInitializeApp } = require('../src/app/session/sessionBootstrapRunners');
const { runPurgePendingAccountDeletion } = require('../src/app/session/accountDeletionRunners');

const PENDING = {
  state: 'pending',
  phase: 'chat_scrub',
  retryable: true,
  localCleanupComplete: false,
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

test('accepted deletion purges local scope before replacing Auth and marks durable cleanup', async () => {
  const calls = [];
  const pending = { ...PENDING };
  const result = await runPurgePendingAccountDeletion({
    SESSION_KEYS: { TOUR_DATA: 'tour', BOOKING_DATA: 'booking' },
    SessionStorage: {
      multiGet: async () => [
        ['tour', JSON.stringify({ id: 'tour-1' })],
        ['booking', JSON.stringify({ id: 'booking-1' })],
      ],
    },
    accountDeletionService: {
      readPending: async () => pending,
      markLocalCleanupComplete: async () => { calls.push('marked'); return { ...pending, localCleanupComplete: true }; },
    },
    appSessionService: {
      readSession: async () => ({
        sessionId: 'session', authUid: 'old-auth', principalType: 'passenger',
        principalId: 'pax', tourId: 'tour-1',
      }),
      completeEnd: async () => { calls.push('session-cleared'); },
    },
    auth: { currentUser: { uid: 'fresh-recovery-auth' } },
    authHelpers: { replaceWithFreshAnonymous: async () => { calls.push('fresh-auth'); return { uid: 'fresh-auth' }; } },
    localSessionCleanupService: {
      cleanup: async (scope) => { calls.push(['cleanup', scope]); return { success: true }; },
    },
    setAppSession: (value) => calls.push(['app-session', value]),
    setUser: (value) => calls.push(['user', value.uid]),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0][0], 'cleanup');
  assert.equal(calls[0][1].authUid, 'old-auth');
  assert.ok(calls.indexOf('marked') < calls.indexOf('fresh-auth'));
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
    auth: { currentUser: { uid: 'old-auth' } },
    authHelpers: { replaceWithFreshAnonymous: async () => { replaced = true; } },
    localSessionCleanupService: { cleanup: async () => ({ success: false, failures: [{ name: 'cache' }] }) },
    setAppSession: () => {},
    setUser: () => {},
  });
  assert.equal(result.success, false);
  assert.equal(marked, false);
  assert.equal(replaced, false);
});
