'use strict';

const DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS = Object.freeze({
  maxLocationsPerRun: 100,
});

const TOURS_ROOT = 'tours';

/**
 * Removes only disconnect-safe live-location leases that are still expired when their
 * individual record is transactionally re-read.  The compare-and-delete is
 * deliberately scoped to the exact session and update timestamp returned by
 * the query: a driver publishing a fresh location while this batch runs must
 * never lose that new location.
 */
async function cleanupExpiredDriverLocations({
  database,
  nowMs = Date.now(),
  limit = DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS.maxLocationsPerRun,
} = {}) {
  if (!database || typeof database.ref !== 'function') {
    throw new TypeError('A Realtime Database instance is required.');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS.maxLocationsPerRun) {
    throw new RangeError(`limit must be 1-${DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS.maxLocationsPerRun}.`);
  }

  const snapshot = await database.ref(TOURS_ROOT)
    .orderByChild('driverLocation/cleanupAtMs')
    .startAt(1)
    .endAt(nowMs)
    .limitToFirst(limit)
    .get();
  const candidates = snapshot.exists() ? snapshot.val() || {} : {};
  let removed = 0;
  let restoredPickups = 0;

  await Promise.all(Object.entries(candidates).map(async ([tourId, tour]) => {
    const candidate = tour?.driverLocation;
    if (!isExpiredLiveDriverLocation(candidate, nowMs)) return;

    const result = await database.ref(`${TOURS_ROOT}/${tourId}/driverLocation`).transaction((current) => {
      if (!isSameExpiredLiveDriverLocation(current, candidate, nowMs)) return undefined;
      return normalizePickupFallback(current.fallbackPickup);
    }, undefined, false);
    if (result?.committed) {
      removed += 1;
      if (normalizePickupFallback(candidate.fallbackPickup)) restoredPickups += 1;
    }
  }));

  return {
    ok: true,
    scanned: Object.keys(candidates).length,
    removed,
    restoredPickups,
    hasMore: Object.keys(candidates).length >= limit,
    cleanedAtMs: nowMs,
  };
}

function normalizePickupFallback(location) {
  if (
    !location
    || location.schemaVersion !== 1
    || location.isSharing !== true
    || location.mode !== 'pickup'
    || location.source !== 'manual'
    || !Number.isFinite(location.latitude)
    || location.latitude < -90
    || location.latitude > 90
    || !Number.isFinite(location.longitude)
    || location.longitude < -180
    || location.longitude > 180
    || !Number.isSafeInteger(location.timestamp)
  ) return null;
  const fallback = {
    schemaVersion: 1,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
  };
  if (Number.isFinite(location.accuracy) && location.accuracy >= 0 && location.accuracy <= 10000) {
    fallback.accuracy = location.accuracy;
  }
  if (typeof location.address === 'string' && location.address.trim() && location.address.trim().length <= 500) {
    fallback.address = location.address.trim();
  }
  if (typeof location.updatedBy === 'string' && location.updatedBy.trim() && location.updatedBy.trim().length <= 100) {
    fallback.updatedBy = location.updatedBy.trim();
  }
  return fallback;
}

function isExpiredLiveDriverLocation(location, nowMs) {
  return Boolean(
    location
    && typeof location === 'object'
    && location.mode === 'live'
    && location.schemaVersion === 1
    && typeof location.sessionId === 'string'
    && location.sessionId.length > 0
    && Number.isSafeInteger(location.timestamp)
    && Number.isSafeInteger(location.cleanupAtMs)
    && location.cleanupAtMs <= nowMs,
  );
}

function isSameExpiredLiveDriverLocation(current, candidate, nowMs) {
  return Boolean(
    isExpiredLiveDriverLocation(current, nowMs)
    && current.sessionId === candidate.sessionId
    && current.timestamp === candidate.timestamp
    && current.cleanupAtMs === candidate.cleanupAtMs,
  );
}

module.exports = {
  DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS,
  cleanupExpiredDriverLocations,
  isExpiredLiveDriverLocation,
  isSameExpiredLiveDriverLocation,
  normalizePickupFallback,
};
