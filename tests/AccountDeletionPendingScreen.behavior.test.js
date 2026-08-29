const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const host = (name) => {
  const Component = ({ children, ...props }) => React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};
const originalLoad = Module._load;
Module._load = function mocked(request, parent, isMain) {
  if (request === 'react-native') return {
    ActivityIndicator: host('ActivityIndicator'),
    StyleSheet: { create: (styles) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
  if (request === 'react-native-safe-area-context') return { SafeAreaView: host('SafeAreaView') };
  if (request.includes('MaterialCommunityIcons')) return host('Icon');
  return originalLoad(request, parent, isMain);
};
const Screen = require('../screens/AccountDeletionPendingScreen').default;
Module._load = originalLoad;

const text = (node) => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return '';
};
const allText = (root) => root.findAll((node) => node.type === 'Text')
  .map((node) => text(node.props.children));

test('pending screen says deletion continues safely and disables offline retry', async () => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Screen, {
      state: 'pending',
      phase: 'chat_scrub',
      isConnected: false,
      onRetry: () => {},
    }));
  });
  const copy = allText(renderer.root).join(' ');
  assert.match(copy, /secure recovery receipt is saved/iu);
  assert.match(copy, /Secure step: chat scrub/iu);
  assert.equal(renderer.root.findByType('TouchableOpacity').props.disabled, true);
});

test('completion is only announced for backend completed state', async () => {
  let pendingRenderer;
  let completedRenderer;
  await act(async () => {
    pendingRenderer = TestRenderer.create(React.createElement(Screen, {
      state: 'pending', isConnected: true, onRetry: () => {},
    }));
    completedRenderer = TestRenderer.create(React.createElement(Screen, {
      state: 'completed', isConnected: true, onDone: () => {},
    }));
  });
  assert.doesNotMatch(allText(pendingRenderer.root).join(' '), /Account deletion complete/iu);
  assert.match(allText(completedRenderer.root).join(' '), /Account deletion complete/iu);
  assert.match(allText(completedRenderer.root).join(' '), /Travel booking records may still be retained/iu);
});
