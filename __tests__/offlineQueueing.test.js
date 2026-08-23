const test = require('node:test');
const assert = require('node:assert');
const { updateManifestBooking, MANIFEST_STATUS } = require('../services/bookingServiceRealtime');
const { sendInternalDriverMessage, sendMessage } = require('../services/chatService');
const offlineSyncService = require('../services/offlineSyncService');

const clearQueue = async () => {
  const queued = await offlineSyncService.getQueuedActions({ includeAll: true });
  if (queued.success) {
    await Promise.all(queued.data.map((action) => offlineSyncService.removeAction(action.id, { includeAll: true })));
  }
};

test('manifest update queues when offline option is false', async () => {
  await clearQueue();
  let directWriteAttempts = 0;
  const result = await updateManifestBooking('TOUR 1', 'ABC123', [MANIFEST_STATUS.BOARDED], {
    online: false,
    db: {
      ref: () => {
        directWriteAttempts += 1;
        throw new Error('offline updates must not touch the database');
      },
    },
    actorPrincipalId: 'driver:D-TEST',
    authUid: 'driver-auth-test',
  });
  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  assert.equal(directWriteAttempts, 0);

  const queued = await offlineSyncService.getQueuedActions({ includeAll: true });
  assert.equal(queued.data.some((a) => a.type === 'MANIFEST_UPDATE'), true);
});

test('chat send queues when offline option is false', async () => {
  await clearQueue();
  let directWriteAttempts = 0;
  const result = await sendMessage(
    'tour-1',
    'Hello queue',
    { name: 'Tester', userId: 'stable-pax-1', principalType: 'passenger', stablePassengerId: 'stable-pax-1', isDriver: false },
    {
      ref: () => {
        directWriteAttempts += 1;
        throw new Error('offline chat sends must not touch the database');
      },
    },
    { online: false }
  );
  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  assert.equal(result.message.status, 'queued');
  assert.equal(directWriteAttempts, 0);

  const queued = await offlineSyncService.getQueuedActions({ includeAll: true });
  assert.equal(queued.data.some((a) => a.type === 'CHAT_MESSAGE'), true);
});

test('internal driver chat queues immediately without touching Firebase while offline', async () => {
  await clearQueue();
  let directWriteAttempts = 0;
  const result = await sendInternalDriverMessage(
    'tour-driver-offline',
    'Coach is delayed',
    { name: 'Driver Bondy', principalId: 'driver:BONDY', principalType: 'driver', isDriver: true },
    {
      ref: () => {
        directWriteAttempts += 1;
        throw new Error('offline internal chat sends must not touch the database');
      },
    },
    { online: false },
  );

  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  assert.equal(result.message.status, 'queued');
  assert.equal(directWriteAttempts, 0);

  const queued = await offlineSyncService.getQueuedActions({ includeAll: true });
  assert.equal(queued.data.some((action) => action.type === 'INTERNAL_CHAT_MESSAGE'), true);
});
