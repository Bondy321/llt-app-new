const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readAppArchitectureSource,
  readFunctionsArchitectureSource,
  readMobileModuleSource,
  readServiceModuleSource,
} = require('./helpers/readAppArchitectureSource');

const offlineSyncService = require('../services/offlineSyncService');

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
const readText = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const assertDeniedForOrdinaryIdentity = expression => {
  const absent = { child() { return this; }, val: () => null, exists: () => false };
  for (const auth of [null, { uid: 'ordinary', token: { firebase: {} } }]) {
    assert.equal(require('node:vm').runInNewContext(String(expression), { auth, root: absent }), false);
  }
};

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

test('Static contract: principal chat writes require current sessions and projections are server-owned', () => {
  const rules = readJson('database.rules.json').rules;
  for (const chat of [rules.chats.$tourId, rules.internal_chats.$tourId]) {
    assert.match(chat['.read'], /app_session_authority/);
    assert.match(chat['.read'], /driver_staff_policy/);
    assert.match(chat['.read'], /assigned_drivers/);
    for (const projection of ['typing', 'presence']) assert.match(String(chat[projection].$id['.write']), /false/);
  }
  assert.match(String(rules.chats.$tourId.messages.$messageId.reactions.$emoji['.write']), /false/);
  assert.match(rules.chats.$tourId.messages.$messageId.reactions.$emoji.$id['.write'], /app_session_authority/);
  for (const source of [rules.chat_presence_sessions, rules.chat_typing_sessions]) {
    const write = source.$scope.$appSessionId['.write'];
    assert.match(write, /app_session_authority/);
    assert.match(write, /sessionId'\)\.val\(\) === \$appSessionId/);
    assert.match(write, /principalId'\)\.val\(\)/);
    assert.match(write, /expiresAtMs'\)\.val\(\) > now/);
  }
});

test('Static contract: identity authority is server-published and direct compatibility cleanup is disabled', () => {
  const rules = readJson('database.rules.json').rules;
  const binding = rules.identity_bindings.$stablePassengerId.$uid['.write'];
  assert.match(binding, /lltSessionIssuer/);
  assert.match(binding, /writePaths/);
  assert.match(binding, /false/);
  assert.match(rules.identity_bindings_meta.$stablePassengerId['.write'], /sign_in_second_factor/);
  assert.match(rules.passenger_identity_security.$bookingRef.authorizedAuthUid['.write'], /false/);
  assert.match(rules.passenger_identity_security.$bookingRef.authorizedAuthUids.$authUid['.write'], /writePaths/);
  assert.match(rules.identity_bindings_meta.$stablePassengerId['.validate'], /pax_v2_/);
});

test('Static contract: sensitive database writes remain ownership or admin gated', () => {
  const rules = readJson('database.rules.json');
  const adminUid = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
  const adminOnlyRootAccess = `auth != null && (auth.uid === '${adminUid}' && auth.token.firebase.sign_in_second_factor === 'totp')`;
  const portalAdminRootAccess = `auth != null && ((auth.uid === '${adminUid}' && auth.token.firebase.sign_in_second_factor === 'totp') || (root.child('admin_users/' + auth.uid).val() === true && auth.token.firebase.sign_in_second_factor === 'totp'))`;
  const manifestBookingAccess = rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.write'];

  assert.match(rules.rules.bookings.$bookingRef['.write'], /sign_in_second_factor/);
  assert.match(rules.rules.bookings.$bookingRef['.write'], /lltSessionIssuer !== true/);
  assert.equal(rules.rules.bookings['.read'], adminOnlyRootAccess);
  assert.notEqual(rules.rules.bookings['.read'], 'auth != null');
  assert.notEqual(rules.rules.bookings.$bookingRef['.read'], 'auth != null');
  assert.doesNotMatch(rules.rules.bookings.$bookingRef['.read'], /booking_access_grants/);
  assert.match(rules.rules.bookings.$bookingRef['.read'], /data\.child\('tourId'\)\.isString\(\)/);
  assert.deepEqual(rules.rules.bookings['.indexOn'], ['tourId']);
  assert.match(manifestBookingAccess, /app_sessions/);
  assert.match(manifestBookingAccess, /tourId'\)\.val\(\) === \$tourId/);
  assert.match(manifestBookingAccess, /users\/' \+ auth\.uid \+ '\/bookingRef/);
  assert.match(manifestBookingAccess, /participants\/' \+ auth\.uid \+ '\/sessionId/);
  assert.match(manifestBookingAccess, /assigned_drivers/);
  assert.match(manifestBookingAccess, /bookings\/' \+ \$bookingRef \+ '\/tourId/);
  assert.equal(rules.rules.tour_manifests['.read'], portalAdminRootAccess);
  assert.notEqual(rules.rules.tour_manifests['.read'], 'auth != null');
  assert.notEqual(rules.rules.tour_manifests.$tourId['.read'], 'auth != null');
  assert.doesNotMatch(rules.rules.tour_manifests.$tourId['.read'], /participants\/' \+ auth\.uid/);
  assert.match(rules.rules.tour_manifests.$tourId['.read'], /assigned_drivers/);
  assert.match(rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.read'], /users\/' \+ auth\.uid \+ '\/bookingRef/);
  assert.match(rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.read'], /app_sessions/);
  assert.doesNotMatch(rules.rules.tour_manifests.$tourId.bookings.$bookingRef['.read'], /booking_access_grants/);
  const privateOwnerAccess = rules.rules.private_tour_photos.$tourId.$ownerId['.read'];
  assert.match(String(rules.rules.private_tour_photos.$tourId.$ownerId['.write']), /false/);
  assert.match(privateOwnerAccess, /app_sessions/);
  assert.match(privateOwnerAccess, /principalId'\)\.val\(\) === \$ownerId/);
  assert.match(privateOwnerAccess, /participants\/' \+ auth\.uid \+ '\/sessionId/);
  assert.notEqual(rules.rules.group_tour_photos.$tourId['.read'], 'auth != null');
  assert.match(rules.rules.group_tour_photos.$tourId['.read'], /app_session_authority/);
  assert.match(rules.rules.group_tour_photos.$tourId['.read'], /tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid/);
  assert.match(rules.rules.group_tour_photos.$tourId['.read'], /assigned_drivers/);
  ['privatePhotoOwnerKey', 'stablePassengerKey'].forEach((field) => {
    assert.match(rules.rules.users.$userId[field]['.validate'], /pax_v2_/);
    assert.doesNotMatch(rules.rules.users.$userId[field]['.write'], /auth\.uid === \$userId/);
    assert.match(rules.rules.users.$userId[field]['.write'], /admin_users/);
  });
  assert.ok(rules.rules.users.$userId.driverId['.validate'].includes('!newData.exists() || newData.isString()'));
  assert.ok(rules.rules.users.$userId.driverPrincipalId['.validate'].includes('!newData.exists() || newData.isString()'));
  assert.ok(rules.rules.users.$userId.driverAssignedTourId['.validate'].includes('!newData.exists() || newData.isString() || newData.val() === null'));
  assert.ok(rules.rules.users.$userId.principalType['.validate'].includes("!newData.exists() || newData.val() === 'passenger' || newData.val() === 'driver'"));
  ['driverId', 'driverPrincipalId', 'principalType', 'lastUpdated'].forEach((field) => {
    assert.match(rules.rules.users.$userId[field]['.write'], /admin_users/);
  });
  assert.match(rules.rules.users.$userId.driverAssignedTourId['.write'], /lltSessionIssuer/);
  assert.match(rules.rules.users.$userId.driverAssignedTourId['.write'], /writePaths/);
  assertDeniedForOrdinaryIdentity(rules.rules.users.$userId.driverAssignedTourId['.write']);
  assert.equal(rules.rules.globalSafetyAlerts['.write'], false);
  assert.equal(rules.rules.globalSafetyAlerts.$eventId['.write'], false);
  assert.equal(rules.rules.logs.$userId['.write'], false);
  assert.equal(rules.rules.logs.$userId.safety['.write'], undefined);
  for (const field of ['status', 'statusUpdatedAt', 'statusUpdatedBy']) {
    assert.equal(rules.rules.logs.$userId.safety.$eventId[field]['.write'], false);
  }
  assert.notEqual(rules.rules.globalSafetyAlerts['.read'], 'auth != null');
  assert.match(rules.rules.globalSafetyAlerts['.read'], /admin_users/);
  assert.notEqual(rules.rules.globalSafetyAlerts.$eventId['.write'], 'auth != null');
});

test('Static contract: tour metadata writes stay least-privilege', () => {
  const rules = readJson('database.rules.json');
  const tourRules = rules.rules.tours.$tourId;

  assert.match(rules.rules.tours['.read'], /admin_users/);
  assert.notEqual(rules.rules.tours['.read'], 'auth != null');
  assert.doesNotMatch(tourRules['.read'], /tour_access_grants/);
  assert.match(tourRules['.read'], /app_sessions/);
  assert.match(tourRules['.read'], /assigned_drivers/);
  assert.match(tourRules.itinerary['.read'], /app_sessions/);
  assert.match(tourRules.itinerary['.read'], /participants\/' \+ auth\.uid \+ '\/sessionId/);
  assert.match(tourRules.driverLocation['.read'], /participants\/' \+ auth\.uid/);
  assert.equal(tourRules.driver_itinerary['.read'], undefined);
  assert.match(rules.rules.bookings.$bookingRef['.read'], /assigned_drivers/);
  assert.doesNotMatch(rules.rules.bookings.$bookingRef['.read'], /booking_access_grants/);
  assert.match(String(tourRules['.write']), /false/);
  assert.match(tourRules.participants.$userId['.write'], /lltSessionIssuer/);
  assert.match(tourRules.participants.$userId['.write'], /writePaths/);
  assert.match(String(tourRules.currentParticipants['.write']), /false/);
  assert.match(tourRules.itinerary['.write'], /assigned_drivers/);
  assert.match(tourRules.driver_itinerary['.write'], /assigned_drivers/);
  assert.match(tourRules.liveTracking.$userId['.write'], /auth\.uid === \$userId/);
  assert.match(tourRules.liveTracking.$userId['.write'], /app_session_authority/);
  assert.match(readText('package.json'), /tests\/firebaseRules\/tours\.rules\.test\.js/);

  const bookingSource = readServiceModuleSource('services/bookingServiceRealtime.js');
  assert.match(bookingSource, /currentParticipants is the booked passenger total[\s\S]*must never replace that commercial passenger count/);
  assert.match(bookingSource, /Membership is created atomically by verifyPassengerLogin/);
  assert.match(bookingSource, /participant\.sessionId !== activeSession\.sessionId/);
  assert.doesNotMatch(bookingSource, /participantRef\.transaction/);
  assert.doesNotMatch(bookingSource, /tourRef\.transaction\(\(tourState\)/);
  assert.doesNotMatch(bookingSource, /update\(\{ isActive: true, participants: \{\}, currentParticipants: 0 \}\)/);
});

test('Static contract: verified login grants are scoped and short-lived', () => {
  const rules = readJson('database.rules.json');
  const tourGrant = rules.rules.tour_access_grants.$tourId.$userId;
  const bookingGrant = rules.rules.booking_access_grants.$bookingRef.$userId;
  const functionsSource = readFunctionsArchitectureSource();
  const bookingServiceSource = readServiceModuleSource('services/bookingServiceRealtime.js');

  assert.match(tourGrant['.read'], /auth\.uid === \$userId/);
  assert.match(tourGrant['.write'], /admin_users/);
  assert.match(tourGrant['.validate'], /expiresAtMs'\)\.val\(\) > now/);
  assert.doesNotMatch(tourGrant['.validate'], /tourCode/);
  assert.match(bookingGrant['.read'], /auth\.uid === \$userId/);
  assert.match(bookingGrant['.validate'], /bookingRef'\)\.val\(\) === \$bookingRef/);
  assert.doesNotMatch(bookingGrant['.validate'], /tourCode/);
  assert.match(functionsSource, /tour_access_grants\/\$\{tourId\}\/\$\{authUid\}/);
  assert.match(functionsSource, /booking_access_grants\/\$\{bookingRef\}\/\$\{authUid\}/);
  assert.match(functionsSource, /verifyIdToken\(token, true\)/);
  assert.match(bookingServiceSource, /headers\.Authorization = `Bearer \$\{firebaseAuthResult\.token\}`/);
  assert.match(functionsSource, /booking: buildPassengerSafeBooking/);
  assert.match(functionsSource, /tour: buildPassengerSafeTour/);
  assert.match(bookingServiceSource, /normalizePassengerBookingProjection/);
  assert.doesNotMatch(bookingServiceSource, /passenger_tour_after_verifier/);
});

test('Static contract: passenger manifests are assembled through verified backend endpoint', () => {
  const bookingSource = readServiceModuleSource('services/bookingServiceRealtime.js');
  const functionsSource = readFunctionsArchitectureSource();
  const packageJson = readText('package.json');

  assert.match(bookingSource, /buildTourManifestEndpointUrl/);
  assert.match(bookingSource, /fetchTourManifestFromFunction/);
  assert.match(bookingSource, /headers,\s*\n\s*body: JSON\.stringify\(\{ tourId: tourCodeOriginal \}\)/);
  assert.match(bookingSource, /Manifest fetch completed via function/);
  assert.doesNotMatch(bookingSource, /const bookingsQuery = realtimeDb\.ref\('bookings'\)/);
  assert.match(functionsSource, /const getTourManifest = onRequestWithResult/);
  assert.match(functionsSource, /getTourManifest: manifests\.getTourManifest/);
  assert.match(functionsSource, /verifyTourManifestAccess/);
  assert.match(functionsSource, /Array\.isArray\(liveStatus\.passengerStatus\)/);
  assert.match(functionsSource, /buildDriverManifestBooking/);
  assert.match(functionsSource, /orderByChild\('tourId'\)\.equalTo\(canonicalTourId\)/);
  assert.match(packageJson, /tests\/getTourManifest\.test\.js/);
});

test('Static contract: driver login uses verifier without client manifest scans', () => {
  const bookingSource = readServiceModuleSource('services/bookingServiceRealtime.js');
  const functionsSource = readFunctionsArchitectureSource();
  const driverTestSource = readText('tests/validateBookingReference.driver.test.js');

  assert.match(bookingSource, /buildDriverLoginVerifierUrl/);
  assert.match(bookingSource, /verifyDriverLoginIdentity/);
  assert.match(bookingSource, /Driver verifier accepted code/);
  assert.match(functionsSource, /const verifyDriverLogin = onRequestWithResult/);
  assert.match(functionsSource, /verifyDriverLogin: driverAuth\.verifyDriverLogin/);
  assert.match(functionsSource, /resolveDriverAssignment/);
  assert.doesNotMatch(functionsSource, /db\.ref\('tour_manifests'\)\.once\('value'\)/);
  assert.match(driverTestSource, /uses verified driver endpoint when configured/);
});

test('Static contract: driver identity and assignment authority are server-owned', () => {
  const rules = readJson('database.rules.json');
  const functionsSource = readFunctionsArchitectureSource();
  const driverRootRules = rules.rules.drivers;
  const driverWriteRule = rules.rules.drivers.$driverId['.write'];
  const authUidWriteRule = rules.rules.drivers.$driverId.authUid['.write'];
  const lastActiveWriteRule = rules.rules.drivers.$driverId.lastActive['.write'];
  const assignedDriverWriteRule = rules.rules.tour_manifests.$tourId.assigned_drivers.$driverId['.write'];
  const assignedDriverCodeWriteRule = rules.rules.tour_manifests.$tourId.assigned_driver_codes.$driverId['.write'];

  assert.match(driverRootRules['.read'], /admin_users/);
  assert.notEqual(driverRootRules['.read'], 'auth != null');
  assert.notEqual(driverRootRules.$driverId['.read'], 'auth != null');
  assert.match(driverRootRules.$driverId['.read'], /driver_login_policy\/v1\/generation/);
  assert.match(driverRootRules.$driverId['.read'], /driverLoginPolicyGeneration/);
  assert.match(driverRootRules.$driverId['.read'], /enforceSingleDevice/);
  assert.doesNotMatch(driverRootRules.$driverId['.read'], /data\.child\('authUid'\)\.val\(\) === auth\.uid/);
  assert.match(driverWriteRule, /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.doesNotMatch(driverWriteRule, /authUid.*auth\.uid/);
  assert.match(authUidWriteRule, /data\.val\(\) === auth\.uid && !newData\.exists\(\)/);
  assert.doesNotMatch(authUidWriteRule, /!data\.child\('authUid'\)\.exists\(\)/);
  assert.match(lastActiveWriteRule, /root\.child\('drivers\/' \+ \$driverId \+ '\/authUid'\)\.val\(\) === auth\.uid/);
  assert.match(String(assignedDriverWriteRule), /false/);
  assert.match(String(assignedDriverCodeWriteRule), /false/);
  assert.match(functionsSource, /const assignDriverToTour = onRequestWithResult/);
  assert.match(functionsSource, /assignDriverToTour: assignment\.assignDriverToTour/);
  assert.match(functionsSource, /claimDriverAuthUid/);
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
  const bookingSource = readServiceModuleSource('services/bookingServiceRealtime.js');
  const chatSource = readServiceModuleSource('services/chatService.js');
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
  const source = readAppArchitectureSource();

  assert.match(source, /const STARTUP_CONNECTION_ERROR_MESSAGE =/);
  assert.match(source, /setAuthError\(STARTUP_CONNECTION_ERROR_MESSAGE\);/);
  assert.doesNotMatch(source, /setAuthError\(error\.message\)/);
});

test('Static contract: curated ops alerts stay separate from raw logs and schema-gated', () => {
  const rules = readJson('database.rules.json');
  const opsAlerts = rules.rules.ops_alerts;
  const adminUsers = rules.rules.admin_users;

  assert.match(rules.rules.logs.$userId['.read'], /auth\.uid === \$userId/);
  assert.match(rules.rules.logs.$userId['.read'], /app_sessions/);
  assert.match(rules.rules.logs.$userId['.read'], /status'\)\.val\(\) === 'active'/);
  assert.match(rules.rules.logs.$userId['.read'], /expiresAtMs'\)\.val\(\) > now/);
  assert.match(adminUsers['.read'], /sign_in_second_factor/);
  assert.match(adminUsers['.read'], /admin_users/);
  assert.match(adminUsers.$uid['.write'], /sign_in_second_factor/);
  assert.match(adminUsers.$uid['.write'], /9CWQ4705gVRkfW5Xki5LyvrmVp23/);
  assert.ok(adminUsers.$uid['.validate'].includes('!newData.exists() || newData.val() === true'));
  assert.match(opsAlerts['.read'], /sign_in_second_factor/);
  assert.match(opsAlerts['.read'], /admin_users/);
  assert.deepEqual(opsAlerts['.indexOn'], ['createdAtMs', 'lastSeenAtMs', 'severity', 'status']);
  assert.match(opsAlerts.$alertId['.write'], /auth\.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'/);
  assert.match(opsAlerts.$alertId['.write'], /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.match(opsAlerts.$alertId['.write'], /newData\.child\('fingerprint'\)\.val\(\) === \$alertId/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.hasChildren\(\['alertVersion', 'fingerprint', 'createdAt', 'createdAtMs'/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('message'\)\.val\(\)\.length <= 240/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('summary'\)\.val\(\)\.length <= 600/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('source'\)\.val\(\) === 'mobile_logger'/);
  assert.match(opsAlerts.$alertId['.validate'], /newData\.child\('source'\)\.val\(\) === 'crash_diagnostics'/);
  assertDeniedForOrdinaryIdentity(opsAlerts.$alertId.deviceInfo.$other['.validate']);
  assertDeniedForOrdinaryIdentity(opsAlerts.$alertId.$other['.validate']);
});

test('Static contract: Functions error logger redacts exception text', () => {
  const source = readFunctionsArchitectureSource();

  assert.match(source, /normalizedKey === 'error'/);
  assert.match(source, /return '\[redacted-error\]'/);
  assert.match(source, /error: sanitizeLogValue\(/);
  assert.match(source, /\? sanitizeLogValue\('stack', error\.stack\)\s+: null/);
});

test('Static contract: dashboard broadcast root reads and writes stay Firebase-backed', () => {
  const rules = readJson('database.rules.json');
  const broadcasts = rules.rules.broadcasts;
  const evaluate = (expression, auth, listedAdmin) => require('node:vm').runInNewContext(expression, {
    auth, root: { child: () => ({ val: () => listedAdmin }) },
  });
  for (const expression of [broadcasts['.read'], broadcasts.$tourId.$broadcastId['.write']]) {
    for (const uid of ['9CWQ4705gVRkfW5Xki5LyvrmVp23', 'listed-admin']) {
      const listed = uid === 'listed-admin';
      assert.equal(evaluate(expression, { uid, token: { firebase: {} } }, listed), false);
      assert.equal(evaluate(expression, { uid, token: { firebase: { sign_in_second_factor: 'totp' } } }, listed), true);
    }
    assert.equal(evaluate(expression, null, false), false);
    assert.equal(evaluate(expression, { uid: 'ordinary', token: { firebase: { sign_in_second_factor: 'totp' } } }, false), false);
  }
  assert.notEqual(broadcasts.$tourId['.read'], 'auth != null');
  assert.match(broadcasts.$tourId['.read'], /tours\/' \+ \$tourId \+ '\/participants\/' \+ auth\.uid/);
  assert.match(broadcasts.$tourId['.read'], /assigned_drivers/);
  assert.deepEqual(broadcasts.$tourId['.indexOn'], ['createdAtMs']);
  for (const issuer of ['lltSessionIssuer', 'lltNotificationIssuer', 'lltMediaPublisher']) {
    assert.equal(evaluate(broadcasts.$tourId.$broadcastId['.write'], {
      uid: 'listed-admin', [issuer]: true, token: { firebase: { sign_in_second_factor: 'totp' } },
    }, true), false);
  }
  assert.match(broadcasts.$tourId.$broadcastId['.validate'], /newData\.child\('createdByUid'\)\.val\(\) === auth\.uid/);
});

test('Static contract: category broadcasts target canonical tour-interest preferences', () => {
  const rules = readJson('database.rules.json');
  const source = readFunctionsArchitectureSource();
  const categoryHandlerSource = readText('functions/src/domains/notifications/broadcastFunctions.js');
  const screenSource = readMobileModuleSource('screens/NotificationPreferencesScreen.js');
  const adminSource = readText('web-admin/src/components/BroadcastPanel.jsx');
  const categoryBroadcasts = rules.rules.category_broadcasts;
  const categoryKeys = [
    'day_trips',
    'mystery_breaks',
    'scotland_highlands_islands',
    'isle_of_ireland',
    'european_breaks',
    'steam_train_tours',
    'cruises_ferries',
    'theatre_concerts',
    'sporting_breaks',
    'history_military_breaks',
  ];
  const evaluateAccess = (expression, auth, listedAdmin) => require('node:vm').runInNewContext(expression, {
    auth, root: { child: () => ({ val: () => listedAdmin }) },
  });
  for (const expression of [categoryBroadcasts['.read'], categoryBroadcasts.$categoryKey.$broadcastId['.write']]) {
    for (const uid of ['9CWQ4705gVRkfW5Xki5LyvrmVp23', 'listed-admin']) {
      const listedAdmin = uid === 'listed-admin';
      assert.equal(evaluateAccess(expression, { uid, token: { firebase: {} } }, listedAdmin), false);
      assert.equal(evaluateAccess(expression, { uid, token: { firebase: { sign_in_second_factor: 'totp' } } }, listedAdmin), true);
    }
    assert.equal(evaluateAccess(expression, { uid: 'ordinary-user', token: { firebase: { sign_in_second_factor: 'totp' } } }, false), false);
    assert.equal(evaluateAccess(expression, null, false), false);
  }
  for (const issuer of ['lltSessionIssuer', 'lltNotificationIssuer', 'lltMediaPublisher']) {
    assert.equal(evaluateAccess(categoryBroadcasts.$categoryKey.$broadcastId['.write'], {
      uid: 'listed-admin', [issuer]: true, token: { firebase: { sign_in_second_factor: 'totp' } },
    }, true), false, 'restricted publication identity cannot use ordinary admin fallback');
  }
  assert.deepEqual(categoryBroadcasts.$categoryKey['.indexOn'], ['createdAtMs']);
  assert.match(categoryBroadcasts.$categoryKey.$broadcastId['.validate'], /newData\.child\('categoryKey'\)\.val\(\) === \$categoryKey/);
  assert.match(source, /const processCategoryBroadcastWrite = onValueCreated/);
  assert.match(source, /processCategoryBroadcastWrite: broadcasts\.processCategoryBroadcastWrite/);
  assert.match(source, /ref: '\/category_broadcasts\/\{categoryKey\}\/\{broadcastId\}'/);
  assert.match(source, /loadNotificationAudiencePage/);
  assert.match(source, /marketingPreferences/);
  assert.match(categoryHandlerSource, /buildMarketingNotificationJob\(\{/);
  assert.match(categoryHandlerSource, /enqueueNotificationJob\(\{/);
  assert.doesNotMatch(categoryHandlerSource, /buildChatNotificationContent/);
  assert.doesNotMatch(categoryHandlerSource, /chunkArrayDeterministically\(\s*validRecipients/);
  assert.match(adminSource, /category_broadcasts\/\$\{targetId\}/);

  categoryKeys.forEach((categoryKey) => {
    assert.ok(rules.rules.users['.indexOn'].includes(`preferences/marketing/${categoryKey}`));
    assert.ok(rules.rules.notification_devices['.indexOn'].includes(`marketingPreferences/${categoryKey}`));
    assert.match(screenSource, new RegExp(categoryKey));
    assert.match(categoryBroadcasts.$categoryKey.$broadcastId['.validate'], new RegExp(categoryKey));
  });
});

test('Static contract: notification taps preserve exact destination context end to end', () => {
  const appSource = readAppArchitectureSource();
  const chatSource = readMobileModuleSource('screens/ChatScreen.js');
  const preferencesSource = readMobileModuleSource('screens/NotificationPreferencesScreen.js');
  const routingSource = readText('utils/notificationRouting.js');
  const sessionNavigationSource = readText('src/app/notifications/useNotificationSessionNavigation.js');

  assert.match(sessionNavigationSource, /const hasLiveAppSession = Boolean\(/);
  assert.match(sessionNavigationSource, /appSession\?\.sessionRevision/);
  assert.match(sessionNavigationSource, /appSession\?\.expiresAtMs > Date\.now\(\)/);
  assert.match(appSource, /bookingId: bookingData\?\.id/);
  assert.match(appSource, /initialMessageId=\{context\.screenParams\.messageId \|\| null\}/);
  assert.match(appSource, /initialMarketingCategoryKey=\{context\.screenParams\?\.categoryKey \|\| null\}/);
  assert.match(appSource, /MarketingNotificationDetailScreen/);
  assert.match(appSource, /SafetyAlertDetailScreen/);
  assert.match(chatSource, /getChatMessageById/);
  assert.match(chatSource, /initialMessageId/);
  assert.match(preferencesSource, /initialMarketingCategoryKey/);
  assert.match(routingSource, /GLOBAL_NOTIFICATION_SCREENS/);
  assert.match(routingSource, /messageId/);
  assert.match(routingSource, /categoryKey/);
});

test('Static contract: notification read state stays canonical and migrates legacy UID branches', () => {
  const rules = readJson('database.rules.json');
  const serviceSource = readText('services/notificationInboxService.js');
  const screenSource = readMobileModuleSource('screens/NotificationPreferencesScreen.js');
  const functionsSource = readFunctionsArchitectureSource();
  const principalRules = rules.rules.notification_read_state.$tourId.$principalId;
  const migrationRules = rules.rules.notification_read_migration_requests.$tourId.$authUid;

  assert.match(principalRules['.read'], /app_sessions/);
  assert.match(principalRules['.read'], /principalId'\)\.val\(\) === \$principalId/);
  assert.match(principalRules['.read'], /participants\/' \+ auth\.uid \+ '\/sessionId/);
  assert.match(principalRules['.read'], /assigned_drivers/);
  assert.match(principalRules.$noticeId['.write'], /tour_notifications/);
  assert.match(migrationRules['.write'], /auth\.uid === \$authUid/);
  assert.match(migrationRules['.write'], /app_sessions/);
  assert.match(migrationRules['.write'], /principalId'\)\.val\(\)/);
  const rejectUnknown = migrationRules.$other['.validate'];
  for (const auth of [null, { uid: 'ordinary-user' }, { uid: 'ordinary-user', token: {
    lltSessionIssuer: true, lltNotificationIssuer: true, lltTourPublisher: true, lltMediaPublisher: true,
  } }]) {
    assert.equal(require('node:vm').runInNewContext(String(rejectUnknown), { auth }), false,
      'unknown migration fields remain denied to every ordinary client, including forged token claims');
  }
  assert.match(serviceSource, /requestNotificationReadStateMigration/);
  assert.match(serviceSource, /notification_read_state\/\$\{safeTourId\}\/\$\{safeReadStateOwnerId\}/);
  assert.match(screenSource, /readStateOwnerId: appSession\?\.principalId/);
  assert.match(functionsSource, /const processNotificationReadMigrationRequest = onValueCreated/);
  assert.match(functionsSource, /processNotificationReadMigrationRequest: notificationReads\.processNotificationReadMigrationRequest/);
  assert.match(functionsSource, /retry: true/);
  assert.match(functionsSource, /notificationReadStateUpgradedTours/);
  assert.doesNotMatch(functionsSource, /notification_read_migration_receipts/);
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

test('Static contract: user content reports stay scoped to tour users and admin review', () => {
  const rules = readJson('database.rules.json');
  const reports = rules.rules.content_reports;
  const reportRule = reports.$reportId;
  for (const secondFactor of [undefined, 'totp']) {
    assert.equal(require('node:vm').runInNewContext(reports['.read'], {
      auth: { uid: 'listed-admin', token: { firebase: { sign_in_second_factor: secondFactor } } },
      root: { child: () => ({ val: () => true }) },
    }), secondFactor === 'totp');
  }
  assert.deepEqual(reports['.indexOn'], ['createdAtMs', 'tourId', 'status', 'contentType']);
  assert.match(reportRule['.write'], /newData\.child\('reporterAuthUid'\)\.val\(\) === auth\.uid/);
  assert.match(reportRule['.write'], /tours\/' \+ newData\.child\('tourId'\)\.val\(\) \+ '\/participants\/' \+ auth\.uid/);
  assert.match(reportRule['.write'], /assigned_drivers/);
  assert.match(reportRule['.validate'], /newData\.child\('contentType'\)\.val\(\) === 'chat_message'/);
  assert.match(reportRule['.validate'], /newData\.child\('contentType'\)\.val\(\) === 'group_photo'/);
  assert.match(reportRule['.validate'], /newData\.child\('reason'\)\.val\(\) === 'harassment'/);
  assert.match(reportRule['.validate'], /newData\.child\('contentPreview'\)\.val\(\)\.length <= 500/);
  assert.match(rules.rules.chats.$tourId.messages.$messageId['.write'], /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assert.match(rules.rules.internal_chats.$tourId.messages.$messageId['.write'], /root\.child\('admin_users\/' \+ auth\.uid\)\.val\(\) === true/);
  assertDeniedForOrdinaryIdentity(rules.rules.group_tour_photos.$tourId.$photoId['.write']);
});

test('Static contract: photo objects are inaccessible directly and all media operations are server-authorized', () => {
  const storageRules = readText('storage_rules.json');
  const photoSource = readServiceModuleSource('services/photoService.js');
  const functionsSource = readFunctionsArchitectureSource();

  assert.match(storageRules, /match \/private_tour_photos\/\{tourId\}\/\{ownerId\}\/\{allPaths=\*\*\}[\s\S]*allow read, write: if false/);
  assert.match(storageRules, /match \/group_tour_photos\/\{tourId\}\/\{fileName\}[\s\S]*allow read, write: if false/);
  assert.doesNotMatch(photoSource, /getDownloadURL\(/);
  assert.match(photoSource, /throw new Error\('Authenticated user required for photo upload'\)/);
  assert.match(photoSource, /if \(!appCheckToken\) throw new Error\('App Check is required for photos'\)/);
  assert.match(photoSource, /withPhotoRequestBoundary/);
  assert.match(photoSource, /resolveGroupPhotoMedia/);
  assert.match(photoSource, /uploadGroupPhoto/);
  assert.match(photoSource, /deleteGroupPhoto/);
  assert.match(photoSource, /uploadPrivatePhoto/);
  assert.match(photoSource, /deletePrivatePhoto/);
  assert.match(functionsSource, /verifyCurrentTourPhotoAccess/);
  assert.match(functionsSource, /verifyActiveAppSession/);
  assert.match(functionsSource, /enforceGroupMediaAppCheck/);
  assert.match(functionsSource, /GROUP_MEDIA_URL_TTL_MS = 5 \* 60 \* 1000/);
  assert.doesNotMatch(functionsSource, /viewerToken = visibility === "private"/);
});

test('Static contract: passenger identities are server-issued opaque values and client writes are removed', () => {
  const appSource = readAppArchitectureSource();
  const chatSource = readServiceModuleSource('services/chatService.js');

  assert.match(appSource, /isOpaquePassengerId\(stablePassengerId\)/);
  assert.match(appSource, /stablePassengerKey = toRealtimeKeySegment\(stablePassengerId\)/);
  assert.doesNotMatch(appSource, /identity_bindings\/\$\{/);
  assert.doesNotMatch(appSource, /pax_v1:/);
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
    const source = relativePath.startsWith('services/')
      ? readText(relativePath)
      : readMobileModuleSource(relativePath);

    assert.match(source, /from 'expo-file-system\/legacy'/);
    assert.doesNotMatch(source, /from 'expo-file-system';/);
  });
});

test('Static contract: chat media rejects durable URLs and permits server-created photo references', () => {
  const rules = readJson('database.rules.json');
  const messageRules = rules.rules.chats.$tourId.messages.$messageId;
  assert.match(messageRules.imageUrl['.validate'], /!newData\.exists\(\)/);
  assert.match(messageRules.thumbnailUrl['.validate'], /!newData\.exists\(\)/);
  assert.match(messageRules.photoId['.validate'], /newData\.isString/);
});

test('Static contract: photo upload modals guard duplicate enqueue taps', () => {
  [
    'screens/PhotobookScreen.js',
    'screens/GroupPhotobookScreen.js',
  ].forEach((relativePath) => {
    const source = readMobileModuleSource(relativePath);

    assert.match(source, /const \[uploading, setUploading\] = useState\(false\);/);
    assert.match(source, /if \(uploading(?: \|\| !pendingImage\?\.uri)?\) return;/);
    assert.match(source, /setUploading\(true\);/);
    assert.match(source, /finally \{\s*setUploading\(false\);\s*\}/);
    assert.match(source, /disabled=\{uploading\}/);
    assert.match(source, /uploadButtonDisabled/);
  });
});

test('Static contract: passenger driver calls use tour contact data', () => {
  const source = readMobileModuleSource('screens/TourHomeScreen.js');

  assert.match(source, /resolveDriverPhoneNumber/);
  assert.match(source, /tourData\?\.driverPhone/);
  assert.match(source, /openDriverContactUrl\(`tel:\$\{phone\}`, 'call'\)/);
  assert.doesNotMatch(source, /tel:\+441414876737/);
});

test('Static contract: failed chat sends preserve reply composer context', () => {
  const source = readMobileModuleSource('screens/ChatScreen.js');

  assert.match(source, /const pendingReply = replyingToMessage;/);
  assert.match(source, /setReplyingToMessage\(value => value \|\| pendingReply\);/);
  assert.match(source, /replyTo: pendingReply \|\| undefined/);
  assert.match(source, /imageSendResetTimeoutRef/);
  assert.match(source, /clearImageSendResetTimeout/);
});

test('Static contract: chat connectivity and queue ownership stay wired from app shell to every send and replay', () => {
  const appSource = readAppArchitectureSource();
  const chatSource = readMobileModuleSource('screens/ChatScreen.js');
  const offlineSource = readServiceModuleSource('services/offlineSyncService.js');

  assert.match(appSource, /routerProps=\{\{[\s\S]*offlineSessionScope,/);
  assert.match(appSource, /services: \{ bookingService, chatService, photoService, driverTourPackActionService \}/);
  assert.match(chatSource, /isConnected = true/);
  assert.match(chatSource, /offlineSessionScope = null/);
  assert.match(chatSource, /online: isConnected/);
  assert.match(chatSource, /scope: chatQueueScope \|\| undefined/);
  assert.match(chatSource, /subscribeQueuedActions/);
  assert.match(chatSource, /chatMessage: \{/);
  assert.match(offlineSource, /hasReplayHandler/);
  assert.match(offlineSource, /Queue replay preserved action without an injected handler/);
});

test('Static contract: chat listener failures keep visible messages and expose retry recovery', () => {
  const serviceSource = readServiceModuleSource('services/chatService.js');
  const screenSource = readMobileModuleSource('screens/ChatScreen.js');

  assert.doesNotMatch(serviceSource, /onMessagesUpdate\(\[\]\)/);
  assert.match(screenSource, /Live updates paused\. Your existing messages are still available\./);
  assert.match(screenSource, /Retry live chat updates/);
});

test('Static contract: chat read state advances only after restore and while the reader is at the latest message', () => {
  const source = readMobileModuleSource('screens/ChatScreen.js');

  assert.match(source, /sessionUnreadBoundaryTimestamp/);
  assert.match(source, /readStateRestored/);
  assert.match(source, /if \(!force && !isAtBottomRef\.current\) return;/);
  assert.match(source, /!isMessageOwnedByCurrentSession\(message, canonicalIdentity\)/);
});

test('Static contract: internal driver chat uses the rules-compatible stable actor for live state', () => {
  const source = readMobileModuleSource('screens/ChatScreen.js');

  assert.match(
    source,
    /internalDriverChat\s*&&\s*isDriver\s*&&\s*principalId\.startsWith\('driver:'\)/,
  );
  assert.match(
    source,
    /return isRealtimeKeySegment\(principalId\)[\s\S]*?toRealtimeKeySegment\(principalId\)/,
  );
});

test('Static contract: chat timestamp helpers use strict shared parser', () => {
  [
    'utils/chatTimeline.js',
    'utils/chatUnreadSummary.js',
    'services/chatService.js',
  ].forEach((relativePath) => {
    const source = relativePath.startsWith('services/')
      ? readServiceModuleSource(relativePath)
      : readText(relativePath);

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
    const source = readMobileModuleSource(relativePath);

    assert.match(source, /parseTimestampMs|parseSharedTimestampMs/);
    assert.doesNotMatch(source, /Date\.parse\(/);
  });

  ['screens/PhotobookScreen.js', 'screens/GroupPhotobookScreen.js'].forEach((relativePath) => {
    const source = readMobileModuleSource(relativePath);
    assert.match(source, /getPhotoTimestampMs/);
    assert.doesNotMatch(source, /const aTs = a\.timestamp \|\| 0;/);
  });
});

test('Static contract: native tracking uses iOS background mode and user-initiated Android foreground service', () => {
  const source = readText('app.config.js');

  assert.match(source, /const isProductionBuild = \['production', 'testflight'\]\.includes\(process\.env\.EAS_BUILD_PROFILE\);/);
  assert.match(source, /NSAppTransportSecurity: appTransportSecurity/);
  assert.match(source, /NSAllowsArbitraryLoads: false/);
  assert.match(source, /NSLocationWhenInUseUsageDescription/);
  assert.match(source, /locationAlwaysAndWhenInUsePermission:/);
  assert.match(source, /locationAlwaysPermission: false/);
  assert.match(source, /isIosBackgroundLocationEnabled: true/);
  assert.match(source, /isAndroidForegroundServiceEnabled: true/);
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

  assert.match(pluginSource, /STORE_BUILD_PROFILES\.has\(process\.env\.EAS_BUILD_PROFILE\)/);
  assert.match(pluginSource, /delete pluginConfig\.modResults\.NSBonjourServices/);
  assert.match(pluginSource, /delete pluginConfig\.modResults\.NSLocalNetworkUsageDescription/);
  assert.match(pluginSource, /android\.permission\.SYSTEM_ALERT_WINDOW/);
  assert.match(pluginSource, /removeAndroidPermission\(pluginConfig\.modResults, SYSTEM_ALERT_WINDOW\)/);
});

test('Static contract: live map and safety sharing guard stale or malformed location state', () => {
  const mapSource = readMobileModuleSource('screens/MapScreen.js');
  const locationSource = readText('utils/driverLocation.js');
  assert.match(mapSource, /normalizeMapCoords/);
  assert.match(mapSource, /getDriverLocationPresentation/);
  assert.match(mapSource, /Location\.getForegroundPermissionsAsync/);
  assert.match(mapSource, /setDriverLocation\(null\)/);
  assert.match(mapSource, /disabled=\{!driverLocationPresentation\.actionable\}/);
  assert.match(mapSource, /let cancelled = false;/);
  assert.match(mapSource, /driverLocationPoint && userLocationPoint/);
  assert.match(mapSource, /const fitTimer = setTimeout/);
  assert.match(mapSource, /return \(\) => clearTimeout\(fitTimer\);/);
  assert.match(locationSource, /DRIVER_LOCATION_STALE_MS = 30 \* 60 \* 1000/);
  assert.match(locationSource, /freshness: 'invalid'/);
  assert.match(locationSource, /timestamp: \{ '\.sv': 'timestamp' \}/);

  const safetySource = readMobileModuleSource('screens/SafetySupportScreen.js');
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
    const source = readMobileModuleSource(relativePath);
    assert.match(source, /Linking\.openURL/);
    assert.match(source, /catch \(/);
    assert.match(source, /Alert\.alert/);
  });
});

test('Static contract: production binary EAS workflows gate release on mobile/backend verification', () => {
  const readinessDoc = readText('dependency-upgrade-prod-readiness.md');
  const agentsDoc = readText('AGENTS.md');
  const packageJson = JSON.parse(readText('package.json'));

  [
    ['.github/workflows/eas-build.yml', 'npm run test:mobile:ota'],
    ['.github/workflows/eas-testflight.yml', 'npm run test:mobile'],
  ].forEach(([relativePath, mobileTestCommand]) => {
    const source = readText(relativePath);
    const workflowLines = source.split(/\r?\n/).map((line) => line.trim());

    assert.match(source, /node-version:\s*'24\.22\.1'/);
    assert.match(source, /npm --prefix functions ci/);
    assert.match(source, /uses: \.\/\.github\/actions\/runner-java21/);
    const javaSelection = readText('.github/actions/runner-java21/action.yml');
    assert.match(javaSelection, /using: composite/);
    assert.match(javaSelection, /java\.specification\.version = 21/);
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

  [
    '.github/workflows/eas-build.yml',
    '.github/workflows/eas-testflight.yml',
    '.github/workflows/eas-update.yml',
  ].forEach((relativePath) => {
    const source = readText(relativePath);
    assert.match(source, /run:\s*npm run security:audit:release/);
    assert.match(source, /EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK:\s*'true'/);
    assert.match(source, /EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK:\s*'true'/);
    assert.doesNotMatch(
      source,
      /EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_(?:USE|REQUIRE)_APPCHECK:\s*\$\{\{\s*secrets\./,
      `${relativePath} must use the reviewed explicit App Check mode`,
    );
  });

  assert.equal(
    packageJson.scripts['test:mobile:ota'],
    'npm run test:mobile:auth && npm run test:mobile:services:booking',
  );
  assert.match(readinessDoc, /Deploy Firebase Functions and Firebase rules before any production EAS update\/build/);
  assert.match(readinessDoc, /deploy Functions first, then Realtime Database\/Storage rules, then publish the EAS update\/build/);
  assert.match(agentsDoc, /Production binary EAS workflows test backend changes but do not deploy Firebase backend artifacts/);
});

test('Static contract: reviewed dispatch plans an iOS OTA only for bundle-safe TestFlight changes', () => {
  const source = readText('.github/workflows/eas-update.yml');
  const easConfig = JSON.parse(readText('eas.json'));
  const packageJson = JSON.parse(readText('package.json'));

  assert.match(source, /github\.event_name == 'workflow_dispatch' && inputs\.prerequisites_verified == true/);
  assert.match(source, /inputs\.prerequisites_verified == true/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /plan-update:/);
  assert.match(source, /needs\.plan-update\.outputs\.should_publish/);
  assert.match(source, /EAS_BUILD_PROFILE:\s*testflight/);
  assert.match(source, /EXPO_PUBLIC_DRIVER_TOUR_PACK_TESTFLIGHT:\s*'false'/);
  assert.match(source, /npm run update:testflight -- --non-interactive/);
  assert.doesNotMatch(source, /eas update --channel production/);
  assert.doesNotMatch(source, /npm run test:emulators/);
  assert.doesNotMatch(source, /npm run test:functions:scripts/);
  assert.equal(easConfig.build?.testflight?.channel, 'testflight');
  assert.match(packageJson.scripts['update:testflight'], /runEasUpdate\.js --target=testflight/);
  assert.match(packageJson.scripts['update:prod'], /runEasUpdate\.js --target=production/);
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
  assert.equal(easConfig.cli?.version, '22.6.0');
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

  assert.match(readMobileModuleSource('screens/LoginScreen.js'), /useWindowDimensions/);
  assert.match(readMobileModuleSource('screens/PhotobookScreen.js'), /thumbnailTileStyle/);
  assert.match(readMobileModuleSource('screens/GroupPhotobookScreen.js'), /thumbnailTileStyle/);
  assert.match(readMobileModuleSource('screens/SafetySupportScreen.js'), /useWindowDimensions/);
  assert.match(readMobileModuleSource('screens/TourHomeScreen.js'), /quickActionWrapper/);
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
  const source = readMobileModuleSource('screens/ItineraryScreen.js');
  const bookingSource = readServiceModuleSource('services/bookingServiceRealtime.js');
  const functionsSource = readFunctionsArchitectureSource();

  assert.match(source, /mountedRef/);
  assert.match(source, /activeTourIdRef/);
  assert.match(source, /const canUpdateForTour = useCallback/);
  assert.match(source, /if \(canUpdateForTour\(targetTourId\)\) \{\s+setLastSyncedAt\(syncedAt\);/);
  assert.match(source, /if \(canUpdateForTour\(targetTourId\)\) \{\s+setCachedItinerary\(data\);/);
  assert.match(source, /setDataSource\(ITINERARY_DATA_SOURCE\.CACHE\)/);
  assert.match(source, /disabled=\{saving \|\| Boolean\(editConflict\)\}/);
  assert.match(source, /A newer itinerary is already live/);
  assert.match(bookingSource, /tours\/\$\{normalizedTourId\}\/itinerary/);
  assert.match(bookingSource, /throw error;/);
  assert.match(functionsSource, /const sendItineraryNotification = onValueWritten/);
  assert.match(functionsSource, /buildItineraryNotificationJob/);
  assert.match(functionsSource, /coalescingKey: `itinerary:\$\{tourId\}`/);
  assert.match(functionsSource, /enqueueNotificationJob/);
});

test('Static contract: preference and manifest screens guard stale async state', () => {
  const notificationSource = readMobileModuleSource('screens/NotificationPreferencesScreen.js');
  const manifestSource = readMobileModuleSource('screens/PassengerManifestScreen.js');
  const imageViewerSource = readMobileModuleSource('components/ImageViewer.js');

  assert.match(notificationSource, /mountedRef/);
  assert.match(notificationSource, /preferenceLoadSeqRef/);
  assert.match(notificationSource, /const canApplyRequest = \(\) => mountedRef\.current && requestSeq === preferenceLoadSeqRef\.current/);
  assert.doesNotMatch(notificationSource, /Test failed:/);

  assert.match(manifestSource, /mountedRef/);
  assert.match(manifestSource, /manifestLoadSeqRef/);
  assert.match(manifestSource, /subscribeQueuedActions/);
  assert.match(manifestSource, /summarizeManifestQueue\(actions, activeTourId\)/);
  const queuePresentation = readText('components/passenger-manifest/manifestQueuePresentation.js');
  assert.match(queuePresentation, /action\.type === 'MANIFEST_UPDATE' && normalizeTourId\(action\.tourId\) === tourId/);
  assert.match(manifestSource, /return \(\) => unsubscribe\?\.\(\)/);
  assert.match(manifestSource, /setManifestLoadError\(\['ROSTER_UPDATING', 'SOURCE_ROSTER_INVALID', 'TOUR_INACTIVE'\]\.includes\(error\?\.code\)[\s\S]*?error\.message : 'Could not load the passenger manifest/);
  assert.match(manifestSource, /manifestLoadError[\s\S]*onPress=\{\(\) => loadManifest\(\)\}/);
  assert.doesNotMatch(manifestSource, /Failed to load manifest: ' \+ error\.message/);

  assert.match(imageViewerSource, /scrollRetryTimeoutRef/);
  assert.match(imageViewerSource, /clearTimeout\(scrollRetryTimeoutRef\.current\)/);
  assert.match(imageViewerSource, /if \(!visibleRef\.current\) return/);
});

test('Static contract: boarding phone actions use the active scoped Tour Pack contact', () => {
  const appSource = readAppArchitectureSource();
  const manifestSource = readMobileModuleSource('screens/PassengerManifestScreen.js');
  const phoneSource = readText('utils/bookingLeadPhone.js');

  assert.match(appSource, /driverTourPack=\{context\.driverTourPackState\?\.pack \|\| null\}/);
  assert.match(manifestSource, /buildBookingLeadPhoneIndex\(driverTourPack, tourId\)/);
  assert.match(manifestSource, /Phone booking/);
  assert.match(manifestSource, /Linking\.openURL\(telephoneUrl\)/);
  assert.match(phoneSource, /packTourId !== requestedTourId/);
  assert.doesNotMatch(manifestSource, /logger\.(?:info|warn)[^;]*selectedBookingPhone/s);
});

test('Static contract: customer pickup readiness uses only the booking-safe projection', () => {
  const appSource = readAppArchitectureSource();
  const homeSource = readMobileModuleSource('screens/TourHomeScreen.js');
  const mapSource = readMobileModuleSource('screens/MapScreen.js');
  const mapWebSource = readMobileModuleSource('screens/MapScreen.web.js');
  const boundarySource = readText('services/passengerDataBoundary.js');

  assert.match(appSource, /routerProps=\{\{[\s\S]*bookingData,/);
  assert.match(homeSource, /formatPickupDate\(pickup\.date \|\| bookingData\.pickupDate\)/);
  assert.match(mapSource, /resolvePrimaryPickup\(bookingData\)/);
  assert.match(mapSource, /Directions to your pickup/);
  assert.match(mapWebSource, /Directions to your pickup/);
  assert.doesNotMatch(boundarySource, /serviceContracts|driver_itinerary|internalNotes/);
  assert.doesNotMatch(mapSource, /bookingData\?\.services|bookingData\.services|tourData\?\.services|tourData\.services/);
  assert.doesNotMatch(homeSource, /bookingData\?\.services|bookingData\.services|tourData\?\.services|tourData\.services/);
});

test('Static contract: safety support cleans up emergency timers and validates phone handoffs', () => {
  const source = readMobileModuleSource('screens/SafetySupportScreen.js');

  assert.match(source, /const MIN_DIALABLE_DIGITS = 7/);
  assert.match(source, /const hasDialableDigits = \(phone\) =>/);
  assert.match(source, /clearInterval\(sosTimerRef\.current\)/);
  assert.match(source, /locationWatchRef\.current\.remove\(\)/);
  assert.match(source, /historyRequestSeqRef/);
  assert.match(source, /Text \$\{primaryContact\.name\}/);
  assert.match(source, /sosCoordsRef/);
  assert.match(source, /network must never delay access to the phone dialler/);
  assert.doesNotMatch(source, /Notify Emergency Contacts\?/);
  assert.match(source, /!sanitized \|\| !hasDialableDigits\(sanitized\)/);
  assert.match(source, /!hasDialableDigits\(newContactPhone\)/);
  assert.match(source, /Live location toggle blocked without identity context/);
  assert.match(source, /const shareStarted = await updateLiveLocationSharing/);
  assert.match(source, /if \(!shareStarted\) \{/);
  assert.match(source, /const shareStopped = await updateLiveLocationSharing/);
  assert.match(source, /onAccessibleActivate={confirmAccessibleSOS}/);
  assert.match(source, /Start SOS countdown\?/);
  assert.match(source, /hasDialableDigits\(trustedContacts\[0\]\?\.phone\)/);
  assert.match(source, /activeLiveLocationScopeRef/);
  assert.match(source, /Operations safety alert sent\./);
  assert.match(source, /The operations alert was not saved\./);
  assert.match(source, /SAFETY_STATUS_META/);
});

test('Static contract: passenger login establishes participant access before entering the app', () => {
  const appSource = readAppArchitectureSource();
  const loginSource = readMobileModuleSource('screens/LoginScreen.js');

  assert.match(appSource, /const authUser = stateUser \|\| authCurrentUser/);
  assert.match(appSource, /const authUid = authUser \? authUser\.uid : null/);
  assert.match(appSource, /if \(loginOptions\.offlineMode \|\| !tour\.id\) return/);
  assert.match(appSource, /await joinTour\(tour\.id, authUid, undefined,/);
  assert.match(appSource, /loginDiagnostics: diagnosticsContext/);
  assert.match(appSource, /joinFailure\.userMessage = 'We could not finish joining your tour session\. Please check your connection and try again\.'/);
  assert.match(appSource, /profileError\.criticalIdentityPersistence = true/);
  assert.match(appSource, /profileError\.userMessage = 'We could not finish securing your tour session\. Please check your connection and try again\.'/);
  assert.match(appSource, /if \(error\.criticalIdentityPersistence\) throw error/);
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

test('Static contract: offline data stays scoped to the signed-in tour identity', () => {
  const appSource = readAppArchitectureSource();
  const offlineSource = readServiceModuleSource('services/offlineSyncService.js');
  const safetySource = readServiceModuleSource('services/safetyService.js');
  const driverItinerarySource = readMobileModuleSource('screens/DriverItineraryScreen.js');

  assert.match(appSource, /cacheOwnerId: bookingData\?\.id \|\| principalId/);
  assert.match(appSource, /setActiveSessionScope\(offlineSessionScope\)/);
  assert.match(appSource, /setActiveSessionScope\(null\)/);
  assert.match(offlineSource, /tour_pack_v2_/);
  assert.match(offlineSource, /actionMatchesScope\(action, scope\)/);
  assert.match(offlineSource, /withQueueMutationLock/);
  assert.match(safetySource, /filterSafetyQueueForScope/);
  assert.match(safetySource, /TRUSTED_CONTACTS_KEY_PREFIX = '@LLT:trustedContacts:v2:'/);
  assert.match(driverItinerarySource, /Unscoped legacy cache removed without reuse/);
  assert.match(driverItinerarySource, /subscribeToDriverItinerary\(\{/);
  assert.match(driverItinerarySource, /\.on\('value', onValue, onError\)/);
  assert.match(driverItinerarySource, /\.off\('value', onValue\)/);
  assert.doesNotMatch(driverItinerarySource, /const migrated = JSON\.parse\(legacyCached\)/);
});

test('Static contract: mobile icon imports do not bundle unused font families', () => {
  for (const directory of ['screens', 'components']) {
    const filenames = fs.readdirSync(path.join(__dirname, '..', directory))
      .filter((filename) => /\.js$/.test(filename));
    filenames.forEach((filename) => {
      const relativePath = `${directory}/${filename}`;
      const source = readText(relativePath);
      assert.doesNotMatch(source, /from ['"]@expo\/vector-icons['"]/, `${relativePath} uses the all-font icon barrel`);
      if (source.includes('MaterialCommunityIcons')) {
        assert.match(
          source,
          /from ['"]@expo\/vector-icons\/build\/MaterialCommunityIcons\.js['"]/,
          `${relativePath} must import the single font module`,
        );
      }
    });
  }
});

test('Static contract: driver tracking is explicit, app-owned, globally registered and fenced', () => {
  const home = readText('components/driver-home/DriverHomeController.js');
  const runtime = readText('services/driver-tracking/driverTrackingRuntime.js');
  const controller = readText('services/driver-tracking/createDriverTrackingController.js');
  assert.doesNotMatch(home, /useDriverAutoSharePreference|createDriverLocationSharingActions/);
  assert.match(home, /driverTracking/);
  assert.match(readText('index.js'), /registerDriverTrackingTask/);
  assert.match(runtime, /TaskManager.defineTask/);
  assert.match(runtime, /killServiceOnDestroy: true/);
  assert.match(readText('src/app/AppShell.js'), /useDriverTracking\(offlineSessionScope/);
  assert.match(controller, /disclosureAccepted/);
  assert.match(controller, /deliveryGeneration/);
  assert.match(controller, /retireSession/);
});

test('Static contract: optional haptics cannot reject app actions and pickup countdown avoids second-by-second churn', () => {
  const hapticsSource = readText('services/hapticsService.js');
  const tourHomeSource = readMobileModuleSource('screens/TourHomeScreen.js');
  assert.match(hapticsSource, /Haptics are optional feedback and must never reject a user action/);
  assert.match(hapticsSource, /return await fallback\(\)/);
  assert.match(tourHomeSource, /PICKUP_COUNTDOWN_REFRESH_MS = 30 \* 1000/);
  assert.doesNotMatch(tourHomeSource, /setInterval\([\s\S]*?}, 1000\)/);
});

test('Static contract: safety delivery is operations-visible and Firebase maintenance is request-driven', () => {
  const safetySource = readServiceModuleSource('services/safetyService.js');
  const functionsSource = readFunctionsArchitectureSource();
  const webDebugSource = readText('web-admin/src/services/firebaseDebug.js');

  assert.match(safetySource, /writeSafetyEventAtomically/);
  assert.match(safetySource, /cloudfunctions\.net\/submitSafetyReport/);
  assert.match(safetySource, /Authorization: `Bearer \$\{token\}`/);
  assert.match(functionsSource, /const submitSafetyReport = onRequestWithResult/);
  assert.match(functionsSource, /submitSafetyReport: safety\.submitSafetyReport/);
  assert.match(functionsSource, /buildSafetySubmissionUpdates/);
  assert.match(functionsSource, /const sendSafetyAlertNotification = onValueCreated/);
  assert.match(functionsSource, /sendSafetyAlertNotification: safetyNotifications\.sendSafetyAlertNotification/);
  assert.match(functionsSource, /checkSafetySubmissionRateLimit/);
  assert.match(functionsSource, /SAFETY_RATE_LIMIT_ROOT/);
  assert.match(safetySource, /SAFETY_RETRY_DISPOSITION/);
  assert.match(safetySource, /getOfflineQueueSummary/);
  assert.match(safetySource, /Keep the disconnect cleanup armed until the server confirms deletion/);
  assert.match(readAppArchitectureSource(), /processOfflineSafetyQueue\(offlineSessionScope\)/);
  assert.doesNotMatch(safetySource, /Promise\.allSettled\(auxiliaryWrites\)/);
  assert.match(functionsSource, /runLazyRateLimitMaintenance\(now\)/);
  assert.doesNotMatch(functionsSource, /const maintenanceInterval = setInterval/);
  assert.match(webDebugSource, /if \(explicitSetting === 'true'\) return true/);
  assert.doesNotMatch(webDebugSource, /VITE_FIREBASE_DEBUG_LOGS !== 'false'/);
});

test('Static contract: web-admin release shell is non-cacheable, hardened, and large selectors are bounded', () => {
  const firebaseConfig = JSON.parse(readText('firebase.json'));
  const headers = firebaseConfig.hosting?.headers || [];
  const defaultHeaders = Object.fromEntries(
    (headers.find((entry) => entry.source === '**')?.headers || [])
      .map(({ key, value }) => [key, value]),
  );
  const assetHeaders = Object.fromEntries(
    (headers.find((entry) => entry.source === '/assets/**')?.headers || [])
      .map(({ key, value }) => [key, value]),
  );
  assert.equal(defaultHeaders['Cache-Control'], 'no-cache, no-store, must-revalidate');
  assert.equal(assetHeaders['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.match(defaultHeaders['Content-Security-Policy'], /default-src 'self'/);
  assert.match(defaultHeaders['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(
    defaultHeaders['Content-Security-Policy'],
    /script-src-elem 'self'[^;]*https:\/\/\*\.firebasedatabase\.app/,
  );
  assert.match(
    defaultHeaders['Content-Security-Policy'],
    /frame-src[^;]*https:\/\/loch-lomond-travel\.firebaseapp\.com https:\/\/\*\.firebasedatabase\.app/,
  );
  assert.doesNotMatch(defaultHeaders['Content-Security-Policy'], /script-src[^;]*'unsafe-(?:inline|eval)'/);
  assert.doesNotMatch(defaultHeaders['Content-Security-Policy'], /script-src-elem[^;]*(?:https?:\/\/)?\*(?:[\s;]|$)/);
  assert.equal(defaultHeaders['Permissions-Policy'], 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');

  const broadcastSource = readText('web-admin/src/components/BroadcastPanel.jsx');
  const passengerModalSource = readText('web-admin/src/components/AddPassengerModal.jsx');
  assert.match(broadcastSource, /label="Target Tour"[\s\S]*?searchable[\s\S]*?limit=\{50\}/);
  assert.match(passengerModalSource, /placeholder="Select the passenger's tour"[\s\S]*?searchable[\s\S]*?limit=\{50\}/);
});
