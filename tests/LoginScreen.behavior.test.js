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

require.extensions['.png'] = (module) => {
  module.exports = 'mock-image';
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const createHost = (name) => {
  const Comp = ({ children, ...props }) => React.createElement(name, props, children);
  Comp.displayName = name;
  return Comp;
};

const extractText = (children) => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
};

const getAllText = (root) => root
  .findAll((node) => node.type === 'Text')
  .map((node) => extractText(node.props.children))
  .filter(Boolean);

const hasText = (root, value) => getAllText(root).includes(value);

const findTextInputByPlaceholder = (root, placeholder) => root
  .findAll((node) => node.type === 'TextInput')
  .find((node) => node.props.placeholder === placeholder);

const findTouchableByText = (root, text) => root
  .findAll((node) => node.type === 'TouchableOpacity')
  .find((touchable) => touchable
    .findAll((child) => child.type === 'Text')
    .some((textNode) => extractText(textNode.props.children) === text));

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    const Text = createHost('Text');
    const AnimatedValue = class {
      constructor(value) {
        this.value = value;
      }
      setValue(next) {
        this.value = next;
      }
    };

    const immediateAnimation = () => ({ start: (callback) => callback?.() });

    return {
      StyleSheet: { create: (styles) => styles },
      Text,
      View: createHost('View'),
      TextInput: createHost('TextInput'),
      TouchableOpacity: createHost('TouchableOpacity'),
      ScrollView: createHost('ScrollView'),
      KeyboardAvoidingView: createHost('KeyboardAvoidingView'),
      ActivityIndicator: createHost('ActivityIndicator'),
      Image: createHost('Image'),
      Alert: { alert: () => {} },
      Linking: { canOpenURL: async () => false, openURL: async () => false },
      Platform: { OS: 'ios' },
      Dimensions: { get: () => ({ height: 900, width: 400 }) },
      Animated: {
        Value: AnimatedValue,
        View: createHost('AnimatedView'),
        timing: immediateAnimation,
        sequence: () => immediateAnimation(),
      },
    };
  }

  if (request === 'react-native-safe-area-context') {
    return { SafeAreaView: createHost('SafeAreaView') };
  }

  if (request === '@expo/vector-icons') {
    return { MaterialCommunityIcons: createHost('MaterialCommunityIcons') };
  }

  if (request === 'expo-linear-gradient') {
    return { LinearGradient: createHost('LinearGradient') };
  }

  if (request.endsWith('/theme') || request === '../theme') {
    return {
      COLORS: {
        primary: '#1E40AF',
        primaryDark: '#1D4ED8',
        primaryMuted: '#DBEAFE',
        white: '#FFFFFF',
        error: '#EF4444',
        textPrimary: '#111827',
        background: '#F3F4F6',
        textMuted: '#9CA3AF',
        border: '#E5E7EB',
        textSecondary: '#6B7280',
      },
    };
  }

  if (request.endsWith('/services/loggerService') || request === '../services/loggerService') {
    return {
      __esModule: true,
      default: {
        trackScreen: () => {},
        info: () => {},
        error: () => {},
        trackEvent: () => {},
      },
      maskIdentifier: (value) => value,
    };
  }

  if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
    return {
      validateBookingReference: async () => ({ valid: false, error: 'invalid' }),
    };
  }

  return originalLoad(request, parent, isMain);
};

const renderLoginScreen = async (props = {}) => {
  const LoginScreen = require('../screens/LoginScreen').default;
  let renderer;

  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(LoginScreen, {
        onLoginSuccess: async () => {},
        logger: { trackScreen: () => {}, info: () => {}, error: () => {}, trackEvent: () => {} },
        isConnected: true,
        resolveOfflineLogin: async () => ({ success: false, reason: 'NO_CACHED_SESSION' }),
        ...props,
      })
    );
  });

  await waitForEffects();
  return renderer;
};

test('LoginScreen defers invalid email format error until blur, then shows it', async () => {
  const renderer = await renderLoginScreen();
  const root = renderer.root;

  const codeInput = findTextInputByPlaceholder(root, 'Booking or driver code');
  await act(async () => {
    codeInput.props.onChangeText('ABC123');
  });

  const emailInput = findTextInputByPlaceholder(root, 'Booking email');
  await act(async () => {
    emailInput.props.onChangeText('invalid-email');
  });

  assert.equal(hasText(root, 'Please enter a valid booking email (for example, name@example.com).'), false);

  await act(async () => {
    emailInput.props.onBlur();
  });

  assert.equal(hasText(root, 'Please enter a valid booking email (for example, name@example.com).'), true);
});

test('LoginScreen shows invalid email error on submit when format is invalid', async () => {
  const renderer = await renderLoginScreen();
  const root = renderer.root;

  await act(async () => {
    findTextInputByPlaceholder(root, 'Booking or driver code').props.onChangeText('ABC123');
  });
  await act(async () => {
    findTextInputByPlaceholder(root, 'Booking email').props.onChangeText('bad-email');
  });

  await act(async () => {
    findTouchableByText(root, 'Access My Tour').props.onPress();
  });

  assert.equal(hasText(root, 'Please enter a valid booking email (for example, name@example.com).'), true);
});

test('LoginScreen keeps offline recovery disclosure collapsed by default and toggles steps on tap', async () => {
  const renderer = await renderLoginScreen({
    isConnected: false,
    resolveOfflineLogin: async () => ({ success: false, reason: 'EMAIL_MISMATCH' }),
  });
  const root = renderer.root;

  await act(async () => {
    findTextInputByPlaceholder(root, 'Booking or driver code').props.onChangeText('ABC123');
  });
  await act(async () => {
    findTextInputByPlaceholder(root, 'Booking email').props.onChangeText('passenger@example.com');
  });
  await act(async () => {
    findTouchableByText(root, 'Access My Tour').props.onPress();
  });

  const firstRecoveryStep = '• Use the same booking email that was used when this trip was first verified.';

  assert.equal(hasText(root, 'How to recover'), true);
  assert.equal(hasText(root, firstRecoveryStep), false);

  await act(async () => {
    findTouchableByText(root, 'How to recover').props.onPress();
  });
  assert.equal(hasText(root, firstRecoveryStep), true);

  await act(async () => {
    findTouchableByText(root, 'How to recover').props.onPress();
  });
  assert.equal(hasText(root, firstRecoveryStep), false);
});

test('LoginScreen keeps first glance minimal and reveals email by hint focus/code prefix', async () => {
  const renderer = await renderLoginScreen();
  const root = renderer.root;

  assert.equal(Boolean(findTextInputByPlaceholder(root, 'Booking email')), false);

  await act(async () => {
    findTouchableByText(root, 'Passenger').props.onPress();
  });
  assert.equal(Boolean(findTextInputByPlaceholder(root, 'Booking email')), true);

  await act(async () => {
    findTouchableByText(root, 'Driver').props.onPress();
  });
  assert.equal(Boolean(findTextInputByPlaceholder(root, 'Booking email')), false);

  await act(async () => {
    findTextInputByPlaceholder(root, 'Driver code (for example D-BONDY)').props.onChangeText('ABC123');
  });
  assert.equal(Boolean(findTextInputByPlaceholder(root, 'Booking email')), true);

  await act(async () => {
    findTextInputByPlaceholder(root, 'Booking reference (for example T12345)').props.onChangeText('D-BONDY');
  });
  assert.equal(Boolean(findTextInputByPlaceholder(root, 'Booking email')), false);
});
