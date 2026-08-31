'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-account-deletion-mobile-adversarial';

const makePersistence = (initial = {}, { failDeleteCount = 0, failSet = null } = {}) => {
  const values = new Map(Object.entries(initial));
  const events = [];
  let remainingDeleteFailures = failDeleteCount;
  return {
    events,
    values,
    async setItemAsync(key, value) {
      events.push(['set', key, value]);
      if (failSet?.({ key, value })) throw new Error('injected secure pending write failure');
      values.set(key, value);
    },
    async getItemAsync(key) { events.push(['get', key]); return values.get(key) ?? null; },
    async deleteItemAsync(key) {
      events.push(['delete', key]);
      if (remainingDeleteFailures > 0) {
        remainingDeleteFailures -= 1;
        throw new Error('injected receipt clear failure');
      }
      values.delete(key);
    },
  };
};

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request.endsWith('/firebase') || request === '../firebase') {
    return {
      auth: { currentUser: null },
      authHelpers: {},
      getCurrentAppCheckToken: async () => null,
    };
  }
  if (request.endsWith('/persistenceProvider') || request === './persistenceProvider') {
    return { createPersistenceProvider: () => makePersistence() };
  }
  if (request === '@react-native-async-storage/async-storage') return { default: {} };
  if (parent?.filename?.endsWith('localSessionCleanupService.js') && request === './offlineSyncService') {
    return {};
  }
  if (parent?.filename?.endsWith('localSessionCleanupService.js')
    && request === './driverOperationalLifecycleService') return {};
  if (parent?.filename?.endsWith('localSessionCleanupService.js')
    && request === './notificationInboxService') return { clearNotificationFeedCache: async () => 0 };
  return originalLoad(request, parent, isMain);
};
const {
  ACCOUNT_DELETION_PENDING_KEY,
  createAccountDeletionService,
} = require('../services/accountDeletionService');
const {
  APP_LOCAL_KEYS,
  createLocalSessionCleanupService,
} = require('../services/localSessionCleanupService');
const {
  runPurgePendingAccountDeletion,
  toAccountDeletionUiState,
} = require('../src/app/session/accountDeletionRunners');
const {
  runHandleLoginSuccess,
  runResolveOfflineLogin,
} = require('../src/app/session/loginRunners');
const { runInitializeApp } = require('../src/app/session/sessionBootstrapRunners');
Module._load = originalLoad;

const SESSION_ID = `sess_v1_${'a'.repeat(32)}`;
const RECEIPT = `delrec_v1_${'b'.repeat(64)}`;
const ORIGINAL_AUTH_UID = 'original-auth-uid';
const TOUR_KEY = '@LLT:tourData';
const BOOKING_KEY = '@LLT:bookingData';
const APP_SESSION_KEY = '@LLT:appSession:v1';

const pendingRecord = (overrides = {}) => ({
  schemaVersion: 3,
  deletionReceipt: RECEIPT,
  originalAuthUid: ORIGINAL_AUTH_UID,
  state: 'accepted',
  phase: 'reserved',
  retryable: true,
  createdAtMs: 100,
  updatedAtMs: 100,
  requestAttempts: 1,
  statusAttempts: 0,
  localCleanupState: 'not_started',
  localCleanupComplete: false,
  completionHandled: false,
  ...overrides,
});

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const firebaseBoundary = () => ({
  auth: { currentUser: { uid: 'recovery-auth', getIdToken: async () => 'recovery-token' } },
  authHelpers: {},
  getCurrentAppCheckToken: async () => null,
});

const makeLocalStorage = (entries = {}) => {
  const values = new Map(Object.entries(entries));
  return {
    values,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
    async multiGet(keys) { return keys.map((key) => [key, values.get(key) ?? null]); },
    async multiRemove(keys) { keys.forEach((key) => values.delete(key)); },
  };
};

