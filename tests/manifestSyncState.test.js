const test = require('node:test');
const assert = require('node:assert');
const offlineSyncService = require('../services/offlineSyncService');

test('pending queue with healthy backend derives ONLINE_BACKLOG_PENDING', () => {
  const key = offlineSyncService.deriveSyncStateKey({
    isConnected: true,
    firebaseConnected: true,
    queueStats: { pending: 2, failed: 0, syncing: 0 },
  });

  assert.equal(key, 'ONLINE_BACKLOG_PENDING');
});

test('backend degraded takes precedence over pending queue state', () => {
  const key = offlineSyncService.deriveSyncStateKey({
    isConnected: true,
    firebaseConnected: false,
    queueStats: { pending: 3, failed: 0, syncing: 1 },
  });

  assert.equal(key, 'ONLINE_BACKEND_DEGRADED');
});

test('failed queue actions derive ONLINE_BACKEND_DEGRADED even when connected', () => {
  const key = offlineSyncService.deriveSyncStateKey({
    isConnected: true,
    firebaseConnected: true,
    queueStats: { pending: 0, failed: 2, syncing: 0 },
  });

  assert.equal(key, 'ONLINE_BACKEND_DEGRADED');
});
