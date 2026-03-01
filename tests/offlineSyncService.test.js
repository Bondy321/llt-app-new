const test = require('node:test');
const assert = require('node:assert');
const offlineSyncService = require('../services/offlineSyncService');

const clearQueue = async () => {
  const queued = await offlineSyncService.getQueuedActions();
  if (!queued.success) return;
  await Promise.all(queued.data.map((action) => offlineSyncService.removeAction(action.id)));
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

test('replayQueue writes lastSuccessAt only when there are zero failures', async () => {
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
    id: 'last-success-fail',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-last-success',
    payload: { text: 'fails-once' },
  });

  const priorValue = afterSuccess.data;
  const secondReplay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: false, error: 'network' }),
      },
    },
  });

  assert.equal(secondReplay.success, true);
  assert.equal(secondReplay.data.failed, 1);

  const afterFailure = await offlineSyncService.getLastSuccessAt();
  assert.equal(afterFailure.success, true);
  assert.equal(afterFailure.data, priorValue);
});
