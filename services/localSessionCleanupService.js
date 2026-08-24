const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const offlineSyncService = require('./offlineSyncService');
const driverOperationalLifecycleService = require('./driverOperationalLifecycleService');
const { clearNotificationFeedCache } = require('./notificationInboxService');

const APP_LOCAL_KEYS = [
  '@LLT:tourData',
  '@LLT:bookingData',
  '@LLT:lastScreen',
  '@LLT:identityBinding',
  '@LLT:appSession:v1',
  '@LLT:safetyOfflineQueue',
  '@LLT:safetyOfflineQueue:corruptBackup',
  '@LLT:trustedContacts',
  'LLT_LOGS_app_logs',
];

const loadPhotoCacheService = () => {
  try { return require('./photoViewerCacheService'); } catch { return null; }
};

const createLocalSessionCleanupService = ({
  storage = AsyncStorage,
  offline = offlineSyncService,
  driverLifecycle = driverOperationalLifecycleService,
  clearNotifications = clearNotificationFeedCache,
  photoCache = loadPhotoCacheService(),
} = {}) => {
  let cleanupInFlight = null;

  const cleanup = async ({
    authUid,
    appSession,
    bookingData,
    tourData,
    driverOperationalScope = null,
  } = {}) => {
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = (async () => {
      const role = appSession?.principalType || (bookingData?.isDriver ? 'driver' : 'passenger');
      const tourId = appSession?.tourId || tourData?.id || null;
      const principalId = appSession?.principalId || null;
      const ownerId = bookingData?.id || null;
      const operations = {
        stopOfflineReplay: () => offline.setActiveSessionScope(null),
        clearSessionKeys: () => storage.multiRemove(APP_LOCAL_KEYS),
        clearNotificationCache: () => authUid ? clearNotifications({ userId: authUid }) : Promise.resolve(0),
        clearPhotoCache: () => photoCache?.clearPhotoViewerCache?.() || Promise.resolve({ success: true }),
      };

      if (role === 'driver' && driverOperationalScope) {
        operations.clearDriverOperationalData = () => driverLifecycle.purge(driverOperationalScope);
      } else if (tourId && ownerId) {
        operations.clearTourPack = () => offline.purgeTourPack(tourId, role, { ownerId });
      }
      if (tourId && principalId) {
        operations.clearQueuedActions = () => offline.purgeActionsForScope({
          scope: { tourId, principalId, role, authUid, cacheOwnerId: ownerId },
        });
      }
      if (principalId) {
        operations.clearTrustedContacts = () => storage.removeItem(
          `@LLT:trustedContacts:v2:${encodeURIComponent(principalId)}`,
        );
      }

      const results = {};
      for (const [name, operation] of Object.entries(operations)) {
        try {
          const value = await operation();
          const failed = value?.success === false;
          results[name] = failed
            ? { success: false, error: value.error || 'Cleanup operation failed' }
            : { success: true, value };
        } catch (error) {
          results[name] = { success: false, error: error?.message || String(error) };
        }
      }
      const failures = Object.entries(results)
        .filter(([, result]) => result.success === false)
        .map(([name, result]) => ({ name, error: result.error }));
      return {
        success: failures.length === 0,
        role,
        tourId,
        attempted: Object.keys(results),
        failures,
        results,
      };
    })();
    try { return await cleanupInFlight; } finally { cleanupInFlight = null; }
  };

  return { cleanup };
};

const localSessionCleanupService = createLocalSessionCleanupService();

module.exports = {
  APP_LOCAL_KEYS,
  createLocalSessionCleanupService,
  ...localSessionCleanupService,
};
