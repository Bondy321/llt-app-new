const test = require('node:test');
const assert = require('node:assert');
const offlineSyncService = require('../services/offlineSyncService');

const testScope = (tourId, principalId = 'test-principal', role = 'passenger') => ({
  tourId,
  principalId,
  role,
  authUid: 'test-auth-uid',
});
const rawQueueApi = {
  enqueueAction: offlineSyncService.enqueueAction,
  getQueuedActions: offlineSyncService.getQueuedActions,
  getQueueStats: offlineSyncService.getQueueStats,
  updateAction: offlineSyncService.updateAction,
  removeAction: offlineSyncService.removeAction,
  retryFailedActions: offlineSyncService.retryFailedActions,
  replayQueue: offlineSyncService.replayQueue,
};

// Most tests in this file predate session isolation and intentionally exercise
// whole-queue mechanics. Keep those assertions explicit while the isolation
// tests below call the raw scoped API directly.
offlineSyncService.enqueueAction = async (action) => {
  const scope = action.scope || testScope(action.tourId);
  await offlineSyncService.setActiveSessionScope(scope);
  return rawQueueApi.enqueueAction({ ...action, scope });
};
offlineSyncService.getQueuedActions = (options = {}) => rawQueueApi.getQueuedActions({ includeAll: true, ...options });
offlineSyncService.getQueueStats = (options = {}) => rawQueueApi.getQueueStats({ includeAll: true, ...options });
offlineSyncService.updateAction = (id, patch, options = {}) => rawQueueApi.updateAction(id, patch, { includeAll: true, ...options });
offlineSyncService.removeAction = (id, options = {}) => rawQueueApi.removeAction(id, { includeAll: true, ...options });
offlineSyncService.retryFailedActions = (options = {}) => rawQueueApi.retryFailedActions({ includeAll: true, ...options });
offlineSyncService.replayQueue = async (options = {}) => {
  const queued = await rawQueueApi.getQueuedActions({ includeAll: true });
  const scope = options.scope || queued.data?.find((action) => action.status !== 'failed')?.scope || testScope('tour-1');
  await offlineSyncService.setActiveSessionScope(scope);
  return rawQueueApi.replayQueue({ ...options, scope });
};

const clearQueue = async () => {
  const queued = await rawQueueApi.getQueuedActions({ includeAll: true });
  if (!queued.success) return;

  for (const action of queued.data) {
    await rawQueueApi.removeAction(action.id, { includeAll: true });
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
  assert.equal(remaining.data.length, 1);
  assert.equal(remaining.data[0].status, 'completed');
});

test('screen-specific replay preserves queued actions whose handlers were not injected', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'chat-context-message',
    type: 'CHAT_MESSAGE',
    tourId: 'tour-mixed-context',
    payload: { text: 'send me now' },
  });
  await offlineSyncService.enqueueAction({
    id: 'chat-context-photo',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-mixed-context',
    payload: {
      tourId: 'tour-mixed-context',
      userId: 'passenger-1',
      uri: 'file:///tmp/preserve.jpg',
      idempotencyKey: 'photo-preserve-1',
    },
  });

  const replay = await offlineSyncService.replayQueue({
    services: {
      chatService: {
        sendMessageDirect: async () => ({ success: true }),
      },
    },
  });

  assert.equal(replay.success, true);
  assert.equal(replay.data.processed, 1);
  assert.equal(replay.data.failed, 0);
  assert.equal(replay.data.skipped, 1);
  assert.equal(replay.data.outcomes.find((outcome) => outcome.actionId === 'chat-context-photo')?.skipped, true);

  const remaining = await offlineSyncService.getQueuedActions();
  const preservedPhoto = remaining.data.find((action) => action.id === 'chat-context-photo');
  assert.ok(preservedPhoto);
  assert.equal(preservedPhoto.status, 'queued');
  assert.equal(preservedPhoto.attempts, 0);
  assert.equal(preservedPhoto.lastError, null);
});

