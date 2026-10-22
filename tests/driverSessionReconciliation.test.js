'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { APP_SESSION_KEY } = require('../services/appSessionService');
const { createDriverSessionReconciliationHarness: harness, INITIAL, assigned, deferred, flush } = require('./helpers/driverSessionReconciliationHarness');
const { restoreStoredSessionProjection } = require('../src/app/session/sessionRestorePhases');
const { runSaveSessionProjection } = require('../src/app/session/sessionSaveRunner');
// External Firebase adapters remain inert; these tests exercise the actual
// application lifecycles without booting a real mobile SDK or network client.
const firebasePath = require.resolve('../firebase');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true,
  exports: { auth: { currentUser: null }, authHelpers: {}, realtimeDb: null, getCurrentAppCheckToken: async () => null } };
const { runRestoreSession } = require('../src/app/session/sessionBootstrapRunners');
const { runClearSessionState, runHandleLogout, runPurgeLocalSession } = require('../src/app/session/logoutRunners');
const { settleDriverAssignmentRetirement } = require('../src/app/driver/driverAssignmentRunners');

test('real listener reconciles first assignment, reassignment and removal without logout or split persisted scope', async () => {
  const h = await harness();
  try {
    for (const session of [assigned('TOUR_A', 2), assigned('TOUR_B', 3), assigned(null, 4)]) {
      h.emit(session); await h.settle();
      assert.deepEqual(h.revoked, []);
      assert.deepEqual(h.state.session, session);
      assert.equal(h.state.booking.assignedTourId, session.tourId);
      assert.equal(h.state.booking.currentTourId, session.tourId);
      assert.equal(h.state.booking.driverAssignedTourId, session.tourId);
      assert.equal(h.state.booking.currentTourCode, session.tourId);
      assert.equal(h.state.tour?.id || null, session.tourId);
      assert.deepEqual(JSON.parse(h.values.get(APP_SESSION_KEY)), session);
      assert.equal(JSON.parse(h.values.get('booking')).assignedTourId, session.tourId);
      assert.equal(JSON.parse(h.values.get('tour'))?.id || null, session.tourId);
      assert.equal(h.state.screen, 'DriverHome');
    }
    assert.deepEqual(h.calls.filter(call => call[0] === 'purge'), [['purge', 'TOUR_A'], ['purge', 'TOUR_B']]);
    assert.equal(h.calls.filter(call => call[0] === 'stop').length, 3);
    assert.equal(h.state.generation, 3);
    assert.ok(h.deps.sessionGenerationRef.current >= 3);
  } finally { h.unsubscribe(); }
});

test('realtime before HTTP and HTTP before realtime converge; older and duplicate responses never restore assignments', async () => {
  for (const realtimeFirst of [true, false]) {
    const h = await harness();
    try {
      const first = assigned('TOUR_A', 2);
      if (realtimeFirst) { h.emit(first); await h.settle(); await h.accept(first); }
      else { await h.accept(first); h.emit(first); await h.settle(); }
      const newest = assigned('TOUR_B', 4);
      h.emit(newest); await h.settle();
      h.emit(assigned('TOUR_A', 3)); await h.accept(first); await h.settle();
      assert.deepEqual(h.state.session, newest);
      assert.equal(h.state.tour.id, 'TOUR_B');
      assert.deepEqual(await h.service.readSession(), newest);
      assert.deepEqual(h.revoked, []);
      assert.equal(h.state.generation, 2);
    } finally { h.unsubscribe(); }
  }
});

test('a delayed tour load cannot restore old state after newer assignment, logout or replacement identity', async () => {
  for (const interruption of ['newer', 'logout', 'principal', 'installation']) {
    const h = await harness(assigned('TOUR_A', 2));
    try {
      h.state.pauseTourB = deferred();
      const old = h.accept(assigned('TOUR_B', 3)); await flush();
      if (interruption === 'newer') { h.emit(assigned('TOUR_C', 4)); }
      if (interruption === 'logout') { h.state.loggedOut = true; h.deps.appSessionRef.current = null; }
      if (interruption === 'principal') { h.state.session = { ...INITIAL, sessionId: `sess_v1_${'b'.repeat(32)}`,
        principalId: 'driver:D-OTHER', driverId: 'D-OTHER' }; h.deps.appSessionRef.current = h.state.session; }
      if (interruption === 'installation') h.state.uid = 'other-installation';
      h.state.pauseTourB.resolve(); await old; await h.settle();
      assert.notEqual(h.state.tour?.id, 'TOUR_B');
      if (interruption === 'newer') assert.equal(h.state.tour.id, 'TOUR_C');
    } finally { h.unsubscribe(); }
  }
});

