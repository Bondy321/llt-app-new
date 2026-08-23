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
    { id: bookingRefs.queued, pickupLocation: 'Glasgow Buchanan Bus Station', pickupTime: '10:30', passengerNames: ['Q One'], status: 'PENDING' },
    { id: bookingRefs.syncing, pickupLocation: 'Glasgow Buchanan Bus Station', pickupTime: '10:30', passengerNames: ['S One'], status: 'BOARDED' },
    { id: bookingRefs.failed, pickupLocation: 'Balloch Tourist Information Centre', pickupTime: '11:15', passengerNames: ['F One'], status: 'PENDING' },
    { id: bookingRefs.malformed, pickupLocation: 'Balloch Tourist Information Centre', pickupTime: '11:15', passengerNames: ['M One'], status: 'BOARDED' },
  ],
  stats: { totalPax: 4, checkedIn: 0, noShows: 0 },
};

const mockQueueActions = [
  { id: '1', type: 'MANIFEST_UPDATE', status: 'queued', tourId: 'TOUR-1', payload: { bookingRef: bookingRefs.queued } },
  { id: '2', type: 'MANIFEST_UPDATE', status: 'syncing', tourId: 'TOUR-1', payload: { bookingRef: bookingRefs.syncing } },
  { id: '3', type: 'MANIFEST_UPDATE', status: 'failed', tourId: 'TOUR-1', payload: { bookingRef: bookingRefs.failed } },
  { id: '4', type: 'MANIFEST_UPDATE', status: 'bad-state-value', tourId: 'TOUR-1', payload: { bookingRef: bookingRefs.malformed } },
  { id: '5', type: 'MANIFEST_UPDATE', status: 'failed', tourId: 'OTHER-TOUR', payload: { bookingRef: 'REF-OTHER' } },
];

let replayQueueCalls = 0;
let replayQueueScopes = [];
let subscribedQueueScopes = [];
let queuedActionReadScopes = [];
let getTourManifestCalls = 0;
let manifestLoader = async () => mockManifest;
let manifestUpdater = async () => ({ success: true, queued: false });
let manifestUpdateCalls = [];
let cachedManifest = null;
let cachedReplacements = [];
let openedUrls = [];

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    const Text = createHost('Text');
    return {
      StyleSheet: { create: (styles) => styles },
      Text,
      View: createHost('View'),
      SectionList: ({ sections = [], renderItem, renderSectionHeader, keyExtractor, ...props }) => React.createElement(
        'SectionList',
        props,
        sections.map((section) => React.createElement(
          React.Fragment,
          { key: section.title },
          renderSectionHeader ? renderSectionHeader({ section }) : null,
          section.data.map((item, index) => {
            const extractedKey = typeof keyExtractor === 'function'
              ? keyExtractor(item, index)
              : item?.id;
            const fallbackKey = extractedKey ?? `${section.title}-${index}`;
            return React.createElement(React.Fragment, { key: String(fallbackKey) }, renderItem({ item, index }));
          })
        ))
      ),
      FlatList: ({ data = [], renderItem, keyExtractor, ...props }) => React.createElement(
        'FlatList',
        props,
        data.map((item, index) => {
          const extractedKey = typeof keyExtractor === 'function' ? keyExtractor(item, index) : item?.id;
          const fallbackKey = extractedKey ?? `flat-item-${index}`;
          return React.createElement(React.Fragment, { key: String(fallbackKey) }, renderItem({ item, index }));
        })
      ),
      TextInput: createHost('TextInput'),
      TouchableOpacity: createHost('TouchableOpacity'),
      ActivityIndicator: createHost('ActivityIndicator'),
      Modal: createHost('Modal'),
      Alert: { alert: () => {} },
      Linking: { openURL: async (url) => { openedUrls.push(url); return true; } },
    };
  }

  if (request === 'react-native-safe-area-context') {
    return { SafeAreaView: createHost('SafeAreaView') };
  }

  if (request === '@expo/vector-icons') {
    return { MaterialCommunityIcons: createHost('MaterialCommunityIcons') };
  }
  if (request === '@expo/vector-icons/build/MaterialCommunityIcons.js') {
    return createHost('MaterialCommunityIcons');
  }

  if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
    return {
      getTourManifest: async () => {
        getTourManifestCalls += 1;
        return manifestLoader();
      },
      updateManifestBooking: async (...args) => {
        manifestUpdateCalls.push(args);
        return manifestUpdater(...args);
      },
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
        subscribeQueuedActions: (callback, options) => {
          subscribedQueueScopes.push(options?.scope || null);
          callback(mockQueueActions);
          return () => {};
        },
        getQueuedActions: async (options) => {
          queuedActionReadScopes.push(options?.scope || null);
          return { success: true, data: mockQueueActions };
        },
        replayQueue: async (options) => {
          replayQueueCalls += 1;
          replayQueueScopes.push(options?.scope || null);
          return { success: true };
        },
        updateAction: async () => ({ success: true }),
      },
      subscribeQueueState: () => () => {},
      subscribeQueuedActions: (callback, options) => {
        subscribedQueueScopes.push(options?.scope || null);
        callback(mockQueueActions);
        return () => {};
      },
      getQueuedActions: async (options) => {
        queuedActionReadScopes.push(options?.scope || null);
        return { success: true, data: mockQueueActions };
      },
      replayQueue: async (options) => {
        replayQueueCalls += 1;
        replayQueueScopes.push(options?.scope || null);
        return { success: true };
      },
      updateAction: async () => ({ success: true }),
    };
  }

  if (request.endsWith('/services/driverManifestCacheService') || request === '../services/driverManifestCacheService') {
    return {
      get: async () => ({ success: true, data: cachedManifest }),
      replace: async ({ manifest, tourId, driverId }) => {
        const data = { ...manifest, tourId, driverId, fetchedAtMs: 1, schemaVersion: 1 };
        cachedReplacements.push(data);
        return { success: true, data };
      },
      applyOptimisticUpdate: async () => ({ success: true }),
    };
  }

  if (request.endsWith('/services/chatService') || request === '../services/chatService') {
    return {};
  }

  return originalLoad(request, parent, isMain);
};

