'use strict';

process.env.NODE_ENV = 'test';
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
const React = require('react');
const { act, create } = require('react-test-renderer');
const Module = require('node:module');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createAppSessionService, APP_SESSION_KEY } = require('../../services/appSessionService');
const { createLocalSessionCleanupService } = require('../../services/localSessionCleanupService');
const driverTourPackService = require('../../services/driverTourPackService');
const { normalizeTourId, resolveTourId } = require('../../services/tourIdentityService');
const { getCanonicalIdentity } = require('../../services/identityService');
const { sessionOwnsScope } = require('../../services/appSessionTransition');
let mountedService;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
  if (request.endsWith('/services/appSessionService')) return new Proxy({}, { get: (_target, key) => mountedService?.[key] });
  if (request.endsWith('/services/loggerService')) return { info() {}, warn() {} };
  if (request.endsWith('/services/accountDeletionService')) return { readPending: async () => null };
  if (request.endsWith('/notificationDeviceApiService')) return { endNotificationDeviceSession: async () => ({ success: true }) };
  return originalLoad(request, parent, isMain);
};
const useLogoutLifecycle = require('../../src/app/session/useLogoutLifecycle').default;
const useLogoutStatus = require('../../src/app/session/useLogoutStatus').default;
const { runHandleLoginSuccess } = require('../../src/app/session/loginRunners');
const { runHandleNotificationOnboardingComplete } = require('../../src/app/notifications/notificationOnboardingRunners');
const { runHandleDriverAssignmentChange, settleDriverAssignmentRetirement } = require('../../src/app/driver/driverAssignmentRunners');
const { runHandleSessionRevisionChange } = require('../../src/app/session/sessionRevisionRunners');
const { runSaveSessionProjection } = require('../../src/app/session/sessionSaveRunner');
const { runPurgeLocalSession, runClearSessionState, runHandleLogout } = require('../../src/app/session/logoutRunners');
Module._load = originalLoad;

const INITIAL = { schemaVersion: 1, sessionId: `sess_v1_${'a'.repeat(32)}`, principalType: 'driver',
  principalId: 'driver:D-DEMO', driverId: 'D-DEMO', tourId: 'TOUR_A', issuedAtMs: 1000,
  expiresAtMs: 20000, sessionRevision: 1 };
const assigned = (tourId, revision, expiresAtMs = 40000) => ({ ...INITIAL, tourId, sessionRevision: revision, expiresAtMs });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 80; index += 1) await Promise.resolve(); };
const KEYS = { BOOKING_DATA: '@LLT:bookingData', TOUR_DATA: '@LLT:tourData', LAST_SCREEN: '@LLT:lastScreen',
  IDENTITY_BINDING: '@LLT:identityBinding' };
const tourFor = id => id ? { id, tourCode: id, startDate: '2026-10-19' } : null;

