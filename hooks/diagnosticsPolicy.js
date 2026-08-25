const FIREBASE_PROBE_PATH = '.info/serverTimeOffset';
const PROBE_WINDOWS_MS = Object.freeze({
  appForeground: 5000,
  networkReconnect: 8000,
});
const SYNC_META_REFRESH_WINDOW_MS = 5000;

module.exports = {
  FIREBASE_PROBE_PATH,
  PROBE_WINDOWS_MS,
  SYNC_META_REFRESH_WINDOW_MS,
};