test('queued chat photo uploads create one deterministic chat image after upload', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'queued-chat-photo-1',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-chat-photo',
    payload: {
      tourId: 'tour-chat-photo',
      userId: 'passenger-1',
      uri: 'file:///tmp/chat-photo.jpg',
      idempotencyKey: 'chat-photo-upload-1',
      chatMessage: {
        tourId: 'tour-chat-photo',
        messageId: 'img-chat-photo-1',
        idempotencyKey: 'img-chat-photo-1',
        caption: '',
        senderInfo: {
          name: 'Alex',
          principalId: 'passenger-1',
          principalType: 'passenger',
          stablePassengerId: 'passenger-1',
        },
      },
    },
  });

  const calls = [];
  const replay = await offlineSyncService.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async () => ({
          success: true,
          data: { sourceUrl: 'https://example.com/chat-photo.jpg', id: 'photo-1' },
        }),
      },
      chatService: {
        sendImageMessage: async (tourId, imageUrl, caption, senderInfo, db, options) => {
          calls.push({ tourId, imageUrl, caption, senderInfo, db, options });
          return {
            success: true,
            message: { id: options.messageId },
            serverPromise: Promise.resolve(),
          };
        },
      },
    },
  });

  assert.equal(replay.success, true);
  assert.equal(replay.data.processed, 1);
  assert.equal(replay.data.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tourId, 'tour-chat-photo');
  assert.deepEqual(calls[0].imageUrl, { photoId: 'photo-1' });
  assert.equal(calls[0].options.messageId, 'img-chat-photo-1');
  assert.equal(calls[0].options.photoId, 'photo-1');

  const remaining = await offlineSyncService.getQueuedActions();
  assert.equal(remaining.data[0].status, 'completed');
  assert.equal(remaining.data[0].result.chatMessageId, 'img-chat-photo-1');
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
  const packOptions = { ownerId: 'BOOKING-PACK-1' };

  const firstWrite = await offlineSyncService.saveTourPack(tourId, role, {
    tour: { id: tourId, name: 'Loch Tour' },
    booking: { reference: 'ABC123' },
  }, packOptions);
  assert.equal(firstWrite.success, true);

  const secondWrite = await offlineSyncService.saveTourPack(tourId, role, {
    itinerary: { stops: [{ name: 'Luss' }] },
  }, packOptions);
  assert.equal(secondWrite.success, true);

  const cached = await offlineSyncService.getTourPack(tourId, role, packOptions);
  assert.equal(cached.success, true);
  assert.deepEqual(cached.data.tour, { id: tourId, name: 'Loch Tour' });
  assert.deepEqual(cached.data.booking, { reference: 'ABC123' });
  assert.deepEqual(cached.data.itinerary, { stops: [{ name: 'Luss' }] });
  assert.equal(typeof cached.data.fetchedAt, 'string');
  assert.equal(typeof cached.data.sourceVersion, 'number');
});

test('saveTourPack can atomically replace a legacy passenger payload', async () => {
  const tourId = 'tour-replace-legacy';
  const role = 'passenger';
  const packOptions = { ownerId: 'BOOKING-REPLACE-1' };

  await offlineSyncService.saveTourPack(tourId, role, {
    tour: { id: tourId, services: [{ supplier: 'Hidden' }] },
    contracts: [{ ref: 'Hidden' }],
  }, packOptions);
  await offlineSyncService.saveTourPack(tourId, role, {
    tour: { id: tourId, name: 'Safe tour' },
    booking: { id: 'BOOKING-REPLACE-1' },
  }, { ...packOptions, replaceExisting: true });

  const cached = await offlineSyncService.getTourPack(tourId, role, packOptions);
  assert.equal(cached.success, true);
  assert.deepEqual(cached.data.tour, { id: tourId, name: 'Safe tour' });
  assert.equal('contracts' in cached.data, false);
});

test('queue mutations serialize concurrent enqueues without dropping actions', async () => {
  await clearQueue();
  const scope = testScope('tour-concurrent', 'passenger-concurrent');
  await offlineSyncService.setActiveSessionScope(scope);

  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => rawQueueApi.enqueueAction({
    id: `concurrent-${index}`,
    type: 'CHAT_MESSAGE',
    tourId: scope.tourId,
    scope,
    payload: { text: `message-${index}` },
  })));

  assert.equal(results.every((result) => result.success), true);
  const queued = await rawQueueApi.getQueuedActions({ scope });
  assert.equal(queued.data.length, 24);
  assert.equal(new Set(queued.data.map((action) => action.id)).size, 24);
});