async function mountDriverSession({ initial = null } = {}) {
  const previousEndEndpoint = process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
  process.env.EXPO_PUBLIC_END_APP_SESSION_URL = 'https://example.invalid/endAppSession';
  const values = new Map();
  const listeners = new Set();
  const capturedListeners = [];
  const timers = new Map();
  const calls = [];
  const controls = { now: 2000, remote: initial, tourGates: {}, failPurge: false, cleanupCount: 0 };
  const storage = { getItem: async key => {
    if (key === APP_SESSION_KEY) {
      controls.sessionReads = (controls.sessionReads || 0) + 1;
      if (controls.pauseSessionRead === controls.sessionReads) await controls.sessionReadGate?.promise;
    }
    return values.get(key) ?? null;
  },
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
    multiSet: async entries => { entries.forEach(([key, value]) => values.set(key, value)); },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)); } };
  const auth = { currentUser: { uid: 'uid-demo', getIdToken: async () => 'synthetic-token' } };
  const db = { ref: path => path.startsWith('app_sessions/') ? {
    on: (_event, callback) => { listeners.add(callback); capturedListeners.push(callback); },
    off: (_event, callback) => { listeners.delete(callback); },
    once: async () => ({ val: () => controls.remote }),
  } : { once: async () => { const id = path.split('/')[1]; calls.push(['tourRead', id]);
    await controls.tourGates[id]?.promise;
    return { exists: () => true, val: () => tourFor(id) };
  } } };
  const service = createAppSessionService({ storage, now: () => controls.now,
    getFirebase: () => ({ auth, realtimeDb: db }),
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }),
    scheduleTimer: (callback, delay) => { const key = Symbol(); timers.set(key, { callback, delay }); return key; },
    cancelTimer: key => timers.delete(key) });
  mountedService = service;
  if (initial) await service.persistSession(initial);
  const offline = { setActiveSessionScope: async scope => { calls.push(['offline', scope?.tourId || null]); },
    saveTourPack: async (id, _role, pack) => { await controls.packGate?.promise; calls.push(['pack', id, pack.driver.id]); },
    setTourPackMeta: async () => {}, purgeActionsForScope: async () => ({ success: true }),
    purgeTourPack: async () => ({ success: true }) };
  const driverLifecycle = { purge: async scope => { calls.push(['purge', scope.tourId]);
    return { success: !controls.failPurge }; } };
  const cleanup = createLocalSessionCleanupService({ storage, offline, driverLifecycle,
    clearNotifications: async () => { controls.cleanupCount += 1; }, photoCache: null,
    tripLifecycle: { stopPassengerTrip() {}, purgePassengerTrip: async () => {} } });
  const logger = { info() {}, warn() {}, error() {} };
  let api;
  function Probe() {
    const [appSession, setSessionState] = React.useState(initial);
    const [bookingData, setBookingData] = React.useState(initial ? { id: initial.driverId, assignedTourId: initial.tourId } : null);
    const [tourData, setTourData] = React.useState(tourFor(initial?.tourId));
    const [currentScreen, setCurrentScreen] = React.useState(initial ? 'DriverHome' : 'Login');
    const [screenParams, setScreenParams] = React.useState({});
    const { logoutStatus, logoutStatusRef, setLogoutStatus } = useLogoutStatus();
    const [, setDriverSessionGeneration] = React.useState(0);
    const appSessionRef = React.useRef(initial);
    const assignmentReconciliationRef = React.useRef(null);
    const loginProjectionRef = React.useRef(null);
    const loginAttemptRef = React.useRef(null);
    const sessionGenerationRef = React.useRef(0);
    const logoutContextRef = React.useRef(null);
    const driverLifecyclePurgeRef = React.useRef(null);
    const previousDriverOperationalScopeRef = React.useRef(null);
    const contextRef = React.useRef(null);
    const routeHistoryRef = React.useRef({ reset() { calls.push(['routeReset']); } });
    const setAppSession = React.useCallback(session => { appSessionRef.current = session; setSessionState(session); }, []);
    const scope = appSession && bookingData && tourData && bookingData.id === appSession.driverId && tourData.id === appSession.tourId
      ? { authUid: auth.currentUser.uid, driverId: bookingData.id, tourId: tourData.id, startDate: tourData.startDate,
        departureKey: bookingData.assignedDepartureKey } : null;
    const identity = getCanonicalIdentity({ authUser: auth.currentUser, bookingData });
    const offlineScope = scope && { tourId: scope.tourId, role: identity.principalType,
      principalId: identity.principalId, authUid: identity.authUid, cacheOwnerId: bookingData.id,
      sessionId: appSession.sessionId };
    const operationalScope = scope ? driverTourPackService.normalizeScope(scope) : null;
    contextRef.current = { appSession, bookingData, tourData, currentDriverLifecycleScope: scope,
      userUid: auth.currentUser.uid, get active() { return logoutStatusRef.current.state === 'idle'; }, currentScreen, screenParams };
    const deps = { SESSION_KEYS: KEYS, SessionStorage: storage, appSession, appSessionRef, appSessionService: service,
      assignmentReconciliationRef, loginAttemptRef, loginProjectionRef, getCurrentContext: () => contextRef.current,
      sessionGenerationRef, logoutContextRef, auth, user: auth.currentUser, bookingData, tourData,
      currentScreen, currentDriverLifecycleScope: scope, driverLifecyclePurgeRef,
      previousDriverOperationalScopeRef, setAppSession, setBookingData, setTourData, setCurrentScreen,
      setScreenParams, setLogoutStatus, setDriverSessionGeneration, setTourCode() {}, setIdentityBinding() {},
      routeHistoryRef, offlineSyncService: offline, driverOperationalLifecycleService: driverLifecycle,
      driverTourPackService, normalizeTourId, resolveTourId, realtimeDb: db, logger,
      stopDriverTracking: async () => { calls.push(['stop']); return { success: true }; },
      purgeDriverTracking: async () => {}, localSessionCleanupService: cleanup,
      accountDeletionService: { readPending: async () => null }, maskIdentifier: value => value,
      loginDiagnostics: { recordLoginDiagnostic: async event => {
        calls.push(['diagnostic', event]);
        if (event === 'app_login_success_handler_started') await controls.prepareGate?.promise;
        if (event === 'app_login_success_handler_completed') await controls.completedDiagnosticGate?.promise;
      }, summarizeError: () => ({}) },
      recordCrashBreadcrumb() {}, startLoginTransition() {}, getLoginTransitionDurationMs: () => 1000,
      shouldShowNotificationOnboarding: async () => { await controls.onboardingGate?.promise; return controls.onboard === true; },
      persistDriverIdentityForUser: async ({ driverId, assignedTourId }) => {
        calls.push(['identity', driverId, assignedTourId]);
        await controls.identityGate?.promise; return { driverId, assignedTourId };
      } };
    deps.saveSession = overrides => runSaveSessionProjection({ ...deps, passengerTripActive: false }, overrides);
    deps.reconcileDriverSession = event => runHandleDriverAssignmentChange(deps, event);
    deps.clearSessionState = options => runClearSessionState(deps, options);
    deps.settleDriverAssignmentRetirement = () => settleDriverAssignmentRetirement(assignmentReconciliationRef,
      { pendingLoginWork: () => loginProjectionRef.current?.projectionTask });
    deps.purgeLocalSession = options => runPurgeLocalSession(deps, options);
    useLogoutLifecycle({ ...deps, userUid: auth.currentUser.uid, isConnected: false, logoutStatus, logoutStatusRef,
      onSession: event => runHandleSessionRevisionChange(deps, event) });
    api = { state: { appSession, bookingData, tourData, currentScreen, screenParams, logoutStatus, scope }, deps,
      login: session => runHandleLoginSuccess(deps, session.driverId, tourFor(session.tourId),
        { id: session.driverId, name: 'Synthetic driver' }, 'driver', { appSession: session }),
      logout: () => runHandleLogout(deps), setAppSession,
      completeOnboarding: () => runHandleNotificationOnboardingComplete({ ...deps, homeScreen: 'DriverHome',
        saveNotificationOnboardingState: async state => { values.set('@LLT:notificationOnboarding', JSON.stringify(state)); },
        navigateTo: screen => { setScreenParams({}); setCurrentScreen(screen); void deps.saveSession({ currentScreen: screen }); },
      }, { status: 'completed', audience: 'driver', returnTo: 'DriverHome' }) };
    return React.createElement('driver-session-state', { driverMode: bookingData?.id?.startsWith('D-') === true,
      identity, offlineScope, offlineAuthorized: sessionOwnsScope(appSession, offlineScope),
      operationalScope, route: currentScreen });
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  return { get state() { return api.state; }, get deps() { return api.deps; },
    get rendered() { return renderer.root.findByType('driver-session-state').props; }, values, calls, controls,
    service, storage, timers, capturedListeners, listeners,
    login: session => api.login(session), logout: () => api.logout(), completeOnboarding: () => api.completeOnboarding(),
    emit: session => { controls.remote = session; for (const callback of [...listeners]) callback({ val: () => session }); },
    setSession: session => api.setAppSession(session),
    tick: now => { controls.now = now; for (const timer of [...timers.values()]) timer.callback(); },
    flush: () => act(flush), unmount: () => act(async () => {
      renderer.unmount();
      if (previousEndEndpoint === undefined) delete process.env.EXPO_PUBLIC_END_APP_SESSION_URL;
      else process.env.EXPO_PUBLIC_END_APP_SESSION_URL = previousEndEndpoint;
    }) };
}

module.exports = { mountDriverSession, INITIAL, assigned, deferred, act, flush, KEYS, APP_SESSION_KEY };
