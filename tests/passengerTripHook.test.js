const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const React = require('react');
const { act, create } = require('react-test-renderer');
const { createTripCache } = require('../services/passenger-trip/tripCache');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const disk = new Map();
const cache = createTripCache({ getItem: async (key) => disk.get(key) || null,
  setItem: async (key, value) => disk.set(key, value), removeItem: async (key) => disk.delete(key) });
let attaches = 0; let detaches = 0; let foreground;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'react-native') return { AppState: { currentState: 'active',
    addEventListener: (_event, cb) => { foreground = cb; return { remove() {} }; } } };
  if (request.endsWith('/services/loggerService')) return { __esModule: true, default: { debug() {} } };
  if (request.endsWith('/passenger-trip/tripApi')) return { createTripApi: () => ({ request: async () => { throw new Error('OFFLINE_TEST'); },
    subscribeSignals: () => { attaches += 2; return () => { detaches += 2; }; } }) };
  if (request.endsWith('/passenger-trip/tripCache')) return { getTripCache: () => cache };
  if (request.endsWith('/passenger-trip/legacyTripSeed')) return { readLegacyTripSeed: async (_scope, seed) => seed };
  return originalLoad(request, parent, isMain);
};
const { default: usePassengerTrip, passengerTripEnabled } = require('../hooks/usePassengerTrip');
const { runSaveSessionProjection } = require('../src/app/session/sessionSaveRunner');
Module._load = originalLoad;
const scope = { authUid: 'synthetic-hook', principalId: `pax_v2_${'a'.repeat(32)}`,
  cacheOwnerId: 'BOOK-HOOK', tourId: 'TOUR_HOOK', sessionId: `sess_v1_${'b'.repeat(32)}` };
const props = { scope, bookingData: { id: scope.cacheOwnerId, tourId: scope.tourId, passengerNames: ['Synthetic'] },
  tourData: { id: scope.tourId, name: 'Hook Tour', itinerary: { days: [{ day: 1, content: 'Saved without navigation' }] } },
  isConnected: false, enabled: true };
let state;
const Probe = (input) => { state = usePassengerTrip(input); return null; };

test('disabled gate has no pipeline; enabled shell owner persists itinerary and navigation does not multiply listeners', async () => {
  const oldFlag = process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED;
  delete process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED;
  assert.equal(passengerTripEnabled(), false);
  process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED = 'true'; assert.equal(passengerTripEnabled(), true);
  let renderer;
  await act(async () => { renderer = create(React.createElement(Probe, { ...props, enabled: false })); });
  assert.equal(state, null); assert.equal(attaches, 0);
  await act(async () => { renderer.update(React.createElement(Probe, props)); });
  assert.equal(state.parts.itinerary.data.days[0].content, 'Saved without navigation');
  assert.equal(state.parts.itinerary.persisted, true);
  await act(async () => { renderer.update(React.createElement(Probe, { ...props, isConnected: true })); });
  assert.equal(attaches, 2);
  await act(async () => { renderer.update(React.createElement(Probe, { ...props, isConnected: true,
    bookingData: { ...props.bookingData, passengerNames: ['Changed display name'] }, scope: { ...scope } })); });
  assert.equal(attaches, 2);
  await act(async () => foreground('background')); assert.equal(detaches, 2);
  await act(async () => renderer.unmount());
  if (oldFlag === undefined) delete process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED;
  else process.env.EXPO_PUBLIC_PASSENGER_TRIP_ENABLED = oldFlag;
});

test('navigation writer cannot overwrite display or auth evidence with a captured projection', async () => {
  let entries;
  const deps = { SESSION_KEYS: { TOUR_DATA: 'tour', BOOKING_DATA: 'booking', LAST_SCREEN: 'screen', IDENTITY_BINDING: 'identity' },
    SessionStorage: { multiSet: async (value) => { entries = value; } }, logger: { error() {} },
    passengerTripActive: true, tourData: { stale: true }, bookingData: { stale: true }, currentScreen: 'Itinerary' };
  await runSaveSessionProjection(deps);
  assert.deepEqual(entries, [['screen', 'Itinerary']]);
  await runSaveSessionProjection(deps, { bookingData: props.bookingData, tourData: props.tourData });
  assert.equal(entries[0][0], 'tour'); assert.equal(entries[1][0], 'booking');
});
