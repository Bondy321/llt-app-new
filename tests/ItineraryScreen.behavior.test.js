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

const actualItineraryService = require('../services/itineraryService');
const createHost = (name) => {
  const Component = ({ children, ...props }) => React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

const extractText = (children) => {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
};

const allText = (root) => root
  .findAll((node) => node.type === 'Text')
  .map((node) => extractText(node.props.children))
  .filter(Boolean);

const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const baseItinerary = {
  title: 'Loch Lomond tour',
  days: [{ day: 1, content: '09:00 Depart for Luss' }],
  revision: 2,
  updatedAt: 1787200000000,
  updatedBy: 'driver-one',
};

let cachedItinerary = baseItinerary;
let networkMode = 'success';
let saveResult = { success: true, itinerary: baseItinerary };

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    const immediateAnimation = () => ({ start: (callback) => callback?.() });
    class AnimatedValue {
      interpolate() { return 1; }
    }
    return {
      StyleSheet: { create: (styles) => styles },
      Text: createHost('Text'),
      View: createHost('View'),
      TouchableOpacity: createHost('TouchableOpacity'),
      ScrollView: createHost('ScrollView'),
      TextInput: createHost('TextInput'),
      ActivityIndicator: createHost('ActivityIndicator'),
      RefreshControl: createHost('RefreshControl'),
      Alert: { alert: () => {} },
      Animated: { Value: AnimatedValue, View: createHost('AnimatedView'), timing: immediateAnimation },
      LayoutAnimation: { configureNext: () => {}, Presets: { easeInEaseOut: {} } },
      UIManager: { setLayoutAnimationEnabledExperimental: () => {} },
      Platform: { OS: 'ios' },
      Share: { share: async () => ({}) },
    };
  }
  if (request === 'react-native-safe-area-context') {
    return { SafeAreaView: createHost('SafeAreaView') };
  }
  if (request === 'expo-linear-gradient') {
    return { LinearGradient: createHost('LinearGradient') };
  }
  if (request === '@expo/vector-icons/build/MaterialCommunityIcons.js') {
    return createHost('MaterialCommunityIcons');
  }
  if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
    return {
      getTourItinerary: async () => {
        if (networkMode === 'failure') throw new Error('network unavailable');
        return baseItinerary;
      },
    };
  }
  if (request.endsWith('/itineraryService') || request === '../services/itineraryService') {
    return {
      ...actualItineraryService,
      saveItineraryWithConflictGuard: async () => saveResult,
    };
  }
  if (request.endsWith('/services/offlineSyncService') || request === '../services/offlineSyncService') {
    return {
      __esModule: true,
      default: {
        getTourPack: async () => ({ success: true, data: cachedItinerary ? { itinerary: cachedItinerary } : null }),
        getTourPackMeta: async () => ({
          success: true,
          data: { itineraryLastSyncedAt: '2026-08-20T09:00:00.000Z' },
        }),
        saveTourPack: async () => ({ success: true }),
        setTourPackMeta: async () => ({ success: true }),
        getStalenessLabel: () => ({ bucket: 'fresh', label: 'Updated 2 min ago' }),
      },
    };
  }
  if (request.endsWith('/services/loggerService') || request === '../services/loggerService') {
    return {
      __esModule: true,
      default: {
        trackScreen: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };
  }
  if (request.endsWith('/firebase') || request === '../firebase') {
    return {
      auth: { currentUser: { uid: 'driver-one' } },
      realtimeDb: {
        ref: () => ({ on: () => {}, off: () => {} }),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const renderScreen = async ({ isDriver = false } = {}) => {
  const ItineraryScreen = require('../screens/ItineraryScreen').default;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ItineraryScreen, {
      onBack: () => {},
      tourId: 'TOUR_1',
      tourName: 'Loch Lomond tour',
      startDate: '20/08/2026',
      isDriver,
      offlineCacheOwnerId: isDriver ? 'D-ONE' : 'BOOKING-ONE',
    }));
  });
  await waitForEffects();
  return renderer;
};

test('a network failure keeps the saved itinerary visible and offers an explicit retry', async () => {
  networkMode = 'failure';
  cachedItinerary = baseItinerary;
  const renderer = await renderScreen();
  const text = allText(renderer.root);

  assert.ok(text.includes('Saved itinerary'));
  assert.ok(text.includes('09:00 Depart for Luss'));
  assert.ok(renderer.root.findAll((node) => node.props.accessibilityLabel === 'Retry itinerary refresh').length > 0);

  await act(async () => renderer.unmount());
});

test('a conflicting save keeps the draft intact until the driver explicitly chooses a version', async () => {
  networkMode = 'success';
  cachedItinerary = baseItinerary;
  const serverItinerary = {
    ...baseItinerary,
    days: [{ day: 1, content: '10:00 New server departure' }],
    revision: 3,
  };
  saveResult = { success: false, conflict: true, serverItinerary };
  const renderer = await renderScreen({ isDriver: true });

  await act(async () => {
    renderer.root.find((node) => node.props.accessibilityLabel === 'Edit itinerary').props.onPress();
  });
  const editor = renderer.root.find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Day 1 content');
  await act(async () => editor.props.onChangeText('09:30 My reviewed draft'));
  await act(async () => {
    await renderer.root.find((node) => node.props.accessibilityLabel === 'Save itinerary').props.onPress();
  });
  await waitForEffects();

  assert.ok(allText(renderer.root).includes('A newer itinerary is already live'));
  assert.equal(
    renderer.root.find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Day 1 content').props.value,
    '09:30 My reviewed draft',
  );
  assert.equal(
    renderer.root.find((node) => node.props.accessibilityLabel === 'Save itinerary').props.accessibilityState.disabled,
    true,
  );

  await act(async () => {
    renderer.root.find((node) => node.props.accessibilityLabel === 'Load latest itinerary').props.onPress();
  });
  assert.equal(
    renderer.root.find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Day 1 content').props.value,
    '10:00 New server departure',
  );
  assert.ok(!allText(renderer.root).includes('A newer itinerary is already live'));

  await act(async () => renderer.unmount());
});
