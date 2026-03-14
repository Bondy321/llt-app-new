const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('key surfaces use offlineSyncService.formatSyncOutcome instead of hard-coded sync outcome strings', () => {
  const tourHome = read('screens/TourHomeScreen.js');
  const chatScreen = read('screens/ChatScreen.js');
  const driverHome = read('screens/DriverHomeScreen.js');

  assert.match(tourHome, /offlineSyncService\.formatSyncOutcome\(/);
  assert.match(chatScreen, /offlineSyncService\.formatSyncOutcome\(/);
  assert.match(driverHome, /offlineSyncService\.formatSyncOutcome\(/);
});

test('sync status banner component keeps formatLastSyncRelative and state.showLastSync visibility contract', () => {
  const appJs = read('App.js');
  const syncBanner = read('components/SyncStatusBanner.js');

  assert.doesNotMatch(appJs, /UnifiedSyncBanner/);
  assert.doesNotMatch(appJs, /syncBanner/);

  assert.match(syncBanner, /state\.showLastSync/);
  assert.match(syncBanner, /offlineSyncService\.formatLastSyncRelative\(/);
  assert.match(syncBanner, /Last successful sync/);
});


test('chat replay injects photoService so PHOTO_UPLOAD queue actions can replay', () => {
  const chatScreen = read('screens/ChatScreen.js');

  assert.match(chatScreen, /replayQueue\(\{ services: \{ bookingService, chatService, photoService \} \}\)/);
});