const makeCleanupRunner = ({ deletionService, localStorage, cleanupService }) => ({
  SESSION_KEYS: { TOUR_DATA: TOUR_KEY, BOOKING_DATA: BOOKING_KEY },
  SessionStorage: localStorage,
  accountDeletionService: deletionService,
  appSessionService: {
    readSession: async () => {
      const raw = localStorage.values.get(APP_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    },
    completeEnd: async () => { throw new Error('cleanup owns the final session-key commit'); },
  },
  authHelpers: { replaceWithFreshAnonymous: async () => ({ uid: 'fresh-recovery-auth' }) },
  localSessionCleanupService: cleanupService,
  setAppSession: () => {},
  setUser: () => {},
});

const makeCleanupDependencies = ({ storage, offlineOverrides = {}, driverLifecycle, beforeSessionKeyCommit } = {}) => ({
  storage,
  offline: {
    setActiveSessionScope: async () => ({ success: true }),
    purgeTourPack: async () => ({ success: true }),
    purgeActionsForScope: async () => ({ success: true }),
    ...offlineOverrides,
  },
  driverLifecycle: driverLifecycle || { purge: async () => ({ success: true }) },
  clearNotifications: async () => 0,
  photoCache: { clearPhotoViewerCache: async () => ({ success: true }) },
  beforeSessionKeyCommit,
});

const makeScopedLocalStorage = ({ appSession, bookingData, tourData }) => makeLocalStorage({
  ...Object.fromEntries(APP_LOCAL_KEYS.map((key) => [key, 'private-local-value'])),
  [APP_SESSION_KEY]: JSON.stringify(appSession),
  [BOOKING_KEY]: JSON.stringify(bookingData),
  [TOUR_KEY]: JSON.stringify(tourData),
});

test('the durable receipt survives the actual local purge while offline and notification caches are cleared', async () => {
  const recoveryPersistence = makePersistence();
  const deletionService = createAccountDeletionService({ persistence: recoveryPersistence });
  await deletionService.writePending(pendingRecord());

  const localValues = new Map(APP_LOCAL_KEYS.map((key) => [key, 'private-local-value']));
  const removedKeys = [];
  const storage = {
    async multiRemove(keys) {
      removedKeys.push(...keys);
      keys.forEach((key) => localValues.delete(key));
    },
    async removeItem(key) { removedKeys.push(key); localValues.delete(key); },
  };
  const calls = [];
  const cleanup = createLocalSessionCleanupService({
    storage,
    offline: {
      setActiveSessionScope: async (scope) => { calls.push(['offline-scope', scope]); },
      purgeTourPack: async (...args) => { calls.push(['tour-pack', ...args]); return { success: true }; },
      purgeActionsForScope: async (...args) => { calls.push(['offline-actions', ...args]); return { success: true }; },
    },
    driverLifecycle: { purge: async () => ({ success: true }) },
    clearNotifications: async ({ userId }) => { calls.push(['notification-cache', userId]); return 2; },
    photoCache: { clearPhotoViewerCache: async () => { calls.push(['photo-cache']); return { success: true }; } },
  });
  const result = await cleanup.cleanup({
    authUid: 'old-auth',
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_LOCAL',
    },
    bookingData: { id: 'BOOK_LOCAL', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_LOCAL' },
  });

  assert.equal(result.success, true);
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localValues.has(key), false, key));
  assert.deepEqual(calls[0], ['offline-scope', null]);
  assert.equal(calls.some(([kind]) => kind === 'offline-actions'), true);
  assert.equal(calls.some(([kind]) => kind === 'notification-cache'), true);
  assert.equal(calls.some(([kind]) => kind === 'photo-cache'), true);
  assert.equal(removedKeys.some((key) => key.includes(ACCOUNT_DELETION_PENDING_KEY)), false);
  assert.deepEqual(
    { deletionReceipt: (await deletionService.readPending()).deletionReceipt, originalAuthUid: (await deletionService.readPending()).originalAuthUid },
    { deletionReceipt: RECEIPT, originalAuthUid: ORIGINAL_AUTH_UID },
  );
});

