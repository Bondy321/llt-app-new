'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
const React = require('react');
const { act, create } = require('react-test-renderer');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'react-native') return { PanResponder: { create: () => ({ panHandlers: {} }) } };
  if (request.endsWith('/services/loggerService')) return { trackScreen() {}, info() {}, warn() {}, error() {} };
  return originalLoad(request, parent, isMain);
};
const useAppNavigation = require('../src/app/navigation/useAppNavigation').default;
const { runSaveSessionProjection } = require('../src/app/session/sessionSaveRunner');
const { restoreStoredSessionProjection } = require('../src/app/session/sessionRestorePhases');
const { runInitializeApp } = require('../src/app/session/sessionBootstrapRunners');
const { runHydrateIdentityBindingForCurrentUser } = require('../src/app/session/identityBindingRunners');
Module._load = originalLoad;
const { createAppSessionService, APP_SESSION_KEY, PENDING_SESSION_END_KEY } = require('../services/appSessionService');
const { createLocalSessionCleanupService } = require('../services/localSessionCleanupService');
const { CLEANUP_KEY } = require('../services/localSessionWriteBoundary');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const keys = { TOUR_DATA: '@LLT:tourData', BOOKING_DATA: '@LLT:bookingData',
  LAST_SCREEN: '@LLT:lastScreen', IDENTITY_BINDING: '@LLT:identityBinding' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const memory = () => {
  const values = new Map();
  return { values, getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value), removeItem: async key => values.delete(key),
    multiSet: async entries => entries.forEach(([key, value]) => values.set(key, value)),
    multiRemove: async entries => entries.forEach(key => values.delete(key)) };
};
const passenger = { schemaVersion: 1, sessionId: `sess_v1_${'a'.repeat(32)}`, principalType: 'passenger',
  principalId: `pax_v2_${'b'.repeat(32)}`, driverId: null, tourId: 'TOUR_A', issuedAtMs: 1,
  expiresAtMs: Date.now() + 600000, sessionRevision: 1 };
const cleanupFor = storage => createLocalSessionCleanupService({ storage,
  offline: { setActiveSessionScope: async () => {}, purgeTourPack: async () => ({ success: true }),
    purgeActionsForScope: async () => { storage.values.delete('LLT_OFFLINE_queue_v1'); return { success: true }; } },
  driverLifecycle: { purge: async () => ({ success: true }) }, clearNotifications: async () => {},
  photoCache: null, tripLifecycle: { stopPassengerTrip() {}, purgePassengerTrip: async () => {} } });

for (const reason of ['logout', 'account deletion', 'principal change']) {
  test(`mounted navigation native batch draining across ${reason} cannot resurrect projection after clean restart`, async () => {
    const storage = memory();
    const service = createAppSessionService({ storage });
    await service.persistSession(passenger);
    storage.values.set(PENDING_SESSION_END_KEY, 'retained-exact-end-receipt');
    storage.values.set('@LLT:pendingAccountDeletion:v1', 'retained-deletion-receipt');
    storage.values.set('@LLT:driverTrackingStop:v1', 'retained-stop-tombstone');
    storage.values.set('LLT_OFFLINE_queue_v1', 'retained-current-unsent-action');
    const cleanup = cleanupFor(storage);
    const gate = deferred(); const entered = deferred();
    const write = storage.multiSet;
    storage.multiSet = async entries => { entered.resolve(); await gate.promise; await write(entries); };
    let nav; let projection;
    const binding = { current: passenger };
    function Probe() {
      nav = useAppNavigation({ driverTourPackFeature: { enabled: false, loading: false }, homeScreen: 'TourHome',
        persistScreen: overrides => {
          projection = runSaveSessionProjection({ SESSION_KEYS: keys, SessionStorage: storage,
            logger: { error() {} }, currentScreen: 'TourHome', appSession: passenger, appSessionRef: binding,
            appSessionService: service, tourData: { id: 'TOUR_A' },
            bookingData: { id: 'BOOK_A', stablePassengerId: passenger.principalId } }, overrides);
          return projection;
        } });
      return null;
    }
    let renderer;
    await act(async () => { renderer = create(React.createElement(Probe)); });
    let finished = false;
    try {
      await act(async () => { nav.navigateTo('Itinerary'); await entered.promise; });
      binding.current = null;
      const cleanupScope = { authUid: 'phone', appSession: passenger,
        bookingData: { id: 'BOOK_A', stablePassengerId: passenger.principalId }, tourData: { id: 'TOUR_A' },
        discardQueuedActions: reason === 'account deletion' };
      const clean = (reason === 'account deletion'
        ? cleanup.prepareScopedCleanup(cleanupScope).then(result => result.success
          ? cleanup.commitSessionKeys({ preservePendingSessionEnd: false }) : result)
        : cleanup.cleanup(cleanupScope)).then(result => { finished = true; return result; });
      await tick();
      assert.equal(finished, false, 'cleanup cannot acknowledge while the dispatched batch remains unresolved');
      gate.resolve();
      await act(async () => { await projection; assert.equal((await clean).success, true); });
      for (const key of [...Object.values(keys), APP_SESSION_KEY]) assert.equal(storage.values.has(key), false, key);
      assert.equal(storage.values.get(PENDING_SESSION_END_KEY), reason === 'account deletion' ? undefined : 'retained-exact-end-receipt');
      assert.equal(storage.values.get('@LLT:pendingAccountDeletion:v1'), 'retained-deletion-receipt');
      assert.equal(storage.values.get('@LLT:driverTrackingStop:v1'), 'retained-stop-tombstone');
      assert.equal(storage.values.get('LLT_OFFLINE_queue_v1'), reason === 'account deletion' ? undefined : 'retained-current-unsent-action');
      assert.equal(await createAppSessionService({ storage }).readSession(), null);
      assert.equal(JSON.parse(storage.values.get(CLEANUP_KEY)).state, 'complete');
      await act(async () => { nav.navigateTo('Map'); await projection; });
      assert.equal(storage.values.has(keys.LAST_SCREEN), false);
    } finally { gate.resolve(); await act(async () => renderer.unmount()); }
  });
}

