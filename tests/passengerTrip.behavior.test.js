const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;
const nativeMocks = require('./helpers/passengerTripNativeMocks');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
nativeMocks.install();
test.after(() => nativeMocks.restore());

const extractText = (children) => {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
};

const allText = (root) => root
  .findAll((node) => node.type === 'Text')
  .map((node) => extractText(node.props.children))
  .filter(Boolean);

const calls = nativeMocks.calls;
calls.refresh = [];
let incomingRefreshResult = null;

const nowMs = new Date(2026, 8, 10, 8, 42).getTime();
const itinerary = { title: 'Highland day', days: [{ day: 1, content: '08:45 Depart for Luss' }], revision: 7 };
const bookingData = {
  id: 'BOOK-ONE',
  passengerNames: ['Alex Example'],
  seatNumbers: ['12A'],
  pickupPoints: [{ time: '08:45', location: 'George Square', date: '2026-09-10' }],
};
const tourData = {
  id: 'TOUR-ONE',
  tourCode: '5000D 1',
  name: 'Highland day',
  startDate: '2026-09-10',
  driverPhone: '+441234567890',
  itinerary,
};
const passengerTrip = {
  nowMs,
  parts: {
    booking: { data: bookingData, version: 'b2', checkedAtMs: nowMs, status: 'checked', persisted: true },
    tour: { data: tourData, version: 't2', checkedAtMs: nowMs, status: 'checked', persisted: true },
    itinerary: { data: itinerary, version: 'i7', checkedAtMs: nowMs, status: 'checked', persisted: true },
  },
  refresh: async (reason, parts) => {
    calls.refresh.push([reason, parts]);
    return incomingRefreshResult || passengerTrip;
  },
};

test('home renders authorised core details while optional listeners remain unresolved', async () => {
  const { TourHomeScreen } = nativeMocks.loadScreens();
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(TourHomeScreen, {
      bookingData,
      tourCode: tourData.tourCode,
      tourData,
      passengerTrip,
      onNavigate: () => {},
      onLogout: () => {},
    }));
  });

  const text = allText(renderer.root);
  assert.ok(text.includes('BOOK-ONE'));
  assert.ok(text.includes('12A'));
  assert.ok(text.includes('George Square'));
  assert.ok(text.includes('Boarding status pending'));
  assert.ok(text.includes('08:45 Depart for Luss'));
  assert.equal(text.includes('Ready for pickup'), false);
  assert.equal(text.includes('Live'), false);
  assert.equal(text.includes('Booking synced'), false);
  assert.equal(text.includes('Alerts ready'), false);
  assert.equal(calls.homeListener, 1);

  nativeMocks.setDeferBackgroundRefresh(true);
  incomingRefreshResult = passengerTrip;
  const homeScroll = renderer.root.find((node) => node.type === 'ScrollView' && node.props.refreshControl);
  await act(async () => homeScroll.props.refreshControl.props.onRefresh());
  assert.deepEqual(calls.refresh.at(-1), ['manual', ['booking', 'tour', 'itinerary']]);
  assert.equal(renderer.root.find((node) => node.type === 'ScrollView' && node.props.refreshControl)
    .props.refreshControl.props.refreshing, false);
  assert.ok(allText(renderer.root).includes('Trip details checked.'));

  incomingRefreshResult = {
    parts: {
      booking: { ...passengerTrip.parts.booking, status: 'saved' },
      tour: { ...passengerTrip.parts.tour, status: 'error' },
      itinerary: { ...passengerTrip.parts.itinerary, status: 'saved' },
    },
  };
  await act(async () => homeScroll.props.refreshControl.props.onRefresh());
  assert.ok(allText(renderer.root).includes('Trip details could not be refreshed. Your previous details remain shown.'));
  assert.equal(allText(renderer.root).includes('Trip details checked.'), false);
  nativeMocks.setDeferBackgroundRefresh(false);
  incomingRefreshResult = null;

  await act(async () => renderer.unmount());
});

test('passenger itinerary uses shared state and refresh without legacy reads, listeners, or cache writes', async () => {
  const { ItineraryScreen } = nativeMocks.loadScreens();
  const screenProps = {
    onBack: () => {},
    tourId: tourData.id,
    tourName: tourData.name,
    startDate: tourData.startDate,
    isDriver: false,
    offlineCacheOwnerId: bookingData.id,
  };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ItineraryScreen, {
      ...screenProps,
      passengerTrip,
    }));
  });

  assert.ok(allText(renderer.root).includes('08:45 Depart for Luss'));
  assert.equal(calls.itineraryFetch, 0);
  assert.equal(calls.itineraryListener, 0);
  assert.equal(calls.cacheRead, 0);
  assert.equal(calls.cacheWrite, 0);

  const itineraryScroll = renderer.root.find((node) => node.type === 'ScrollView' && node.props.refreshControl);
  await act(async () => itineraryScroll.props.refreshControl.props.onRefresh());
  assert.deepEqual(calls.refresh.at(-1), ['manual', ['itinerary']]);
  assert.equal(calls.itineraryFetch, 0);
  assert.equal(calls.itineraryListener, 0);
  assert.equal(calls.cacheWrite, 0);

  const revisedItinerary = { ...itinerary, revision: 8, days: [{ day: 1, content: '09:15 Revised departure' }] };
  const revisedTrip = {
    ...passengerTrip,
    parts: {
      ...passengerTrip.parts,
      itinerary: { data: revisedItinerary, version: 'i8', checkedAtMs: nowMs + 60_000, status: 'checked', persisted: true },
    },
  };
  await act(async () => renderer.update(React.createElement(ItineraryScreen, { ...screenProps, passengerTrip: revisedTrip })));
  assert.ok(allText(renderer.root).includes('09:15 Revised departure'));
  assert.equal(allText(renderer.root).includes('08:45 Depart for Luss'), false);

  const withdrawnTrip = {
    ...revisedTrip,
    parts: {
      ...revisedTrip.parts,
      itinerary: { data: null, version: 'i9', checkedAtMs: nowMs + 120_000, status: 'empty', persisted: true },
    },
  };
  await act(async () => renderer.update(React.createElement(ItineraryScreen, { ...screenProps, passengerTrip: withdrawnTrip })));
  assert.ok(allText(renderer.root).includes('No published itinerary'));
  assert.equal(allText(renderer.root).includes('09:15 Revised departure'), false);

  await act(async () => renderer.unmount());
});
