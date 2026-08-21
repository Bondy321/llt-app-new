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
const createHost = (name) => {
  const Component = ({ children, ...props }) => React.createElement(name, props, children);
  Component.displayName = name;
  return Component;
};
const textOf = (children) => {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
};
const allText = (root) => root.findAll((node) => node.type === 'Text').map((node) => textOf(node.props.children));

const manifest = {
  schemaVersion: 1,
  complete: true,
  tourId: '5001D_1',
  bookings: [{
    id: 'B1',
    passengerNames: ['Jane Driver'],
    passengerStatus: ['BOARDED'],
    seatLabels: ['1A'],
    seatNumbers: ['1A'],
    pickupPoints: [],
    status: 'BOARDED',
  }],
  stats: { totalPax: 1, checkedIn: 1, noShows: 0 },
};

const originalLoad = Module._load;
Module._load = function mockLoader(request, parent, isMain) {
  if (request === 'react-native') {
    return {
      StyleSheet: { create: (styles) => styles },
      Text: createHost('Text'),
      View: createHost('View'),
      TouchableOpacity: createHost('TouchableOpacity'),
      ScrollView: createHost('ScrollView'),
      Linking: { openURL: async () => true },
      Platform: { OS: 'ios' },
    };
  }
  if (request === 'react-native-safe-area-context') return { SafeAreaView: createHost('SafeAreaView') };
  if (request === '@expo/vector-icons/build/MaterialCommunityIcons.js') return createHost('MaterialCommunityIcons');
  if (request.endsWith('/services/driverManifestCacheService') || request === '../services/driverManifestCacheService') {
    return {
      __esModule: true,
      default: {
        get: async () => ({ success: true, data: { ...manifest, driverId: 'D-ONE', fetchedAtMs: Date.now() } }),
        replace: async () => ({ success: true, data: { ...manifest, driverId: 'D-ONE', fetchedAtMs: Date.now() } }),
      },
    };
  }
  if (request.endsWith('/services/bookingServiceRealtime') || request === '../services/bookingServiceRealtime') {
    return { getTourManifest: async () => manifest };
  }
  return originalLoad(request, parent, isMain);
};

const pack = {
  revision: 3,
  departureKey: '2026-09-10::5001D_1',
  tourId: '5001D_1',
  tourCode: '5001D 1',
  dateISO: '2026-09-10',
  tour: { name: 'Highland Explorer' },
  quality: { state: 'complete', conflicts: 0, tourPaxOnly: 0, paxOnly: 0, unseated: 0, missingReports: 0, suppressSeatMap: false },
  pickups: { p1: { pickupId: 'p1', sequence: 0, name: 'Main Street', dateISO: '2026-09-10', time: '08:00', address: '1 Main Street', passengerCount: 1, bookingCount: 1 } },
  passengers: { pax1: { passengerKey: 'pax1', bookingRef: 'B1', name: 'Jane Driver', pickupId: 'p1', seatLabel: '1A', sourceState: 'MATCHED', bookingLeadContactId: '' } },
  seats: { seat1: { seatId: 'seat1', label: '1A', state: 'occupied', passengerKey: 'pax1' } },
  timeline: { event1: { eventId: 'event1', dateISO: '2026-09-10', time: '08:00', title: 'Main Street pickup', subtitle: 'Main Street', type: 'pickup', sequence: 0 } },
  hotels: {}, services: {},
  coach: { details: {} },
  contacts: { bookingLeads: {}, operational: {} },
  itineraries: { client: { title: '', text: '' }, driver: { title: '', text: '' } },
};

test('renders assignment/offline answers and authoritative progress across tabs', async () => {
  const Screen = require('../screens/DriverTourPackScreen').default;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Screen, {
      packState: { pack, state: 'ready', source: 'cache' },
      driverData: { id: 'D-ONE', currentTourId: '5001D_1', name: 'Driver One' },
      tourData: { name: 'Highland Explorer' },
      onBack: () => {},
      onNavigate: () => {},
    }));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.ok(allText(renderer.root).includes('Correct tour confirmed: 5001D 1 on 2026-09-10.'));
  assert.ok(allText(renderer.root).includes('Ready offline'));

  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Run tab' }).props.onPress());
  assert.ok(allText(renderer.root).some((value) => value.includes('1 boarded • 0 pending • 0 no-show')));

  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'People tab' }).props.onPress());
  assert.ok(renderer.root.findAllByProps({ accessibilityLabel: 'Jane Driver, seat 1A, Boarded' }).length > 0);
  const visualSeat = renderer.root.findByProps({ accessibilityLabel: 'Seat 1A: Boarded, Jane Driver' });
  assert.notEqual(visualSeat.props.accessibilityRole, 'button');

  await act(async () => renderer.unmount());
});
