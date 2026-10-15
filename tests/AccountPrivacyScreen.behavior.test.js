'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;

require('@babel/register')({
  extensions: ['.js', '.jsx'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const host = name => {
  const Component = ({ children, ...props }) => React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};
const alerts = [];
const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (request === 'react-native') return {
    ActivityIndicator: host('ActivityIndicator'), Alert: { alert: (...args) => alerts.push(args) },
    Linking: { openURL: async () => {} }, ScrollView: host('ScrollView'),
    StyleSheet: { create: value => value }, Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'), View: host('View'),
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: host('SafeAreaView') };
  if (request === 'expo-linear-gradient') return { LinearGradient: host('LinearGradient') };
  if (request.includes('MaterialCommunityIcons')) return host('Icon');
  if (request.endsWith('/services/accountDeletionService')) return {
    DATA_REQUEST_EMAIL: 'privacy@example.test', PRIVACY_POLICY_URL: 'https://example.test/privacy',
  };
  if (request.endsWith('/services/loggerService')) return {
    __esModule: true, default: { info() {}, warn() {} }, maskIdentifier: () => 'masked',
  };
  return originalLoad(request, parent, isMain);
};
const Screen = require('../screens/AccountPrivacyScreen').default;
Module._load = originalLoad;

test('passenger deletion discloses booking-shared content before any destructive request', async () => {
  alerts.length = 0;
  let deletionCalls = 0;
  let logoutCalls = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Screen, {
      bookingData: { id: 'fixture-booking' },
      onDeleteAccount: async () => { deletionCalls += 1; return { success: true }; },
      onLogout: () => { logoutCalls += 1; },
    }));
  });
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Delete account' }).props.onPress());
  const [title, message, buttons] = alerts.at(-1);
  assert.equal(title, 'Delete account?');
  assert.match(message, /chat and photos shared by this booking/iu);
  assert.match(message, /including content used on other phones/iu);
  assert.match(message, /Other phones keep their own app access/iu);
  assert.match(message, /choose Log out instead/iu);
  assert.equal(deletionCalls, 0);
  assert.equal(buttons.find(button => button.text === 'Cancel').style, 'cancel');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Log out' }).props.onPress());
  assert.equal(logoutCalls, 1);
  assert.equal(deletionCalls, 0);
  await act(async () => buttons.find(button => button.text === 'Delete account').onPress());
  assert.equal(deletionCalls, 1);
  await act(async () => renderer.unmount());
});

test('driver deletion confirmation retains its operational preservation promise', async () => {
  alerts.length = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Screen, { isDriverSession: true }));
  });
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Delete account' }).props.onPress());
  const message = alerts.at(-1)[1];
  assert.match(message, /Shared operational chat, media, assignments, and canonical operations records are retained/iu);
  assert.doesNotMatch(message, /shared by this booking|Other phones keep/iu);
  await act(async () => renderer.unmount());
});