test('replay processes only the active principal and retains another session queue', async () => {
  await clearQueue();
  const scopeA = testScope('tour-shared-device', 'passenger-a');
  const scopeB = testScope('tour-shared-device', 'passenger-b');
  await offlineSyncService.setActiveSessionScope(null);
  await rawQueueApi.enqueueAction({
    id: 'scope-a-message',
    type: 'CHAT_MESSAGE',
    tourId: scopeA.tourId,
    scope: scopeA,
    payload: { text: 'from-a' },
  });
  await rawQueueApi.enqueueAction({
    id: 'scope-b-message',
    type: 'CHAT_MESSAGE',
    tourId: scopeB.tourId,
    scope: scopeB,
    payload: { text: 'from-b' },
  });
  await offlineSyncService.setActiveSessionScope(scopeB);

  const delivered = [];
  const replay = await rawQueueApi.replayQueue({
    scope: scopeB,
    services: {
      chatService: {
        sendMessageDirect: async (payload) => {
          delivered.push(payload.text);
          return { success: true };
        },
      },
    },
  });

  assert.equal(replay.success, true);
  assert.deepEqual(delivered, ['from-b']);
  assert.equal(replay.data.heldForOtherSessions, 1);
  const remaining = await rawQueueApi.getQueuedActions({ includeAll: true });
  assert.deepEqual(remaining.data.map((action) => action.id), ['scope-a-message']);
});

test('active session cannot mutate or enqueue actions owned by another principal', async () => {
  await clearQueue();
  const scopeA = testScope('tour-shared-device', 'passenger-a');
  const scopeB = testScope('tour-shared-device', 'passenger-b');
  await offlineSyncService.setActiveSessionScope(scopeA);
  await rawQueueApi.enqueueAction({
    id: 'scope-a-protected',
    type: 'CHAT_MESSAGE',
    tourId: scopeA.tourId,
    scope: scopeA,
    payload: { text: 'owned-by-a' },
  });

  await offlineSyncService.setActiveSessionScope(scopeB);
  const update = await rawQueueApi.updateAction('scope-a-protected', { status: 'failed' });
  const remove = await rawQueueApi.removeAction('scope-a-protected');
  const foreignEnqueue = await rawQueueApi.enqueueAction({
    id: 'forged-a-action',
    type: 'CHAT_MESSAGE',
    tourId: scopeA.tourId,
    scope: scopeA,
    payload: { text: 'forged' },
  });

  assert.equal(update.success, false);
  assert.equal(remove.success, false);
  assert.equal(foreignEnqueue.success, false);
  const remaining = await rawQueueApi.getQueuedActions({ includeAll: true });
  assert.deepEqual(remaining.data.map((action) => action.id), ['scope-a-protected']);
});

test('queue ownership remains canonical when tour-pack owner uses a booking reference', async () => {
  await clearQueue();
  const principalScope = testScope('tour-cache-owner', 'pax_v1:booking-a:alice@example.com');
  await offlineSyncService.setActiveSessionScope({
    ...principalScope,
    cacheOwnerId: 'BOOKING-A',
  });

  const result = await rawQueueApi.enqueueAction({
    id: 'cache-owner-action',
    type: 'CHAT_MESSAGE',
    tourId: principalScope.tourId,
    scope: principalScope,
    payload: { text: 'still mine' },
  });

  assert.equal(result.success, true);
  const queued = await rawQueueApi.getQueuedActions({ scope: principalScope });
  assert.deepEqual(queued.data.map((action) => action.id), ['cache-owner-action']);
});

test('replay stops before the next action when the signed-in session changes', async () => {
  await clearQueue();
  const scopeA = testScope('tour-session-change', 'passenger-a');
  const scopeB = testScope('tour-session-change', 'passenger-b');
  await offlineSyncService.setActiveSessionScope(scopeA);
  for (const id of ['session-change-1', 'session-change-2']) {
    await rawQueueApi.enqueueAction({
      id,
      type: 'CHAT_MESSAGE',
      tourId: scopeA.tourId,
      scope: scopeA,
      payload: { text: id },
    });
  }

  const delivered = [];
  const replay = await rawQueueApi.replayQueue({
    scope: scopeA,
    services: {
      chatService: {
        sendMessageDirect: async (payload) => {
          delivered.push(payload.text);
          await offlineSyncService.setActiveSessionScope(scopeB);
          return { success: true };
        },
      },
    },
  });

  assert.equal(replay.success, true);
  assert.deepEqual(delivered, ['session-change-1']);
  const remaining = await rawQueueApi.getQueuedActions({ includeAll: true });
  assert.deepEqual(remaining.data.map((action) => action.id), ['session-change-2']);
});

