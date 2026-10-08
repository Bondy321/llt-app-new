const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { act, create } = require('react-test-renderer');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const removes = [];
let rejectRemoval = false;
const db = { ref: target => ({ remove: async () => {
  removes.push(target);
  if (rejectRemoval) throw new Error('OFFLINE');
}, onDisconnect: () => ({ cancel: async () => {} }) }) };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') return { Platform: { OS: 'android' } };
  if (request === 'expo-location') return { Accuracy: { Balanced: 3 } };
  if (request === '../hapticsService') return {};
  if (request === '../../firebase') return { realtimeDb: db };
  if (request.endsWith('/loggerService')) return { __esModule: true,
    default: { info: noop, debug: noop, warn: noop, error: noop }, maskIdentifier: value => value };
  return originalLoad(request, parent, isMain);
};
const { default: createActions } = require('../services/driver-home/createDriverLocationSharingActions');
const { default: usePreference } = require('../hooks/useDriverAutoSharePreference');
Module._load = originalLoad;
const SID = `sess_v1_${'a'.repeat(32)}`;
const baseScope = { sessionId: SID, authUid: 'synthetic-driver' };
const capture = async () => ({ success: true, location: { timestamp: Date.now(),
  coords: { latitude: 56, longitude: -4, accuracy: 10 } } });
let state;
const Probe = ({ enabledInitially = false, tourId = 'TOUR_A', scope = baseScope,
  captureLocation = capture, save = async () => {}, initialPoint = null, active = true, load, driverId = 'D-ONE',
  upload = async () => ({ timestamp: Date.now() }) }) => {
  const [status, setStatus] = React.useState('');
  const [point, setPoint] = React.useState(initialPoint);
  const [banner, setBanner] = React.useState(null);
  const activeTourIdRef = React.useRef(tourId); activeTourIdRef.current = tourId;
  const driverIdRef = React.useRef(driverId); driverIdRef.current = driverId;
  const scopeRef = React.useRef(scope); scopeRef.current = scope;
  const activeRef = React.useRef(active); activeRef.current = active;
  const sessionRef = React.useRef(null);
  const pending = React.useRef(new Map());
  const preferenceGenerationRef = React.useRef(0);
  const persistenceRef = React.useRef({ setItemAsync: save,
    getItemAsync: load || (async () => enabledInitially ? 'true' : 'false') });
  const { enabled, setEnabled } = usePreference({ persistenceRef,
    preferenceKey: `synthetic-pref-${driverId}`, driverId,
    generationRef: preferenceGenerationRef, setStatus });
  const enabledRef = React.useRef(enabled); enabledRef.current = enabled;
  const context = {
    activeTourId: tourId, activeTourIdRef, driverIdRef, driverData: { id: driverId },
    autoShareEnabled: enabled, autoShareEnabledRef: enabledRef,
    autoShareGenerationRef: React.useRef(0), autoShareInFlightRef: React.useRef(null),
    autoShareInitialLocationRef: React.useRef(null), autoSharePendingWithdrawalsRef: pending,
    autoSharePreferenceGenerationRef: preferenceGenerationRef,
    autoSharePreferenceKey: `synthetic-pref-${driverId}`, autoShareSessionRef: sessionRef,
    autoShareToggleInFlightRef: React.useRef(false), locationSessionScope: scope,
    locationSessionScopeRef: scopeRef, isAppActive: active, isAppActiveRef: activeRef,
    persistenceRef, locationBusyRef: React.useRef(false),
    lastLocationAddressRef: React.useRef(''), previewRequestIdRef: React.useRef(0),
    captureCurrentLocationWithPermission: captureLocation, uploadLocationUpdate: upload,
    setAutoShareEnabled: setEnabled, setAutoShareStatus: setStatus, setLastLocationUpdate: setPoint,
    showBanner: setBanner, setAutoShareSaving: noop, setAutoShareLastRunAt: noop, setLocationAccuracy: noop,
    setJoinModalVisible: noop, setAddressLoading: noop, setAddressText: noop, setPreviewLocation: noop,
    setPreviewModalVisible: noop, setUpdatingLocation: noop,
  };
  state = { ...createActions(context), enabled, enabledRef, status, point, banner, sessionRef, pending, setPoint };
  return null;
};
test.beforeEach(() => { removes.length = 0; rejectRemoval = false; });

