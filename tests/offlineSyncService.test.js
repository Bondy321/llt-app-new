const test = require('node:test');
const assert = require('node:assert');
const offlineSyncService = require('../services/offlineSyncService');

const clearQueue = async () => {
  const queued = await offlineSyncService.getQueuedActions();
  if (!queued.success) return;

  for (const action of queued.data) {
    await offlineSyncService.removeAction(action.id);
  }
};

test('queue enqueue/dequeue lifecycle works', async () => {
  await clearQueue();
  const enqueue = await offlineSyncService.enqueueAction({
    id: 'q-lifecycle-1',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    createdAt: new Date().toISOString(),
    payload: { text: 'hello' },
  });
  assert.equal(enqueue.success, true);

  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.success, true);
  assert.equal(queued.data.length, 1);

  const removed = await offlineSyncService.removeAction('q-lifecycle-1');
  assert.equal(removed.success, true);
  const after = await offlineSyncService.getQueuedActions();
  assert.equal(after.data.length, 0);
});

test('unified sync taxonomy exposes exactly four canonical states with required metadata', () => {
  const stateKeys = Object.keys(offlineSyncService.UNIFIED_SYNC_STATES).sort();
  assert.deepEqual(stateKeys, [
    'OFFLINE_NO_NETWORK',
    'ONLINE_BACKEND_DEGRADED',
    'ONLINE_BACKLOG_PENDING',
    'ONLINE_HEALTHY',
  ]);

  stateKeys.forEach((stateKey) => {
    const state = offlineSyncService.UNIFIED_SYNC_STATES[stateKey];
    assert.equal(typeof state.label, 'string');
    assert.equal(typeof state.description, 'string');
    assert.equal(typeof state.severity, 'string');
    assert.equal(typeof state.icon, 'string');
    assert.equal(typeof state.canRetry, 'boolean');
    assert.equal(typeof state.showLastSync, 'boolean');
  });
});

test('formatSyncOutcome always emits canonical "X synced / Y pending / Z failed" text', () => {
  const formatted = offlineSyncService.formatSyncOutcome({
    syncedCount: '11.7',
    pendingCount: NaN,
    failedCount: null,
  });
  assert.match(formatted, /^\d+ synced \/ \d+ pending \/ \d+ failed$/);
  assert.equal(formatted, '11 synced / 0 pending / 0 failed');
});

test('buildSyncSummary applies fallback normalization for missing and invalid values', () => {
  const summary = offlineSyncService.buildSyncSummary({
    syncedCount: -20,
    pendingCount: 'not-a-number',
    failedCount: 4.9,
    source: 'totally-unsupported',
  });

  assert.deepEqual(summary, {
    syncedCount: 0,
    pendingCount: 0,
    failedCount: 4,
    lastSuccessAt: null,
    source: 'unknown',
  });
});

test('setLastSuccessAt/getLastSuccessAt persist and restore stored timestamps', async () => {
  const persisted = await offlineSyncService.setLastSuccessAt(1735689600000);
  assert.equal(persisted.success, true);
  assert.equal(persisted.data, 1735689600000);

  const loaded = await offlineSyncService.getLastSuccessAt();
  assert.equal(loaded.success, true);
  assert.equal(loaded.data, 1735689600000);
});

test('formatLastSyncRelative returns expected labels including fallback', () => {
  assert.equal(offlineSyncService.formatLastSyncRelative(1735689600000, 1735689600020), 'Just now');
  assert.equal(offlineSyncService.formatLastSyncRelative(1735689480000, 1735689600000), '2m ago');
  assert.equal(offlineSyncService.formatLastSyncRelative(1735686000000, 1735689600000), '1h ago');
  assert.equal(offlineSyncService.formatLastSyncRelative('2025-01-01T00:00:00.000Z', '2025-01-02T10:00:00.000Z'), 'Yesterday');
  assert.equal(offlineSyncService.formatLastSyncRelative('invalid', 1735689600000), 'Never');
});