test('explicitly scoped queue subscribers never follow a later active session', async () => {
  await clearQueue();
  const scopeA = testScope('tour-subscription', 'passenger-a');
  const scopeB = testScope('tour-subscription', 'passenger-b');
  await offlineSyncService.setActiveSessionScope(null);
  await rawQueueApi.enqueueAction({
    id: 'subscription-a',
    type: 'CHAT_MESSAGE',
    tourId: scopeA.tourId,
    scope: scopeA,
    payload: { text: 'private-a' },
  });

  const queueSnapshots = [];
  const statSnapshots = [];
  const unsubscribeQueue = offlineSyncService.subscribeQueuedActions(
    (actions) => queueSnapshots.push(actions.map((action) => action.id)),
    { scope: scopeA },
  );
  const unsubscribeStats = offlineSyncService.subscribeQueueState(
    (stats) => statSnapshots.push(stats),
    { scope: scopeA },
  );
  await new Promise((resolve) => setImmediate(resolve));

  await offlineSyncService.setActiveSessionScope(scopeB);
  await rawQueueApi.enqueueAction({
    id: 'subscription-b',
    type: 'CHAT_MESSAGE',
    tourId: scopeB.tourId,
    scope: scopeB,
    payload: { text: 'private-b' },
  });
  unsubscribeQueue();
  unsubscribeStats();

  assert.deepEqual(queueSnapshots.at(-1), ['subscription-a']);
  assert.equal(statSnapshots.at(-1).total, 1);
});

test('saveTourPack serializes concurrent partial writes for the same tour pack', async () => {
  const tourId = `tour-concurrent-${Date.now()}`;
  const role = 'driver';
  const packOptions = { ownerId: 'D-CONCURRENT' };

  const [tourWrite, itineraryWrite, safetyWrite] = await Promise.all([
    offlineSyncService.saveTourPack(tourId, role, { tour: { id: tourId, name: 'Concurrent tour' } }, packOptions),
    offlineSyncService.saveTourPack(tourId, role, { itinerary: { days: [{ day: 1, content: 'Luss' }] } }, packOptions),
    offlineSyncService.saveTourPack(tourId, role, { safety: { supportPhone: '01234 567890' } }, packOptions),
  ]);

  assert.equal(tourWrite.success, true);
  assert.equal(itineraryWrite.success, true);
  assert.equal(safetyWrite.success, true);
  const cached = await offlineSyncService.getTourPack(tourId, role, packOptions);
  assert.equal(cached.success, true);
  assert.equal(cached.data.tour.name, 'Concurrent tour');
  assert.equal(cached.data.itinerary.days[0].content, 'Luss');
  assert.equal(cached.data.safety.supportPhone, '01234 567890');
});

