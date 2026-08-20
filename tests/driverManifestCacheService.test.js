const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriverManifestCacheService } = require('../services/driverManifestCacheService');

const createStorage = () => {
  const values = new Map();
  return {
    values,
    getItemAsync: async (key) => values.get(key) || null,
    setItemAsync: async (key, value) => values.set(key, value),
    deleteItemAsync: async (key) => values.delete(key),
  };
};

const manifest = (overrides = {}) => ({
  tourId: 'TOUR_1',
  complete: true,
  bookings: [{
    id: 'BOOK-1', passengerNames: ['Ada', 'Ben'], passengerStatus: ['BOARDED', 'PENDING'],
    seatNumbers: [1, 2], seatLabels: ['A1', 'A2'],
    pickupPoints: [{ date: '20/08/2026', time: '08:10', location: 'Luss' }],
    pickupLocation: 'Luss', pickupTime: '08:10', notes: 'Call ahead', ignoredSensitiveField: 'must-not-persist',
  }],
  stats: { totalBookings: 999, totalPax: 999, checkedIn: 999, noShows: 999 },
  ...overrides,
});

test('stores a bounded complete driver manifest snapshot and recomputes stats', async () => {
  const storage = createStorage();
  const cache = createDriverManifestCacheService({ storage, now: () => 1_000 });
  const saved = await cache.replace({ tourId: 'tour_1', driverId: 'd-driver', manifest: manifest(), fetchedAtMs: 900 });
  assert.equal(saved.success, true);
  assert.deepEqual(saved.data.stats, { totalBookings: 1, totalPax: 2, checkedIn: 1, noShows: 0 });
  assert.equal(saved.data.complete, true);
  assert.deepEqual(saved.data.bookings[0].seatLabels, ['A1', 'A2']);
  assert.deepEqual(saved.data.bookings[0].pickupPoints, [{ date: '20/08/2026', time: '08:10', location: 'Luss' }]);
  assert.equal(JSON.stringify(saved.data).includes('must-not-persist'), false);
  const loaded = await cache.get({ tourId: 'TOUR_1', driverId: 'D-DRIVER' });
  assert.deepEqual(loaded.data, saved.data);
});

test('never accepts a wrong-tour, malformed, duplicated, or partial snapshot', async () => {
  const storage = createStorage();
  const cache = createDriverManifestCacheService({ storage, now: () => 1_000 });
  for (const invalid of [
    manifest({ tourId: 'OTHER' }),
    manifest({ complete: false }),
    manifest({ complete: undefined }),
    manifest({ bookings: [{ id: 'BOOK-1', passengerNames: [], status: 'PENDING' }] }),
    manifest({ bookings: [manifest().bookings[0], manifest().bookings[0]] }),
    manifest({ bookings: [{ ...manifest().bookings[0], passengerStatus: ['PENDING'] }] }),
  ]) {
    const result = await cache.replace({ tourId: 'TOUR_1', driverId: 'D-DRIVER', manifest: invalid, fetchedAtMs: 900 });
    assert.equal(result.success, false);
  }
  assert.equal(storage.values.size, 0);
});

test('does not replace a valid non-empty cached manifest with an empty or unmarked payload', async () => {
  const storage = createStorage();
  const cache = createDriverManifestCacheService({ storage, now: () => 1_000 });
  const saved = await cache.replace({ tourId: 'TOUR_1', driverId: 'D-DRIVER', manifest: manifest(), fetchedAtMs: 900 });
  assert.equal(saved.success, true);
  assert.equal((await cache.replace({
    tourId: 'TOUR_1', driverId: 'D-DRIVER', manifest: manifest({ bookings: [] }), fetchedAtMs: 950,
  })).success, false);
  assert.equal((await cache.replace({
    tourId: 'TOUR_1', driverId: 'D-DRIVER', manifest: manifest({ complete: false }), fetchedAtMs: 950,
  })).success, false);
  assert.deepEqual((await cache.get({ tourId: 'TOUR_1', driverId: 'D-DRIVER' })).data, saved.data);
});

test('identity-scopes snapshots and performs exact idempotent purge', async () => {
  const storage = createStorage();
  const cache = createDriverManifestCacheService({ storage, now: () => 1_000 });
  await cache.replace({ tourId: 'TOUR_1', driverId: 'D-ONE', manifest: manifest(), fetchedAtMs: 900 });
  await cache.replace({ tourId: 'TOUR_1', driverId: 'D-TWO', manifest: manifest(), fetchedAtMs: 900 });
  assert.equal((await cache.get({ tourId: 'TOUR_1', driverId: 'D-ONE' })).success, true);
  await cache.purge({ tourId: 'TOUR_1', driverId: 'D-ONE' });
  await cache.purge({ tourId: 'TOUR_1', driverId: 'D-ONE' });
  assert.equal((await cache.get({ tourId: 'TOUR_1', driverId: 'D-ONE' })).data, null);
  assert.ok((await cache.get({ tourId: 'TOUR_1', driverId: 'D-TWO' })).data);
});

test('patches only an existing scoped cached booking for an offline queued update', async () => {
  const storage = createStorage();
  const cache = createDriverManifestCacheService({ storage, now: () => 1_000 });
  await cache.replace({ tourId: 'TOUR_1', driverId: 'D-DRIVER', manifest: manifest(), fetchedAtMs: 900 });
  const patched = await cache.applyOptimisticUpdate({
    tourId: 'TOUR_1', driverId: 'D-DRIVER', bookingRef: 'BOOK-1', passengerStatuses: ['NO_SHOW', 'NO_SHOW'],
  });
  assert.equal(patched.success, true);
  assert.equal(patched.data.bookings[0].status, 'NO_SHOW');
  assert.deepEqual(patched.data.stats, { totalBookings: 1, totalPax: 2, checkedIn: 0, noShows: 2 });
  assert.equal((await cache.applyOptimisticUpdate({
    tourId: 'TOUR_1', driverId: 'D-OTHER', bookingRef: 'BOOK-1', passengerStatuses: ['NO_SHOW', 'NO_SHOW'],
  })).success, false);
});
