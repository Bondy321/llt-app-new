const test = require('node:test');
const assert = require('node:assert');
const offlineSyncService = require('../services/offlineSyncService');

test('sync state mapping exposes canonical states and normalized fields', () => {
  const keys = Object.keys(offlineSyncService.SYNC_STATES).sort();
  assert.deepEqual(keys, [
    'OFFLINE_NO_NETWORK',
    'ONLINE_BACKEND_DEGRADED',
    'ONLINE_BACKLOG_PENDING',
    'ONLINE_HEALTHY',
  ].sort());

  keys.forEach((key) => {
    const state = offlineSyncService.SYNC_STATES[key];
    assert.ok(state.label);
    assert.ok(state.description);
    assert.ok(['info', 'warning', 'critical', 'success'].includes(state.severity));
    assert.ok(typeof state.icon === 'string');
    assert.equal(typeof state.canRetry, 'boolean');
    assert.equal(typeof state.showLastSync, 'boolean');
  });
});

test('formatSyncOutcome follows strict output contract and falls back to zeroes', () => {
  assert.equal(
    offlineSyncService.formatSyncOutcome({ syncedCount: 4, pendingCount: 2, failedCount: 1 }),
    '4 synced / 2 pending / 1 failed'
  );

  assert.equal(
    offlineSyncService.formatSyncOutcome({ syncedCount: undefined, pendingCount: null, failedCount: 'bad' }),
    '0 synced / 0 pending / 0 failed'
  );
});

test('formatLastSyncRelative supports canonical labels', () => {
  const now = Date.now();
  assert.equal(offlineSyncService.formatLastSyncRelative(now), 'Just now');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 2 * 60 * 1000), '2m ago');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 60 * 60 * 1000), '1h ago');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 26 * 60 * 60 * 1000), 'Yesterday');
});

test('unified status includes labels and lastSync visibility for all major states', () => {
  const base = { source: 'test', lastSuccessAt: new Date().toISOString() };

  const offline = offlineSyncService.deriveUnifiedSyncStatus({
    ...base,
    isConnected: false,
    firebaseConnected: false,
    queueStats: { pending: 2, failed: 0, syncing: 0 },
  });
  assert.equal(offline.key, 'OFFLINE_NO_NETWORK');
  assert.equal(offline.showLastSync, true);

  const degraded = offlineSyncService.deriveUnifiedSyncStatus({
    ...base,
    isConnected: true,
    firebaseConnected: false,
    queueStats: { pending: 0, failed: 1, syncing: 0 },
  });
  assert.equal(degraded.key, 'ONLINE_BACKEND_DEGRADED');
  assert.equal(degraded.canRetry, true);

  const pending = offlineSyncService.deriveUnifiedSyncStatus({
    ...base,
    isConnected: true,
    firebaseConnected: true,
    queueStats: { pending: 3, failed: 0, syncing: 0 },
  });
  assert.equal(pending.key, 'ONLINE_BACKLOG_PENDING');

  const healthy = offlineSyncService.deriveUnifiedSyncStatus({
    ...base,
    isConnected: true,
    firebaseConnected: true,
    queueStats: { pending: 0, failed: 0, syncing: 0 },
  });
  assert.equal(healthy.key, 'ONLINE_HEALTHY');
});
