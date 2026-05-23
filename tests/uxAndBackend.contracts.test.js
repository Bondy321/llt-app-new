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

test('Static contract: sensitive database writes remain ownership or admin gated', () => {
  const rules = readJson('database.rules.json');
  const adminUid = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
  const privateOwnerAccess = "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || auth.uid === $ownerId || $ownerId === root.child('users/' + auth.uid + '/stablePassengerId').val() || $ownerId === root.child('users/' + auth.uid + '/stablePassengerKey').val() || $ownerId === root.child('users/' + auth.uid + '/privatePhotoOwnerId').val() || $ownerId === root.child('users/' + auth.uid + '/privatePhotoOwnerKey').val() || root.child('identity_bindings/' + $ownerId + '/' + auth.uid).val() === true)";
  const manifestBookingAccess = `auth != null && (auth.uid === '${adminUid}' || root.child('tours/' + $tourId + '/participants/' + auth.uid).exists() || (root.child('users/' + auth.uid + '/driverId').isString() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid && root.child('tour_manifests/' + $tourId + '/assigned_drivers/' + root.child('users/' + auth.uid + '/driverId').val()).val() === true)) && root.child('bookings/' + $bookingRef + '/tourId').val() === $tourId`;

  assert.equal(
    rules.rules.bookings.$bookingRef['.write'],
    `auth != null && auth.uid === '${adminUid}'`,
  );
  assert.equal(
    rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.write'],
    manifestBookingAccess,
  );
  assert.equal(rules.rules.private_tour_photos.$tourId.$ownerId['.read'], privateOwnerAccess);
  assert.equal(rules.rules.private_tour_photos.$tourId.$ownerId['.write'], privateOwnerAccess);
  assert.deepEqual(rules.rules.users.$userId.privatePhotoOwnerKey, { '.validate': '!newData.exists() || newData.isString()' });
  assert.deepEqual(rules.rules.users.$userId.stablePassengerKey, { '.validate': '!newData.exists() || newData.isString()' });
  assert.deepEqual(rules.rules.users.$userId.driverId, { '.validate': '!newData.exists() || newData.isString()' });
  assert.deepEqual(rules.rules.users.$userId.driverPrincipalId, { '.validate': '!newData.exists() || newData.isString()' });
  assert.deepEqual(rules.rules.users.$userId.driverAssignedTourId, { '.validate': '!newData.exists() || newData.isString() || newData.val() === null' });
  assert.deepEqual(rules.rules.users.$userId.principalType, { '.validate': "!newData.exists() || newData.val() === 'passenger' || newData.val() === 'driver'" });
  assert.match(
    rules.rules.globalSafetyAlerts.$eventId['.write'],
    /auth\.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'/,
  );
  assert.doesNotEqual(rules.rules.globalSafetyAlerts.$eventId['.write'], 'auth != null');
});

test('Static contract: photo variant lifecycle fields stay allowed by database rules', () => {
  const rules = readJson('database.rules.json');
  const groupPhotoValidate = rules.rules.group_tour_photos.$tourId.$photoId['.validate'];
  const privatePhotoValidate = rules.rules.private_tour_photos.$tourId.$ownerId.$photoId['.validate'];

  ['sourceUrl', 'viewerUrl', 'viewerStoragePath', 'variantStatus', 'variantUpdatedAt', 'variantError', 'variantVersion'].forEach((field) => {
    assert.match(groupPhotoValidate, new RegExp(`newData\\.child\\('${field}'\\)`));
    assert.match(privatePhotoValidate, new RegExp(`newData\\.child\\('${field}'\\)`));
  });
});

test('Static contract: email-style stable identities are encoded before identity binding path writes', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'chatService.js'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'chatIdentityMigrationService.js'), 'utf8');
  const privatePhotoMigrationSource = fs.readFileSync(path.join(__dirname, '..', 'functions', 'scripts', 'migratePrivatePhotoOwnersToStablePassengerIds.js'), 'utf8');

  assert.match(appSource, /stablePassengerKey = stablePassengerId \? toRealtimeKeySegment\(stablePassengerId\) : null/);
  assert.match(appSource, /privatePhotoOwnerKey = toRealtimeKeySegment\(stablePassengerId \|\| bookingRef\)/);
  assert.match(appSource, /users\/\$\{authUid\}\/privatePhotoOwnerKey/);
  assert.match(appSource, /users\/\$\{authUid\}\/stablePassengerKey/);
  assert.match(appSource, /identity_bindings\/\$\{stablePassengerKey\}\/\$\{authUid\}/);
  assert.doesNotMatch(appSource, /identity_bindings\/\$\{stablePassengerId\}/);
  assert.match(migrationSource, /identity_bindings\/\$\{stablePassengerKey\}/);
  assert.match(privatePhotoMigrationSource, /stableOwnerKey = toRealtimeKeySegment\(stablePassengerId\)/);
  assert.match(privatePhotoMigrationSource, /private_tour_photos\/\$\{tourId\}\/\$\{stableOwnerKey\}/);
  assert.doesNotMatch(privatePhotoMigrationSource, /private_tour_photos\/\$\{tourId\}\/\$\{stableOwnerId\}/);
  assert.match(chatSource, /getRealtimeActorContext\(userId\)/);
  assert.match(chatSource, /typing\/\$\{actorKey\}/);
  assert.match(chatSource, /presence\/\$\{actorKey\}/);
  assert.match(chatSource, /lastRead\/\$\{actorKey\}/);
});

test('Static contract: legacy Expo FileSystem methods use the explicit legacy entrypoint', () => {
  [
    'components/ImageViewer.js',
    'screens/PhotobookScreen.js',
    'services/imageOptimizationService.js',
    'services/photoViewerCacheService.js',
  ].forEach((relativePath) => {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

    assert.match(source, /from 'expo-file-system\/legacy'/);
    assert.doesNotMatch(source, /from 'expo-file-system';/);
  });
});

test('Static contract: chat message validation keeps image payload branch and thumbnail requirement', () => {
  // Intentional static check: validation expression is a rules DSL string; regex guards critical media constraints.
  const rules = readJson('database.rules.json');
  const messageValidate = rules.rules.chats.$tourId.messages.$messageId['.validate'];

  assert.match(messageValidate, /newData\.child\('type'\)\.val\(\) === 'image'/);
  assert.match(messageValidate, /newData\.child\('thumbnailUrl'\)/);
});