test('failed cleanup remains durably blocked across context recreation and permits only completed recovery', async () => {
  const storage = memory(); const service = createAppSessionService({ storage });
  await service.persistSession(passenger);
  const cleanup = cleanupFor(storage);
  const remove = storage.multiRemove;
  storage.multiRemove = async () => { throw new Error('Synthetic storage failure'); };
  const scope = { authUid: 'phone', appSession: passenger,
    bookingData: { id: 'BOOK_A', stablePassengerId: passenger.principalId }, tourData: { id: 'TOUR_A' } };
  assert.equal((await cleanup.cleanup(scope)).success, false);
  const recreated = createAppSessionService({ storage });
  assert.equal(await recreated.readSession(), null);
  assert.equal(await recreated.persistSession(passenger), false);
  assert.deepEqual(await cleanupFor(storage).readPendingCleanup(), { ...scope, driverOperationalScope: null, requireCompleteScope: false, discardQueuedActions: false });
  storage.multiRemove = remove;
  assert.equal((await cleanupFor(storage).cleanup(scope)).success, true);
  const successor = { ...passenger, sessionId: `sess_v1_${'c'.repeat(32)}` };
  assert.deepEqual(await recreated.persistSession(successor), successor);
});

test('every historical parameter-dependent route restores verified Home only', async () => {
  const routes = ['Chat', 'PassengerManifest', 'DriverTourPack', 'Map', 'Photobook', 'GroupPhotobook',
    'Itinerary', 'DriverItinerary', 'MarketingNotificationDetail', 'SafetyAlertDetail', 'NotificationPreferences', 'Unknown'];
  for (const route of routes) {
    let destination;
    const booking = { id: 'BOOK_A', stablePassengerId: passenger.principalId, identityVersion: 'pax_v2' };
    const deps = { appSessionRef: { current: passenger }, appSessionService: { persistProjection: async ({ isCurrent }) => isCurrent() }, SESSION_KEYS: keys, SessionStorage: memory(), IDENTITY_VERSION: 'pax_v2',
      isOpaquePassengerId: value => value === passenger.principalId,
      normalizePassengerIdentityProjection: value => value, normalizePassengerTourProjection: value => value,
      routeHistoryRef: { current: { reset() {} } }, setBookingData() {}, setTourData() {}, setTourCode() {},
      setCurrentScreen: value => { destination = value; }, logger: { warn() {} } };
    assert.equal(await restoreStoredSessionProjection(deps, passenger,
      [[keys.TOUR_DATA, JSON.stringify({ id: 'TOUR_A' })], [keys.BOOKING_DATA, JSON.stringify(booking)], [keys.LAST_SCREEN, route]]), true);
    assert.equal(destination, 'TourHome', route);
  }
});