test('passenger Tour Pack failure retains scope keys and recreation retries the exact scoped purge', async () => {
  const appSession = {
    sessionId: SESSION_ID,
    principalType: 'passenger',
    principalId: 'passenger-principal',
    tourId: 'TOUR_LOCAL',
  };
  const localStorage = makeScopedLocalStorage({
    appSession,
    bookingData: { id: 'BOOK_LOCAL', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_LOCAL' },
  });
  const deletionService = createAccountDeletionService({ persistence: makePersistence(), now: () => 200 });
  await deletionService.writePending(pendingRecord());
  const packs = new Set([
    'TOUR_LOCAL|passenger|BOOK_LOCAL',
    'TOUR_LOCAL|passenger|BOOK_OTHER',
  ]);
  const packScopes = [];
  let packAttempts = 0;
  const offlineOverrides = {
    purgeTourPack: async (tourId, role, { ownerId }) => {
      const key = `${tourId}|${role}|${ownerId}`;
      packScopes.push(key);
      packAttempts += 1;
      if (packAttempts === 1) return { success: false, error: 'injected Tour Pack failure' };
      packs.delete(key);
      return { success: true };
    },
  };

  const firstCleanup = createLocalSessionCleanupService(makeCleanupDependencies({
    storage: localStorage,
    offlineOverrides,
  }));
  const first = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: firstCleanup,
  }));
  assert.equal(first.success, false);
  assert.deepEqual(first.failures, [{ name: 'clearTourPack', error: 'injected Tour Pack failure' }]);
  assert.equal((await deletionService.readPending()).localCleanupComplete, false);
  assert.equal((await deletionService.readPending()).localCleanupState, 'not_started');
  [TOUR_KEY, BOOKING_KEY, APP_SESSION_KEY].forEach((key) => assert.equal(localStorage.values.has(key), true, key));
  assert.equal(packs.has('TOUR_LOCAL|passenger|BOOK_LOCAL'), true);

  const restartedCleanup = createLocalSessionCleanupService(makeCleanupDependencies({
    storage: localStorage,
    offlineOverrides,
  }));
  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: restartedCleanup,
  }));
  assert.equal(resumed.success, true);
  assert.deepEqual(packScopes, [
    'TOUR_LOCAL|passenger|BOOK_LOCAL',
    'TOUR_LOCAL|passenger|BOOK_LOCAL',
  ]);
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), false, key));
  assert.equal(packs.has('TOUR_LOCAL|passenger|BOOK_LOCAL'), false);
  assert.equal(packs.has('TOUR_LOCAL|passenger|BOOK_OTHER'), true, 'another principal must be preserved');
  assert.equal((await deletionService.readPending()).localCleanupComplete, true);
});

test('account-deletion cleanup rejects a mismatched persisted principal before touching local data', async () => {
  const localStorage = makeScopedLocalStorage({
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_LOCAL',
    },
    bookingData: { id: 'BOOK_LOCAL', stablePassengerId: 'different-principal' },
    tourData: { id: 'TOUR_LOCAL' },
  });
  let operationCalls = 0;
  const cleanup = createLocalSessionCleanupService(makeCleanupDependencies({
    storage: localStorage,
    offlineOverrides: {
      setActiveSessionScope: async () => { operationCalls += 1; },
      purgeTourPack: async () => { operationCalls += 1; return { success: true }; },
      purgeActionsForScope: async () => { operationCalls += 1; return { success: true }; },
    },
  }));
  const result = await cleanup.cleanup({
    authUid: ORIGINAL_AUTH_UID,
    appSession: JSON.parse(localStorage.values.get(APP_SESSION_KEY)),
    bookingData: JSON.parse(localStorage.values.get(BOOKING_KEY)),
    tourData: JSON.parse(localStorage.values.get(TOUR_KEY)),
    requireCompleteScope: true,
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.failures, [{ name: 'validateCleanupScope', error: 'LOCAL_CLEANUP_SCOPE_INCOMPLETE' }]);
  assert.equal(operationCalls, 0);
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), true, key));
});

