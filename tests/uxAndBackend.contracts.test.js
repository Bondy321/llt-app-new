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
  const internalChatRules = rules.rules.internal_chats.$tourId;
  const expectedPrincipalWrite = "auth != null && (auth.uid === $id || $id === root.child('users/' + auth.uid + '/stablePassengerId').val() || $id === root.child('users/' + auth.uid + '/privatePhotoOwnerId').val() || root.child('identity_bindings/' + $id + '/' + auth.uid).val() === true || (root.child('users/' + auth.uid + '/driverId').isString() && $id === 'driver:' + root.child('users/' + auth.uid + '/driverId').val() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid))";
  const expectedInternalDriverWrite = "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || (root.child('users/' + auth.uid + '/driverId').isString() && $id === 'driver:' + root.child('users/' + auth.uid + '/driverId').val() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid && root.child('tour_manifests/' + $tourId + '/assigned_drivers/' + root.child('users/' + auth.uid + '/driverId').val()).val() === true))";
  const expectedInternalDriverLastReadWrite = "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || (root.child('users/' + auth.uid + '/driverId').isString() && $principalId === 'driver:' + root.child('users/' + auth.uid + '/driverId').val() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid && root.child('tour_manifests/' + $tourId + '/assigned_drivers/' + root.child('users/' + auth.uid + '/driverId').val()).val() === true))";

  assert.notEqual(chatRules['.read'], 'auth != null');
  assert.equal(chatRules['.read'], chatRules['.validate']);
  assert.match(chatRules['.read'], /tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid/);
  assert.match(chatRules['.read'], /assigned_drivers/);
  assert.notEqual(internalChatRules['.read'], 'auth != null');
  assert.equal(internalChatRules['.read'], internalChatRules['.validate']);
  assert.doesNotMatch(internalChatRules['.read'], /participants/);
  assert.match(internalChatRules['.read'], /assigned_drivers/);
  assert.equal(chatRules.messages.$messageId.reactions.$emoji['.write'], false);
  assert.equal(chatRules.messages.$messageId.reactions.$emoji.$id['.write'], expectedPrincipalWrite);
  assert.equal(chatRules.typing.$id['.write'], expectedPrincipalWrite);
  assert.equal(chatRules.presence.$id['.write'], expectedPrincipalWrite);
  assert.equal(internalChatRules.lastRead.$principalId['.write'], expectedInternalDriverLastReadWrite);
  assert.equal(internalChatRules.typing.$id['.write'], expectedInternalDriverWrite);
  assert.equal(internalChatRules.presence.$id['.write'], expectedInternalDriverWrite);
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
  const privateOwnerAccess = "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || $ownerId === root.child('users/' + auth.uid + '/stablePassengerKey').val() || $ownerId === root.child('users/' + auth.uid + '/privatePhotoOwnerKey').val() || root.child('identity_bindings/' + $ownerId + '/' + auth.uid).val() === true)";
  const manifestBookingAccess = `auth != null && (auth.uid === '${adminUid}' || (root.child('tours/' + $tourId + '/participants/' + auth.uid).exists() && (root.child('users/' + auth.uid + '/bookingRef').val() === $bookingRef || (root.child('booking_access_grants/' + $bookingRef + '/' + auth.uid + '/expiresAtMs').isNumber() && root.child('booking_access_grants/' + $bookingRef + '/' + auth.uid + '/expiresAtMs').val() > now))) || (root.child('users/' + auth.uid + '/driverId').isString() && root.child('drivers/' + root.child('users/' + auth.uid + '/driverId').val() + '/authUid').val() === auth.uid && root.child('tour_manifests/' + $tourId + '/assigned_drivers/' + root.child('users/' + auth.uid + '/driverId').val()).val() === true)) && root.child('bookings/' + $bookingRef + '/tourId').val() === $tourId`;

  assert.equal(
    rules.rules.bookings.$bookingRef['.write'],
    `auth != null && auth.uid === '${adminUid}'`,
  );
  assert.equal(rules.rules.bookings['.read'], undefined);
  assert.notEqual(rules.rules.bookings.$bookingRef['.read'], 'auth != null');
  assert.match(rules.rules.bookings.$bookingRef['.read'], /booking_access_grants/);
  assert.match(rules.rules.bookings.$bookingRef['.read'], /data\.child\('tourId'\)\.isString\(\)/);
  assert.deepEqual(rules.rules.bookings['.indexOn'], ['tourId']);
  assert.equal(
    rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.write'],
    manifestBookingAccess,
  );
  assert.equal(rules.rules.tour_manifests['.read'], undefined);
  assert.notEqual(rules.rules.tour_manifests.$tourId['.read'], 'auth != null');
  assert.doesNotMatch(rules.rules.tour_manifests.$tourId['.read'], /participants\/' \+ auth\.uid/);
  assert.match(rules.rules.tour_manifests.$tourId['.read'], /assigned_drivers/);
  assert.match(rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.read'], /users\/' \+ auth\.uid \+ '\/bookingRef/);
  assert.match(rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.read'], /booking_access_grants/);
  assert.equal(rules.rules.private_tour_photos.$tourId.$ownerId['.read'], privateOwnerAccess);
  assert.equal(rules.rules.private_tour_photos.$tourId.$ownerId['.write'], privateOwnerAccess);
  assert.notEqual(rules.rules.group_tour_photos.$tourId['.read'], 'auth != null');
  assert.equal(rules.rules.group_tour_photos.$tourId['.read'], rules.rules.group_tour_photos.$tourId['.validate']);
  assert.match(rules.rules.group_tour_photos.$tourId['.read'], /tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid/);
  assert.match(rules.rules.group_tour_photos.$tourId['.read'], /assigned_drivers/);
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
  assert.notEqual(rules.rules.globalSafetyAlerts['.read'], 'auth != null');
  assert.match(rules.rules.globalSafetyAlerts['.read'], /admin_users/);
  assert.notEqual(rules.rules.globalSafetyAlerts.$eventId['.write'], 'auth != null');
});

test('Static contract: tour metadata writes stay least-privilege', () => {
  const rules = readJson('database.rules.json');
  const tourRules = rules.rules.tours.$tourId;

  assert.equal(rules.rules.tours['.read'], undefined);
  assert.match(tourRules['.read'], /tour_access_grants\/' \+ \$tourId \+ '\/' \+ auth\.uid \+ '\/expiresAtMs/);
  assert.notEqual(tourRules['.write'], 'auth != null');
  assert.match(tourRules['.write'], /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.match(tourRules.participants.$userId['.write'], /tour_access_grants\/' \+ \$tourId \+ '\/' \+ auth\.uid \+ '\/expiresAtMs/);
  assert.notEqual(tourRules.participants.$userId['.write'], "auth != null && (auth.uid === $userId || auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')");
  assert.match(tourRules.currentParticipants['.write'], /root\.child\('tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid\)\.exists\(\)/);
  assert.match(tourRules.driverLocation['.write'], /tour_manifests\/' \+ \$tourId \+ '\/assigned_drivers\//);
  assert.match(tourRules.itinerary['.write'], /assigned_drivers/);
  assert.match(tourRules.driver_itinerary['.write'], /assigned_drivers/);
  assert.match(tourRules.safetyAlerts.$eventId['.write'], /participants\/' \+ auth\.uid/);
  assert.match(tourRules.liveTracking.$userId['.write'], /auth\.uid === \$userId/);
  assert.match(readText('package.json'), /tests\/firebaseRules\/tours\.rules\.test\.js/);

  const bookingSource = readText('services/bookingServiceRealtime.js');
  assert.match(bookingSource, /Client joins must never create or rewrite tour metadata/);
  assert.match(bookingSource, /participantRef\.transaction/);
  assert.doesNotMatch(bookingSource, /tourRef\.transaction\(\(tourState\)/);
  assert.doesNotMatch(bookingSource, /update\(\{ isActive: true, participants: \{\}, currentParticipants: 0 \}\)/);
});

test('Static contract: verified login grants are scoped and short-lived', () => {
  const rules = readJson('database.rules.json');
  const tourGrant = rules.rules.tour_access_grants.$tourId.$userId;
  const bookingGrant = rules.rules.booking_access_grants.$bookingRef.$userId;
  const functionsSource = readText('functions/index.js');
  const bookingServiceSource = readText('services/bookingServiceRealtime.js');

  assert.match(tourGrant['.read'], /auth\.uid === \$userId/);
  assert.match(tourGrant['.write'], /admin_users/);
  assert.match(tourGrant['.validate'], /expiresAtMs'\)\.val\(\) > now/);
  assert.doesNotMatch(tourGrant['.validate'], /tourCode/);
  assert.match(bookingGrant['.read'], /auth\.uid === \$userId/);
  assert.match(bookingGrant['.validate'], /bookingRef'\)\.val\(\) === \$bookingRef/);
  assert.doesNotMatch(bookingGrant['.validate'], /tourCode/);
  assert.match(functionsSource, /tour_access_grants\/\$\{tourId\}\/\$\{authUid\}/);
  assert.match(functionsSource, /booking_access_grants\/\$\{bookingRef\}\/\$\{authUid\}/);
  assert.match(functionsSource, /verifyIdToken\(token\)/);
  assert.match(bookingServiceSource, /headers\.Authorization = `Bearer \$\{firebaseAuthResult\.token\}`/);
});

test('Static contract: passenger manifests are assembled through verified backend endpoint', () => {
  const bookingSource = readText('services/bookingServiceRealtime.js');
  const functionsSource = readText('functions/index.js');
  const packageJson = readText('package.json');

  assert.match(bookingSource, /buildTourManifestEndpointUrl/);
  assert.match(bookingSource, /fetchTourManifestFromFunction/);
  assert.match(bookingSource, /headers,\s*\n\s*body: JSON\.stringify\(\{ tourId: tourCodeOriginal \}\)/);
  assert.match(bookingSource, /Manifest fetch completed via function/);
  assert.match(bookingSource, /Array\.isArray\(liveStatus\.passengerStatus\)/);
  assert.match(functionsSource, /exports\.getTourManifest = onRequest/);
  assert.match(functionsSource, /verifyTourManifestAccess/);
  assert.match(functionsSource, /orderByChild\('tourId'\)\.equalTo\(canonicalTourId\)/);
  assert.match(packageJson, /tests\/getTourManifest\.test\.js/);
});

test('Static contract: driver login uses verifier without client manifest scans', () => {
  const bookingSource = readText('services/bookingServiceRealtime.js');
  const functionsSource = readText('functions/index.js');
  const driverTestSource = readText('tests/validateBookingReference.driver.test.js');

  assert.match(bookingSource, /buildDriverLoginVerifierUrl/);
  assert.match(bookingSource, /verifyDriverLoginIdentity/);
  assert.match(bookingSource, /Driver verifier accepted code/);
  assert.match(functionsSource, /exports\.verifyDriverLogin = onRequest/);
  assert.match(functionsSource, /resolveDriverAssignment/);
  assert.doesNotMatch(functionsSource, /db\.ref\('tour_manifests'\)\.once\('value'\)/);
  assert.match(driverTestSource, /uses verified driver endpoint when configured/);
});

test('Static contract: driver records cannot be created by arbitrary clients', () => {
  const rules = readJson('database.rules.json');
  const driverRootRules = rules.rules.drivers;
  const driverWriteRule = rules.rules.drivers.$driverId['.write'];

  assert.equal(driverRootRules['.read'], undefined);
  assert.notEqual(driverRootRules.$driverId['.read'], 'auth != null');
  assert.match(driverRootRules.$driverId['.read'], /data\.child\('authUid'\)\.val\(\) === auth\.uid/);
  assert.notEqual(driverWriteRule, "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || data.child('authUid').val() === auth.uid || newData.child('authUid').val() === auth.uid)");
  assert.match(driverWriteRule, /data\.exists\(\)/);
  assert.match(driverWriteRule, /!data\.child\('authUid'\)\.exists\(\) && newData\.child\('authUid'\)\.val\(\) === auth\.uid/);
  assert.match(driverWriteRule, /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.match(readText('package.json'), /tests\/firebaseRules\/drivers\.rules\.test\.js/);
});

test('Static contract: remote logger uploads stay warning-plus by default outside dev', () => {
  const loggerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'loggerService.js'), 'utf8');
  const loggingDocs = readText('docs/safe-logging-conventions.md');

  assert.match(loggerSource, /const DEFAULT_SERVER_MIN_LEVEL = IS_DEV \? 'DEBUG' : 'WARN';/);
  assert.match(loggerSource, /CONFIGURED_SERVER_MIN_LEVEL/);
  assert.doesNotMatch(loggerSource, /VERBOSE_RTDB_LOGGING_ENABLED\s*=\s*true/);
  assert.match(loggingDocs, /Outside development, `loggerService` uploads `WARN`, `ERROR`, and `FATAL`/);
  assert.doesNotMatch(loggingDocs, /Temporary verbose RTDB diagnostics/);
});

test('Static contract: early runtime console logging stays development-gated', () => {
  const firebaseSource = readText('firebase.js');
  const persistenceSource = readText('services/persistenceProvider.js');
  const bookingSource = readText('services/bookingServiceRealtime.js');
  const chatSource = readText('services/chatService.js');
  const optionalLoaderSource = readText('services/optionalServiceLoader.js');
  const firebaseConsoleCalls = firebaseSource.match(/console\.(log|warn|error)\(/g) || [];

  assert.deepEqual(
    firebaseConsoleCalls.sort(),
    ['console.error(', 'console.log(', 'console.warn('].sort(),
  );
  assert.match(firebaseSource, /const firebaseDebugLog = \(\.\.\.args\) => \{\s+if \(IS_DEV\)/);
  assert.match(firebaseSource, /const firebaseWarnLog = \(\.\.\.args\) => \{\s+if \(IS_DEV\)/);
  assert.match(firebaseSource, /const firebaseErrorLog = \(\.\.\.args\) => \{\s+if \(IS_DEV\)/);
  assert.match(persistenceSource, /const IS_DEV_RUNTIME =/);
  assert.match(persistenceSource, /const writeDevConsole = \(method, \.\.\.args\) => \{/);
  assert.doesNotMatch(persistenceSource, /debug: \(msg, data\) => console\.log/);
  assert.match(bookingSource, /const IS_DEV_RUNTIME =/);
  assert.match(chatSource, /const IS_DEV_RUNTIME =/);
  assert.match(chatSource, /if \(IS_DEV_RUNTIME\) \{\s+try \{\s+const consoleMethod/);
  assert.match(optionalLoaderSource, /const isDevelopmentRuntime = \(\) =>/);
  assert.match(optionalLoaderSource, /shouldLog && isDevelopmentRuntime\(\)/);
});

test('Static contract: user-facing runtime text has no mojibake artifacts', () => {
  const runtimeFiles = [
    'App.js',
    'functions/index.js',
    ...fs.readdirSync(path.join(__dirname, '..', 'screens')).map((file) => path.join('screens', file)),
    ...fs.readdirSync(path.join(__dirname, '..', 'components')).map((file) => path.join('components', file)),
  ].filter((file) => file.endsWith('.js'));

  runtimeFiles.forEach((file) => {
    const source = readText(file);
    assert.doesNotMatch(source, /[âÃ�ð]/, `${file} contains mojibake-looking text`);
  });
});

test('Static contract: startup initialization errors use curated customer copy', () => {
  const source = readText('App.js');

  assert.match(source, /const STARTUP_CONNECTION_ERROR_MESSAGE =/);
  assert.match(source, /setAuthError\(STARTUP_CONNECTION_ERROR_MESSAGE\);/);
  assert.doesNotMatch(source, /setAuthError\(error\.message\)/);
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

test('Static contract: Functions error logger redacts exception text', () => {
  const source = readText('functions/index.js');

  assert.match(source, /const sanitizeLogText = \(value\) =>/);
  assert.match(source, /error: sanitizeLogText\(error\?\.message \|\| error \|\| null\)/);
  assert.match(source, /stack: error\?\.stack \? sanitizeLogText\(error\.stack\) : null/);
  assert.match(source, /sanitizeLogText,/);
});

test('Static contract: dashboard broadcast root reads and writes stay Firebase-backed', () => {
  const rules = readJson('database.rules.json');
  const broadcasts = rules.rules.broadcasts;
  const adminAccess = "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true)";

  assert.equal(broadcasts['.read'], adminAccess);
  assert.notEqual(broadcasts.$tourId['.read'], 'auth != null');
  assert.match(broadcasts.$tourId['.read'], /tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid/);
  assert.match(broadcasts.$tourId['.read'], /assigned_drivers/);
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
  assert.match(groupPhotoValidate, /!newData\.child\('url'\)\.exists\(\)/);
  assert.match(groupPhotoValidate, /!newData\.child\('fullUrl'\)\.exists\(\)/);
  assert.match(privatePhotoValidate, /!newData\.child\('url'\)\.exists\(\)/);
  assert.match(privatePhotoValidate, /!newData\.child\('fullUrl'\)\.exists\(\)/);
});

test('Static contract: Storage photo writes require caller auth metadata', () => {
  const storageRules = readText('storage_rules.json');
  const photoSource = readText('services/photoService.js');

  assert.match(storageRules, /function hasMatchingUploaderAuth\(\)/);
  assert.match(storageRules, /request\.resource\.metadata\.authUid == request\.auth\.uid/);
  assert.match(storageRules, /resource == null \|\| resource\.metadata\.authUid == request\.auth\.uid/);
  assert.doesNotMatch(storageRules, /resource\.exists\(\)/);
  assert.match(photoSource, /authInstance = auth/);
  assert.match(photoSource, /throw new Error\('Authenticated user required for photo upload'\)/);
  assert.match(photoSource, /customMetadata: \{\s+uploadedBy: validatedUserId,\s+authUid,/);
});

test('Static contract: email-style stable identities are encoded before identity binding path writes', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'chatService.js'), 'utf8');

  assert.match(appSource, /!authUid \|\| !realtimeDb \|\| !bookingRef \|\| !stablePassengerId/);
  assert.match(appSource, /stablePassengerKey = toRealtimeKeySegment\(stablePassengerId\)/);
  assert.match(appSource, /privatePhotoOwnerKey = stablePassengerKey/);
  assert.match(appSource, /users\/\$\{authUid\}\/privatePhotoOwnerKey/);
  assert.match(appSource, /users\/\$\{authUid\}\/stablePassengerKey/);
  assert.match(appSource, /identity_bindings\/\$\{stablePassengerKey\}\/\$\{authUid\}/);
  assert.doesNotMatch(appSource, /identity_bindings\/\$\{stablePassengerId\}/);
  assert.match(chatSource, /getRealtimeActorContext\(userId\)/);
  assert.match(chatSource, /getChatActorStatusPath\(validatedTourId, 'typing', scope\)/);
  assert.match(chatSource, /getChatActorStatusPath\(validatedTourId, 'presence', scope\)/);
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
  assert.match(source, /imageSendResetTimeoutRef/);
  assert.match(source, /clearImageSendResetTimeout/);
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

  assert.match(source, /const isProductionBuild = process\.env\.EAS_BUILD_PROFILE === 'production';/);
  assert.match(source, /NSAppTransportSecurity: appTransportSecurity/);
  assert.match(source, /NSAllowsArbitraryLoads: false/);
  assert.match(source, /NSLocationWhenInUseUsageDescription/);
  assert.match(source, /locationAlwaysAndWhenInUsePermission: false/);
  assert.match(source, /locationAlwaysPermission: false/);
  assert.match(source, /isIosBackgroundLocationEnabled: false/);
  assert.match(source, /isAndroidBackgroundLocationEnabled: false/);
  assert.doesNotMatch(source, /ACCESS_BACKGROUND_LOCATION/);
  assert.doesNotMatch(source, /NSLocationAlwaysAndWhenInUseUsageDescription/);
  assert.doesNotMatch(source, /UIBackgroundModes:\s*\[/);
  assert.doesNotMatch(source, /READ_EXTERNAL_STORAGE/);
  assert.doesNotMatch(source, /WRITE_EXTERNAL_STORAGE/);
});

test('Static contract: production native config strips dev-client release metadata', () => {
  const appConfigSource = readText('app.config.js');
  const pluginSource = readText('plugins/withProductionReleaseCleanup.js');

  assert.match(appConfigSource, /const devClientAutolinkingExclusions = \[/);
  assert.match(appConfigSource, /'expo-dev-client'/);
  assert.match(appConfigSource, /'expo-dev-launcher'/);
  assert.match(appConfigSource, /'expo-dev-menu'/);
  assert.match(appConfigSource, /'\.\/plugins\/withProductionReleaseCleanup'/);

  assert.match(pluginSource, /process\.env\.EAS_BUILD_PROFILE !== 'production'/);
  assert.match(pluginSource, /delete pluginConfig\.modResults\.NSBonjourServices/);
  assert.match(pluginSource, /delete pluginConfig\.modResults\.NSLocalNetworkUsageDescription/);
  assert.match(pluginSource, /android\.permission\.SYSTEM_ALERT_WINDOW/);
  assert.match(pluginSource, /removeAndroidPermission\(pluginConfig\.modResults, SYSTEM_ALERT_WINDOW\)/);
});

test('Static contract: live map and safety sharing guard stale or malformed location state', () => {
  const mapSource = readText('screens/MapScreen.js');
  assert.match(mapSource, /normalizeMapCoords/);
  assert.match(mapSource, /driverLocation\.timestamp \|\| driverLocation\.lastUpdated/);
  assert.match(mapSource, /let cancelled = false;/);
  assert.match(mapSource, /driverLocationPoint && userLocationPoint/);
  assert.match(mapSource, /const fitTimer = setTimeout/);
  assert.match(mapSource, /return \(\) => clearTimeout\(fitTimer\);/);

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

test('Static contract: production EAS workflows gate release on mobile/backend verification', () => {
  const readinessDoc = readText('dependency-upgrade-prod-readiness.md');
  const agentsDoc = readText('AGENTS.md');
  const packageJson = JSON.parse(readText('package.json'));

  [
    ['.github/workflows/eas-build.yml', 'npm run test:mobile:ota'],
    ['.github/workflows/eas-testflight.yml', 'npm run test:mobile:ota'],
    ['.github/workflows/eas-update.yml', 'npm run test:mobile:ota'],
  ].forEach(([relativePath, mobileTestCommand]) => {
    const source = readText(relativePath);
    const workflowLines = source.split(/\r?\n/).map((line) => line.trim());

    assert.match(source, /node-version:\s*24/);
    assert.match(source, /functions\/package-lock\.json/);
    assert.match(source, /npm --prefix functions ci/);
    assert.match(source, /actions\/setup-java@v4/);
    assert.match(source, /java-version:\s*21/);
    assert.equal(workflowLines.includes(`run: ${mobileTestCommand}`), true);
    assert.match(source, /npm run test:functions:scripts/);
    assert.match(source, /npm run test:emulators/);
    assert.match(source, /npm run validate:expo-env/);

    const testIndex = source.indexOf(`run: ${mobileTestCommand}`);
    const envIndex = source.indexOf('npm run validate:expo-env');
    const publishIndex = Math.max(source.indexOf('eas build'), source.indexOf('eas update'));
    assert.ok(testIndex >= 0 && envIndex > testIndex, 'tests must run before env validation');
    assert.ok(envIndex >= 0 && publishIndex > envIndex, 'env validation must run before EAS publish/build');
  });

  assert.equal(
    packageJson.scripts['test:mobile:ota'],
    'npm run test:mobile:auth && npm run test:mobile:services:booking',
  );
  assert.match(readinessDoc, /Deploy Firebase Functions and Firebase rules before any production EAS update\/build/);
  assert.match(readinessDoc, /deploy Functions first, then Realtime Database\/Storage rules, then publish the EAS update\/build/);
  assert.match(agentsDoc, /Current EAS workflows test backend changes but do not deploy Firebase backend artifacts/);
});

test('Static contract: production binary workflows verify EAS remote version state before building', () => {
  const easConfig = JSON.parse(readText('eas.json'));
  const appConfig = require('../app.config.js').expo;

  assert.equal(easConfig.cli?.appVersionSource, 'remote');
  assert.equal(easConfig.build?.production?.autoIncrement, true);
  assert.equal(appConfig.ios?.buildNumber, '3');
  assert.equal(appConfig.android?.versionCode, 3);

  [
    '.github/workflows/eas-build.yml',
    '.github/workflows/eas-testflight.yml',
  ].forEach((relativePath) => {
    const source = readText(relativePath);
    const versionIndex = source.indexOf('eas build:version:get');
    const buildIndex = source.indexOf('Build production');

    assert.ok(versionIndex >= 0, `${relativePath} must read EAS remote app version state`);
    assert.ok(buildIndex > versionIndex, `${relativePath} must read EAS remote app version state before building`);
    assert.doesNotMatch(source, /continue-on-error:\s*true[\s\S]{0,120}eas build:version:get/);
  });
});

test('Static contract: TestFlight App Store Connect key is created only after EAS build', () => {
  const source = readText('.github/workflows/eas-testflight.yml');
  const validationIndex = source.indexOf('Validate iOS submit configuration inputs');
  const buildIndex = source.indexOf('Build production iOS binary');
  const configureIndex = source.indexOf('Configure iOS submit profile');
  const p8WriteIndex = source.indexOf('printf \'%s\' "$EXPO_ASC_API_KEY_P8"');
  const submitIndex = source.indexOf('Submit build to TestFlight');

  assert.ok(validationIndex >= 0 && validationIndex < buildIndex, 'submit inputs should be validated before building');
  assert.ok(configureIndex > buildIndex, 'iOS submit profile should be configured after the EAS build');
  assert.ok(p8WriteIndex > buildIndex, 'App Store Connect key file should not exist before EAS build upload');
  assert.ok(submitIndex > configureIndex, 'TestFlight submit should run after submit profile configuration');
});

test('Static contract: Android production submit profile targets customer release track', () => {
  const easConfig = JSON.parse(readText('eas.json'));
  assert.equal(easConfig.cli?.version, '>= 16.0.1');
  assert.equal(easConfig.submit?.production?.android?.track, 'production');
});

test('Static contract: dependency readiness doc reflects the current mobile release baseline', () => {
  const source = readText('dependency-upgrade-prod-readiness.md');

  assert.match(source, /Expo SDK: `~55\.0\.0`/);
  assert.match(source, /Firebase JS SDK: `\^12\.14\.0`/);
  assert.match(source, /`npm audit --omit=dev`: `0 vulnerabilities`/);
  assert.doesNotMatch(source, /Expo 54|SDK 54|Firebase 9|firebase`\s*\(`\^9/);
  assert.doesNotMatch(source, /dependencies that should be upgraded before prod/);
});

test('Static contract: customer-facing screens avoid startup-only window measurements', () => {
  [
    'components/ImageViewer.js',
    'screens/ChatScreen.js',
    'screens/DriverHomeScreen.js',
    'screens/GroupPhotobookScreen.js',
    'screens/LoginScreen.js',
    'screens/MapScreen.js',
    'screens/PhotobookScreen.js',
    'screens/SafetySupportScreen.js',
    'screens/TourHomeScreen.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);
    assert.doesNotMatch(source, /\bDimensions\b/, `${relativePath} must not use static window dimensions`);
  });

  assert.match(readText('screens/LoginScreen.js'), /useWindowDimensions/);
  assert.match(readText('screens/PhotobookScreen.js'), /thumbnailTileStyle/);
  assert.match(readText('screens/GroupPhotobookScreen.js'), /thumbnailTileStyle/);
  assert.match(readText('screens/SafetySupportScreen.js'), /useWindowDimensions/);
  assert.match(readText('screens/TourHomeScreen.js'), /quickActionWrapper/);
});

test('Static contract: shared gallery data hook guards stale async updates', () => {
  const source = readText('hooks/usePhotoGalleryData.js');

  assert.match(source, /mountedRef/);
  assert.match(source, /requestSeqRef\.current \+= 1/);
  assert.match(source, /loadMoreSeqRef\.current \+= 1/);
  assert.match(source, /!mountedRef\.current \|\| requestSeqRef\.current !== requestSeq/);
  assert.match(source, /!mountedRef\.current \|\| loadMoreSeqRef\.current !== loadMoreSeq/);
});

test('Static contract: itinerary cache metadata cannot update stale screens', () => {
  const source = readText('screens/ItineraryScreen.js');

  assert.match(source, /mountedRef/);
  assert.match(source, /activeTourIdRef/);
  assert.match(source, /const canUpdateForTour = useCallback/);
  assert.match(source, /if \(canUpdateForTour\(targetTourId\)\) \{\s+setLastSyncedAt\(syncedAt\);/);
  assert.match(source, /if \(canUpdateForTour\(targetTourId\)\) \{\s+setCachedItinerary\(data\);/);
});

test('Static contract: preference and manifest screens guard stale async state', () => {
  const notificationSource = readText('screens/NotificationPreferencesScreen.js');
  const manifestSource = readText('screens/PassengerManifestScreen.js');
  const imageViewerSource = readText('components/ImageViewer.js');

  assert.match(notificationSource, /mountedRef/);
  assert.match(notificationSource, /preferenceLoadSeqRef/);
  assert.match(notificationSource, /const canApplyRequest = \(\) => mountedRef\.current && requestSeq === preferenceLoadSeqRef\.current/);
  assert.doesNotMatch(notificationSource, /Test failed:/);

  assert.match(manifestSource, /mountedRef/);
  assert.match(manifestSource, /manifestLoadSeqRef/);
  assert.match(manifestSource, /queueScanSeqRef/);
  assert.match(manifestSource, /Alert\.alert\('Manifest unavailable'/);
  assert.doesNotMatch(manifestSource, /Failed to load manifest: ' \+ error\.message/);

  assert.match(imageViewerSource, /scrollRetryTimeoutRef/);
  assert.match(imageViewerSource, /clearTimeout\(scrollRetryTimeoutRef\.current\)/);
  assert.match(imageViewerSource, /if \(!visibleRef\.current\) return/);
});

test('Static contract: safety support cleans up emergency timers and validates phone handoffs', () => {
  const source = readText('screens/SafetySupportScreen.js');

  assert.match(source, /const MIN_DIALABLE_DIGITS = 7/);
  assert.match(source, /const hasDialableDigits = \(phone\) =>/);
  assert.match(source, /clearInterval\(sosTimerRef\.current\)/);
  assert.match(source, /locationWatchRef\.current\.remove\(\)/);
  assert.match(source, /historyRequestSeqRef/);
  assert.match(source, /Notify Contacts/);
  assert.doesNotMatch(source, /Notify Emergency Contacts\?/);
  assert.match(source, /!sanitized \|\| !hasDialableDigits\(sanitized\)/);
  assert.match(source, /!hasDialableDigits\(newContactPhone\)/);
  assert.match(source, /Live location toggle blocked without identity context/);
  assert.match(source, /const shareStarted = await updateLiveLocationSharing/);
  assert.match(source, /if \(!shareStarted\) \{/);
  assert.match(source, /const shareStopped = await updateLiveLocationSharing/);
});

test('Static contract: passenger login establishes participant access before entering the app', () => {
  const appSource = readText('App.js');
  const loginSource = readText('screens/LoginScreen.js');

  assert.match(appSource, /const authUser = user \|\| auth\?\.currentUser \|\| null/);
  assert.match(appSource, /const authUid = authUser\?\.uid \|\| null/);
  assert.match(appSource, /if \(!options\?\.offlineMode && tourDetails\?\.id\) \{/);
  assert.match(appSource, /await joinTour\(tourDetails\.id, authUid\)/);
  assert.match(appSource, /joinFailure\.userMessage = 'We could not finish joining your tour session\. Please check your connection and try again\.'/);
  assert.match(appSource, /profileError\.criticalIdentityPersistence = true/);
  assert.match(appSource, /profileError\.userMessage = 'We could not finish securing your tour session\. Please check your connection and try again\.'/);
  assert.match(appSource, /if \(error\?\.criticalIdentityPersistence\) \{\s*throw error;\s*\}/);
  assert.doesNotMatch(appSource, /catch \(error\) \{\s*logger\.error\('Tour', 'Error joining tour', \{ error: error\.message \}\);\s*\}/);

  assert.match(loginSource, /typeof error\?\.userMessage === 'string'/);
  assert.doesNotMatch(loginSource, /setSimpleError\(error\.message\)/);
});

test('Static contract: customer-facing error copy avoids raw backend messages', () => {
  [
    'screens/ChatScreen.js',
    'screens/DriverHomeScreen.js',
    'screens/GroupPhotobookScreen.js',
    'screens/NotificationPreferencesScreen.js',
    'screens/PassengerManifestScreen.js',
    'screens/PhotobookScreen.js',
  ].forEach((relativePath) => {
    const source = readText(relativePath);
    assert.doesNotMatch(source, /message:\s*result\?\.error \|\|/, `${relativePath} surfaces result.error directly`);
    assert.doesNotMatch(source, /message:\s*replay\.error \?/, `${relativePath} surfaces replay.error directly`);
    assert.doesNotMatch(source, /description:\s*fallbackErrorMessage \|\| replayResult\?\.error \|\|/, `${relativePath} surfaces replayResult.error directly`);
    assert.doesNotMatch(source, /Alert\.alert\([^)]*enqueueResult\.error \|\|/s, `${relativePath} surfaces enqueueResult.error directly`);
    assert.doesNotMatch(source, /Alert\.alert\([^)]*result\.error \|\|/s, `${relativePath} surfaces result.error directly`);
    assert.doesNotMatch(source, /\$\{error\.message\}/, `${relativePath} interpolates raw error.message into UI copy`);
    assert.doesNotMatch(source, /Test failed:/, `${relativePath} surfaces raw test notification failure details`);
  });
});
