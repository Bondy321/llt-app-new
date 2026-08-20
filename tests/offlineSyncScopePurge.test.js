const test = require('node:test');
const assert = require('node:assert/strict');

const offlineSyncService = require('../services/offlineSyncService');

const scope = (tourId, principalId) => ({
  tourId,
  principalId,
  role: 'driver',
  authUid: `auth-${principalId}`,
  cacheOwnerId: principalId.replace(/^driver:/, ''),
});

const enqueue = async ({ id, type = 'MANIFEST_UPDATE', ownerScope }) => {
  const result = await offlineSyncService.enqueueAction({
    id,
    type,
    tourId: ownerScope.tourId,
    scope: ownerScope,
    payload: type === 'MANIFEST_UPDATE'
      ? { bookingRef: `booking-${id}`, status: 'BOARDED' }
      : { text: `message-${id}` },
  });
  assert.equal(result.success, true);
};

test('purgeActionsForScope removes only the exact driver/tour/type payloads', async () => {
  const oldScope = scope('OLD_TOUR', 'driver:D-ONE');
  const newScope = scope('NEW_TOUR', 'driver:D-ONE');
  const otherDriverScope = scope('OLD_TOUR', 'driver:D-TWO');

  await enqueue({ id: 'old-manifest', ownerScope: oldScope });
  await enqueue({ id: 'old-chat', type: 'CHAT_MESSAGE', ownerScope: oldScope });
  await enqueue({ id: 'new-manifest', ownerScope: newScope });
  await enqueue({ id: 'other-manifest', ownerScope: otherDriverScope });

  const purged = await offlineSyncService.purgeActionsForScope({
    scope: oldScope,
    types: ['MANIFEST_UPDATE'],
  });

  assert.equal(purged.success, true);
  assert.deepEqual(purged.data.removedIds, ['old-manifest']);

  const remaining = await offlineSyncService.getQueuedActions({ includeAll: true });
  assert.deepEqual(
    remaining.data.map((action) => action.id).sort(),
    ['new-manifest', 'old-chat', 'other-manifest'],
  );

  for (const action of remaining.data) {
    await offlineSyncService.removeAction(action.id, { includeAll: true });
  }
});

test('purgeActionsForScope fails closed for incomplete or unsupported scope requests', async () => {
  assert.equal((await offlineSyncService.purgeActionsForScope({ scope: null })).success, false);
  assert.equal((await offlineSyncService.purgeActionsForScope({
    scope: scope('TOUR', 'driver:D-ONE'),
    types: ['NOT_A_REAL_ACTION'],
  })).success, false);
});

test('purgeTourPack deletes only the exact role, tour and login-owner cache pair', async () => {
  await offlineSyncService.saveTourPack('TOUR_A', 'driver', { marker: 'driver-a' }, { ownerId: 'D-ONE' });
  await offlineSyncService.setTourPackMeta('TOUR_A', 'driver', { marker: 'meta-a' }, { ownerId: 'D-ONE' });
  await offlineSyncService.saveTourPack('TOUR_B', 'driver', { marker: 'driver-b' }, { ownerId: 'D-ONE' });
  await offlineSyncService.saveTourPack('TOUR_A', 'driver', { marker: 'driver-two' }, { ownerId: 'D-TWO' });

  const result = await offlineSyncService.purgeTourPack('TOUR_A', 'driver', { ownerId: 'D-ONE' });
  assert.equal(result.success, true);
  assert.equal((await offlineSyncService.getTourPack('TOUR_A', 'driver', { ownerId: 'D-ONE' })).data, null);
  assert.equal((await offlineSyncService.getTourPackMeta('TOUR_A', 'driver', { ownerId: 'D-ONE' })).data, null);
  assert.equal((await offlineSyncService.getTourPack('TOUR_B', 'driver', { ownerId: 'D-ONE' })).data.marker, 'driver-b');
  assert.equal((await offlineSyncService.getTourPack('TOUR_A', 'driver', { ownerId: 'D-TWO' })).data.marker, 'driver-two');

  await offlineSyncService.purgeTourPack('TOUR_B', 'driver', { ownerId: 'D-ONE' });
  await offlineSyncService.purgeTourPack('TOUR_A', 'driver', { ownerId: 'D-TWO' });
});
