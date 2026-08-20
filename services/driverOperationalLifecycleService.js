const driverTourPackService = require('./driverTourPackService');
const driverManifestCacheService = require('./driverManifestCacheService');
const offlineSyncService = require('./offlineSyncService');
const { normalizeTourId } = require('./tourIdentityService');

const normalizeDriverId = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^D-[A-Z0-9_-]+$/.test(normalized) ? normalized : null;
};

const normalizeDriverOperationalScope = ({
  authUid,
  driverId,
  departureKey,
  tourId,
  startDate,
} = {}) => {
  const normalizedDriverId = normalizeDriverId(driverId);
  const normalizedTourId = normalizeTourId(tourId);
  if (!normalizedDriverId || !normalizedTourId) {
    return { ok: false, reason: 'DRIVER_OPERATIONAL_SCOPE_INVALID' };
  }

  const packScope = driverTourPackService.normalizeScope({
    authUid,
    driverId: normalizedDriverId,
    departureKey,
    tourId: normalizedTourId,
    startDate,
  });

  return {
    ok: true,
    driverId: normalizedDriverId,
    tourId: normalizedTourId,
    authUid: typeof authUid === 'string' && authUid.trim() ? authUid.trim() : null,
    departureKey: packScope.ok ? packScope.departureKey : null,
    packScope: packScope.ok ? packScope : null,
    queueScope: {
      tourId: normalizedTourId,
      principalId: `driver:${normalizedDriverId}`,
      role: 'driver',
      authUid: typeof authUid === 'string' && authUid.trim() ? authUid.trim() : null,
      cacheOwnerId: normalizedDriverId,
    },
  };
};

function createDriverOperationalLifecycleService({
  driverPacks = driverTourPackService,
  manifests = driverManifestCacheService,
  offline = offlineSyncService,
} = {}) {
  const purge = async (scopeInput, { purgeQueuedActions = true } = {}) => {
    const scope = normalizeDriverOperationalScope(scopeInput);
    if (!scope.ok) {
      return { success: false, error: scope.reason, results: {} };
    }

    // Stop replay before removing local operational data. setActiveSessionScope
    // increments the replay generation so an in-flight action cannot continue
    // into a revoked or reassigned tour.
    const operations = {
      session: () => offline.setActiveSessionScope(null),
      manifest: () => manifests.purge({ tourId: scope.tourId, driverId: scope.driverId }),
      legacyTourPack: () => offline.purgeTourPack(scope.tourId, 'driver', { ownerId: scope.driverId }),
      ...(scope.packScope ? { driverTourPack: () => driverPacks.purge(scope.packScope) } : {}),
      ...(purgeQueuedActions ? { queuedActions: () => offline.purgeActionsForScope({ scope: scope.queueScope }) } : {}),
    };

    const settled = await Promise.all(Object.entries(operations).map(async ([name, operation]) => {
      try {
        const result = await operation();
        return [name, result];
      } catch (error) {
        return [name, { success: false, error: error?.message || String(error) }];
      }
    }));
    const results = Object.fromEntries(settled);
    const failures = Object.entries(results)
      .filter(([, result]) => result?.success === false)
      .map(([name, result]) => ({ name, error: result.error || 'Purge failed' }));

    return {
      success: failures.length === 0,
      data: {
        tourId: scope.tourId,
        departureKey: scope.departureKey,
        purged: Object.keys(results),
      },
      error: failures.length ? 'One or more operational caches could not be purged.' : null,
      failures,
      results,
    };
  };

  return { normalizeScope: normalizeDriverOperationalScope, purge };
}

const service = createDriverOperationalLifecycleService();

module.exports = {
  ...service,
  createDriverOperationalLifecycleService,
  normalizeDriverOperationalScope,
};