test('scoped offline queue failure retains scope keys and recreation retries without purging another principal', async () => {
  const appSession = {
    sessionId: SESSION_ID,
    principalType: 'passenger',
    principalId: 'passenger-principal',
    tourId: 'TOUR_QUEUE',
  };
  const localStorage = makeScopedLocalStorage({
    appSession,
    bookingData: { id: 'BOOK_QUEUE', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_QUEUE' },
  });
  const deletionService = createAccountDeletionService({ persistence: makePersistence(), now: () => 300 });
  await deletionService.writePending(pendingRecord());
  const queues = new Set([
    'TOUR_QUEUE|passenger-principal|passenger|BOOK_QUEUE',
    'TOUR_QUEUE|passenger-other|passenger|BOOK_OTHER',
  ]);
  const queueScopes = [];
  let queueAttempts = 0;
  const offlineOverrides = {
    purgeActionsForScope: async ({ scope }) => {
      const key = `${scope.tourId}|${scope.principalId}|${scope.role}|${scope.cacheOwnerId}`;
      queueScopes.push({ ...scope });
      queueAttempts += 1;
      if (queueAttempts === 1) return { success: false, error: 'injected queue failure' };
      queues.delete(key);
      return { success: true };
    },
  };

  const first = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(first.success, false);
  assert.equal((await deletionService.readPending()).localCleanupComplete, false);
  assert.equal((await deletionService.readPending()).localCleanupState, 'not_started');
  [TOUR_KEY, BOOKING_KEY, APP_SESSION_KEY].forEach((key) => assert.equal(localStorage.values.has(key), true, key));
  assert.equal(queues.has('TOUR_QUEUE|passenger-principal|passenger|BOOK_QUEUE'), true);

  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.equal(queueScopes.length, 2);
  assert.deepEqual(queueScopes[0], queueScopes[1]);
  assert.deepEqual(queueScopes[1], {
    tourId: 'TOUR_QUEUE',
    principalId: 'passenger-principal',
    role: 'passenger',
    authUid: ORIGINAL_AUTH_UID,
    cacheOwnerId: 'BOOK_QUEUE',
  });
  assert.equal(queues.has('TOUR_QUEUE|passenger-principal|passenger|BOOK_QUEUE'), false);
  assert.equal(queues.has('TOUR_QUEUE|passenger-other|passenger|BOOK_OTHER'), true);
});

test('driver purge failure retains persisted coordinates and recreation rebuilds the exact operational scope', async () => {
  const appSession = {
    sessionId: SESSION_ID,
    principalType: 'driver',
    principalId: 'driver:D-ALPHA',
    driverId: 'D-ALPHA',
    tourId: 'TOUR_DRIVER',
  };
  const localStorage = makeScopedLocalStorage({
    appSession,
    bookingData: { id: 'D-ALPHA', isDriver: true, assignedDepartureKey: '2026-09-01::TOUR_DRIVER' },
    tourData: { id: 'TOUR_DRIVER', startDate: '2026-09-01' },
  });
  const deletionService = createAccountDeletionService({ persistence: makePersistence(), now: () => 400 });
  await deletionService.writePending(pendingRecord());
  const driverStores = new Set(['TOUR_DRIVER|D-ALPHA', 'TOUR_OTHER|D-BETA']);
  const scopes = [];
  let attempts = 0;
  const driverLifecycle = {
    purge: async (scope) => {
      scopes.push({ ...scope });
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'injected driver purge failure' };
      driverStores.delete(`${scope.tourId}|${scope.driverId}`);
      return { success: true };
    },
  };

  const first = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      driverLifecycle,
    })),
  }));
  assert.equal(first.success, false);
  assert.equal((await deletionService.readPending()).localCleanupComplete, false);
  assert.equal((await deletionService.readPending()).localCleanupState, 'not_started');
  [TOUR_KEY, BOOKING_KEY, APP_SESSION_KEY].forEach((key) => assert.equal(localStorage.values.has(key), true, key));
  assert.equal(driverStores.has('TOUR_DRIVER|D-ALPHA'), true);

  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      driverLifecycle,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.deepEqual(scopes, [
    {
      authUid: ORIGINAL_AUTH_UID,
      driverId: 'D-ALPHA',
      departureKey: '2026-09-01::TOUR_DRIVER',
      tourId: 'TOUR_DRIVER',
      startDate: '2026-09-01',
    },
    {
      authUid: ORIGINAL_AUTH_UID,
      driverId: 'D-ALPHA',
      departureKey: '2026-09-01::TOUR_DRIVER',
      tourId: 'TOUR_DRIVER',
      startDate: '2026-09-01',
    },
  ]);
  assert.equal(driverStores.has('TOUR_DRIVER|D-ALPHA'), false);
  assert.equal(driverStores.has('TOUR_OTHER|D-BETA'), true);
});