test('known-offline startup restores only exact unexpired authority without contacting profile/session readers', async () => {
  const local = memory(); const service = createAppSessionService({ storage: local });
  await service.persistSession(passenger);
  let restored; let remoteReads = 0; let initialized;
  await runInitializeApp({ isConnected: false, SESSION_KEYS: keys, STARTUP_CONNECTION_ERROR_MESSAGE: 'Connection required',
    SessionStorage: local, accountDeletionService: { readPending: async () => null },
    appSessionService: { ...service, verifyCurrent: async () => { remoteReads++; throw Error('offline'); } },
    authHelpers: { ensureAuthenticated: async () => ({ uid: 'phone' }), onAuthStateChanged: () => () => {} }, authUnsubscribeRef: { current: null },
    handleAuthStateChange() {}, hydrateIdentityBindingForCurrentUser: async () => { remoteReads++; },
    localSessionCleanupService: { readPendingCleanup: async () => null },
    logger: { setUserId() {}, info() {}, warn() {}, error() {} }, maskIdentifier: value => value, recordCrashBreadcrumb() {},
    restoreSession: async value => { restored = value; }, setAccountDeletionStatus() {}, setAppSession() {}, setAuthError() {},
    setDiagnosticsAuthUid() {}, setInitializing: value => { initialized = value; }, setLogoutStatus() {}, setUser() {} });
  assert.deepEqual(restored, passenger); assert.equal(remoteReads, 0); assert.equal(initialized, false);
});

test('late profile hydration cannot repopulate a successor under the same installation', async () => {
  const read = deferred(); const local = memory(); const service = createAppSessionService({ storage: local });
  await service.persistSession(passenger); const current = { current: passenger }; let shown = false;
  const hydration = runHydrateIdentityBindingForCurrentUser({ IDENTITY_VERSION: 'pax_v2', SESSION_KEYS: keys,
    SessionStorage: local, isOpaquePassengerId: value => value === passenger.principalId,
    logger: { info() {}, warn() {} }, maskIdentifier: value => value,
    realtimeDb: { ref: () => ({ once: () => read.promise }) }, setIdentityBinding: () => { shown = true; },
    toRealtimeKeySegment: value => value, appSessionRef: current, appSessionService: service }, 'phone', { timeoutMs: 100 });
  current.current = { ...passenger, sessionId: `sess_v1_${'d'.repeat(32)}` };
  await service.persistSession(current.current);
  read.resolve({ val: () => ({ stablePassengerId: passenger.principalId, identityVersion: 'pax_v2' }) });
  await hydration;
  assert.equal(shown, false); assert.equal(local.values.has(keys.IDENTITY_BINDING), false);
  assert.deepEqual(await service.readSession(), current.current);
});

test('production logger and crash diagnostic adapters drain dispatched writes before cleanup and reject late callbacks', async () => {
  const adapters = new Map();
  const getAdapter = namespace => {
    if (!adapters.has(namespace)) {
      const values = new Map();
      adapters.set(namespace, { values, getItemAsync: async key => values.get(key) || null,
        setItemAsync: async (key, value) => values.set(key, value), deleteItemAsync: async key => values.delete(key) });
    }
    return adapters.get(namespace);
  };
  const oldLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'react-native') return { Platform: { OS: 'test', Version: 1 } };
    if (request === '../firebase') return { auth: { currentUser: null }, realtimeDb: null };
    if (request === './persistenceProvider') return { createPersistenceProvider: ({ namespace }) => getAdapter(namespace) };
    return oldLoad(request, parent, isMain);
  };
  let logger; let diagnostics;
  try {
    logger = require('../services/loggerService').default;
    diagnostics = require('../services/crashDiagnosticsService');
  } finally { Module._load = oldLoad; }
  await tick();
  for (const entry of [
    { adapter: getAdapter('LLT_LOGS'), write: () => { logger.logQueue = [{ id: 'synthetic-old' }]; return logger.saveLogsLocally(); }, clear: () => logger.clearSessionDiagnostics() },
    { adapter: getAdapter('LLT_CRASH_DIAGNOSTICS'), write: () => diagnostics.flushDiagnostics('synthetic-old'), clear: () => diagnostics.clearSessionDiagnostics() },
  ]) {
    const gate = deferred(); const entered = deferred(); const put = entry.adapter.setItemAsync;
    entry.adapter.setItemAsync = async (key, value) => { entered.resolve(); await gate.promise; return put(key, value); };
    const pending = entry.write(); await entered.promise;
    let completed = false; const clearing = entry.clear().then(() => { completed = true; });
    await tick(); assert.equal(completed, false);
    gate.resolve(); await pending; await clearing;
    assert.equal(entry.adapter.values.size, 0);
    await entry.write(); assert.equal(entry.adapter.values.size, 0, 'a late diagnostic callback cannot recreate cleared private data');
  }
});