test('an old installation listener cannot adopt an otherwise matching session after Auth replacement', async () => {
  const h = await harness();
  try {
    h.state.uid = 'replacement-installation';
    h.emit(assigned('TOUR_A', 2)); await h.settle();
    assert.equal(h.state.session.tourId, null);
    assert.equal(h.state.generation, 0);
    assert.equal((await h.service.readSession()).sessionRevision, 1);
  } finally { h.unsubscribe(); }
});

test('accepted expiry supersedes the previous timer; replacement session, principal and same-revision mutation revoke', async () => {
  const h = await harness();
  try {
    const oldTimer = [...h.timers.values()][0];
    const next = assigned('TOUR_A', 2, 60000);
    h.emit(next); await h.settle(); h.setNow(20001); oldTimer.callback();
    h.emit(INITIAL); await h.settle();
    assert.deepEqual(h.revoked, []);
    assert.equal([...h.timers.values()][0].delay, 39999);
    h.setNow(60000); [...h.timers.values()][0].callback();
    assert.deepEqual(h.revoked, [{ reason: 'SESSION_EXPIRED', session: next }]);
  } finally { h.unsubscribe(); }
  for (const patch of [{ sessionId: `sess_v1_${'b'.repeat(32)}` },
    { driverId: 'D-OTHER', principalId: 'driver:D-OTHER' }, { tourId: 'TOUR_A' }]) {
    const invalid = await harness();
    try { invalid.emit({ ...INITIAL, ...patch }); await invalid.settle();
      assert.deepEqual(invalid.revoked, [{ reason: 'SESSION_CHANGED', session: INITIAL }]);
    } finally { invalid.unsubscribe(); }
  }
});

test('driver restore reconciles a verified newer assignment and old navigation cannot overwrite the new persisted seed', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    const next = assigned('TOUR_B', 3);
    await h.service.persistSession(next);
    h.deps.appSessionRef.current = next;
    h.state.session = next;
    const restored = await restoreStoredSessionProjection({ ...h.deps,
      isOpaquePassengerId: () => false,
      normalizePassengerIdentityProjection: value => value, normalizePassengerTourProjection: value => value,
    }, next, [['tour', JSON.stringify(h.state.tour)], ['booking', JSON.stringify(h.state.booking)],
      ['screen', 'Chat'], ['binding', null]]);
    assert.equal(restored, true);
    assert.equal(h.state.tour.id, 'TOUR_B');
    await runSaveSessionProjection({ ...h.deps, appSession: assigned('TOUR_A', 2),
      SessionStorage: { multiSet: async () => { throw Error('driver bypassed guarded session adapter'); } },
      tourData: { id: 'TOUR_A' }, bookingData: { id: 'D-DEMO', assignedTourId: 'TOUR_A' },
      currentScreen: 'Chat' });
    assert.equal(JSON.parse(h.values.get('tour')).id, 'TOUR_B');
    assert.equal(JSON.parse(h.values.get('booking')).assignedTourId, 'TOUR_B');
    assert.deepEqual(await h.service.readSession(), next);
  } finally { h.unsubscribe(); }
});

test('revision-only same-tour updates extend authoritative expiry without restarting tracking, replay or navigation', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    h.state.screen = 'Chat';
    const next = assigned('TOUR_A', 3, 60000);
    h.emit(next); await h.settle();
    assert.deepEqual(h.state.session, next);
    assert.deepEqual(await h.service.readSession(), next);
    assert.equal(h.state.tour.id, 'TOUR_A');
    assert.equal(h.state.screen, 'Chat');
    assert.equal(h.state.generation, 0);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.revoked, []);
  } finally { h.unsubscribe(); }
});