test('tour packs and sync metadata are isolated by login identity on the same tour', async () => {
  const tourId = `tour-shared-pack-${Date.now()}`;
  const ownerA = { ownerId: 'BOOKING-A' };
  const ownerB = { ownerId: 'BOOKING-B' };

  await offlineSyncService.saveTourPack(tourId, 'passenger', {
    booking: { id: 'BOOKING-A', passengerNames: ['Alice'] },
  }, ownerA);
  await offlineSyncService.setTourPackMeta(
    tourId,
    'passenger',
    { lastSyncedAt: '2026-08-01T10:00:00.000Z' },
    ownerA,
  );
  await offlineSyncService.saveTourPack(tourId, 'passenger', {
    booking: { id: 'BOOKING-B', passengerNames: ['Bob'] },
  }, ownerB);
  await offlineSyncService.setTourPackMeta(
    tourId,
    'passenger',
    { lastSyncedAt: '2026-08-02T10:00:00.000Z' },
    ownerB,
  );

  const [packA, packB, missingPack, metaA, metaB] = await Promise.all([
    offlineSyncService.getTourPack(tourId, 'passenger', ownerA),
    offlineSyncService.getTourPack(tourId, 'passenger', ownerB),
    offlineSyncService.getTourPack(tourId, 'passenger', { ownerId: 'BOOKING-C' }),
    offlineSyncService.getTourPackMeta(tourId, 'passenger', ownerA),
    offlineSyncService.getTourPackMeta(tourId, 'passenger', ownerB),
  ]);

  assert.equal(packA.data.booking.passengerNames[0], 'Alice');
  assert.equal(packB.data.booking.passengerNames[0], 'Bob');
  assert.equal(missingPack.data, null);
  assert.equal(metaA.data.lastSyncedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(metaB.data.lastSyncedAt, '2026-08-02T10:00:00.000Z');
});

test('concurrent Tour Pack metadata writes preserve resource-specific sync provenance', async () => {
  const tourId = `tour-meta-${Date.now()}`;
  const options = { ownerId: 'D-META' };
  await Promise.all([
    offlineSyncService.setTourPackMeta(tourId, 'driver', {
      lastSyncedAt: '2026-08-20T09:00:00.000Z',
      itineraryLastSyncedAt: '2026-08-20T09:00:00.000Z',
      itineraryRevision: 4,
    }, options),
    offlineSyncService.setTourPackMeta(tourId, 'driver', {
      lastSyncedAt: '2026-08-20T09:01:00.000Z',
      driverItineraryLastSyncedAt: '2026-08-20T09:01:00.000Z',
    }, options),
  ]);

  const meta = await offlineSyncService.getTourPackMeta(tourId, 'driver', options);
  assert.equal(meta.success, true);
  assert.equal(meta.data.itineraryLastSyncedAt, '2026-08-20T09:00:00.000Z');
  assert.equal(meta.data.itineraryRevision, 4);
  assert.equal(meta.data.driverItineraryLastSyncedAt, '2026-08-20T09:01:00.000Z');
  assert.equal(meta.data.lastSyncedAt, '2026-08-20T09:01:00.000Z');

  await offlineSyncService.setTourPackMeta(tourId, 'driver', {
    lastSyncedAt: '2026-08-20T08:00:00.000Z',
    safetyLastSyncedAt: '2026-08-20T08:00:00.000Z',
  }, options);
  const afterOlderWrite = await offlineSyncService.getTourPackMeta(tourId, 'driver', options);
  assert.equal(afterOlderWrite.data.lastSyncedAt, '2026-08-20T09:01:00.000Z');
  assert.equal(afterOlderWrite.data.safetyLastSyncedAt, '2026-08-20T08:00:00.000Z');
});

test('new manifest queue entries supersede stale pending updates only within the same tour and booking', async () => {
  await clearQueue();
  const baseAction = {
    type: 'MANIFEST_UPDATE',
    tourId: 'TOUR_1',
    payload: { tourCode: 'TOUR_1', bookingRef: 'ABC123', passengerStatuses: ['PENDING'] },
  };
  await offlineSyncService.enqueueAction({ ...baseAction, id: 'manifest-old' });
  await offlineSyncService.enqueueAction({
    ...baseAction,
    id: 'manifest-other-tour',
    tourId: 'TOUR_2',
    payload: { ...baseAction.payload, tourCode: 'TOUR_2' },
  });
  const latest = await offlineSyncService.enqueueAction({
    ...baseAction,
    id: 'manifest-latest',
    payload: { ...baseAction.payload, passengerStatuses: ['BOARDED'] },
  });

  assert.equal(latest.success, true);
  assert.equal(latest.data.supersededActionCount, 1);
  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.data.some((action) => action.id === 'manifest-old'), false);
  assert.equal(queued.data.some((action) => action.id === 'manifest-latest'), true);
  assert.equal(queued.data.some((action) => action.id === 'manifest-other-tour'), true);
  await clearQueue();
});