test('mounted manifest receives automatic and manual reconciliation and fences a same-installation role switch', async () => {
  const queue = require('../services/offlineSyncService');
  const { createDriverManifestCacheService } = require('../services/driverManifestCacheService');
  const local = new Map();
  const cache = createDriverManifestCacheService({ storage: { getItemAsync: async key => local.get(key) || null,
    setItemAsync: async (key, value) => local.set(key, value), deleteItemAsync: async key => local.delete(key) } });
  const scope = { tourId: 'TOUR_A', principalId: 'driver:D-ONE', role: 'driver', authUid: 'phone', cacheOwnerId: 'D-ONE' };
  await queue.setActiveSessionScope(scope); await queue.purgeActionsForScope({ scope });
  await cache.replace({ tourId: 'TOUR_A', driverId: 'D-ONE', manifest: { complete: true, tourId: 'TOUR_A',
    bookings: [{ id: 'BOOK_1', passengerNames: ['Synthetic Guest'], passengerStatus: ['BOARDED'] }] } });
  let view; let result = () => Promise.resolve({ success: true, reconciled: true, passengerStatus: ['NO_SHOW'],
    conflict: { reason: 'SERVER_NEWER', bookingRef: 'BOOK_1', serverStatus: 'NO_SHOW', attemptedStatus: 'BOARDED' } });
  let remoteReady = false;
  const bookingService = { getTourManifest: () => remoteReady ? Promise.resolve({ complete: true, tourId: 'TOUR_A', bookings: [{ id: 'BOOK_1', passengerNames: ['Synthetic Guest'], passengerStatus: ['NO_SHOW'] }] }) : new Promise(() => {}), applyManifestUpdateDirect: () => result(), MANIFEST_STATUS: { PENDING: 'PENDING' } };
  const oldLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'react-native') return { Alert: {}, Linking: {}, Keyboard: {} };
    if (request === './PassengerManifestView') return { __esModule: true, default: props => { view = props; return null; } };
    if (request === './usePassengerManifestPresentation') return { __esModule: true, default: () => ({}), priorityRank: () => 0, computeStats: () => ({}), getUnresolvedBookingCount: () => 0 };
    if (request === '../../services/driverManifestCacheService') return cache;
    if (request === '../../services/bookingServiceRealtime') return bookingService;
    if (request === '../../services/chatService') return {};
    if (request === '../../services/offlineSyncService') return { ...queue, replayQueue: options => queue.replayQueue({ ...options, services: { ...options.services, driverManifestCache: cache } }) };
    if (request === '../../services/loggerService') return { __esModule: true, default: { trackScreen() {}, info() {}, warn() {}, debug() {}, error() {} }, maskIdentifier: value => value };
    return oldLoad(request, parent, isMain);
  };
  let Controller;
  try { Controller = require('../components/passenger-manifest/PassengerManifestController').default; }
  finally { Module._load = oldLoad; }
  let renderer;
  const props = { route: { params: { tourId: 'TOUR_A', actorPrincipalId: scope.principalId, authUid: 'phone', offlineCacheOwnerId: 'D-ONE', sessionGeneration: 1 } }, navigation: {} };
  const enqueue = id => queue.enqueueAction({ id, type: 'MANIFEST_UPDATE', tourId: 'TOUR_A', scope,
    payload: { bookingRef: 'BOOK_1', passengerStatuses: ['BOARDED'] } });
  try {
    await act(async () => { renderer = create(React.createElement(Controller, props)); await tick(); });
    assert.equal(view.manifestData.bookings[0].status, 'BOARDED');
    await act(async () => { await enqueue('mounted_auto'); await queue.replayQueue({ scope, services: { bookingService, driverManifestCache: cache } }); });
    assert.equal(view.manifestData.bookings[0].status, 'NO_SHOW');
    assert.equal(view.manifestConflict.serverStatus, 'NO_SHOW'); assert.equal(view.queueStats?.total || 0, 0);
    remoteReady = true;
    await act(async () => { await enqueue('mounted_manual'); await view.handleSyncNow(); });
    assert.equal(view.manifestData.bookings[0].status, 'NO_SHOW'); assert.equal(view.manifestConflict.serverStatus, 'NO_SHOW');
    const late = deferred(); result = () => late.promise;
    let replay;
    await act(async () => { await enqueue('mounted_stale'); replay = queue.replayQueue({ scope, services: { bookingService, driverManifestCache: cache } }); await tick(); });
    remoteReady = false;
    const successorScope = { ...scope, principalId: 'driver:D-TWO', cacheOwnerId: 'D-TWO' };
    await act(async () => {
      await queue.setActiveSessionScope(successorScope);
      renderer.update(React.createElement(Controller, { ...props, route: { params: { ...props.route.params, actorPrincipalId: successorScope.principalId, offlineCacheOwnerId: 'D-TWO', sessionGeneration: 2 } } }));
    });
    late.resolve({ success: true, reconciled: true, passengerStatus: ['BOARDED'] });
    await act(async () => { await replay; });
    assert.equal(view.manifestData.bookings.length, 0); assert.equal(view.manifestConflict, null);
  } finally { await act(async () => renderer?.unmount()); await queue.setActiveSessionScope(scope); await queue.purgeActionsForScope({ scope }); }
});