test('failed old-tour retirement keeps the new scope unavailable and a duplicate authoritative event can retry safely', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    const next = assigned('TOUR_B', 3);
    h.deps.driverOperationalLifecycleService.purge = async () => ({ success: false });
    await assert.rejects(h.accept(next), /could not be fully retired/);
    assert.equal(h.state.session.principalType, 'driver');
    assert.equal(h.state.session.tourId, 'TOUR_B');
    assert.equal(h.state.tour, null);
    assert.equal(h.state.booking.currentTourId, null);
    assert.equal((await h.service.readSession()).tourId, 'TOUR_A');
    h.deps.driverOperationalLifecycleService.purge = async () => ({ success: true });
    h.emit(next); await h.settle();
    assert.equal(h.state.tour.id, 'TOUR_B');
    assert.deepEqual(await h.service.readSession(), next);
    assert.deepEqual(h.revoked, []);
  } finally { h.unsubscribe(); }
});

test('passenger revision-only events update React authority and storage monotonically without touching sibling scopes', async () => {
  const initial = { ...INITIAL, principalType: 'passenger', principalId: `pax_v2_${'b'.repeat(32)}`,
    driverId: null, tourId: 'TOUR_A' };
  const h = await harness(initial);
  try {
    const newest = { ...initial, sessionRevision: 3, expiresAtMs: 60000 };
    h.emit({ ...initial, sessionRevision: 2, expiresAtMs: 40000 });
    h.emit(newest); await h.settle();
    h.emit(initial); await h.settle();
    assert.deepEqual(h.state.session, newest);
    assert.deepEqual(await h.service.readSession(), newest);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.generation, 0);
    assert.deepEqual(h.revoked, []);
  } finally { h.unsubscribe(); }
});

test('duplicate driver and passenger authority retries an interrupted session-only persistence batch', async () => {
  for (const role of ['driver', 'passenger']) {
    const initial = role === 'driver' ? assigned('TOUR_A', 2) : { ...INITIAL, tourId: 'TOUR_A',
      principalType: 'passenger', principalId: `pax_v2_${'b'.repeat(32)}`, driverId: null };
    const h = await harness(initial);
    try {
      const next = { ...initial, sessionRevision: initial.sessionRevision + 1, expiresAtMs: 60000 };
      h.state.failWrites = true;
      h.emit(next); await assert.rejects(h.settle(), /durable storage failure/);
      assert.deepEqual(h.state.session, next);
      assert.deepEqual(await h.service.readSession(), initial);
      h.state.failWrites = false;
      h.emit(next); await h.settle();
      assert.deepEqual(await h.service.readSession(), next);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.revoked, []);
    } finally { h.unsubscribe(); }
  }
});

