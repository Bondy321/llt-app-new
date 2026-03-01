const test = require('node:test');
const assert = require('node:assert');
const { buildSyncSummary, formatSyncOutcome } = require('../services/offlineSyncService');

test('buildSyncSummary applies safe defaults without undefined values', () => {
  const summary = buildSyncSummary();

  assert.deepEqual(summary, {
    syncedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    lastSuccessAt: null,
    source: 'unknown',
  });
});

test('buildSyncSummary normalizes partial and invalid inputs', () => {
  const summary = buildSyncSummary({
    syncedCount: '5',
    pendingCount: 'oops',
    failedCount: undefined,
    source: 'manual-refresh',
  });

  assert.equal(summary.syncedCount, 5);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.lastSuccessAt, null);
  assert.equal(summary.source, 'manual-refresh');
});

test('buildSyncSummary truncates decimal values and clamps negatives to zero', () => {
  const summary = buildSyncSummary({
    syncedCount: 3.9,
    pendingCount: -2.7,
    failedCount: '4.8',
    source: 'auto-replay',
  });

  assert.equal(summary.syncedCount, 3);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.failedCount, 4);
  assert.equal(summary.source, 'auto-replay');
});

test('buildSyncSummary falls back to unknown source for unsupported source values', () => {
  const summary = buildSyncSummary({ source: 'unexpected-source' });
  assert.equal(summary.source, 'unknown');
});

test('formatSyncOutcome always returns normalized summary string pattern', () => {
  const formatted = formatSyncOutcome({
    syncedCount: '11.7',
    pendingCount: NaN,
    failedCount: null,
  });

  assert.equal(formatted, '11 synced / 0 pending / 0 failed');
});

test('deriveUnifiedSyncStatus returns state metadata with normalized syncSummary', () => {
  const { deriveUnifiedSyncStatus } = require('../services/offlineSyncService');
  const status = deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 2, failed: 1 },
    lastSyncAt: 1700000000000,
    syncSummary: { syncedCount: '7.9', source: 'manual-refresh' },
  });

  assert.equal(status.stateKey, 'ONLINE_BACKLOG_PENDING');
  assert.equal(status.label, 'Syncing backlog');
  assert.equal(status.syncSummary.syncedCount, 7);
  assert.equal(status.syncSummary.pendingCount, 2);
  assert.equal(status.syncSummary.failedCount, 1);
  assert.equal(status.syncSummary.lastSuccessAt, 1700000000000);
  assert.equal(status.syncSummary.source, 'manual-refresh');
});

test('deriveUnifiedSyncStatus reports offline state when network is unavailable', () => {
  const { deriveUnifiedSyncStatus } = require('../services/offlineSyncService');
  const status = deriveUnifiedSyncStatus({
    network: { isOnline: false },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 0, failed: 0 },
  });

  assert.equal(status.stateKey, 'OFFLINE_NO_NETWORK');
  assert.equal(status.canRetry, false);
});