test('mounted chat live window preserves tied-timestamp history, removes actual deletions and fences role changes', async () => {
  const callbacks = []; let observed = []; let renderer;
  const oldLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '../../services/chatService') return { subscribeToChatMessages: (_tour, callback) => { callbacks.push(callback); return () => {}; }, subscribeToInternalDriverChat: () => () => {} };
    if (request === '../../services/loggerService') return { __esModule: true, default: { warn() {} } };
    if (request === './chatShared') return { LIVE_CHAT_MESSAGE_LIMIT: 80, normalizeTimestamp: Number,
      summarizeMessagesForReactionDebug: () => ({}), logChatReactionDebug() {},
      mergeMessagesById: (previous, incoming) => [...new Map([...previous, ...incoming].map(row => [row.id, row])).values()] };
    return oldLoad(request, parent, isMain);
  };
  let useLifecycle;
  try { useLifecycle = require('../components/chat/useChatSubscriptionLifecycle').default; }
  finally { Module._load = oldLoad; }
  const noop = () => {}; const timestamp = row => row.timestamp; const reactionIds = [];
  function Harness({ principalId }) {
    const [messages, setMessages] = React.useState([]); observed = messages;
    const cursor = React.useRef(null); const bottom = React.useRef(true); const late = React.useRef({});
    useLifecycle({ authUid: 'phone', principalId, tourId: 'TOUR_A', internalDriverChat: false,
      currentReactionUserIds: reactionIds, getMessageTimestamp: timestamp, lastLiveMessageCursorRef: cursor,
      isAtBottomRef: bottom, scrollToBottom: noop, setMessages, setChatLoadError: noop,
      setHasMoreHistory: noop, setLoading: noop, setNewMessagesCount: noop }, late);
    return null;
  }
  const rows = Array.from({ length: 81 }, (_, i) => ({ id: `message_${String(i).padStart(3, '0')}`, timestamp: 1000 }));
  try {
    await act(async () => { renderer = create(React.createElement(Harness, { principalId: 'passenger-a' })); });
    const oldCallback = callbacks[0];
    await act(async () => oldCallback(rows.slice(0, 80)));
    await act(async () => oldCallback(rows.slice(1)));
    assert.equal(observed.length, 81, 'falling outside the live limit must preserve loaded history');
    await act(async () => oldCallback(rows.slice(1, 80)));
    assert.equal(observed.some(row => row.id === 'message_080'), false);
    assert.equal(observed.some(row => row.id === 'message_000'), true);
    await act(async () => renderer.update(React.createElement(Harness, { principalId: 'driver:D-ONE' })));
    await act(async () => oldCallback(rows));
    assert.deepEqual(observed, []);
  } finally { await act(async () => renderer?.unmount()); }
});