test('mounted logout lifecycle applies the real listener transition and still revokes a genuinely replaced session', async () => {
  const Module = require('node:module');
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const h = await harness();
  h.unsubscribe();
  const originalLoad = Module._load;
  let useLogoutLifecycle;
  Module._load = function load(request, parent, isMain) {
    if (request === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
    if (request.endsWith('/services/appSessionService')) return h.service;
    if (request.endsWith('/services/localSessionCleanupService')) return {};
    if (request.endsWith('/services/loggerService')) return { info() {}, warn() {} };
    return originalLoad(request, parent, isMain);
  };
  try { useLogoutLifecycle = require('../src/app/session/useLogoutLifecycle').default; }
  finally { Module._load = originalLoad; }
  let status;
  const purged = [];
  function Probe() {
    const [session, setSession] = React.useState(INITIAL);
    const [logoutStatus, setLogoutStatus] = React.useState({ state: 'idle' });
    status = logoutStatus;
    const context = React.useRef(null);
    h.deps.setAppSession = next => { h.state.session = next; h.deps.appSessionRef.current = next; setSession(next); };
    useLogoutLifecycle({ appSession: session, appSessionRef: h.deps.appSessionRef, userUid: 'uid-demo',
      isConnected: true, logoutContextRef: context, sessionGenerationRef: h.deps.sessionGenerationRef,
      logoutStatus, setLogoutStatus, setCurrentScreen() {},
      purgeLocalSession: async ({ capturedSession }) => { purged.push(capturedSession); return { success: true }; },
      onSession: ({ session: next }) => h.accept(next) });
    return React.createElement('driver-screen', { tour: h.state.tour?.id || null, role: session.principalType });
  }
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const next = assigned('TOUR_A', 2);
    await act(async () => { h.emit(next); await h.settle(); });
    assert.equal(status.state, 'idle');
    assert.equal(h.state.tour.id, 'TOUR_A');
    assert.equal(renderer.toJSON().props.role, 'driver');
    assert.equal(purged.length, 0);
    await act(async () => { h.emit({ ...next, sessionId: `sess_v1_${'f'.repeat(32)}` }); await flush(); });
    assert.equal(status.state, 'complete');
    assert.deepEqual(purged, [next]);
    assert.equal(await h.service.readSession(), null);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('assignment retires real replay, exact caches and in-flight GPS without transferring old work to the new tour', async () => {
  const offline = require('../services/offlineSyncService');
  const { createDriverOperationalLifecycleService } = require('../services/driverOperationalLifecycleService');
  const { createDriverTrackingController } = require('../services/driver-tracking/createDriverTrackingController');
  const h = await harness(assigned('TOUR_A', 2));
  const oldScope = { role: 'driver', authUid: 'uid-demo', cacheOwnerId: 'D-DEMO', principalId: INITIAL.principalId,
    tourId: 'TOUR_A', sessionId: INITIAL.sessionId, expiresAtMs: 40000 };
  const newScope = { ...oldScope, tourId: 'TOUR_B' };
  const trackingValues = new Map();
  const authority = deferred();
  const replay = deferred();
  let pauseAuthority = false;
  let gpsChecks = 0;
  let nativeStarts = 0;
  let publications = 0;
  let replayCalls = 0;
  const tracking = createDriverTrackingController({ now: () => 2000, makeId: () => 'track_session_demo',
    storage: { getItem: async key => trackingValues.get(key) || null,
      setItem: async (key, value) => { trackingValues.set(key, value); },
      removeItem: async key => { trackingValues.delete(key); } },
    native: { isForeground: () => true, requestPermissions: async () => {}, hasPermissions: async () => true,
      start: async () => { nativeStarts += 1; }, stop: async () => {} },
    verifyAuthority: async () => { if (pauseAuthority) { gpsChecks += 1; return authority.promise; } return { valid: true }; },
    writeFence: async () => {}, retireSession: async () => ({ withdrawalAcknowledged: true }),
    publish: async () => { publications += 1; return { timestamp: 2000, publicationAcknowledged: true }; } });
  try {
    await offline.setActiveSessionScope(oldScope);
    for (const [id, scope] of [['f01-old-1', oldScope], ['f01-old-2', oldScope], ['f01-new', newScope]]) {
      await offline.setActiveSessionScope(scope);
      assert.equal((await offline.enqueueAction({ id, type: 'MANIFEST_UPDATE', tourId: scope.tourId, scope,
        createdAt: id === 'f01-old-1' ? '2026-10-19T07:00:00Z' : '2026-10-19T07:01:00Z',
        payload: { bookingRef: id, marker: scope.tourId } })).success, true);
    }
    await offline.setActiveSessionScope(oldScope);
    await offline.saveTourPack('TOUR_A', 'driver', { marker: 'old' }, { ownerId: 'D-DEMO' });
    await tracking.setScope(oldScope);
    assert.equal((await tracking.start({ scope: oldScope, disclosureAccepted: true })).success, true);
    pauseAuthority = true;
    const gps = tracking.handleLocations({ locations: [{ timestamp: 2000, coords: { latitude: 56, longitude: -4, accuracy: 10 } }] });
    const oldReplay = offline.replayQueue({ scope: oldScope, services: { bookingService: {
      applyManifestUpdateDirect: async payload => { replayCalls += 1; assert.equal(payload.marker, 'TOUR_A'); return replay.promise; },
    } } });
    for (let attempt = 0; attempt < 100 && !replayCalls; attempt += 1) await new Promise(setImmediate);
    assert.equal(replayCalls, 1);
    assert.equal(gpsChecks, 1, 'the old GPS callback must be awaiting authority before reassignment');
    h.deps.offlineSyncService = offline;
    h.deps.stopDriverTracking = tracking.stop;
    h.deps.driverOperationalLifecycleService = createDriverOperationalLifecycleService({ offline,
      manifests: { purge: async () => ({ success: true }) },
      driverPacks: { purge: async () => ({ success: true }) },
      driverActions: { purge: async () => ({ success: true }) } });
    h.emit(assigned('TOUR_B', 3)); await h.settle();
    await offline.setActiveSessionScope(newScope);
    await tracking.setScope(newScope);
    authority.resolve({ valid: true }); replay.resolve({ success: true });
    await gps; await oldReplay;
    assert.equal(publications, 0);
    assert.equal(nativeStarts, 1, 'assignment must not implicitly start a second tracking session');
    assert.equal(tracking.getSnapshot().active, false);
    assert.equal(replayCalls, 1, 'the second old-tour action must not execute');
    const remaining = await offline.getQueuedActions({ includeAll: true });
    assert.deepEqual(remaining.data.map(action => [action.id, action.tourId]), [['f01-new', 'TOUR_B']]);
    assert.equal((await offline.getTourPack('TOUR_A', 'driver', { ownerId: 'D-DEMO' })).data, null);
    assert.equal((await offline.replayQueue({ scope: oldScope })).success, false);
    assert.equal(h.state.tour.id, 'TOUR_B');
  } finally {
    authority.resolve({ valid: false }); replay.resolve({ success: false }); h.unsubscribe();
    await tracking.stop(); await offline.setActiveSessionScope(null);
    for (const id of ['f01-old-1', 'f01-old-2', 'f01-new']) await offline.removeAction(id, { includeAll: true });
  }
});

test('failed assignment retirement can finish through actual user logout and remote-revocation retry without a new session event', async () => {
  const Module = require('node:module');
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const { createLocalSessionCleanupService } = require('../services/localSessionCleanupService');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previousEndpoint = process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
  process.env.EXPO_PUBLIC_END_APP_SESSION_URL = 'https://example.invalid/synthetic-session-end';
  try {
    for (const origin of ['user', 'remote']) {
      const h = await harness(assigned('TOUR_A', 2), { fetchFn: async () => ({ ok: true, status: 200,
        json: async () => ({ success: true, reason: 'ENDED' }) }) });
      let allowRetirement = false;
      let retireAttempts = 0;
      let trackingPurges = 0;
      const oldManifest = new Map([['TOUR_A', 'private old-tour data']]);
      h.deps.driverOperationalLifecycleService.purge = async scope => {
        if (scope.tourId === 'TOUR_A') {
          retireAttempts += 1;
          if (!allowRetirement) return { success: false };
          oldManifest.delete(scope.tourId);
        }
        return { success: true };
      };
      const next = assigned('TOUR_B', 3);
      await assert.rejects(h.accept(next), /could not be fully retired/);
      h.unsubscribe();
      const cleanup = createLocalSessionCleanupService({ storage: h.storage,
        offline: { setActiveSessionScope: async () => {}, purgeTourPack: async () => ({ success: true }),
          purgeActionsForScope: async () => ({ success: true }) },
        driverLifecycle: h.deps.driverOperationalLifecycleService,
        clearNotifications: async () => 0,
        photoCache: { clearPhotoViewerCache: async () => ({ success: true }) } });
      const originalLoad = Module._load;
      const hookPath = require.resolve('../src/app/session/useLogoutLifecycle');
      delete require.cache[hookPath];
      Module._load = function load(request, parent, isMain) {
        if (request === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
        if (request.endsWith('/services/appSessionService')) return h.service;
        if (request.endsWith('/services/localSessionCleanupService')) return cleanup;
        if (request.endsWith('/services/loggerService')) return { info() {}, warn() {} };
        return originalLoad(request, parent, isMain);
      };
      let useLogoutLifecycle;
      try { useLogoutLifecycle = require(hookPath).default; } finally { Module._load = originalLoad; }
      const controls = {};
      let contextRef;
      function Probe() {
        const [session, setSession] = React.useState(next);
        const [logoutStatus, setLogoutStatus] = React.useState({ state: 'idle' });
        const logoutContextRef = React.useRef(null);
        contextRef = logoutContextRef;
        controls.status = logoutStatus;
        h.deps.setAppSession = value => { h.state.session = value; h.deps.appSessionRef.current = value; setSession(value); };
        const purge = options => runPurgeLocalSession({ ...h.deps, appSession: h.state.session,
          auth: { currentUser: { uid: 'uid-demo' } }, logoutContextRef,
          localSessionCleanupService: cleanup,
          settleDriverAssignmentRetirement: () => settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef),
          purgeDriverTracking: async () => { trackingPurges += 1; },
          clearSessionState: () => runClearSessionState({ ...h.deps, SessionStorage: h.storage, setIdentityBinding() {} }),
        }, options);
        controls.logout = () => runHandleLogout({ ...h.deps, appSession: session,
          auth: { currentUser: { uid: 'uid-demo' } }, logoutContextRef,
          bookingData: h.state.booking, tourData: h.state.tour,
          appSessionService: h.service, setLogoutStatus, purgeLocalSession: purge,
          notificationDeviceEnd: async () => ({ success: true }), stopDriverTracking: h.deps.stopDriverTracking });
        controls.retry = useLogoutLifecycle({ appSession: session, appSessionRef: h.deps.appSessionRef,
          userUid: 'uid-demo', isConnected: true, logoutContextRef, logoutStatus, setLogoutStatus,
          sessionGenerationRef: h.deps.sessionGenerationRef, setCurrentScreen: h.deps.setCurrentScreen,
          purgeLocalSession: purge, onSession: ({ session: changed }) => h.accept(changed) });
        return null;
      }
      let renderer;
      try {
        await act(async () => { renderer = create(React.createElement(Probe)); });
        await act(async () => {
          if (origin === 'user') await controls.logout();
          else { h.emit(null); await flush(); }
        });
        assert.equal(controls.status.state, 'failed', origin);
        assert.equal(oldManifest.has('TOUR_A'), true);
        assert.equal(contextRef.current.appSession.sessionId, next.sessionId);
        assert.equal(trackingPurges, 0);
        allowRetirement = true;
        await act(async () => { await controls.retry(); });
        assert.equal(controls.status.state, 'complete', origin);
        assert.equal(oldManifest.size, 0, 'retry must retire captured A, not only the incomplete B projection');
        assert.ok(retireAttempts >= 3);
        assert.equal(trackingPurges, 1);
        assert.equal(await h.service.readSession({ allowExpired: true }), null);
        assert.equal(await h.service.readPendingEnd(), null);
        assert.equal(contextRef.current, null);
        assert.equal(h.state.screen, 'Login');
      } finally { if (renderer) await act(async () => renderer.unmount()); }
    }
  } finally {
    if (previousEndpoint === undefined) delete process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
    else process.env.EXPO_PUBLIC_END_APP_SESSION_URL = previousEndpoint;
  }
});

test('a failed retirement retry cannot clear a successor installation session or its newly written cache', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    let purges = 0;
    h.deps.driverOperationalLifecycleService.purge = async () => { purges += 1; return { success: false }; };
    const target = assigned('TOUR_B', 3);
    await assert.rejects(h.accept(target));
    const replacement = { ...target, sessionId: `sess_v1_${'c'.repeat(32)}`, sessionRevision: 1 };
    h.deps.appSessionRef.current = replacement;
    h.state.session = replacement;
    await h.service.persistSession(replacement);
    h.values.set('successor-cache', 'private successor data');
    await assert.rejects(settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef));
    assert.equal(purges, 1);
    const result = await runPurgeLocalSession({ ...h.deps, appSession: replacement,
      auth: { currentUser: { uid: 'uid-demo' } },
      settleDriverAssignmentRetirement: () => settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef),
      localSessionCleanupService: { cleanup: async () => { throw new Error('Successor cleanup must not run'); } },
    }, { capturedSession: target });
    assert.equal(result.success, false);
    assert.deepEqual(await h.service.readSession(), replacement);
    assert.equal(h.values.get('successor-cache'), 'private successor data');
  } finally { h.unsubscribe(); }
});