test('getQueuedActions sanitizes invalid status, attempts, and timestamps from queued actions', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'sanitize-1',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    createdAt: 'not-a-real-date',
    nextAttemptAt: 'also-invalid',
    attempts: -7.8,
    status: 'unexpected-status',
    payload: { text: 'sanitize' },
  });

  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.success, true);
  assert.equal(queued.data.length, 1);

  const [action] = queued.data;
  assert.equal(action.status, 'queued');
  assert.equal(action.attempts, 0);
  assert.equal(action.nextAttemptAt, null);
  assert.match(action.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(action.lastUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('getStalenessLabel supports deterministic now injection and pluralized stale-day labels', () => {
  const now = '2026-01-05T10:00:00.000Z';

  const futureOrNow = offlineSyncService.getStalenessLabel('2026-01-05T10:00:01.000Z', now);
  assert.deepEqual(futureOrNow, { bucket: 'fresh', label: 'Updated just now' });

  const minutesAgo = offlineSyncService.getStalenessLabel('2026-01-05T09:30:00.000Z', now);
  assert.deepEqual(minutesAgo, { bucket: 'stale', label: 'Updated 30 min ago' });

  const multiDay = offlineSyncService.getStalenessLabel('2026-01-01T09:00:00.000Z', now);
  assert.deepEqual(multiDay, { bucket: 'old', label: 'Cached data from 4 days ago' });
});

test('replayQueue processes in FIFO order', async () => {
  await clearQueue();
  const calls = [];

  await offlineSyncService.enqueueAction({ id: 'fifo-2', type: 'CHAT_MESSAGE', tourId: 'tour-1', createdAt: '2026-01-01T00:00:02.000Z', payload: { text: 'second' } });
  await offlineSyncService.enqueueAction({ id: 'fifo-1', type: 'CHAT_MESSAGE', tourId: 'tour-1', createdAt: '2026-01-01T00:00:01.000Z', payload: { text: 'first' } });

  const result = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async (payload) => {
          calls.push(payload.text);
          return { success: true };
        },
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['first', 'second']);
});



test('enqueueAction clears processed id tombstone so intentional re-queue can replay', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'requeue-1',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    payload: { text: 'first attempt' },
  });

  const firstReplay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: true }),
      },
    },
  });

  assert.equal(firstReplay.success, true);

  const replayCalls = [];
  await offlineSyncService.enqueueAction({
    id: 'requeue-1',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    payload: { text: 'second attempt' },
  });

  const secondReplay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async (payload) => {
          replayCalls.push(payload.text);
          return { success: true };
        },
      },
    },
  });

  assert.equal(secondReplay.success, true);
  assert.deepEqual(replayCalls, ['second attempt']);
});
test('replayQueue caps retries and marks action failed', async () => {
  await clearQueue();
  await offlineSyncService.enqueueAction({ id: 'retry-1', type: 'CHAT_MESSAGE', tourId: 'tour-1', payload: { text: 'retry' } });

  for (let i = 0; i < 5; i += 1) {
    await offlineSyncService.replayQueue({ services: { chatService: { sendMessageDirect: async () => ({ success: false, error: 'network' }) } } });
    const queued = await offlineSyncService.getQueuedActions();
    if (queued.data[0]?.status === 'failed') break;
    await offlineSyncService.updateAction('retry-1', { nextAttemptAt: null });
  }

  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.data[0].status, 'failed');
  assert.equal(queued.data[0].attempts >= 5, true);

  const attemptsBefore = queued.data[0].attempts;
  await offlineSyncService.replayQueue({ services: { chatService: { sendMessageDirect: async () => ({ success: false, error: 'network' }) } } });

  const stillFailed = await offlineSyncService.getQueuedActions();
  assert.equal(stillFailed.data[0].status, 'failed');
  assert.equal(stillFailed.data[0].attempts, attemptsBefore);

  await offlineSyncService.updateAction('retry-1', { status: 'queued', nextAttemptAt: null });
  await offlineSyncService.replayQueue({ services: { chatService: { sendMessageDirect: async () => ({ success: false, error: 'network' }) } } });

  const retried = await offlineSyncService.getQueuedActions();
  assert.equal(retried.data[0].attempts, attemptsBefore + 1);

  const stats = await offlineSyncService.getQueueStats();
  assert.equal(stats.success, true);
  assert.equal(stats.data.failed, 1);
  assert.equal(stats.data.pending, 0);
});


