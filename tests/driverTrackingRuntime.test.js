const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { create, act } = require('react-test-renderer');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = name => ({ children, ...props }) => React.createElement(name, props, children);
const platform = { OS: 'android' };
const appState = { currentState: 'active' };
const map = new Map();
const events = [];
const tasks = new Map();
const SID = `sess_v1_${'a'.repeat(32)}`;
const scope = { role: 'driver', authUid: 'native-driver', cacheOwnerId: 'D-NATIVE', principalId: 'driver:D-NATIVE',
  sessionId: SID, tourId: 'TOUR_NATIVE', expiresAtMs: Date.now() + 3600000 };
let permissions;
let registered = false;
let nativeOptions;
let network = true;
let services = true;
const location = {
  Accuracy: { High: 4 }, ActivityType: { AutomotiveNavigation: 3 },
  hasStartedLocationUpdatesAsync: async () => registered,
  hasServicesEnabledAsync: async () => services,
  getForegroundPermissionsAsync: async () => ({ status: permissions.foreground }),
  getBackgroundPermissionsAsync: async () => ({ status: permissions.background }),
  requestForegroundPermissionsAsync: async () => { events.push('foreground_permission'); return { status: permissions.foreground }; },
  requestBackgroundPermissionsAsync: async () => { events.push('background_permission'); return { status: permissions.background }; },
  startLocationUpdatesAsync: async (name, options) => { events.push('start'); nativeOptions = { name, options }; registered = true; },
  stopLocationUpdatesAsync: async () => { events.push('stop'); registered = false; },
};
const storage = { getItem: async key => map.get(key) || null, setItem: async (key, value) => map.set(key, value), removeItem: async key => map.delete(key) };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') return { AppState: appState, Platform: platform,
    StyleSheet: { create: value => value }, Modal: host('Modal'), View: host('View'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity') };
  if (request === 'expo-location') return location;
  if (request === 'expo-task-manager') return { isAvailableAsync: async () => true,
    isTaskDefined: name => tasks.has(name), defineTask: (name, callback) => tasks.set(name, callback) };
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: storage };
  if (request === '../../firebase') return { auth: { authStateReady: async () => {},
    currentUser: { uid: scope.authUid, getIdToken: async () => 'synthetic' } }, realtimeDb: {
    ref: path => ({ once: async () => ({ val: () => path === '.info/connected' ? network : 0 }),
      onDisconnect: () => ({ remove: async () => {}, cancel: async () => {} }) }),
  } };
  if (request === '../appSessionService') return { __esModule: true, default: {
    readPendingEnd: async () => null, readSession: async () => scope,
    verifyCurrent: async () => ({ valid: true, session: scope }),
  } };
  return originalLoad(request, parent, isMain);
};
process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL = 'https://synthetic.firebaseio.test';
process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'synthetic-test';
const originalFetch = global.fetch;
global.fetch = async (_url, options) => { events.push(options.method === 'POST' ? 'retire' : 'http_write');
  return { ok: true, json: async () => ({ success: true, withdrawalAcknowledged: true }) }; };
const { driverTracking, registerDriverTrackingTask } = require('../services/driver-tracking/driverTrackingRuntime');
const Card = require('../components/driver-home/DriverTrackingCard').default;
Module._load = originalLoad;

test.beforeEach(async () => {
  await driverTracking.stop(); map.clear(); events.length = 0;
  permissions = { foreground: 'granted', background: 'granted' }; registered = false;
  network = true; services = true; appState.currentState = 'active'; platform.OS = 'android';
  await driverTracking.setScope(scope);
});
test.after(async () => { await driverTracking.stop(); global.fetch = originalFetch; });
const start = () => driverTracking.start({ scope, disclosureAccepted: true });

test('task is globally registered once without prompting or native start', () => {
  registerDriverTrackingTask(); registerDriverTrackingTask();
  assert.equal(tasks.size, 1); assert.equal(events.length, 0);
});

test('Android starts a visible foreground service with foreground access only', async () => {
  assert.equal((await start()).success, true);
  assert.equal(events.includes('background_permission'), false);
  assert.deepEqual(events, ['foreground_permission', 'http_write', 'start']);
  const { options } = nativeOptions;
  assert.equal(options.foregroundService.killServiceOnDestroy, true);
  assert.match(options.foregroundService.notificationBody, /Open LLT to stop/);
  assert.equal(options.timeInterval, 60000);
  assert.equal(options.pausesUpdatesAutomatically, false);
});

test('iOS requests Always access after foreground access and enables the background indicator', async () => {
  platform.OS = 'ios'; assert.equal((await start()).success, true);
  assert.deepEqual(events.slice(0, 2), ['foreground_permission', 'background_permission']);
  assert.equal(nativeOptions.options.showsBackgroundLocationIndicator, true);
  assert.equal(nativeOptions.options.foregroundService, undefined);
});

test('denied iOS Always, disabled location services and background Start fail safely', async () => {
  platform.OS = 'ios'; permissions.background = 'denied';
  assert.equal((await start()).reason, 'ALWAYS_PERMISSION_REQUIRED');
  assert.equal(events.includes('http_write'), false);
  services = false; assert.equal((await start()).reason, 'LOCATION_SERVICES_DISABLED');
  services = true; appState.currentState = 'background';
  assert.equal((await start()).reason, 'START_INTERRUPTED');
  assert.equal(registered, false);
});

test('turning device location services off causes periodic health check to retire tracking', async () => {
  await start(); services = false;
  await driverTracking.checkCurrent();
  assert.equal(driverTracking.getSnapshot().active, false);
  assert.equal(registered, false); assert.equal(events.includes('retire'), true);
});

test('registered background task shares while app is backgrounded without restarting a service', async () => {
  registerDriverTrackingTask(); await start(); appState.currentState = 'background';
  await [...tasks.values()][0]({ data: { locations: [{ timestamp: Date.now(), coords: { latitude: 56.1, longitude: -4.2, accuracy: 15 } }] } });
  assert.equal(driverTracking.getSnapshot().state, 'sharing');
  assert.equal(events.filter(event => event === 'start').length, 1);
  assert.equal(events.filter(event => event === 'http_write').length, 2);
  assert.doesNotMatch([...map.values()].join(''), /latitude|longitude/);
});

test('offline task delivery reports paused and does not dispatch GPS writes', async () => {
  await start(); network = false;
  await driverTracking.handleLocations({ locations: [{ timestamp: Date.now(), coords: { latitude: 56.1, longitude: -4.2, accuracy: 15 } }] });
  assert.equal(driverTracking.getSnapshot().state, 'paused');
  assert.equal(events.filter(event => event === 'http_write').length, 1);
});

test('tracking card requires a separate disclosure confirmation and exposes retry cleanup', async () => {
  let starts = 0, stops = 0; let renderer;
  const tracking = { canStart: true, status: 'Tracking is off', start: () => { starts += 1; }, stop: () => { stops += 1; } };
  try {
    await act(async () => { renderer = create(React.createElement(Card, { tracking })); });
    assert.equal(renderer.root.findByType('Modal').props.visible, false);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Start coach tracking' }).props.onPress());
    assert.equal(starts, 0); assert.equal(renderer.root.findByType('Modal').props.visible, true);
    assert.match(JSON.stringify(renderer.toJSON()), /even when the app is in the background or your phone is locked/);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Continue to tracking permissions' }).props.onPress());
    assert.equal(starts, 1);
    await act(async () => renderer.update(React.createElement(Card, { tracking: { ...tracking, pending: true, status: 'Stop cleanup pending' } })));
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Retry stopping coach tracking' }).props.onPress());
    assert.equal(stops, 1);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});