test('cold driver restore retires actual A queue/cache before exposing B and preserves its seed for a failed-retirement retry', async () => {
  const offline = require('../services/offlineSyncService');
  const { createDriverOperationalLifecycleService } = require('../services/driverOperationalLifecycleService');
  const h = await harness(assigned('TOUR_A', 2));
  const oldScope = { role: 'driver', authUid: 'uid-demo', cacheOwnerId: 'D-DEMO', principalId: INITIAL.principalId,
    tourId: 'TOUR_A', sessionId: INITIAL.sessionId };
  const next = assigned('TOUR_B', 3);
  let allowManifestPurge = false;
  const privateManifest = new Map([['TOUR_A', true]]);
  const lifecycle = createDriverOperationalLifecycleService({ offline,
    manifests: { purge: async ({ tourId }) => {
      if (!allowManifestPurge) return { success: false };
      privateManifest.delete(tourId); return { success: true };
    } }, driverPacks: { purge: async () => ({ success: true }) }, driverActions: { purge: async () => ({ success: true }) } });
  try {
    await offline.setActiveSessionScope(oldScope);
    assert.equal((await offline.enqueueAction({ id: 'cold-restore-A', type: 'MANIFEST_UPDATE',
      scope: oldScope, tourId: 'TOUR_A', payload: { bookingRef: 'synthetic-booking' } })).success, true);
    await offline.saveTourPack('TOUR_A', 'driver', { marker: 'private A pack' }, { ownerId: 'D-DEMO' });
    await h.storage.multiSet([['booking', JSON.stringify(h.state.booking)], ['tour', JSON.stringify(h.state.tour)], ['screen', 'Chat']]);
    await h.service.persistSession(next); h.deps.appSessionRef.current = next;
    const deps = { ...h.deps, SessionStorage: h.storage, driverOperationalLifecycleService: lifecycle,
      isOpaquePassengerId: () => false, normalizePassengerIdentityProjection: value => value,
      normalizePassengerTourProjection: value => value };
    await assert.rejects(runRestoreSession(deps, next), { code: 'DRIVER_ASSIGNMENT_RESTORE_PENDING' });
    assert.equal(JSON.parse(h.values.get('tour')).id, 'TOUR_A');
    assert.equal(h.state.tour.id, 'TOUR_A');
    allowManifestPurge = true;
    assert.equal(await runRestoreSession(deps, next), true);
    assert.equal(privateManifest.size, 0);
    assert.equal((await offline.getQueuedActions({ includeAll: true })).data.length, 0);
    assert.equal((await offline.getTourPack('TOUR_A', 'driver', { ownerId: 'D-DEMO' })).data, null);
    assert.equal(h.state.tour.id, 'TOUR_B');
    assert.equal(JSON.parse(h.values.get('tour')).id, 'TOUR_B');
    assert.deepEqual(await h.service.readSession(), next);
  } finally {
    h.unsubscribe(); await offline.setActiveSessionScope(null);
    await offline.removeAction('cold-restore-A', { includeAll: true });
  }
});