test('termination before final session-key commit leaves scope durable for an idempotent restart', async () => {
  const appSession = {
    sessionId: SESSION_ID,
    principalType: 'passenger',
    principalId: 'passenger-principal',
    tourId: 'TOUR_COMMIT',
  };
  const localStorage = makeScopedLocalStorage({
    appSession,
    bookingData: { id: 'BOOK_COMMIT', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_COMMIT' },
  });
  const deletionService = createAccountDeletionService({ persistence: makePersistence(), now: () => 500 });
  await deletionService.writePending(pendingRecord());
  const scopes = [];
  const offlineOverrides = {
    purgeTourPack: async (tourId, role, { ownerId }) => {
      scopes.push(`${tourId}|${role}|${ownerId}`);
      return { success: true };
    },
  };
  const interrupted = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
      beforeSessionKeyCommit: async () => {
        assert.equal((await deletionService.readPending()).localCleanupState, 'commit_prepared');
        throw new Error('simulated termination before commit');
      },
    })),
  }));
  assert.equal(interrupted.success, false);
  assert.deepEqual(interrupted.failures, [{ name: 'clearSessionKeys', error: 'simulated termination before commit' }]);
  assert.equal((await deletionService.readPending()).localCleanupComplete, false);
  assert.equal((await deletionService.readPending()).localCleanupState, 'commit_prepared');
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), true, key));

  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.deepEqual(scopes, ['TOUR_COMMIT|passenger|BOOK_COMMIT']);
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), false, key));
  assert.equal((await deletionService.readPending()).localCleanupComplete, true);
});

test('prepared-marker write failure leaves every scope-bearing app key intact', async () => {
  const persistence = makePersistence({}, {
    failSet: ({ value }) => JSON.parse(value).localCleanupState === 'commit_prepared',
  });
  const deletionService = createAccountDeletionService({ persistence, now: () => 600 });
  await deletionService.writePending(pendingRecord());
  const localStorage = makeScopedLocalStorage({
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_PREPARE',
    },
    bookingData: { id: 'BOOK_PREPARE', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_PREPARE' },
  });
  const result = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({ storage: localStorage })),
  }));
  assert.equal(result.success, false);
  assert.deepEqual(result.failures, [{
    name: 'prepareLocalCleanupCommit',
    error: 'LOCAL_CLEANUP_PREPARE_PERSIST_FAILED',
  }]);
  assert.equal((await deletionService.readPending()).localCleanupState, 'not_started');
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), true, key));
});

test('crash after key removal resumes from commit_prepared without the deleted scope', async () => {
  const persistence = makePersistence();
  const deletionService = createAccountDeletionService({ persistence, now: () => 700 });
  await deletionService.writePending(pendingRecord());
  const localStorage = makeScopedLocalStorage({
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_AFTER_CLEAR',
    },
    bookingData: { id: 'BOOK_AFTER_CLEAR', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_AFTER_CLEAR' },
  });
  let scopedPurges = 0;
  const offlineOverrides = {
    purgeTourPack: async () => { scopedPurges += 1; return { success: true }; },
  };
  const interruptedService = {
    ...deletionService,
    markLocalCleanupComplete: async () => { throw new Error('simulated process termination'); },
  };
  const interrupted = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService: interruptedService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(interrupted.success, false);
  assert.equal((await deletionService.readPending()).localCleanupState, 'commit_prepared');
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), false, key));
  assert.equal(scopedPurges, 1);

  const restartedDeletionService = createAccountDeletionService({ persistence, now: () => 701 });
  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService: restartedDeletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.equal(scopedPurges, 1, 'prepared recovery must not reconstruct or repeat scoped purges');
  assert.equal((await restartedDeletionService.readPending()).localCleanupState, 'complete');
});

test('secure completion write failure is resumable from the prepared marker', async () => {
  let remainingCompletionFailures = 1;
  const persistence = makePersistence({}, {
    failSet: ({ value }) => {
      if (JSON.parse(value).localCleanupState !== 'complete' || remainingCompletionFailures < 1) return false;
      remainingCompletionFailures -= 1;
      return true;
    },
  });
  const deletionService = createAccountDeletionService({ persistence, now: () => 800 });
  await deletionService.writePending(pendingRecord());
  const localStorage = makeScopedLocalStorage({
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_SECURE_WRITE',
    },
    bookingData: { id: 'BOOK_SECURE_WRITE', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_SECURE_WRITE' },
  });
  let scopedPurges = 0;
  const offlineOverrides = {
    purgeTourPack: async () => { scopedPurges += 1; return { success: true }; },
  };
  const failed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(failed.success, false);
  assert.deepEqual(failed.failures, [{
    name: 'completeLocalCleanupCommit',
    error: 'LOCAL_CLEANUP_COMPLETE_PERSIST_FAILED',
  }]);
  assert.equal((await deletionService.readPending()).localCleanupState, 'commit_prepared');
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), false, key));

  const restartedDeletionService = createAccountDeletionService({ persistence, now: () => 801 });
  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService: restartedDeletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.equal(scopedPurges, 1);
  assert.equal((await restartedDeletionService.readPending()).localCleanupState, 'complete');
});