test('retryFailedActions re-queues only selected failed types and clears backoff window', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'retry-type-chat',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    payload: { text: 'retry chat' },
    status: 'failed',
    attempts: 3,
    nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await offlineSyncService.enqueueAction({
    id: 'retry-type-manifest',
    type: 'MANIFEST_UPDATE',
    tourId: 'tour-1',
    payload: { bookingRef: 'ABC123' },
    status: 'failed',
    attempts: 2,
    nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const retried = await offlineSyncService.retryFailedActions({ types: ['CHAT_MESSAGE'] });
  assert.equal(retried.success, true);
  assert.equal(retried.data.retriedCount, 1);

  const queued = await offlineSyncService.getQueuedActions();
  const chat = queued.data.find((action) => action.id === 'retry-type-chat');
  const manifest = queued.data.find((action) => action.id === 'retry-type-manifest');

  assert.equal(chat.status, 'queued');
  assert.equal(chat.nextAttemptAt, null);
  assert.equal(chat.attempts, 3);

  assert.equal(manifest.status, 'failed');
  assert.notEqual(manifest.nextAttemptAt, null);
});


test('replayQueue can process PHOTO_UPLOAD when photoService direct handler is provided', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'photo-replay-1',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo',
    payload: {
      uri: 'file:///tmp/test.jpg',
      tourId: 'tour-photo',
      userId: 'user-1',
    },
  });

  let called = 0;
  const replay = await offlineSyncService.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async (payload) => {
          called += 1;
          assert.equal(payload.tourId, 'tour-photo');
          return { success: true };
        },
      },
    },
  });

  assert.equal(replay.success, true);
  assert.equal(replay.data.processed, 1);
  assert.equal(replay.data.failed, 0);
  assert.equal(called, 1);

  const remaining = await offlineSyncService.getQueuedActions();
  assert.equal(remaining.success, true);
  assert.equal(remaining.data.length, 0);
});

test('replayQueue skips max-attempt failed action and replays once when re-queued', async () => {
  await clearQueue();
  const MAX_ATTEMPTS = 5;
  const actionId = 'skip-failed-1';

  await offlineSyncService.enqueueAction({
    id: actionId,
    type: 'CHAT_MESSAGE',
    tourId: 'tour-1',
    payload: { text: 'skip-me' },
    status: 'failed',
    attempts: MAX_ATTEMPTS,
    nextAttemptAt: null,
  });

  let handlerCalls = 0;
  const replayHandler = async () => {
    handlerCalls += 1;
    assert.fail('sendMessageDirect should not be called for failed max-attempt action');
  };

  await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: replayHandler,
      },
    },
  });

  const afterSkip = await offlineSyncService.getQueuedActions();
  assert.equal(handlerCalls, 0);
  assert.equal(afterSkip.data[0].attempts, MAX_ATTEMPTS);
  assert.equal(afterSkip.data[0].status, 'failed');

  await offlineSyncService.updateAction(actionId, { status: 'queued', nextAttemptAt: null });

  await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => {
          handlerCalls += 1;
          return { success: true };
        },
      },
    },
  });

  assert.equal(handlerCalls, 1);
  const afterReplay = await offlineSyncService.getQueuedActions();
  assert.equal(afterReplay.data.length, 0);
});

test('staleness label buckets are derived correctly', async () => {
  const fresh = offlineSyncService.getStalenessLabel(new Date().toISOString());
  const stale = offlineSyncService.getStalenessLabel(new Date(Date.now() - 20 * 60 * 1000).toISOString());
  const old = offlineSyncService.getStalenessLabel(new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString());

  assert.equal(fresh.bucket, 'fresh');
  assert.equal(stale.bucket, 'stale');
  assert.equal(old.bucket, 'old');
});

