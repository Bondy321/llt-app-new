'use strict';

process.env.NODE_ENV = 'test';
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
const { createAppSessionService } = require('../../services/appSessionService');
const { runHandleDriverAssignmentChange } = require('../../src/app/driver/driverAssignmentRunners');
const { runHandleSessionRevisionChange } = require('../../src/app/session/sessionRevisionRunners');
const driverTourPackService = require('../../services/driverTourPackService');
const { normalizeTourId } = require('../../services/tourIdentityService');

const INITIAL = { schemaVersion: 1, sessionId: `sess_v1_${'a'.repeat(32)}`,
  principalType: 'driver', principalId: 'driver:D-DEMO', driverId: 'D-DEMO', tourId: null,
  issuedAtMs: 1000, expiresAtMs: 20000, sessionRevision: 1 };
const assigned = (tourId, revision, expiresAtMs = 40000) => ({ ...INITIAL, tourId,
  sessionRevision: revision, expiresAtMs });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };

async function harness(initial = INITIAL, { database, authUid = 'uid-demo', initialNowMs = 2000,
  fetchFn = async () => { throw new Error('Unexpected synthetic HTTP request'); } } = {}) {
  let nowMs = initialNowMs;
  let listener;
  let remote = initial;
  const timers = new Map();
  const revoked = [];
  const pending = [];
  const calls = [];
  const values = new Map();
  const storage = { getItem: async key => values.get(key) ?? null,
    multiGet: async keys => keys.map(key => [key, values.get(key) ?? null]),
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
    multiRemove: async keys => { keys.forEach(key => values.delete(key)); },
    multiSet: async entries => { state.writeCount = (state.writeCount || 0) + 1;
      if (state.pauseWrites) { state.writeStarted = true; await state.pauseWrites.promise; }
      if (state.failWrites) throw new Error('Synthetic durable storage failure');
      entries.forEach(([key, value]) => values.set(key, value)); } };
  const state = { session: initial, booking: { id: initial.driverId, assignedTourId: initial.tourId,
    currentTourId: initial.tourId, driverAssignedTourId: initial.tourId, currentTourCode: initial.tourId },
    tour: initial.tourId ? { id: initial.tourId, startDate: '2026-10-19' } : null, screen: 'DriverHome', generation: 0 };
  const db = database || { ref: path => path.startsWith('app_sessions/') ? {
    on: (_event, callback) => { listener = callback; }, off() {}, once: async () => ({ val: () => remote }),
  } : { once: async () => { if (path.endsWith('TOUR_B') && state.pauseTourB) {
    state.tourReadStarted = true; await state.pauseTourB.promise;
  }
    return { exists: () => true, val: () => ({ tourCode: path.split('/')[1], startDate: '2026-10-19' }) }; } } };
  const service = createAppSessionService({ storage, now: () => nowMs, fetchFn,
    getFirebase: () => ({ realtimeDb: db, auth: { currentUser: { uid: state.uid || authUid,
      getIdToken: async () => 'synthetic-token' } } }),
    scheduleTimer: (callback, delay) => { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    cancelTimer: id => timers.delete(id) });
  await service.persistSession(initial);
  const deps = { appSessionService: service, appSessionRef: { current: initial },
    assignmentReconciliationRef: { current: null }, sessionGenerationRef: { current: 0 },
    getCurrentContext: () => ({ appSession: state.session, bookingData: state.booking, tourData: state.tour,
      currentDriverLifecycleScope: state.tour ? { authUid, driverId: initial.driverId, tourId: state.tour.id,
        departureKey: `2026-10-19::${state.tour.id}` } : null, userUid: state.uid || authUid,
      active: !state.loggedOut }),
    SESSION_KEYS: { BOOKING_DATA: 'booking', TOUR_DATA: 'tour', LAST_SCREEN: 'screen' },
    driverLifecyclePurgeRef: { current: null }, previousDriverOperationalScopeRef: { current: null },
    driverOperationalLifecycleService: { purge: async scope => { calls.push(['purge', scope.tourId]); return { success: true }; } },
    offlineSyncService: { setActiveSessionScope: async scope => { calls.push(['offline', scope?.tourId || null]); } },
    stopDriverTracking: async () => { calls.push(['stop']); return { success: true }; },
    driverTourPackService, normalizeTourId, realtimeDb: db,
    setAppSession: session => { state.session = session; deps.appSessionRef.current = session; },
    setBookingData: booking => { state.booking = booking; }, setTourData: tour => { state.tour = tour; },
    setTourCode: code => { state.code = code; }, setCurrentScreen: screen => { state.screen = screen; },
    setScreenParams() {}, routeHistoryRef: { current: { reset() {} } },
    setDriverSessionGeneration: update => { state.generation = update(state.generation); },
    logger: { warn() {}, error() {} } };
  deps.reconcileDriverSession = event => runHandleDriverAssignmentChange(deps, event);
  const accept = session => runHandleSessionRevisionChange(deps, { authUid, session });
  const unsubscribe = service.subscribe({ authUid, expectedSession: initial,
    onSession: ({ session }) => { const task = accept(session); pending.push(task); return task; },
    onRevoked: event => revoked.push(event) });
  return { state, deps, service, storage, calls, values, timers, revoked, accept, unsubscribe,
    setNow: value => { nowMs = value; }, emit: session => { remote = session; listener({ val: () => session }); },
    settle: async () => { await flush(); await Promise.all(pending.splice(0)); await flush(); } };
}


module.exports = { createDriverSessionReconciliationHarness: harness, INITIAL, assigned, deferred, flush };