test('logout drains an accepted in-flight projection batch before clearing its captured session and tour seed', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    h.state.pauseWrites = deferred();
    const next = assigned('TOUR_B', 3);
    const assignment = h.accept(next);
    for (let attempt = 0; attempt < 100 && !h.state.writeStarted; attempt += 1) await new Promise(setImmediate);
    assert.equal(h.state.writeStarted, true);
    let cleanups = 0;
    const purge = runPurgeLocalSession({ ...h.deps, appSession: next,
      auth: { currentUser: { uid: 'uid-demo' } },
      settleDriverAssignmentRetirement: () => settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef),
      purgeDriverTracking: async () => {},
      localSessionCleanupService: { cleanup: async () => {
        cleanups += 1;
        await h.storage.multiRemove([APP_SESSION_KEY, 'booking', 'tour', 'screen']);
        return { success: true };
      } },
      clearSessionState: async () => {},
    }, { capturedSession: next });
    await flush();
    assert.equal(cleanups, 0, 'cleanup cannot race an already-issued native storage batch');
    const firstWrite = h.state.pauseWrites;
    h.state.pauseWrites = deferred();
    const newerAssignment = h.accept(assigned('TOUR_C', 4));
    firstWrite.resolve();
    await assignment;
    for (let attempt = 0; attempt < 100 && h.state.writeCount < 2; attempt += 1) await new Promise(setImmediate);
    assert.equal(h.state.writeCount, 2);
    h.state.loggedOut = true;
    // The drain must await the newer tail appended while the first batch was
    // pending, rather than clearing beneath its already-issued storage write.
    await flush();
    assert.equal(cleanups, 0);
    h.state.pauseWrites.resolve();
    await newerAssignment;
    assert.equal((await purge).success, true);
    assert.equal(cleanups, 1);
    assert.equal(await h.service.readSession({ allowExpired: true }), null);
    assert.equal(h.values.has('booking'), false);
    assert.equal(h.values.has('tour'), false);
    await flush();
    assert.equal(h.values.has('tour'), false, 'the old assignment cannot resurrect its seed after logout');
  } finally { h.state.pauseWrites?.resolve(); h.unsubscribe(); }
});

