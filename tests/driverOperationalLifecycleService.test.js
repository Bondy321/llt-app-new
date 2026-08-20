const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDriverOperationalLifecycleService,
  normalizeDriverOperationalScope,
} = require('../services/driverOperationalLifecycleService');

test('normalizes one exact canonical driver, departure and queue scope', () => {
  const scope = normalizeDriverOperationalScope({
    authUid: 'auth-one',
    driverId: 'd-one',
    tourId: '5001d 1',
    startDate: '20/08/2026',
  });

  assert.equal(scope.ok, true);
  assert.equal(scope.driverId, 'D-ONE');
  assert.equal(scope.tourId, '5001D_1');
  assert.equal(scope.departureKey, '2026-08-20::5001D_1');
  assert.deepEqual(scope.queueScope, {
    tourId: '5001D_1',
    principalId: 'driver:D-ONE',
    role: 'driver',
    authUid: 'auth-one',
    cacheOwnerId: 'D-ONE',
  });
});

test('purge removes every exact operational cache and queued action after stopping replay', async () => {
  const calls = [];
  const service = createDriverOperationalLifecycleService({
    driverPacks: {
      normalizeScope: () => ({ ok: true }),
      purge: async (scope) => { calls.push(['driver-pack', scope.departureKey]); return { success: true }; },
    },
    manifests: {
      purge: async (scope) => { calls.push(['manifest', scope]); return { success: true }; },
    },
    offline: {
      setActiveSessionScope: async (scope) => { calls.push(['session', scope]); return { success: true }; },
      purgeTourPack: async (tourId, role, options) => { calls.push(['legacy', tourId, role, options]); return { success: true }; },
      purgeActionsForScope: async ({ scope }) => { calls.push(['queue', scope]); return { success: true }; },
    },
  });

  const result = await service.purge({
    authUid: 'auth-one',
    driverId: 'D-ONE',
    tourId: '5001D_1',
    departureKey: '2026-08-20::5001D_1',
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.find(([name]) => name === 'queue')[1], {
    tourId: '5001D_1',
    principalId: 'driver:D-ONE',
    role: 'driver',
    authUid: 'auth-one',
    cacheOwnerId: 'D-ONE',
  });
});

test('purge remains fail-closed and reports partial storage failures', async () => {
  const service = createDriverOperationalLifecycleService({
    driverPacks: { purge: async () => ({ success: true }) },
    manifests: { purge: async () => ({ success: false, error: 'disk unavailable' }) },
    offline: {
      setActiveSessionScope: async () => ({ success: true }),
      purgeTourPack: async () => ({ success: true }),
      purgeActionsForScope: async () => ({ success: true }),
    },
  });

  const result = await service.purge({ driverId: 'D-ONE', tourId: 'TOUR_1' });
  assert.equal(result.success, false);
  assert.deepEqual(result.failures, [{ name: 'manifest', error: 'disk unavailable' }]);
  assert.equal((await service.purge({ driverId: 'invalid', tourId: 'TOUR_1' })).success, false);
});
