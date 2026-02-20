const test = require('node:test');
const assert = require('node:assert');
const { updateManifestBooking, MANIFEST_STATUS } = require('../services/bookingServiceRealtime');
const { sendMessage } = require('../services/chatService');
const offlineSyncService = require('../services/offlineSyncService');

const clearQueue = async () => {
  const queued = await offlineSyncService.getQueuedActions();
  if (queued.success) {
    await Promise.all(queued.data.map((action) => offlineSyncService.removeAction(action.id)));
  }
};

test('manifest update queues when offline option is false', async () => {
  await clearQueue();
  const result = await updateManifestBooking('TOUR 1', 'ABC123', [MANIFEST_STATUS.BOARDED], { online: false, db: null });
  assert.equal(result.success, true);
  assert.equal(result.queued, true);

  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.data.some((a) => a.type === 'MANIFEST_UPDATE'), true);
});

test('chat send queues when offline option is false', async () => {
  await clearQueue();
  const result = await sendMessage('tour-1', 'Hello queue', { name: 'Tester', userId: 'u-1', isDriver: false }, null, { online: false });
  assert.equal(result.success, true);
  assert.equal(result.queued, true);
  assert.equal(result.message.status, 'queued');

  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.data.some((a) => a.type === 'CHAT_MESSAGE'), true);
});