test('OFF is truthful after a failed delete and rerender; Retry retains the exact retired session', async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(Probe, { enabledInitially: true })); });
  const session = state.sessionRef.current;
  const target = `driver_location_sessions/${SID}|${session.sessionId}`;
  await act(async () => state.setPoint({ appSessionId: SID, liveSharingSessionId: session.sessionId, latitude: 56 }));
  rejectRemoval = true;
  await act(async () => state.handleToggleAutoShare(false));
  assert.equal(state.enabled, false);
  assert.equal(state.enabledRef.current, false);
  assert.equal(state.sessionRef.current, null);
  assert.match(state.status, /removal is pending/);
  assert.equal(state.pending.current.size, 1);
  await act(async () => renderer.update(React.createElement(Probe, { enabledInitially: true })));
  const retry = state.banner.actionHandler;
  rejectRemoval = false;
  await act(async () => retry());
  assert.equal(state.pending.current.size, 0);
  assert.equal(state.status, 'Auto-share is off');
  assert.equal(state.point, null);
  assert.ok(removes.length >= 2);
  assert.ok(removes.every(value => value === target));
  await act(async () => renderer.unmount());
});

test('OFF without an active session keeps the public pickup and performs no fabricated withdrawal', async () => {
  let renderer;
  const point = { mode: 'pickup', latitude: 55.9 };
  await act(async () => { renderer = create(React.createElement(Probe, { initialPoint: point })); });
  await act(async () => state.handleToggleAutoShare(false));
  assert.deepEqual(state.point, point);
  assert.equal(removes.length, 0);
  assert.equal(state.status, 'Auto-share is off');
  await act(async () => renderer.unmount());
});

test('OFF preserves another device public point even when this device has an active session', async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(Probe, { enabledInitially: true })); });
  const point = { mode: 'live', latitude: 56.2 };
  await act(async () => state.setPoint(point));
  await act(async () => state.handleToggleAutoShare(false));
  assert.deepEqual(state.point, point);
  await act(async () => renderer.unmount());
});

test('assignment change during permission capture cannot enable the captured tour', async () => {
  let renderer; let resolveCapture; let saves = 0;
  const captureLocation = () => new Promise(resolve => { resolveCapture = resolve; });
  const props = { captureLocation, save: async () => { saves += 1; } };
  await act(async () => { renderer = create(React.createElement(Probe, props)); });
  let toggle;
  await act(async () => { toggle = state.handleToggleAutoShare(true); });
  await act(async () => renderer.update(React.createElement(Probe, { ...props, tourId: 'TOUR_B' })));
  await act(async () => { resolveCapture(await capture()); await toggle; });
  assert.equal(state.enabled, false);
  assert.equal(state.sessionRef.current, null);
  assert.equal(saves, 0);
  assert.match(state.banner.message, /assignment changed/);
  await act(async () => renderer.unmount());
});

test('app session change while saving cannot start sharing under a stale login', async () => {
  let renderer; let resolveSave; let preference; const saves = [];
  const props = { save: (_key, value) => {
    preference = value; saves.push(value);
    return value === 'true' ? new Promise(resolve => { resolveSave = resolve; }) : Promise.resolve();
  } };
  await act(async () => { renderer = create(React.createElement(Probe, props)); });
  let toggle;
  await act(async () => { toggle = state.handleToggleAutoShare(true); });
  await act(async () => renderer.update(React.createElement(Probe, { ...props,
    scope: { ...baseScope, sessionId: `sess_v1_${'b'.repeat(32)}` } })));
  await act(async () => { resolveSave(); await toggle; });
  assert.equal(state.enabled, false);
  assert.equal(state.sessionRef.current, null);
  assert.equal(preference, 'false');
  assert.deepEqual(saves, ['true', 'false']);
  assert.match(state.banner.message, /session.*changed/);
  await act(async () => renderer.unmount());
});