test('manifest replay reports reconciliation outcomes before removing processed queue entries', async () => {
  await clearQueue();
  await offlineSyncService.enqueueAction({
    id: 'manifest-conflict-outcome',
    type: 'MANIFEST_UPDATE',
    tourId: 'TOUR_1',
    payload: { tourCode: 'TOUR_1', bookingRef: 'ABC123', passengerStatuses: ['BOARDED'] },
  });

  const replay = await offlineSyncService.replayQueue({
    services: {
      bookingService: {
        applyManifestUpdateDirect: async () => ({
          success: true,
          reconciled: true,
          status: 'NO_SHOW',
          conflict: { bookingRef: 'ABC123', serverStatus: 'NO_SHOW', attemptedStatus: 'BOARDED' },
        }),
      },
    },
  });

  assert.equal(replay.success, true);
  assert.equal(replay.data.outcomes.length, 1);
  assert.equal(replay.data.outcomes[0].reconciled, true);
  assert.equal(replay.data.outcomes[0].conflict.serverStatus, 'NO_SHOW');
  const queued = await offlineSyncService.getQueuedActions();
  assert.equal(queued.data.some((action) => action.id === 'manifest-conflict-outcome'), false);
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
  assert.equal(afterFailure.data >= priorValue, true);
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

test('PHOTO_UPLOAD enqueue payload is normalized with idempotency and local assets contract', async () => {
  await clearQueue();
  const createdAt = new Date().toISOString();
  const enqueue = await offlineSyncService.enqueueAction({
    id: 'photo-contract-1',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo-contract',
    payload: {
      idempotencyKey: 'idem-photo-1',
      createdAt,
      visibility: 'group',
      userId: 'user-1',
      localAssets: { sourceUri: 'file:///tmp/source.jpg' },
      metadata: { caption: 'hello' },
    },
  });
  assert.equal(enqueue.success, true);
  assert.equal(enqueue.data.payload.jobId, 'photo-contract-1');
  assert.equal(enqueue.data.payload.idempotencyKey, 'idem-photo-1');
  assert.equal(enqueue.data.payload.payloadVersion, 2);
  assert.equal(enqueue.data.payload.localAssets.sourceUri, 'file:///tmp/source.jpg');
});

test('PHOTO_UPLOAD enqueue normalizes payloadVersion=2 source-only payload', async () => {
  await clearQueue();
  const enqueue = await offlineSyncService.enqueueAction({
    id: 'photo-contract-v2',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo-contract',
    payload: {
      payloadVersion: 2,
      idempotencyKey: 'idem-photo-v2',
      visibility: 'group',
      userId: 'user-1',
      localAssets: { sourceUri: 'file:///tmp/source-v2.jpg', previewUri: 'file:///tmp/preview-v2.jpg' },
    },
  });
  assert.equal(enqueue.success, true);
  assert.equal(enqueue.data.payload.payloadVersion, 2);
  assert.equal(enqueue.data.payload.localAssets.sourceUri, 'file:///tmp/source-v2.jpg');
  assert.equal(enqueue.data.payload.localAssets.previewUri, 'file:///tmp/preview-v2.jpg');
});

test('PHOTO_UPLOAD enqueue drops obsolete thumbnail/viewer replay fields', async () => {
  await clearQueue();
  const enqueue = await offlineSyncService.enqueueAction({
    id: 'photo-contract-current-variants',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo-contract',
    payload: {
      idempotencyKey: 'idem-photo-current',
      visibility: 'group',
      userId: 'user-1',
      localAssets: {
        sourceUri: 'file:///tmp/source.jpg',
        thumbnailUri: 'file:///tmp/thumb.jpg',
        viewerUri: 'file:///tmp/viewer.jpg',
      },
    },
  });

  assert.equal(enqueue.success, true);
  assert.equal(enqueue.data.payload.payloadVersion, 2);
  assert.equal(enqueue.data.payload.localAssets.sourceUri, 'file:///tmp/source.jpg');
  assert.equal('thumbnailUri' in enqueue.data.payload.localAssets, false);
  assert.equal('viewerUri' in enqueue.data.payload.localAssets, false);
});

test('pruneCompletedPhotoUploadActions removes stale completed uploads but keeps failed entries', () => {
  const now = Date.parse('2026-04-11T00:00:00.000Z');
  const staleCompleted = Array.from({ length: 22 }).map((_, index) => ({
    id: `old-completed-${index}`,
    type: 'PHOTO_UPLOAD',
    status: 'completed',
    createdAt: '2026-04-08T00:00:00.000Z',
    lastUpdatedAt: '2026-04-08T00:00:00.000Z',
  }));
  const result = offlineSyncService.pruneCompletedPhotoUploadActions([
    ...staleCompleted,
    {
      id: 'failed-photo',
      type: 'PHOTO_UPLOAD',
      status: 'failed',
      createdAt: '2026-04-08T00:00:00.000Z',
      lastUpdatedAt: '2026-04-08T00:00:00.000Z',
    },
  ], now);

  assert.equal(result.removedCount, 2);
  assert.equal(result.queue.some((item) => item.id === 'failed-photo'), true);
});

test('discarding a failed group photo upload removes it from scoped queue and stats', async () => {
  await clearQueue();

  await offlineSyncService.enqueueAction({
    id: 'photo-discard-group',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo-discard',
    status: 'failed',
    attempts: 5,
    payload: {
      payloadVersion: 2,
      idempotencyKey: 'idem-discard-group',
      tourId: 'tour-photo-discard',
      visibility: 'group',
      userId: 'user-1',
      localAssets: { sourceUri: 'file:///tmp/discard.jpg' },
      metadata: { caption: 'discard me' },
    },
  });

  const before = await offlineSyncService.getPhotoUploadActions({ tourId: 'tour-photo-discard', visibility: 'group' });
  assert.equal(before.success, true);
  assert.equal(before.data.length, 1);
  assert.equal(before.data[0].status, 'failed');

  const removed = await offlineSyncService.removeAction('photo-discard-group');
  assert.equal(removed.success, true);

  const after = await offlineSyncService.getPhotoUploadActions({ tourId: 'tour-photo-discard', visibility: 'group' });
  assert.equal(after.success, true);
  assert.equal(after.data.length, 0);

  const stats = await offlineSyncService.getQueueStats();
  assert.equal(stats.success, true);
  assert.equal(stats.data.failed, 0);
  assert.equal(stats.data.total, 0);
});

test('PHOTO_UPLOAD retry keeps one logical record and transitions retrying to completed', async () => {
  await clearQueue();
  let calls = 0;
  await offlineSyncService.enqueueAction({
    id: 'photo-retry-1',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-photo',
    payload: {
      idempotencyKey: 'idem-retry-1',
      tourId: 'tour-photo',
      visibility: 'group',
      userId: 'user-1',
      localAssets: { sourceUri: 'file:///tmp/retry.jpg' },
      metadata: { caption: 'retry' },
    },
  });

  await offlineSyncService.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async () => {
          calls += 1;
          if (calls === 1) return { success: false, error: 'network' };
          return { success: true, data: { id: 'photo-1' } };
        },
      },
    },
  });
  const failedQueue = await offlineSyncService.getQueuedActions();
  assert.equal(failedQueue.data[0].status, 'retrying');

  await offlineSyncService.updateAction('photo-retry-1', { nextAttemptAt: null, status: 'retrying' });
  await offlineSyncService.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async () => {
          calls += 1;
          return { success: true, data: { id: 'photo-1' } };
        },
      },
    },
  });
  const completedQueue = await offlineSyncService.getQueuedActions();
  assert.equal(completedQueue.data[0].status, 'completed');
  assert.equal(calls, 2);
});