test('prepared recovery retries a failed final key removal without repeating scoped purges', async () => {
  const persistence = makePersistence();
  const deletionService = createAccountDeletionService({ persistence, now: () => 900 });
  await deletionService.writePending(pendingRecord());
  const localStorage = makeScopedLocalStorage({
    appSession: {
      sessionId: SESSION_ID,
      principalType: 'passenger',
      principalId: 'passenger-principal',
      tourId: 'TOUR_KEY_RETRY',
    },
    bookingData: { id: 'BOOK_KEY_RETRY', stablePassengerId: 'passenger-principal' },
    tourData: { id: 'TOUR_KEY_RETRY' },
  });
  const baseMultiRemove = localStorage.multiRemove.bind(localStorage);
  let remainingFinalFailures = 1;
  localStorage.multiRemove = async (keys) => {
    const isFinalCommit = keys.length === APP_LOCAL_KEYS.length
      && APP_LOCAL_KEYS.every((key) => keys.includes(key));
    if (isFinalCommit && remainingFinalFailures > 0) {
      remainingFinalFailures -= 1;
      throw new Error('injected final key removal failure');
    }
    return baseMultiRemove(keys);
  };
  let scopedPurges = 0;
  const offlineOverrides = {
    purgeTourPack: async () => { scopedPurges += 1; return { success: true }; },
  };
  const failed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(failed.success, false);
  assert.deepEqual(failed.failures, [{ name: 'clearSessionKeys', error: 'injected final key removal failure' }]);
  assert.equal((await deletionService.readPending()).localCleanupState, 'commit_prepared');
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), true, key));

  const resumed = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService: createAccountDeletionService({ persistence, now: () => 901 }),
    localStorage,
    cleanupService: createLocalSessionCleanupService(makeCleanupDependencies({
      storage: localStorage,
      offlineOverrides,
    })),
  }));
  assert.equal(resumed.success, true);
  assert.equal(scopedPurges, 1);
  APP_LOCAL_KEYS.forEach((key) => assert.equal(localStorage.values.has(key), false, key));
});

test('prepared recovery preserves another principal without reading deleted cleanup scope', async () => {
  const persistence = makePersistence();
  const deletionService = createAccountDeletionService({ persistence, now: () => 1_000 });
  await deletionService.writePending(pendingRecord({ localCleanupState: 'commit_prepared' }));
  const foreignTrustedContactKey = '@LLT:trustedContacts:v2:foreign-principal';
  const localStorage = makeLocalStorage({
    ...Object.fromEntries(APP_LOCAL_KEYS.map((key) => [key, 'private-local-value'])),
    [foreignTrustedContactKey]: 'foreign-contact-data',
  });
  const foreignPacks = new Set(['TOUR_OTHER|passenger|BOOK_OTHER']);
  const foreignActions = new Set(['TOUR_OTHER|foreign-principal|passenger|BOOK_OTHER']);
  let scopedCalls = 0;
  const forbiddenScopedCall = async () => {
    scopedCalls += 1;
    throw new Error('prepared recovery must not touch scoped stores');
  };
  const cleanupService = createLocalSessionCleanupService(makeCleanupDependencies({
    storage: localStorage,
    offlineOverrides: {
      setActiveSessionScope: forbiddenScopedCall,
      purgeTourPack: forbiddenScopedCall,
      purgeActionsForScope: forbiddenScopedCall,
    },
    driverLifecycle: { purge: forbiddenScopedCall },
  }));
  const result = await runPurgePendingAccountDeletion(makeCleanupRunner({
    deletionService,
    localStorage,
    cleanupService,
  }));
  assert.equal(result.success, true);
  assert.equal(scopedCalls, 0);
  assert.deepEqual([...foreignPacks], ['TOUR_OTHER|passenger|BOOK_OTHER']);
  assert.deepEqual([...foreignActions], ['TOUR_OTHER|foreign-principal|passenger|BOOK_OTHER']);
  assert.equal(localStorage.values.get(foreignTrustedContactKey), 'foreign-contact-data');
  assert.equal((await deletionService.readPending()).localCleanupState, 'complete');
});

