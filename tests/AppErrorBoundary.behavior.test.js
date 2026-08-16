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

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') {
    const host = (name) => ({ children, ...props }) => React.createElement(name, props, children);
    return {
      StyleSheet: { create: (styles) => styles },
      Text: host('Text'),
      TouchableOpacity: host('TouchableOpacity'),
      View: host('View'),
    };
  }
  if (request.endsWith('services/loggerService')) {
    return { __esModule: true, default: { error: () => {} } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const AppErrorBoundary = require('../components/AppErrorBoundary').default;
Module._load = originalLoad;

const ThrowingScreen = () => {
  throw new Error('render exploded');
};

test('AppErrorBoundary replaces a broken render with an accessible recovery action', async () => {
  let renderer;
  let resetCalls = 0;

  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        AppErrorBoundary,
        { resetKey: 0, onReset: () => { resetCalls += 1; } },
        React.createElement(ThrowingScreen),
      ),
    );
  });

  const alert = renderer.root.findByProps({ accessibilityRole: 'alert' });
  assert.equal(alert.props.accessibilityLabel, 'The app encountered an unexpected problem');
  const button = renderer.root.findByProps({ accessibilityLabel: 'Try reopening the app' });

  await act(async () => {
    button.props.onPress();
  });

  assert.equal(resetCalls, 1);
});
