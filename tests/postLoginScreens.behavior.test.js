const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { create, act } = require('react-test-renderer');
const nativeMocks = require('./helpers/passengerTripNativeMocks');
require('@babel/register')({ extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
nativeMocks.install({ resolveModule(request) {
  if (request === 'expo-notifications') return {};
  if (request.endsWith('/services/notificationService')) return {
    getUserPreferences: async () => ({}),
    getNotificationDeviceReadiness: async () => ({}),
    primeNotificationPermissions: async () => ({ success: true, data: { state: 'denied' } }),
    saveUserPreferences: async () => ({ success: true }),
  };
  if (request === './useNotificationFeedController') return { __esModule: true, default: () => ({ items: [], unreadCount: 0 }) };
  if (request.endsWith('/NotificationFeedCard')) return { __esModule: true, default: () => null };
  return undefined;
} });
test.after(() => nativeMocks.restore());

test('tour home renders its initial loading screen before live data arrives', async () => {
  const TourHomeScreen = require('../screens/TourHomeScreen').default;
  let renderer;
  try {
    await act(async () => { renderer = create(React.createElement(TourHomeScreen, {
      tourCode: 'TEST1', tourData: { id: 'TEST1', name: 'Test tour' },
      bookingData: { id: 'TEST123' }, onNavigate: () => {}, onLogout: () => {},
    })); });
    assert.ok(renderer.root.findAllByType('View').length > 0);
    assert.ok(renderer.root.findByType('LinearGradient').props.style);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

for (const isOnboarding of [true, false]) {
  test(`notification preferences render and accept a custom marketing choice (onboarding=${isOnboarding})`, async () => {
    const Screen = require('../screens/NotificationPreferencesScreen').default;
    const View = require('../components/notification-preferences/NotificationPreferencesView').default;
    let renderer;
    try {
      await act(async () => { renderer = create(React.createElement(Screen, { userId: 'test-user', isOnboarding })); });
      const view = () => renderer.root.findByType(View);
      assert.equal(view().props.loading, false);
      assert.equal(view().props.permissionTone.label, 'Not enabled yet');
      await act(async () => view().props.setMarketingExpanded(true));
      const switches = renderer.root.findAllByType('Switch');
      assert.ok(switches.length > 0);
      await act(async () => switches[switches.length - 1].props.onValueChange(true));
      assert.equal(view().props.activeMarketingPreset, 'custom');
      assert.equal(view().props.hasChanges, true);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });
}
