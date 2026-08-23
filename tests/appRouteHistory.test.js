const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppRouteHistory } = require('../utils/appRouteHistory');

test('route history returns the actual caller with its original parameters', () => {
  const history = createAppRouteHistory();
  const params = { tab: 'people', departureKey: 'departure-1' };
  history.push({ screen: 'DriverTourPack', params });

  assert.deepEqual(history.pop({ fallbackScreen: 'DriverHome' }), {
    screen: 'DriverTourPack',
    params,
  });
});

test('route history uses a safe fallback and never retains login', () => {
  const history = createAppRouteHistory();
  assert.equal(history.push({ screen: 'Login', params: {} }), false);
  assert.deepEqual(history.pop({ fallbackScreen: 'TourHome' }), {
    screen: 'TourHome',
    params: {},
  });
});

test('route history is bounded and resettable', () => {
  const history = createAppRouteHistory({ maxEntries: 2 });
  history.push({ screen: 'TourHome', params: { sequence: 1 } });
  history.push({ screen: 'Map', params: { sequence: 2 } });
  history.push({ screen: 'Chat', params: { sequence: 3 } });

  assert.equal(history.size(), 2);
  assert.equal(history.pop().screen, 'Chat');
  assert.equal(history.pop().screen, 'Map');
  history.push({ screen: 'Itinerary', params: {} });
  history.reset();
  assert.equal(history.size(), 0);
});