test('saveTourPack merges partial payloads without losing existing keys', async () => {
  const tourId = 'tour-merge-1';
  const role = 'passenger';

  const firstWrite = await offlineSyncService.saveTourPack(tourId, role, {
    tour: { id: tourId, name: 'Loch Tour' },
    booking: { reference: 'ABC123' },
  });
  assert.equal(firstWrite.success, true);

  const secondWrite = await offlineSyncService.saveTourPack(tourId, role, {
    itinerary: { stops: [{ name: 'Luss' }] },
  });
  assert.equal(secondWrite.success, true);

  const cached = await offlineSyncService.getTourPack(tourId, role);
  assert.equal(cached.success, true);
  assert.deepEqual(cached.data.tour, { id: tourId, name: 'Loch Tour' });
  assert.deepEqual(cached.data.booking, { reference: 'ABC123' });
  assert.deepEqual(cached.data.itinerary, { stops: [{ name: 'Luss' }] });
  assert.equal(typeof cached.data.fetchedAt, 'string');
  assert.equal(typeof cached.data.sourceVersion, 'number');
});

test('subscribeQueueState emits queue stats that drive Pending badge text', async () => {
  await clearQueue();

  const seenBadgeTexts = [];
  const unsubscribe = offlineSyncService.subscribeQueueState((stats) => {
    seenBadgeTexts.push(`Pending ${stats.pending}`);
  });

  await offlineSyncService.enqueueAction({
    id: 'badge-1',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-badge',
    payload: { text: 'queued message' },
  });

  await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: true }),
      },
    },
  });

  unsubscribe();

  assert.equal(seenBadgeTexts.includes('Pending 1'), true);
  assert.equal(seenBadgeTexts.at(-1), 'Pending 0');
});

test('replayQueue writes lastSuccessAt whenever at least one action is processed', async () => {
  await clearQueue();
  await offlineSyncService.setLastSuccessAt(1111);

  await offlineSyncService.enqueueAction({
    id: 'last-success-ok',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-last-success',
    payload: { text: 'success-only' },
  });

  const firstReplay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: true }),
      },
    },
  });

  assert.equal(firstReplay.success, true);
  assert.equal(firstReplay.data.failed, 0);
  const afterSuccess = await offlineSyncService.getLastSuccessAt();
  assert.equal(afterSuccess.success, true);
  assert.equal(typeof afterSuccess.data, 'number');
  assert.equal(afterSuccess.data > 1111, true);

  await offlineSyncService.enqueueAction({
    id: 'last-success-mixed-ok',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-last-success',
    createdAt: '2026-01-01T00:00:01.000Z',
    payload: { text: 'mixed-success' },
  });

  await offlineSyncService.enqueueAction({
    id: 'last-success-mixed-fail',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-last-success',
    createdAt: '2026-01-01T00:00:02.000Z',
    payload: { text: 'mixed-failure' },
  });

  const priorValue = afterSuccess.data;
  const secondReplay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async (payload) => (
          payload.text === 'mixed-success'
            ? { success: true }
            : { success: false, error: 'network' }
        ),
      },
    },
  });

  assert.equal(secondReplay.success, true);
  assert.equal(secondReplay.data.processed, 1);
  assert.equal(secondReplay.data.failed, 1);

  const afterFailure = await offlineSyncService.getLastSuccessAt();
  assert.equal(afterFailure.success, true);
  assert.equal(typeof afterFailure.data, 'number');
  assert.equal(afterFailure.data > priorValue, true);
});

test('replayQueue does not refresh lastSuccessAt when there is no work to process', async () => {
  await clearQueue();
  await offlineSyncService.setLastSuccessAt(123456789);

  const replayResult = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: true }),
      },
    },
  });

  assert.equal(replayResult.success, true);
  assert.equal(replayResult.data.processed, 0);
  assert.equal(replayResult.data.failed, 0);

  const afterReplay = await offlineSyncService.getLastSuccessAt();
  assert.equal(afterReplay.success, true);
  assert.equal(afterReplay.data, 123456789);
});
