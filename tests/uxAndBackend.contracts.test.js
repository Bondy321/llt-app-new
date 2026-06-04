const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const offlineSyncService = require('../services/offlineSyncService');

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
const readText = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

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
  const expectedPrincipalWrite = "auth != null && (auth.uid === $id || $id === root.child('users/' + auth.uid + '/stablePassengerId').val() || $id === root.child('users/' + auth.uid + '/privatePhotoOwnerId').val() || root.child('identity_bindings/' + $id + '/' + auth.uid).val() === true || (root.child('users/' + auth.uid + '/driverId').isString() && $id === 'driver:' + root.child('users/' + auth.uid + '/driverId').val() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid))";

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
  const manifestBookingAccess = `auth != null && (auth.uid === '${adminUid}' || root.child('tours/' + $tourId + '/participants/' + auth.uid).exists() || (root.child('users/' + auth.uid + '/driverId').isString() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid && root.child('tour_manifests/' + $tourId + '/assigned_drivers/' + root.child('users/' + auth.uid + '/driverId').val()).val() === true)) && (root.child('bookings/' + $bookingRef + '/tourId').val() === $tourId || (root.child('bookings/' + $bookingRef + '/tourCode').isString() && root.child('tours/' + $tourId + '/tourCode').isString() && root.child('bookings/' + $bookingRef + '/tourCode').val() === root.child('tours/' + $tourId + '/tourCode').val()) || (root.child('bookings/' + $bookingRef + '/tourCode').isString() && root.child('tour_manifests/' + $tourId + '/tourCode').isString() && root.child('bookings/' + $bookingRef + '/tourCode').val() === root.child('tour_manifests/' + $tourId + '/tourCode').val()))`;

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
  assert.notEqual(rules.rules.globalSafetyAlerts.$eventId['.write'], 'auth != null');
});

test('Static contract: remote logger uploads stay warning-plus by default outside dev', () => {
  const loggerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'loggerService.js'), 'utf8');

  assert.match(loggerSource, /const DEFAULT_SERVER_MIN_LEVEL = IS_DEV \? 'DEBUG' : 'WARN';/);
  assert.match(loggerSource, /CONFIGURED_SERVER_MIN_LEVEL/);
  assert.doesNotMatch(loggerSource, /VERBOSE_RTDB_LOGGING_ENABLED\s*=\s*true/);
});