test('pending deletion blocks both offline restoration and normal login before either action runs', async () => {
  let offlineResolverCalled = false;
  const offlineResult = await runResolveOfflineLogin({
    accountDeletionService: { readPending: async () => pendingRecord() },
    appSessionService: { readPendingEnd: async () => false, readSession: async () => ({}) },
    resolveOfflineLoginFromCache: async () => { offlineResolverCalled = true; return { success: true }; },
  }, 'reference', 'email@example.test');
  assert.equal(offlineResult.reason, 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(offlineResolverCalled, false);

  let prepared = false;
  await assert.rejects(() => runHandleLoginSuccess({
    accountDeletionService: { readPending: async () => pendingRecord() },
    prepareLoginContext: async () => { prepared = true; },
  }, 'reference', {}, {}), (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(prepared, false);
});

test('restart validates durable pending state and routes it before Auth/session restoration', async () => {
  const persistence = makePersistence();
  const deletionService = createAccountDeletionService({ persistence });
  await deletionService.writePending(pendingRecord({ state: 'pending', phase: 'chat_scrub' }));
  const calls = [];
  const state = {};
  const unsubscribe = () => {};
  await runInitializeApp({
    SESSION_KEYS: {},
    STARTUP_CONNECTION_ERROR_MESSAGE: 'offline',
    SessionStorage: {},
    accountDeletionService: deletionService,
    appSessionService: {},
    authHelpers: {
      ensureAuthenticated: async () => { calls.push('recovery-auth'); return { uid: 'anonymous-recovery' }; },
      onAuthStateChanged: () => unsubscribe,
    },
    authUnsubscribeRef: { current: null },
    handleAuthStateChange: () => {},
    hydrateIdentityBindingForCurrentUser: async () => { calls.push('hydrate'); },
    localSessionCleanupService: {},
    logger: { error: () => {}, info: () => {}, setUserId: () => {} },
    maskIdentifier: (value) => value,
    recordCrashBreadcrumb: () => {},
    restoreSession: async () => { calls.push('restore'); },
    setAccountDeletionStatus: (value) => { state.deletion = value; },
    setAppSession: (value) => { state.session = value; },
    setAuthError: () => {},
    setDiagnosticsAuthUid: () => {},
    setInitializing: () => {},
    setLogoutStatus: () => {},
    setUser: (value) => { state.user = value; },
    toAccountDeletionUiState,
  });
  assert.deepEqual(calls, ['recovery-auth']);
  assert.equal(state.deletion.state, 'pending');
  assert.equal(state.deletion.phase, 'chat_scrub');
  assert.equal(state.session, null);
  assert.equal(state.user.uid, 'anonymous-recovery');
});

test('unknown or invalid receipt status is generic and preserves recoverable pending state', async () => {
  const persistence = makePersistence();
  const service = createAccountDeletionService({
    persistence,
    now: () => 200,
    getFirebase: firebaseBoundary,
    fetchFn: async () => response(404, {
      success: false,
      reason: 'ACCOUNT_DELETION_STATUS_UNAVAILABLE',
      internalDeletionId: 'must-not-surface',
    }),
  });
  await service.writePending(pendingRecord());
  const result = await service.pollStatus();
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ACCOUNT_DELETION_STATUS_UNAVAILABLE');
  assert.equal(result.error, 'We could not confirm account deletion status. Please try again.');
  assert.equal(JSON.stringify(result).includes('must-not-surface'), false);
  assert.equal(JSON.stringify(result).includes(RECEIPT), true, 'the receipt remains only in private pending recovery');
  assert.equal((await service.readPending()).deletionReceipt, RECEIPT);
});

test('completion finalizer clears only after cleanup, is single-flight, and is idempotent', async () => {
  const persistence = makePersistence();
  const service = createAccountDeletionService({ persistence, now: () => 300 });
  await service.writePending(pendingRecord({
    state: 'completed',
    phase: 'completed',
    retryable: false,
    completedAtMs: 250,
  }));
  const blocked = await service.finalizeCompletedRecovery();
  assert.equal(blocked.success, false);
  assert.equal(blocked.reason, 'LOCAL_CLEANUP_REQUIRED');
  assert.equal((await service.readPending()).deletionReceipt, RECEIPT);
  assert.equal((await service.readPending()).originalAuthUid, ORIGINAL_AUTH_UID);

  await service.markLocalCleanupCommitPrepared();
  await service.markLocalCleanupComplete();
  const [left, right] = await Promise.all([
    service.finalizeCompletedRecovery(),
    service.finalizeCompletedRecovery(),
  ]);
  assert.deepEqual(left, right);
  assert.equal(left.success, true);
  assert.equal(await service.readPending(), null);
  assert.equal(persistence.events.filter(([kind]) => kind === 'delete').length, 1);

  const replay = await service.finalizeCompletedRecovery();
  assert.deepEqual(replay, { success: true, alreadyComplete: true, pending: null });
  assert.equal(persistence.events.filter(([kind]) => kind === 'delete').length, 1);
});

test('crash after completion marker resumes only receipt clearing', async () => {
  const persistence = makePersistence({}, { failDeleteCount: 1 });
  const service = createAccountDeletionService({ persistence, now: () => 400 });
  await service.writePending(pendingRecord({
    state: 'completed',
    phase: 'completed',
    retryable: false,
    completedAtMs: 350,
    localCleanupState: 'complete',
    localCleanupComplete: true,
  }));
  await assert.rejects(service.finalizeCompletedRecovery(), /receipt clear failure/);
  const afterCrash = await service.readPending();
  assert.equal(afterCrash.completionHandled, true);
  const setsAfterCrash = persistence.events.filter(([kind]) => kind === 'set').length;

  const resumed = await service.finalizeCompletedRecovery();
  assert.equal(resumed.success, true);
  assert.equal(await service.readPending(), null);
  assert.equal(persistence.events.filter(([kind]) => kind === 'set').length, setsAfterCrash);
  assert.equal(persistence.events.filter(([kind]) => kind === 'delete').length, 2);
});

test('network and requires-attention states remain recoverable with bounded client-safe copy', async () => {
  const persistence = makePersistence();
  let calls = 0;
  const service = createAccountDeletionService({
    persistence,
    now: () => 500 + calls,
    getFirebase: firebaseBoundary,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('raw network diagnostic with identifiers');
      return response(200, {
        success: true,
        status: 'requires_attention',
        phase: 'private_media',
        retryable: true,
      });
    },
  });
  await service.writePending(pendingRecord());
  const offline = await service.pollStatus();
  assert.equal(offline.reason, 'NETWORK_ERROR');
  assert.match(offline.error, /still saved on this device/iu);
  assert.equal(offline.pending.state, 'waiting_for_connection');
  assert.equal(offline.pending.deletionReceipt, RECEIPT);
  assert.equal(JSON.stringify(offline).includes('raw network diagnostic'), false);

  const attention = await service.pollStatus();
  assert.equal(attention.status, 'requires_attention');
  assert.equal(attention.pending.deletionReceipt, RECEIPT);
  const ui = toAccountDeletionUiState(attention.pending);
  assert.deepEqual({ state: ui.state, phase: ui.phase, retryable: ui.retryable }, {
    state: 'requires_attention', phase: 'private_media', retryable: true,
  });

  const screenSource = fs.readFileSync(path.join(__dirname, '..', 'screens', 'AccountDeletionPendingScreen.js'), 'utf8');
  assert.match(screenSource, /old app access remains blocked/iu);
  assert.match(screenSource, /safely close the app/iu);
  assert.doesNotMatch(screenSource, /deletionId|authUid|bookingRef|storagePath/u);
});

test('account privacy wording distinguishes passenger deletion from retained driver operations records', () => {
  const privacySource = fs.readFileSync(path.join(__dirname, '..', 'screens', 'AccountPrivacyScreen.js'), 'utf8');
  assert.match(privacySource, /passenger-authored active-tour chat and media/iu);
  assert.match(privacySource, /Shared operational chat, media, assignments, and canonical operations records are retained/iu);
  assert.match(privacySource, /Travel booking may still be retained/iu);
  assert.match(privacySource, /operations, safety, legal, or accounting/iu);
  assert.doesNotMatch(privacySource, /delete all booking records|erase every record/iu);
});

test('the local cleanup write-ahead marker is absent from Functions and operations warnings', () => {
  const domainPath = path.join(__dirname, '..', 'functions', 'src', 'domains', 'account-deletion');
  const productionSource = fs.readdirSync(domainPath)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(domainPath, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(productionSource, /localCleanupState|commit_prepared/u);
});