test('a stalled tour read bounds logout drain without clearing authority and late results stay fenced until safe retry', async () => {
  const h = await harness(assigned('TOUR_A', 2));
  try {
    h.state.pauseTourB = deferred();
    const next = assigned('TOUR_B', 3);
    const assignment = h.accept(next);
    for (let attempt = 0; attempt < 100 && !h.state.tourReadStarted; attempt += 1) await new Promise(setImmediate);
    assert.equal(h.state.tourReadStarted, true);
    const capturedTail = h.deps.assignmentReconciliationRef.current.tail;
    let expire;
    let canceled = 0;
    let cleanups = 0;
    const purgeDeps = { ...h.deps, appSession: next, auth: { currentUser: { uid: 'uid-demo' } },
      localSessionCleanupService: { cleanup: async () => {
        cleanups += 1; await h.storage.multiRemove([APP_SESSION_KEY, 'booking', 'tour']); return { success: true };
      } }, clearSessionState: async () => {}, purgeDriverTracking: async () => {} };
    const first = runPurgeLocalSession({ ...purgeDeps,
      settleDriverAssignmentRetirement: () => settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef, {
        timeoutMs: 25, scheduleTimer: (callback, delay) => { assert.equal(delay, 25); expire = callback; return 1; },
        cancelTimer: () => { canceled += 1; },
      }),
    }, { capturedSession: next });
    await flush();
    expire();
    assert.equal((await first).success, false);
    assert.equal(canceled, 1);
    assert.equal(cleanups, 0);
    assert.equal(h.deps.assignmentReconciliationRef.current.tail, capturedTail);
    assert.equal((await h.service.readSession()).tourId, 'TOUR_A');
    h.state.loggedOut = true;
    h.state.pauseTourB.resolve(); await assignment; await flush();
    assert.equal((await h.service.readSession()).tourId, 'TOUR_A', 'expired drain must not adopt its late assignment');
    assert.equal(h.state.tour, null);
    const retried = await runPurgeLocalSession({ ...purgeDeps,
      settleDriverAssignmentRetirement: () => settleDriverAssignmentRetirement(h.deps.assignmentReconciliationRef),
    }, { capturedSession: next });
    assert.equal(retried.success, true);
    assert.equal(cleanups, 1);
    assert.equal(await h.service.readSession({ allowExpired: true }), null);
  } finally { h.state.pauseTourB?.resolve(); h.unsubscribe(); }
});