test('Static contract: curated ops alerts stay separate from raw logs and schema-gated', () => {
  const rules = readJson('database.rules.json');
  const opsAlerts = rules.rules.ops_alerts;
  const adminUsers = rules.rules.admin_users;

  assert.equal(
    rules.rules.logs.$userId['.read'],
    "auth != null && (auth.uid === $userId || auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')",
  );
  assert.equal(
    adminUsers['.read'],
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true)",
  );
  assert.equal(
    adminUsers.$uid['.write'],
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true)",
  );
  assert.equal(adminUsers.$uid['.validate'], '!newData.exists() || newData.val() === true');
  assert.equal(
    opsAlerts['.read'],
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true)",
  );
  assert.deepEqual(opsAlerts['.indexOn'], ['createdAtMs', 'lastSeenAtMs', 'severity', 'status']);
  assert.match(opsAlerts.$alertId['.write'], /auth\.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'/);
  assert.match(opsAlerts.$alertId['.write'], /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.match(opsAlerts.$alertId['.write'], /newData\.child\('fingerprint'\)\.val\(\) === \$alertId/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.hasChildren\(\['alertVersion', 'fingerprint', 'createdAt', 'createdAtMs'/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('message'\)\.val\(\)\.length <= 240/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('summary'\)\.val\(\)\.length <= 600/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('source'\)\.val\(\) === 'mobile_logger'/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('source'\)\.val\(\) === 'crash_diagnostics'/);
  assert.equal(opsAlerts.$alertId.deviceInfo.$other['.validate'], false);
  assert.equal(opsAlerts.$alertId.$other['.validate'], false);
});

test('Static contract: dashboard broadcast root reads and writes stay Firebase-backed', () => {
  const rules = readJson('database.rules.json');
  const broadcasts = rules.rules.broadcasts;

  assert.equal(broadcasts['.read'], 'auth != null');
  assert.equal(broadcasts.$tourId['.read'], 'auth != null');
  assert.deepEqual(broadcasts.$tourId['.indexOn'], ['createdAtMs']);
  assert.equal(
    broadcasts.$tourId.$broadcastId['.write'],
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true)",
  );
  assert.match(broadcasts.$tourId.$broadcastId['.validate'], /newData\.child\('createdByUid'\)\.val\(\) === auth\.uid/);
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

test('Static contract: photo upload modals guard duplicate enqueue taps', () => {
  [
    'screens/PhotobookScreen.js',
    'screens/GroupPhotobookScreen.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);

    assert.match(source, /const \[uploading, setUploading\] = useState\(false\);/);
    assert.match(source, /if \(uploading(?: \|\| !pendingImage\?\.uri)?\) return;/);
    assert.match(source, /setUploading\(true\);/);
    assert.match(source, /finally \{\s*setUploading\(false\);\s*\}/);
    assert.match(source, /disabled=\{uploading\}/);
    assert.match(source, /uploadButtonDisabled/);
  });
});

test('Static contract: passenger driver calls use tour contact data', () => {
  const source = readText('screens/TourHomeScreen.js');

  assert.match(source, /resolveDriverPhoneNumber/);
  assert.match(source, /tourData\?\.driverPhone/);
  assert.match(source, /openDriverContactUrl\(`tel:\$\{phone\}`, 'call'\)/);
  assert.doesNotMatch(source, /tel:\+441414876737/);
});

test('Static contract: failed chat sends preserve reply composer context', () => {
  const source = readText('screens/ChatScreen.js');

  assert.match(source, /const pendingReply = replyingToMessage;/);
  assert.match(source, /setReplyingToMessage\(pendingReply\);/);
  assert.match(source, /replyTo: pendingReply \|\| undefined/);
});

test('Static contract: chat timestamp helpers use strict shared parser', () => {
  [
    'utils/chatTimeline.js',
    'utils/chatUnreadSummary.js',
    'services/chatService.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);

    assert.match(source, /parseStrictTimestampMs|parseTimestampMs: parseStrictTimestampMs/);
    assert.doesNotMatch(source, /Date\.parse\(timestamp\)/);
    assert.doesNotMatch(source, /Date\.parse\(value\)/);
  });
});

test('Static contract: customer-facing date labels use strict shared timestamp parsing', () => {
  [
    'screens/ChatScreen.js',
    'screens/SafetySupportScreen.js',
    'components/ImageViewer.js',
    'screens/PhotobookScreen.js',
    'screens/GroupPhotobookScreen.js',
    'screens/NotificationPreferencesScreen.js',
    'screens/ItineraryScreen.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);

    assert.match(source, /parseTimestampMs|parseSharedTimestampMs/);
    assert.doesNotMatch(source, /Date\.parse\(/);
  });

  ['screens/PhotobookScreen.js', 'screens/GroupPhotobookScreen.js'].forEach((relativePath) => {
    const source = readText(relativePath);
    assert.match(source, /getPhotoTimestampMs/);
    assert.doesNotMatch(source, /const aTs = a\.timestamp \|\| 0;/);
  });
});

test('Static contract: native location permissions stay foreground-only', () => {
  const source = readText('app.config.js');

  assert.match(source, /NSLocationWhenInUseUsageDescription/);
  assert.doesNotMatch(source, /ACCESS_BACKGROUND_LOCATION/);
  assert.doesNotMatch(source, /NSLocationAlwaysAndWhenInUseUsageDescription/);
  assert.doesNotMatch(source, /UIBackgroundModes:\s*\[/);
});

test('Static contract: live map and safety sharing guard stale or malformed location state', () => {
  const mapSource = readText('screens/MapScreen.js');
  assert.match(mapSource, /normalizeMapCoords/);
  assert.match(mapSource, /driverLocation\.timestamp \|\| driverLocation\.lastUpdated/);
  assert.match(mapSource, /let cancelled = false;/);
  assert.match(mapSource, /driverLocationPoint && userLocationPoint/);

  const safetySource = readText('screens/SafetySupportScreen.js');
  assert.match(safetySource, /locationWatchRef\.current\.remove\(\);/);
  assert.match(safetySource, /Live location watch update failed/);
  assert.match(safetySource, /Live location sharing stop write failed/);
});

test('Static contract: support and external link handoffs surface failures', () => {
  [
    'screens/TourHomeScreen.js',
    'screens/MapScreen.js',
    'screens/SafetySupportScreen.js',
    'screens/LoginScreen.js',
    'screens/ChatScreen.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);
    assert.match(source, /Linking\.openURL/);
    assert.match(source, /catch \(/);
    assert.match(source, /Alert\.alert/);
  });
});
