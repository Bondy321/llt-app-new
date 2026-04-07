const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const offlineSyncService = require('../services/offlineSyncService');

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));

test('buildSyncSummary and formatSyncOutcome normalize counts and copy contract text', () => {
  const summary = offlineSyncService.buildSyncSummary({
    syncedCount: 7.9,
    pendingCount: -2,
    failedCount: '3.2',
    source: 'not-real',
    lastSuccessAt: 1700000000000,
  });

  assert.deepEqual(summary, {
    syncedCount: 7,
    pendingCount: 0,
    failedCount: 3,
    lastSuccessAt: 1700000000000,
    source: 'unknown',
  });

  assert.equal(
    offlineSyncService.formatSyncOutcome(summary),
    '7 synced / 0 pending / 3 failed',
  );
});

test('formatLastSyncRelative returns deterministic user-facing buckets', () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);

  assert.equal(offlineSyncService.formatLastSyncRelative(now, now), 'Just now');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 10 * 60 * 1000, now), '10m ago');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 3 * 60 * 60 * 1000, now), '3h ago');
  assert.equal(offlineSyncService.formatLastSyncRelative(now - 30 * 60 * 60 * 1000, now), 'Yesterday');
  assert.equal(offlineSyncService.formatLastSyncRelative(now + 1, now), 'Never');
});

test('deriveUnifiedSyncStatus maps network/backend/queue into canonical sync states', () => {
  const offline = offlineSyncService.deriveUnifiedSyncStatus({ network: { isOnline: false } });
  assert.equal(offline.stateKey, 'OFFLINE_NO_NETWORK');

  const degraded = offlineSyncService.deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: false },
  });
  assert.equal(degraded.stateKey, 'ONLINE_BACKEND_DEGRADED');

  const backlog = offlineSyncService.deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 2, syncing: 0, failed: 1 },
  });
  assert.equal(backlog.stateKey, 'ONLINE_BACKLOG_PENDING');
  assert.equal(backlog.syncSummary.pendingCount, 2);
  assert.equal(backlog.syncSummary.failedCount, 1);

  const healthy = offlineSyncService.deriveUnifiedSyncStatus({
    network: { isOnline: true },
    backend: { isReachable: true, isDegraded: false },
    queue: { pending: 0, syncing: 0, failed: 0 },
  });
  assert.equal(healthy.stateKey, 'ONLINE_HEALTHY');
});

test('Static contract: principal-owned chat reaction/typing/presence writes stay aligned with security rules', () => {
  // Intentional static check: these are Firebase Rules expressions, not executable JS exports.
  // We pin exact policy strings so auth principal equivalence across three write paths cannot drift.
  const rules = readJson('database.rules.json');
  const chatRules = rules.rules.chats.$tourId;
  const expectedPrincipalWrite = "auth != null && (auth.uid === $id || $id === root.child('users/' + auth.uid + '/stablePassengerId').val() || $id === root.child('users/' + auth.uid + '/privatePhotoOwnerId').val() || root.child('identity_bindings/' + $id + '/' + auth.uid).val() === true)";

  assert.equal(chatRules.messages.$messageId.reactions.$emoji['.write'], false);
  assert.equal(chatRules.messages.$messageId.reactions.$emoji.$id['.write'], expectedPrincipalWrite);
  assert.equal(chatRules.typing.$id['.write'], expectedPrincipalWrite);
  assert.equal(chatRules.presence.$id['.write'], expectedPrincipalWrite);
});

test('Static contract: identity_bindings_meta writes are limited to admin or caller-owned binding', () => {
  // Intentional static check: this is a least-privilege invariant in database.rules.json.
  const rules = readJson('database.rules.json');
  const writeRule = rules.rules.identity_bindings_meta.$stablePassengerId['.write'];

  assert.equal(
    writeRule,
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('identity_bindings/' + $stablePassengerId + '/' + auth.uid).val() === true)",
  );
});

test('Static contract: chat message validation keeps image payload branch and thumbnail requirement', () => {
  // Intentional static check: validation expression is a rules DSL string; regex guards critical media constraints.
  const rules = readJson('database.rules.json');
  const messageValidate = rules.rules.chats.$tourId.messages.$messageId['.validate'];

  assert.match(messageValidate, /newData\.child\('type'\)\.val\(\) === 'image'/);
  assert.match(messageValidate, /newData\.child\('thumbnailUrl'\)/);
});