test('a revoked callback between layout and passive cleanup ignores cleared or replaced React session authority', async () => {
  const Module = require('node:module');
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const replacement of [null, { ...INITIAL, sessionId: `sess_v1_${'d'.repeat(32)}` },
    { ...INITIAL, sessionId: `sess_v1_${'e'.repeat(32)}`, principalId: 'driver:D-OTHER', driverId: 'D-OTHER' }]) {
    const h = await harness();
    h.unsubscribe();
    const originalLoad = Module._load;
    const hookPath = require.resolve('../src/app/session/useLogoutLifecycle');
    delete require.cache[hookPath];
    Module._load = function load(request, parent, isMain) {
      if (request === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
      if (request.endsWith('/services/appSessionService')) return h.service;
      if (request.endsWith('/services/loggerService')) return { info() {}, warn() {} };
      return originalLoad(request, parent, isMain);
    };
    let useLogoutLifecycle;
    try { useLogoutLifecycle = require(hookPath).default; } finally { Module._load = originalLoad; }
    let status;
    const purged = [];
    function Probe({ session, interrupt }) {
      const [logoutStatus, setLogoutStatus] = React.useState({ state: 'idle' });
      const context = React.useRef(null);
      status = logoutStatus;
      h.deps.appSessionRef.current = session;
      useLogoutLifecycle({ appSession: session, appSessionRef: h.deps.appSessionRef,
        userUid: 'uid-demo', isConnected: true, logoutContextRef: context, logoutStatus, setLogoutStatus,
        sessionGenerationRef: h.deps.sessionGenerationRef, setCurrentScreen() {},
        purgeLocalSession: async ({ capturedSession }) => { purged.push(capturedSession); return { success: true }; } });
      React.useLayoutEffect(() => { if (interrupt) h.emit(null); }, [interrupt]);
      return null;
    }
    let renderer;
    try {
      await act(async () => { renderer = create(React.createElement(Probe, { session: INITIAL, interrupt: false })); });
      if (replacement) await h.service.persistSession(replacement);
      await act(async () => renderer.update(React.createElement(Probe, { session: replacement, interrupt: true })));
      assert.deepEqual(purged, []);
      assert.equal(status.state, 'idle');
      if (replacement) {
        assert.deepEqual(await h.service.readSession(), replacement);
        await act(async () => { h.emit(null); await flush(); });
        assert.deepEqual(purged, [replacement], 'the newly subscribed current session must still revoke normally');
        assert.equal(status.state, 'complete');
      }
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  }
});
