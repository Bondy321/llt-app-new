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

const bookingRefs = {
  queued: 'REF-QUEUED',
  syncing: 'REF-SYNCING',
  failed: 'REF-FAILED',
  malformed: 'REF-MALFORMED',
};

const mockManifest = {
  bookings: [
    { id: bookingRefs.queued, pickupLocation: 'A', passengerNames: ['Q One'], status: 'PENDING' },
    { id: bookingRefs.syncing, pickupLocation: 'A', passengerNames: ['S One'], status: 'PENDING' },
    { id: bookingRefs.failed, pickupLocation: 'B', passengerNames: ['F One'], status: 'PENDING' },
    { id: bookingRefs.malformed, pickupLocation: 'B', passengerNames: ['M One'], status: 'PENDING' },
  ],
  stats: { totalPax: 4, checkedIn: 0, noShows: 0 },
};

const mockQueueActions = [
  { id: '1', type: 'MANIFEST_UPDATE', status: 'queued', payload: { bookingRef: bookingRefs.queued } },
  { id: '2', type: 'MANIFEST_UPDATE', status: 'syncing', payload: { bookingRef: bookingRefs.syncing } },
  { id: '3', type: 'MANIFEST_UPDATE', status: 'failed', payload: { bookingRef: bookingRefs.failed } },
  { id: '4', type: 'MANIFEST_UPDATE', status: 'bad-state-value', payload: { bookingRef: bookingRefs.malformed } },
];

let replayQueueCalls = 0;
let getTourManifestCalls = 0;

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    const Text = createHost('Text');
    return {
      StyleSheet: { create: (styles) => styles },
      Text,
      View: createHost('View'),
      SectionList: ({ sections = [], renderItem, renderSectionHeader, ...props }) => React.createElement(
        'SectionList',
        props,
        sections.map((section) => React.createElement(
          React.Fragment,
          { key: section.title },
          renderSectionHeader ? renderSectionHeader({ section }) : null,
          section.data.map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item })))
        ))
      ),
      FlatList: ({ data = [], renderItem, ...props }) => React.createElement(
        'FlatList',
        props,
        data.map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item })))
      ),
      TextInput: createHost('TextInput'),
      TouchableOpacity: createHost('TouchableOpacity'),
      ActivityIndicator: createHost('ActivityIndicator'),
      Modal: createHost('Modal'),
      Alert: { alert: () => {} },
    };
  }

  if (request === 'react-native-safe-area-context') {
    return { SafeAreaView: createHost('SafeAreaView') };
  }

  if (request === '@expo/vector-icons') {
    return { MaterialCommunityIcons: createHost('MaterialCommunityIcons') };
  }

  if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
    return {
      getTourManifest: async () => {
        getTourManifestCalls += 1;
        return mockManifest;
      },
      updateManifestBooking: async () => ({ success: true }),
      MANIFEST_STATUS: {
        PENDING: 'PENDING',
        BOARDED: 'BOARDED',
        NO_SHOW: 'NO_SHOW',
      },
    };
  }

  if (request.endsWith('/services/offlineSyncService') || request === '../services/offlineSyncService') {
    return {
      __esModule: true,
      default: {
        subscribeQueueState: () => () => {},
        getQueuedActions: async () => ({ success: true, data: mockQueueActions }),
        replayQueue: async () => {
          replayQueueCalls += 1;
          return { success: true };
        },
        updateAction: async () => ({ success: true }),
      },
      subscribeQueueState: () => () => {},
      getQueuedActions: async () => ({ success: true, data: mockQueueActions }),
      replayQueue: async () => {
        replayQueueCalls += 1;
        return { success: true };
      },
      updateAction: async () => ({ success: true }),
    };
  }

  if (request.endsWith('/services/chatService') || request === '../services/chatService') {
    return {};
  }

  return originalLoad(request, parent, isMain);
};

test('PassengerManifestScreen wires booking sync states into ManifestBookingCard labels', async () => {
  replayQueueCalls = 0;
  getTourManifestCalls = 0;
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PassengerManifestScreen, {
        route: { params: { tourId: 'TOUR-1' } },
        navigation: { goBack: () => {} },
      })
    );
  });

  await waitForEffects();
  await waitForEffects();

  const allText = renderer.root
    .findAll((node) => node.type === 'Text')
    .map((node) => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children))
    .filter((value) => typeof value === 'string')
    .map((value) => value.toUpperCase());

  assert.ok(allText.includes('QUEUED'));
  assert.ok(allText.includes('SYNCING'));
  assert.ok(allText.includes('FAILED'));
  assert.ok(allText.includes('SYNCED'));

  const sectionList = renderer.root.findByType('SectionList');
  const baselineManifestCalls = getTourManifestCalls;
  await act(async () => {
    await sectionList.props.onRefresh();
  });

  assert.equal(replayQueueCalls, 1);
  assert.ok(getTourManifestCalls > baselineManifestCalls);
});