test('PassengerManifestScreen only surfaces booking sync labels that need attention', async () => {
  replayQueueCalls = 0;
  replayQueueScopes = [];
  subscribedQueueScopes = [];
  queuedActionReadScopes = [];
  getTourManifestCalls = 0;
  cachedManifest = null;
  cachedReplacements = [];
  manifestUpdater = async () => ({ success: true, queued: false });
  manifestUpdateCalls = [];
  manifestLoader = async () => mockManifest;
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PassengerManifestScreen, {
        route: { params: {
          tourId: 'TOUR-1',
          actorPrincipalId: 'driver:D-TEST',
          authUid: 'driver-auth-test',
          offlineCacheOwnerId: 'D-TEST',
        } },
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
  assert.ok(!allText.includes('SYNCED'));
  assert.ok(allText.includes('GLASGOW BUCHANAN BUS STATION - 10:30'));
  assert.ok(allText.includes('BALLOCH TOURIST INFORMATION CENTRE - 11:15'));
  assert.ok(!allText.includes('UNRESOLVED - 10:30'));
  assert.ok(!allText.includes('RESOLVED - 10:30'));

  const sectionList = renderer.root.findByType('SectionList');
  const baselineManifestCalls = getTourManifestCalls;
  await act(async () => {
    await sectionList.props.onRefresh();
  });

  assert.equal(replayQueueCalls, 1);
  assert.equal(subscribedQueueScopes.at(-1).principalId, 'driver:D-TEST');
  assert.equal(replayQueueScopes[0].principalId, 'driver:D-TEST');
  assert.equal(queuedActionReadScopes.at(-1).principalId, 'driver:D-TEST');
  assert.ok(getTourManifestCalls > baselineManifestCalls);
});

test('PassengerManifestScreen renders an identity-scoped cached manifest before a remote replacement', async () => {
  getTourManifestCalls = 0;
  cachedReplacements = [];
  cachedManifest = {
    tourId: 'TOUR-1', driverId: 'D-CACHE', bookings: [{
      id: 'CACHED-1', passengerNames: ['Cached Passenger'], passengerStatus: ['PENDING'],
      status: 'PENDING', pickupLocation: 'Cached stop', pickupTime: '08:00', hasPassengerStatuses: true,
    }], stats: { totalBookings: 1, totalPax: 1, checkedIn: 0, noShows: 0 },
  };
  let resolveRemote;
  manifestLoader = () => new Promise((resolve) => { resolveRemote = resolve; });
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(PassengerManifestScreen, {
      route: { params: { tourId: 'TOUR-1', offlineCacheOwnerId: 'D-CACHE', sessionGeneration: 4 } },
      navigation: { goBack: () => {} },
    }));
  });
  await waitForEffects();
  const cachedText = renderer.root.findAll((node) => node.type === 'Text')
    .map((node) => String(node.props.children || '')).join(' ');
  assert.match(cachedText, /Cached Passenger/);
  assert.match(cachedText, /Saved offline copy/i);
  await act(async () => { resolveRemote(mockManifest); await Promise.resolve(); });
  await waitForEffects();
  assert.equal(cachedReplacements.length, 1);
  assert.equal(cachedReplacements[0].driverId, 'D-CACHE');
});

