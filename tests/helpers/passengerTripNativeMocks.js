const Module = require('node:module');
const React = require('react');

const originalLoad = Module._load;
const originalPngLoader = require.extensions['.png'];
let installed = false;
let deferBackgroundRefresh = false;

const calls = {
  itineraryFetch: 0,
  itineraryListener: 0,
  cacheRead: 0,
  cacheWrite: 0,
  homeListener: 0,
};
const COUNTER_KEYS = Object.keys(calls);

const resetCalls = () => {
  COUNTER_KEYS.forEach((key) => { calls[key] = 0; });
  deferBackgroundRefresh = false;
};

const createHost = (name) => {
  const Component = ({ children, ...props }) => React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

const nativeModule = () => {
  class AnimatedValue {
    interpolate() { return 1; }
  }
  const animation = () => ({ start: (callback) => callback?.(), stop: () => {} });
  return {
    ActivityIndicator: createHost('ActivityIndicator'),
    Alert: { alert: () => {} },
    Animated: {
      Value: AnimatedValue,
      View: createHost('AnimatedView'),
      loop: animation,
      parallel: animation,
      sequence: animation,
      spring: animation,
      timing: animation,
    },
    Image: createHost('Image'),
    LayoutAnimation: { configureNext: () => {}, Presets: { easeInEaseOut: {} } },
    Linking: { openURL: async () => {} },
    Modal: createHost('Modal'),
    Platform: { OS: 'ios' },
    RefreshControl: createHost('RefreshControl'),
    ScrollView: createHost('ScrollView'),
    Share: { share: async () => ({}) },
    StyleSheet: { create: (styles) => styles },
    Text: createHost('Text'),
    TextInput: createHost('TextInput'),
    TouchableOpacity: createHost('TouchableOpacity'),
    UIManager: { setLayoutAnimationEnabledExperimental: () => {} },
    Vibration: { vibrate: () => {} },
    View: createHost('View'),
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  };
};

const install = ({ resolveModule } = {}) => {
  if (installed) return;
  installed = true;
  require.extensions['.png'] = (module, filename) => { module.exports = filename; };
  Module._load = function passengerTripMockLoader(request, parent, isMain) {
    const override = resolveModule?.(request, parent, isMain);
    if (override !== undefined) return override;
    if (request === 'react-native') return nativeModule();
    if (request === 'react-native-safe-area-context') return { SafeAreaView: createHost('SafeAreaView') };
    if (request === 'expo-linear-gradient') return { LinearGradient: createHost('LinearGradient') };
    if (request === 'expo-status-bar') return { StatusBar: createHost('StatusBar') };
    if (request === '@expo/vector-icons/build/MaterialCommunityIcons.js') return createHost('MaterialCommunityIcons');
    if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
      return {
        MANIFEST_STATUS: { BOARDED: 'boarded', NO_SHOW: 'no_show', PARTIAL: 'partial', PENDING: 'pending' },
        getTourItinerary: async () => {
          calls.itineraryFetch += 1;
          throw new Error('legacy passenger fetch should not run');
        },
      };
    }
    if (request.endsWith('/services/itineraryService') || request === '../services/itineraryService') {
      return {
        createItineraryContentSignature: (value) => JSON.stringify(value || null),
        normalizeItineraryDocument: (value) => (
          value && Array.isArray(value.days) ? { ...value, days: value.days.map((day) => ({ ...day })) } : null
        ),
        saveItineraryWithConflictGuard: async () => ({ success: true }),
      };
    }
    if (request.endsWith('/services/itineraryRealtimeService') || request === '../services/itineraryRealtimeService') {
      return { subscribeToItinerary: () => { calls.itineraryListener += 1; return () => {}; } };
    }
    if (request.endsWith('/services/tourHomeRealtimeService') || request === '../services/tourHomeRealtimeService') {
      const snapshot = (value) => ({ exists: () => Boolean(value), val: () => value });
      return {
        isTourHomeRealtimeAvailable: () => true,
        readTourHomeRealtimeSnapshot: () => deferBackgroundRefresh ? new Promise(() => {}) : Promise.resolve({
          driverSnapshot: snapshot(null), manifestSnapshot: snapshot(null),
        }),
        subscribeToTourHomeRealtime: () => { calls.homeListener += 1; return () => {}; },
      };
    }
    if (request.endsWith('/services/offlineSyncService') || request === '../services/offlineSyncService') {
      return {
        __esModule: true,
        default: {
          getStalenessLabel: () => ({ bucket: 'fresh', label: 'Checked recently' }),
          getTourPack: async () => { calls.cacheRead += 1; return { success: false }; },
          getTourPackMeta: async () => { calls.cacheRead += 1; return { success: false }; },
          replayQueue: async () => deferBackgroundRefresh ? new Promise(() => {}) : { success: true },
          saveTourPack: async () => { calls.cacheWrite += 1; return { success: true }; },
          setTourPackMeta: async () => { calls.cacheWrite += 1; return { success: true }; },
        },
      };
    }
    if (request.endsWith('/services/loggerService') || request === '../services/loggerService') {
      return {
        __esModule: true,
        default: { trackScreen: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        maskIdentifier: () => 'masked',
      };
    }
    if (request.endsWith('/services/chatService') || request === '../services/chatService') return {};
    if (request.endsWith('/services/hapticsService') || request === '../services/hapticsService') {
      return { ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' }, impactAsync: async () => {} };
    }
    if (request.endsWith('/firebase') || request === '../firebase') {
      return { auth: { currentUser: null }, realtimeDb: null };
    }
    return originalLoad(request, parent, isMain);
  };
};

const restore = () => {
  if (!installed) return;
  Module._load = originalLoad;
  if (originalPngLoader) require.extensions['.png'] = originalPngLoader;
  else delete require.extensions['.png'];
  installed = false;
  resetCalls();
};

const loadScreens = () => ({
  ItineraryScreen: require('../../screens/ItineraryScreen').default,
  TourHomeScreen: require('../../screens/TourHomeScreen').default,
});

module.exports = {
  calls,
  getCalls: () => ({ ...calls }),
  install,
  loadScreens,
  resetCalls,
  restore,
  setDeferBackgroundRefresh: (value) => { deferBackgroundRefresh = Boolean(value); },
};
