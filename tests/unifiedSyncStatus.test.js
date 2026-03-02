const test = require('node:test');
const assert = require('node:assert');
const { deriveUnifiedSyncStatus, UNIFIED_SYNC_STATES } = require('../services/offlineSyncService');

test('deriveUnifiedSyncStatus precedence is offline > backend degraded > backlog pending > healthy', () => {
  const offline = deriveUnifiedSyncStatus({
    network: { isOnline: false },
    backend: { isReachable: false, isDegraded: true },
    queue: { pending: 10, syncing: 2, failed: 1 },
  });
  assert.equal(offline.stateKey, 'OFFLINE_NO_NETWORK');

  const degraded = deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: false, isDegraded: true },
    queue: { pending: 10, syncing: 2, failed: 1 },
  });
  assert.equal(degraded.stateKey, 'ONLINE_BACKEND_DEGRADED');

  const backlog = deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 1, syncing: 0, failed: 0 },
  });
  assert.equal(backlog.stateKey, 'ONLINE_BACKLOG_PENDING');

  const healthy = deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 0, syncing: 0, failed: 0 },
  });
  assert.equal(healthy.stateKey, 'ONLINE_HEALTHY');
});

test('pending-vs-degraded conflict deterministically resolves to ONLINE_BACKEND_DEGRADED', () => {
  const status = deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: true },
    queue: { pending: 8, syncing: 2, failed: 3 },
  });

  assert.equal(status.stateKey, 'ONLINE_BACKEND_DEGRADED');
  assert.equal(status.label, UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED.label);
});

test('major state contracts expose expected label/description/severity/icon token values', () => {
  const expected = {
    OFFLINE_NO_NETWORK: {
      label: 'Offline',
      description: 'No network connection. Changes are saved and will sync when online.',
      severity: 'critical',
      icon: 'wifi-off',
    },
    ONLINE_BACKEND_DEGRADED: {
      label: 'Service issue',
      description: 'Connected to network, but the sync service is temporarily unavailable.',
      severity: 'warning',
      icon: 'cloud-alert',
    },
    ONLINE_BACKLOG_PENDING: {
      label: 'Syncing backlog',
      description: 'Connection restored. Pending updates are still being processed.',
      severity: 'info',
      icon: 'clock-sync',
    },
    ONLINE_HEALTHY: {
      label: 'Up to date',
      description: 'Everything is synced and working normally.',
      severity: 'success',
      icon: 'cloud-check',
    },
  };

  Object.entries(expected).forEach(([stateKey, contract]) => {
    const state = UNIFIED_SYNC_STATES[stateKey];
    assert.equal(state.label, contract.label);
    assert.equal(state.description, contract.description);
    assert.equal(state.severity, contract.severity);
    assert.equal(state.icon, contract.icon);
  });
});

test('showLastSync visibility contract remains true for all canonical states', () => {
  Object.values(UNIFIED_SYNC_STATES).forEach((state) => {
    assert.equal(state.showLastSync, true);
  });
});
