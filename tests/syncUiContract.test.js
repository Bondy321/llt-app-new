const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('key surfaces use offlineSyncService.formatSyncOutcome instead of hard-coded sync outcome strings', () => {
  const appJs = read('App.js');
  const tourHome = read('screens/TourHomeScreen.js');
  const chatScreen = read('screens/ChatScreen.js');
  const driverHome = read('screens/DriverHomeScreen.js');

  assert.match(appJs, /offlineSyncService\.formatSyncOutcome\(/);
  assert.match(tourHome, /offlineSyncService\.formatSyncOutcome\(/);
  assert.match(chatScreen, /offlineSyncService\.formatSyncOutcome\(/);
  assert.match(driverHome, /offlineSyncService\.formatSyncOutcome\(/);
});

test('key surfaces use formatLastSyncRelative and state.showLastSync visibility contract', () => {
  const appJs = read('App.js');
  const syncBanner = read('components/SyncStatusBanner.js');

  assert.match(appJs, /offlineSyncService\.formatLastSyncRelative\(/);
  assert.match(appJs, /unifiedSyncStatus\?\.showLastSync/);

  assert.match(syncBanner, /state\.showLastSync/);
  assert.match(syncBanner, /offlineSyncService\.formatLastSyncRelative\(/);
  assert.match(syncBanner, /Last successful sync/);
});
