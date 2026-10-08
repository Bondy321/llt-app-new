const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { create, act } = require('react-test-renderer');
const nativeMocks = require('./helpers/passengerTripNativeMocks');
require('@babel/register')({ extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const events = [];
const status = { active: true, pending: false, state: 'sharing', status: 'Tracking test coach' };
const runtime = { subscribe: () => () => {}, getSnapshot: () => status,
  recover: async () => { events.push('recover'); }, setScope: async value => { events.push(['scope', value]); },
  checkCurrent: async () => {}, stop: async () => {}, start: async value => { events.push(['start', value]); }, purgeScope: async () => {} };
const host = name => ({ children, ...props }) => React.createElement(name, props, children);
nativeMocks.install({ resolveModule(request) {
  if (request === '../services/driver-tracking/driverTrackingRuntime') return { driverTracking: runtime };
  if (request === './navigation/AppScreenRouter') return host('Router');
  if (request.endsWith('/screens/LogoutPendingScreen')) return host('LogoutPending');
  if (request.endsWith('/screens/AccountDeletionPendingScreen')) return host('DeletionPending');
  return undefined;
} });
const useTracking = require('../hooks/useDriverTracking').default;
const AppShellView = require('../src/app/AppShellView').default;
test.after(() => nativeMocks.restore());

test('root tracking hook excludes passenger, initialization and logout scopes and does not start on navigation', async () => {
  let tracking; let renderer;
  const scope = { role: 'driver', authUid: 'test', sessionId: `sess_v1_${'a'.repeat(32)}`, tourId: 'TOUR_TEST',
    cacheOwnerId: 'D-TEST', principalId: 'driver:D-TEST' };
  const Probe = ({ session = scope, initializing = false, logoutState = 'idle', screen = 'DriverHome' }) => {
    tracking = useTracking(session, { initializing, logoutState, expiresAtMs: 1800000000000 });
    return React.createElement('Route', { screen });
  };
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(tracking.canStart, true);
    const driverScope = events.find(event => Array.isArray(event) && event[0] === 'scope')[1];
    assert.equal(driverScope.expiresAtMs, 1800000000000);
    await act(async () => renderer.update(React.createElement(Probe, { screen: 'Chat' })));
    assert.equal(events.filter(event => event === 'recover').length, 1);
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'start').length, 0);
    assert.equal(tracking.active, true);
    for (const props of [{ session: { ...scope, role: 'passenger' } }, { initializing: true }, { logoutState: 'requesting' }]) {
      await act(async () => renderer.update(React.createElement(Probe, props)));
      assert.equal(tracking.canStart, false);
      assert.equal(events.at(-1)[1], null);
    }
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

for (const surface of ['loading', 'auth_error', 'logout', 'deletion', 'route']) {
  test(`tracking cleanup status and Stop remain visible on ${surface} surface`, async () => {
    let renderer; let stops = 0;
    const props = { accountDeletionStatus: { state: 'idle' }, logoutStatus: { state: 'idle' },
      initializing: surface === 'loading', authError: surface === 'auth_error' ? 'offline' : null,
      insets: { top: 24 }, isConnected: true, edgeSwipeResponder: { panHandlers: {} }, routerProps: {},
      driverTracking: { active: false, pending: true, status: 'Updates off; stop cleanup pending', stop: () => { stops += 1; } } };
    if (surface === 'logout') props.logoutStatus = { state: 'pending_network' };
    if (surface === 'deletion') props.accountDeletionStatus = { state: 'accepted' };
    try {
      await act(async () => { renderer = create(React.createElement(AppShellView, props)); });
      assert.match(JSON.stringify(renderer.toJSON()), /Updates off; stop cleanup pending/);
      await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Stop coach tracking' }).props.onPress());
      assert.equal(stops, 1);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });
}