test('PHOTO_UPLOAD survives restart-like rehydrate and can replay later', async () => {
  await clearQueue();
  await offlineSyncService.enqueueAction({
    id: 'photo-restart-1',
    type: 'PHOTO_UPLOAD',
    tourId: 'tour-restart',
    payload: {
      idempotencyKey: 'idem-restart-1',
      tourId: 'tour-restart',
      visibility: 'private',
      ownerId: 'owner-1',
      localAssets: { sourceUri: 'file:///tmp/restart.jpg' },
      metadata: { caption: 'restart' },
    },
  });

  const reloadedModule = require('../services/offlineSyncService');
  const queued = await reloadedModule.getPhotoUploadActions({ tourId: 'tour-restart', visibility: 'private', ownerId: 'owner-1' });
  assert.equal(queued.success, true);
  assert.equal(queued.data.length, 1);

  const replay = await reloadedModule.replayQueue({
    services: {
      photoService: {
        uploadPhotoDirect: async () => ({ success: true, data: { id: 'photo-restart-server' } }),
      },
    },
  });
  assert.equal(replay.success, true);
  const after = await reloadedModule.getPhotoUploadActions({ tourId: 'tour-restart', visibility: 'private', ownerId: 'owner-1' });
  assert.equal(after.data[0].status, 'completed');
});
