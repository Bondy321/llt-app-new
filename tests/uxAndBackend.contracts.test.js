const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('GroupPhotobookScreen keeps virtualized SectionList with throttled prefetch guard', () => {
  const src = read('screens/GroupPhotobookScreen.js');
  assert.match(src, /SectionList/);
  assert.match(src, /prefetchedUrisRef = useRef\(new Set\(\)\)/);
  assert.match(src, /if \(!previewUrl \|\| prefetchedUrisRef\.current\.has\(previewUrl\)\) return;/);
  assert.match(src, /initialNumToRender=\{9\}/);
});

test('PhotobookScreen keeps SectionList virtualization and stable viewer indexing by id', () => {
  const src = read('screens/PhotobookScreen.js');
  assert.match(src, /SectionList/);
  assert.match(src, /photoIndexById/);
  assert.match(src, /const openViewer = useCallback\(\(photoId\)/);
  assert.match(src, /setTimeout\(\(\) => \{/);
  assert.match(src, /\}, 5000\);/);
  assert.match(src, /initialNumToRender=\{12\}/);
});

test('ChatScreen keeps mixed-row timeline contract and unread-jump path', () => {
  const src = read('screens/ChatScreen.js');
  assert.match(src, /type: 'date'/);
  assert.match(src, /type: 'unread-separator'/);
  assert.match(src, /scrollToIndex\(\{ index: unreadAnchorIndex/);
  assert.match(src, /FlatList/);
  assert.match(src, /keyExtractor = useCallback/);
});

test('Cloud function notification path keeps chunked send and targeted profile fetch behavior', () => {
  const src = read('functions/index.js');
  assert.match(src, /fetchUsersSnapshot/);
  assert.match(src, /USER_PROFILE_CACHE_TTL_MS/);
  assert.match(src, /cacheMissCount/);
  assert.match(src, /requestedUserCount/);
  assert.match(src, /ref\(`users\/\$\{userId\}`\)\.once\('value'\)/);
  assert.match(src, /chunkArrayDeterministically/);
  assert.match(src, /expo\.chunkPushNotifications/);
  assert.match(src, /invalidTokens/);
  assert.match(src, /collectExpoTokenFailures/);
  assert.match(src, /DeviceNotRegistered/);
  assert.match(src, /pushTokenStatus: 'INVALID'/);
});

test('useDiagnostics keeps probe throttling windows and duplicate-outcome log guard', () => {
  const src = read('hooks/useDiagnostics.js');
  assert.match(src, /PROBE_WINDOWS_MS/);
  assert.match(src, /appForeground: 5000/);
  assert.match(src, /networkReconnect: 8000/);
  assert.match(src, /duplicateFailure/);
  assert.match(src, /statusRef\.current\.firebaseConnected === connected/);
});

test('ImageViewer keeps thumbnail-first progressive load and load-id race guard', () => {
  const src = read('components/ImageViewer.js');
  assert.match(src, /imageLoadIdRef/);
  assert.match(src, /if \(loadId !== imageLoadIdRef\.current\) return;/);
  assert.match(src, /hasThumbnail &&/);
  assert.match(src, /Animated\.Image/);
});

test('Logger service keeps batching/backoff and sensitive-data redaction', () => {
  const src = read('services/loggerService.js');
  assert.match(src, /baseRetryDelayMs = 400/);
  assert.match(src, /maxRetryAttempts = 4/);
  assert.match(src, /updateBatchWithRetry/);
  assert.match(src, /redactSensitiveData/);
  assert.match(src, /routeUserId/);
});


test('Realtime Database rules allow authenticated users to write only their own reaction leaf under chat messages', () => {
  const rules = JSON.parse(read('database.rules.json'));
  const reactionRules = rules.rules.chats.$tourId.messages.$messageId.reactions;

  assert.ok(reactionRules);
  assert.equal(reactionRules.$emoji['.write'], 'auth != null');
  assert.equal(reactionRules.$emoji.$userId['.write'], 'auth != null && auth.uid === $userId');
  assert.equal(reactionRules.$emoji.$userId['.validate'], '!newData.exists() || newData.val() === true');
});


test('Realtime Database rules support image chat payloads and private photo owner self-heal bootstrap', () => {
  const rules = JSON.parse(read('database.rules.json'));
  const messageValidate = rules.rules.chats.$tourId.messages.$messageId['.validate'];
  const privatePhotosRead = rules.rules.private_tour_photos.$tourId.$ownerId['.read'];
  const photobookScreen = read('screens/PhotobookScreen.js');

  assert.match(messageValidate, /newData\.child\('type'\)\.val\(\) === 'image'/);
  assert.match(messageValidate, /newData\.child\('thumbnailUrl'\)/);
  assert.match(privatePhotosRead, /auth\.uid === \$ownerId/);
  assert.match(privatePhotosRead, /stablePassengerId/);
  assert.match(photobookScreen, /ensurePrivatePhotoOwnerAccess/);
  assert.match(photobookScreen, /realtimeDb\.ref\(`users\/\$\{authUid\}`\)\.update/);
  assert.match(photobookScreen, /stablePassengerId: principalId/);
});

test('Realtime Database rules gate identity_bindings_meta writes to admin or an existing caller-owned binding', () => {
  const rules = JSON.parse(read('database.rules.json'));
  const writeRule = rules.rules.identity_bindings_meta.$stablePassengerId['.write'];

  assert.equal(
    writeRule,
    "auth != null && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('identity_bindings/' + $stablePassengerId + '/' + auth.uid).val() === true)",
  );

  // Proof contract:
  // - User A writing metadata for User B's stable ID is denied because binding lookup checks
  //   identity_bindings/<targetStableId>/<auth.uid>, which is false/absent for User A.
  // - User A writing own stable ID metadata is allowed once identity_bindings/<ownStableId>/<auth.uid> is true.
  assert.match(writeRule, /root\.child\('identity_bindings\/' \+ \$stablePassengerId \+ '\/' \+ auth\.uid\)\.val\(\) === true/);
});

test('Passenger login flow still performs identity binding + metadata multi-path update in App.js', () => {
  const appSrc = read('App.js');

  assert.match(appSrc, /updates\[`identity_bindings\/\$\{stablePassengerId\}\/\$\{user\.uid\}`\] = true;/);
  assert.match(appSrc, /`users\/\$\{user\.uid\}\/privatePhotoOwnerId`\]: stablePassengerId \|\| normalizedBookingData\.id,/);
  assert.match(appSrc, /updates\[`identity_bindings_meta\/\$\{stablePassengerId\}\/bookingRef`\] = normalizedBookingData\.id;/);
  assert.match(appSrc, /updates\[`identity_bindings_meta\/\$\{stablePassengerId\}\/normalizedPassengerEmail`\] = normalizedBookingData\.normalizedPassengerEmail;/);
  assert.match(appSrc, /updates\[`identity_bindings_meta\/\$\{stablePassengerId\}\/identityVersion`\] = identityVersion \|\| IDENTITY_VERSION;/);
  assert.match(appSrc, /updates\[`identity_bindings_meta\/\$\{stablePassengerId\}\/lastSeenAt`\] = now;/);
  assert.match(appSrc, /await realtimeDb\.ref\(\)\.update\(updates\);/);
});
