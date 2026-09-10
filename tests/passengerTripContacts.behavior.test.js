const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act, create } = require('react-test-renderer');
const mocks = require('./helpers/passengerTripNativeMocks');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mocks.install();
const native = require('react-native');
mocks.restore();
native.Animated.Value.prototype.setValue = () => {};
native.Animated.ScrollView = native.ScrollView;
native.Keyboard = { addListener: () => ({ remove() {} }) };
native.KeyboardAvoidingView = native.View;
native.Switch = native.View;
const dialled = []; const presence = [];
native.Linking.openURL = async (url) => { dialled.push(url); };
mocks.install({ resolveModule: (request) => {
  if (request === 'react-native') return native;
  if (request.endsWith('/services/safetyService')) return { CATEGORY_META: {}, SEVERITY_META: {} };
  if (request.endsWith('/services/chatService')) return { setOnlinePresence: (...args) => presence.push(args), setTypingStatus() {} };
  if (request.endsWith('/services/offlineSyncService')) return { __esModule: true, default: { subscribeQueuedActions: () => () => {} } };
  return undefined;
} });
const WebMap = require('../screens/MapScreen.web').default;
const SafetyView = require('../components/safety-support/SafetySupportView').default;
const useChatDraftTypingLifecycle = require('../components/chat/useChatDraftTypingLifecycle').default;
const button = (renderer, label) => renderer.root.findAll((n) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === label)[0];
test.after(() => mocks.restore());

test('web map and Safety Support dial the reassigned driver and remove withdrawn contact', async () => {
  let map; let safety;
  const original = { id: 'SYNTHETIC', driverName: 'First Driver', driverPhone: '+44 7000 000001' };
  const next = { ...original, driverName: 'Next Driver', driverPhone: '+44 7000 000002' };
  const safetyProps = { tourData: original, isConnected: true, isDriver: false, visibleCategories: [],
    trustedContacts: [], safetyHistory: [], offlineQueueCount: 0, operationsNumber: 'OPS', emergencyNumber: '999',
    openDialer: (phone) => dialled.push(phone), sosDeliveryState: { status: 'idle' } };
  await act(async () => {
    map = create(React.createElement(WebMap, { tourData: original }));
    safety = create(React.createElement(SafetyView, safetyProps));
  });
  await act(async () => {
    map.update(React.createElement(WebMap, { tourData: next }));
    safety.update(React.createElement(SafetyView, { ...safetyProps, tourData: next }));
  });
  await act(async () => button(map, 'Call your assigned driver').props.onPress());
  await act(async () => button(safety, 'Call driver').props.onPress());
  assert.deepEqual(dialled, ['tel:+447000000002', '+44 7000 000002']);
  await act(async () => {
    map.update(React.createElement(WebMap, { tourData: { id: original.id } }));
    safety.update(React.createElement(SafetyView, { ...safetyProps, tourData: { id: original.id } }));
  });
  assert.equal(button(map, 'Call your assigned driver'), undefined);
  assert.equal(button(safety, 'Call driver'), undefined);
  assert.ok(button(safety, 'Emergency')); assert.ok(button(safety, 'Operations')); assert.ok(button(safety, 'Driver'));
  await act(async () => { map.unmount(); safety.unmount(); });
});

test('a display name correction keeps the active chat presence lifecycle attached', async () => {
  const noop = () => {};
  const context = { tourId: 'SYNTHETIC', statusActorId: 'SYNTHETIC_ACTOR', chatScope: 'group',
    offlineSessionScope: {}, chatQueueScope: {}, isAtBottomRef: { current: false }, typingTimeoutRef: { current: null },
    scrollToBottom: noop, setDraftRestored: noop, setInputText: noop, setIsKeyboardVisible: noop,
    setKeyboardHeight: noop, setQueueStats: noop, summarizeChatQueueActions: noop, userName: 'Original', isDriver: false };
  const late = { current: {} };
  const Probe = (props) => { useChatDraftTypingLifecycle(props, late); return null; };
  let renderer;
  await act(async () => { renderer = create(React.createElement(Probe, context)); });
  assert.equal(presence.length, 1);
  await act(async () => renderer.update(React.createElement(Probe, { ...context, userName: 'Corrected' })));
  assert.equal(presence.length, 1);
  await act(async () => renderer.unmount());
  assert.equal(presence.length, 2); assert.equal(presence[1][2], 'Corrected');
});
