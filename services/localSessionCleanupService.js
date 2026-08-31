const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const offlineSyncService = require('./offlineSyncService');
const driverOperationalLifecycleService = require('./driverOperationalLifecycleService');
const { clearNotificationFeedCache } = require('./notificationInboxService');

const APP_LOCAL_KEYS = [
  '@LLT:tourData',
  '@LLT:bookingData',
  '@LLT:lastScreen',
  '@LLT:identityBinding',
  '@LLT:notificationOnboarding',
  '@LLT:appSession:v1',
  '@LLT:pendingSessionEnd:v1',
  '@LLT:safetyOfflineQueue',
  '@LLT:safetyOfflineQueue:corruptBackup',
  '@LLT:trustedContacts',
  'LLT_LOGS_app_logs',
];

const safeStorageSegment = (value) => (
  typeof value === 'string' && value.trim() ? value.trim().replace(/[^A-Za-z0-9_-]/gu, '_') : null
);

const notificationLifecycleKeys = ({ authUid, sessionId }) => {
  const keys = [
    '@LLT:handled-notification-responses:v1',
    '@LLT:pending-notification-response:v1',
  ];
  const safeUid = safeStorageSegment(authUid);
  const safeSession = safeStorageSegment(sessionId);
  if (safeUid) keys.push(`@LLT:notification-registration-revision:v1:${safeUid}`);
  if (safeUid) keys.push(`@LLT:notification-registration-retry:v2:${safeUid}:${safeSession || 'marketing'}`);
  return keys;
};

const loadPhotoCacheService = () => {
  try { return require('./photoViewerCacheService'); } catch { return null; }
};

const createLocalSessionCleanupService = ({
  storage = AsyncStorage,
  offline = offlineSyncService,
  driverLifecycle = driverOperationalLifecycleService,
  clearNotifications = clearNotificationFeedCache,
  photoCache = loadPhotoCacheService(),
  beforeSessionKeyCommit = null,
} = {}) => {
  let cleanupInFlight = null;
  let scopedCleanupInFlight = null;
  let sessionKeyCommitInFlight = null;

  const prepareScopedCleanup = async ({
    authUid,
    appSession,
    bookingData,
    tourData,
    driverOperationalScope = null,
    requireCompleteScope = false,
  } = {}) => {
    if (scopedCleanupInFlight) return scopedCleanupInFlight;
    scopedCleanupInFlight = (async () => {
      const role = appSession?.principalType || (bookingData?.isDriver ? 'driver' : 'passenger');
      const tourId = appSession?.tourId || tourData?.id || null;
      const principalId = appSession?.principalId || null;
      const ownerId = role === 'driver'
        ? appSession?.driverId || bookingData?.id || null
        : bookingData?.id || null;
      const resolvedDriverOperationalScope = role === 'driver' && tourId
        ? {
            authUid,
            driverId: appSession?.driverId || bookingData?.id || null,
            departureKey: bookingData?.assignedDepartureKey
              || (!requireCompleteScope ? driverOperationalScope?.departureKey : null)
              || null,
            tourId,
            startDate: tourData?.startDate
              || (!requireCompleteScope ? driverOperationalScope?.startDate : null)
              || null,
          }
        : null;
      const normalizedDriverScope = resolvedDriverOperationalScope
        ? driverLifecycle.normalizeScope?.(resolvedDriverOperationalScope)
        : null;
      const driverScopeValid = !resolvedDriverOperationalScope
        || (normalizedDriverScope ? normalizedDriverScope.ok === true && Boolean(normalizedDriverScope.packScope) : Boolean(
          resolvedDriverOperationalScope.driverId
          && resolvedDriverOperationalScope.tourId
          && (resolvedDriverOperationalScope.departureKey || resolvedDriverOperationalScope.startDate),
        ));
      const projectedTourId = tourData?.id || bookingData?.assignedTourId || null;
      const storedProjectionMatches = role === 'passenger'
        ? bookingData?.stablePassengerId === principalId
          && appSession?.tourId === projectedTourId
        : appSession?.driverId === ownerId
          && principalId === `driver:${ownerId}`
          && appSession?.tourId === projectedTourId;
      const completeScope = Boolean(
        typeof authUid === 'string' && authUid.trim()
        && appSession?.sessionId
        && (role === 'passenger' || role === 'driver')
        && principalId
        && storedProjectionMatches
        && (role === 'passenger'
          ? tourId && ownerId
          : ownerId && driverScopeValid),
      );
      if (requireCompleteScope && !completeScope) {
        return {
          success: false,
          role,
          tourId,
          attempted: [],
          failures: [{ name: 'validateCleanupScope', error: 'LOCAL_CLEANUP_SCOPE_INCOMPLETE' }],
          results: {
            validateCleanupScope: { success: false, error: 'LOCAL_CLEANUP_SCOPE_INCOMPLETE' },
          },
        };
      }
      const operations = {
        stopOfflineReplay: () => offline.setActiveSessionScope(null),
        clearNotificationLifecycle: () => storage.multiRemove(notificationLifecycleKeys({
          authUid,
          sessionId: appSession?.sessionId || null,
        })),
        clearNotificationCache: () => authUid ? clearNotifications({ userId: authUid }) : Promise.resolve(0),
        clearPhotoCache: () => photoCache?.clearPhotoViewerCache?.() || Promise.resolve({ success: true }),
      };

      if (role === 'driver' && resolvedDriverOperationalScope) {
        operations.clearDriverOperationalData = () => driverLifecycle.purge(resolvedDriverOperationalScope);
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
    try { return await scopedCleanupInFlight; } finally { scopedCleanupInFlight = null; }
  };

  const commitSessionKeys = async () => {
    if (sessionKeyCommitInFlight) return sessionKeyCommitInFlight;
    sessionKeyCommitInFlight = (async () => {
      try {
        if (beforeSessionKeyCommit) await beforeSessionKeyCommit();
        const value = await storage.multiRemove(APP_LOCAL_KEYS);
        return {
          success: true,
          attempted: ['clearSessionKeys'],
          failures: [],
          results: { clearSessionKeys: { success: true, value } },
        };
      } catch (error) {
        const failure = { name: 'clearSessionKeys', error: error?.message || String(error) };
        return {
          success: false,
          attempted: ['clearSessionKeys'],
          failures: [failure],
          results: { clearSessionKeys: { success: false, error: failure.error } },
        };
      }
    })();
    try { return await sessionKeyCommitInFlight; } finally { sessionKeyCommitInFlight = null; }
  };

  const cleanup = async (scope = {}) => {
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = (async () => {
      const prepared = await prepareScopedCleanup(scope);
      if (!prepared.success) return prepared;
      const commit = await commitSessionKeys();
      return {
        success: commit.success,
        role: prepared.role,
        tourId: prepared.tourId,
        attempted: [...prepared.attempted, ...commit.attempted],
        failures: [...prepared.failures, ...commit.failures],
        results: { ...prepared.results, ...commit.results },
      };
    })();
    try { return await cleanupInFlight; } finally { cleanupInFlight = null; }
  };

  return { cleanup, commitSessionKeys, prepareScopedCleanup };
};

const localSessionCleanupService = createLocalSessionCleanupService();

module.exports = {
  APP_LOCAL_KEYS,
  createLocalSessionCleanupService,
  ...localSessionCleanupService,
};
