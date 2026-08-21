const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDriverTourPackFeatureFlagService,
  normalizeDriverId,
} = require('../services/driverTourPackFeatureFlag');

function createDatabase() {
  const listeners = new Map();
  const offCalls = [];
  return {
    listeners,
    offCalls,
    ref(path) {
      return {
        on(_event, onValue, onError) { listeners.set(path, { onValue, onError }); },
        off(_event, onValue) { offCalls.push({ path, onValue }); },
      };
    },
    emit(path, value) { listeners.get(path)?.onValue({ val: () => value }); },
    fail(path, error) { listeners.get(path)?.onError(error); },
  };
}

test('normalizes only safe canonical driver IDs', () => {
  assert.equal(normalizeDriverId(' d-bondy_1 '), 'D-BONDY_1');
  assert.equal(normalizeDriverId('../drivers'), '');
  assert.equal(normalizeDriverId('PASSENGER'), '');
});

test('subscribes only to exact global and own-driver flags and supports live rollback', () => {
  const db = createDatabase();
  const service = createDriverTourPackFeatureFlagService({ getDatabase: () => db });
  const states = [];
  const unsubscribe = service.subscribe('D-BONDY', (state) => states.push(state));

  assert.deepEqual([...db.listeners.keys()].sort(), [
    'driver_tour_pack_feature_flags/drivers/D-BONDY',
    'driver_tour_pack_feature_flags/global',
  ]);
  db.emit('driver_tour_pack_feature_flags/global', false);
  assert.equal(states.length, 0);
  db.emit('driver_tour_pack_feature_flags/drivers/D-BONDY', true);
  assert.equal(states.at(-1).enabled, true);
  assert.equal(states.at(-1).reason, 'DRIVER_ENABLED');

  db.emit('driver_tour_pack_feature_flags/drivers/D-BONDY', false);
  assert.equal(states.at(-1).enabled, false);
  assert.equal(states.at(-1).reason, 'DISABLED');
  db.emit('driver_tour_pack_feature_flags/global', true);
  assert.equal(states.at(-1).enabled, true);
  assert.equal(states.at(-1).reason, 'GLOBAL_ENABLED');

  unsubscribe();
  assert.equal(db.offCalls.length, 2);
});

test('fails closed for invalid identity and listener errors', () => {
  const db = createDatabase();
  const service = createDriverTourPackFeatureFlagService({ getDatabase: () => db });
  const invalidStates = [];
  service.subscribe('unsafe/id', (state) => invalidStates.push(state));
  assert.deepEqual(invalidStates, [{ enabled: false, loading: false, reason: 'UNAVAILABLE' }]);
  assert.equal(db.listeners.size, 0);

  const states = [];
  const errors = [];
  service.subscribe('D-BONDY', (state) => states.push(state), (error) => errors.push(error));
  db.fail('driver_tour_pack_feature_flags/global', new Error('permission denied'));
  assert.equal(states.at(-1).enabled, false);
  assert.equal(states.at(-1).reason, 'UNAVAILABLE');
  assert.equal(errors.at(-1).message, 'permission denied');
});

test('TestFlight eligibility requires its independently revocable server flag', () => {
  const db = createDatabase();
  const service = createDriverTourPackFeatureFlagService({ getDatabase: () => db });
  const states = [];
  const unsubscribe = service.subscribe('D-BONDY', (state) => states.push(state), () => {}, { testflightEligible: true });

  assert.deepEqual([...db.listeners.keys()].sort(), [
    'driver_tour_pack_feature_flags/drivers/D-BONDY',
    'driver_tour_pack_feature_flags/global',
    'driver_tour_pack_feature_flags/testflight',
  ]);
  db.emit('driver_tour_pack_feature_flags/global', false);
  db.emit('driver_tour_pack_feature_flags/drivers/D-BONDY', false);
  assert.equal(states.length, 0);
  db.emit('driver_tour_pack_feature_flags/testflight', true);
  assert.equal(states.at(-1).enabled, true);
  assert.equal(states.at(-1).reason, 'TESTFLIGHT_ENABLED');
  db.emit('driver_tour_pack_feature_flags/testflight', false);
  assert.equal(states.at(-1).enabled, false);
  unsubscribe();
  assert.equal(db.offCalls.length, 3);
});