test('PassengerManifestScreen offers the active Tour Pack booking phone in boarding controls', async () => {
  getTourManifestCalls = 0;
  cachedManifest = null;
  cachedReplacements = [];
  openedUrls = [];
  manifestLoader = async () => mockManifest;
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;
  const driverTourPack = {
    tourId: 'TOUR-1',
    contacts: {
      bookingLeads: {
        lead_queued: {
          contactId: 'lead_queued',
          bookingRef: bookingRefs.queued,
          phone: '+44 (0) 7700 900-123',
        },
      },
    },
  };

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(PassengerManifestScreen, {
      route: { params: { tourId: 'TOUR-1' } },
      navigation: { goBack: () => {} },
      driverTourPack,
    }));
  });
  await waitForEffects();

  const bookingCard = renderer.root.findByProps({
    accessibilityLabel: `Booking ${bookingRefs.queued}. PENDING. 1 passengers.`,
  });
  await act(async () => bookingCard.props.onPress());

  const phoneButton = renderer.root.findByProps({
    accessibilityLabel: `Phone booking ${bookingRefs.queued}`,
  });
  await act(async () => phoneButton.props.onPress());

  assert.deepEqual(openedUrls, ['tel:+4407700900123']);
  await act(async () => renderer.unmount());
});

test('PassengerManifestScreen queues a boarding update immediately when connectivity is offline', async () => {
  cachedManifest = null;
  cachedReplacements = [];
  manifestUpdateCalls = [];
  manifestLoader = async () => mockManifest;
  manifestUpdater = async () => ({
    success: true,
    queued: true,
    localStatus: 'BOARDED',
    passengerStatus: ['BOARDED'],
  });
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(PassengerManifestScreen, {
      route: { params: {
        tourId: 'TOUR-1',
        actorPrincipalId: 'driver:D-OFFLINE',
        authUid: 'driver-auth-offline',
        offlineCacheOwnerId: 'D-OFFLINE',
      } },
      navigation: { goBack: () => {} },
      isConnected: false,
    }));
  });
  await waitForEffects();

  const bookingCard = renderer.root.findByProps({
    accessibilityLabel: `Booking ${bookingRefs.queued}. PENDING. 1 passengers.`,
  });
  await act(async () => bookingCard.props.onPress());
  const allHereButton = renderer.root.findByProps({
    accessibilityLabel: `Mark all passengers here for booking ${bookingRefs.queued}`,
  });
  await act(async () => allHereButton.props.onPress());
  await waitForEffects();

  assert.equal(manifestUpdateCalls.length, 1);
  assert.equal(manifestUpdateCalls[0][3].online, false);
  assert.equal(manifestUpdateCalls[0][3].actorPrincipalId, 'driver:D-OFFLINE');
  await act(async () => renderer.unmount());
});

test('PassengerManifestScreen distinguishes an authoritative empty manifest from filtered results', async () => {
  cachedManifest = null;
  cachedReplacements = [];
  manifestLoader = async () => ({
    ...mockManifest,
    bookings: [],
    stats: { totalBookings: 0, totalPax: 0, checkedIn: 0, noShows: 0 },
  });
  const PassengerManifestScreen = require('../screens/PassengerManifestScreen').default;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(PassengerManifestScreen, {
      route: { params: { tourId: 'TOUR-1' } },
      navigation: { goBack: () => {} },
    }));
  });
  await waitForEffects();
  const textContent = renderer.root.findAll((node) => node.type === 'Text')
    .map((node) => String(node.props.children || '')).join(' ');
  assert.match(textContent, /No passengers on this manifest/);
  assert.match(textContent, /no passenger bookings to board/);
  await act(async () => renderer.unmount());
});