test('clearing the secure scope during GPS capture withdraws the exact session and prevents a late upload', async () => {
  let renderer; let resolveCapture; let uploads = 0;
  const props = { enabledInitially: true, captureLocation: () => new Promise(resolve => { resolveCapture = resolve; }),
    upload: async () => { uploads += 1; return { timestamp: Date.now() }; } };
  await act(async () => { renderer = create(React.createElement(Probe, props)); });
  const session = state.sessionRef.current;
  await act(async () => renderer.update(React.createElement(Probe, { ...props, scope: null })));
  await act(async () => resolveCapture(await capture()));
  assert.equal(uploads, 0);
  assert.equal(state.sessionRef.current, null);
  assert.deepEqual(removes, [`driver_location_sessions/${SID}|${session.sessionId}`]);
  await act(async () => renderer.unmount());
});

test('background and unmount retire their own sessions; foreground resumes with a fresh source key', async () => {
  let renderer;
  const props = { enabledInitially: true };
  await act(async () => { renderer = create(React.createElement(Probe, props)); });
  const first = state.sessionRef.current.sessionId;
  await act(async () => renderer.update(React.createElement(Probe, { ...props, active: false })));
  assert.equal(state.sessionRef.current, null);
  await act(async () => renderer.update(React.createElement(Probe, props)));
  const second = state.sessionRef.current.sessionId;
  assert.notEqual(first, second);
  assert.deepEqual(removes, [`driver_location_sessions/${SID}|${first}`]);
  await act(async () => renderer.unmount());
  assert.deepEqual(removes, [`driver_location_sessions/${SID}|${first}`, `driver_location_sessions/${SID}|${second}`]);
});

test('a delayed preference read cannot turn sharing back on after acknowledged OFF', async () => {
  let renderer; let resolveLoad;
  await act(async () => { renderer = create(React.createElement(Probe, {
    load: () => new Promise(resolve => { resolveLoad = resolve; }),
  })); });
  await act(async () => state.handleToggleAutoShare(false));
  await act(async () => resolveLoad('true'));
  assert.equal(state.enabled, false);
  assert.equal(state.sessionRef.current, null);
  assert.equal(state.status, 'Auto-share is off');
  assert.equal(removes.length, 0);
  await act(async () => renderer.unmount());
});

test('a delayed preference error cannot turn sharing off after a completed explicit enable', async () => {
  let renderer; let rejectLoad;
  await act(async () => { renderer = create(React.createElement(Probe, {
    load: () => new Promise((_resolve, reject) => { rejectLoad = reject; }),
  })); });
  await act(async () => state.handleToggleAutoShare(true));
  const session = state.sessionRef.current;
  await act(async () => rejectLoad(new Error('stale disk failure')));
  assert.equal(state.enabled, true);
  assert.equal(state.sessionRef.current, session);
  await act(async () => renderer.unmount());
});

test('a reused controller never inherits another driver enabled preference while the new read is pending', async () => {
  let renderer; let resolveNewLoad; const uploads = [];
  const props = { load: key => key.endsWith('D-ONE') ? Promise.resolve('true')
    : new Promise(resolve => { resolveNewLoad = resolve; }),
  upload: async (_location, _source, options) => { uploads.push(options.targetDriverId); return { timestamp: Date.now() }; } };
  await act(async () => { renderer = create(React.createElement(Probe, props)); });
  assert.equal(state.enabled, true);
  await act(async () => renderer.update(React.createElement(Probe, { ...props, driverId: 'D-TWO',
    scope: { sessionId: `sess_v1_${'c'.repeat(32)}`, authUid: 'synthetic-driver-two' } })));
  assert.equal(state.enabled, false);
  assert.equal(state.sessionRef.current, null);
  assert.deepEqual(uploads, ['D-ONE']);
  await act(async () => resolveNewLoad('false'));
  assert.equal(state.enabled, false);
  assert.deepEqual(uploads, ['D-ONE']);
  await act(async () => renderer.unmount());
});
