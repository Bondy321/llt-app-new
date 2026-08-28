'use strict';

const { reconcileDriverLocationProjection } = require('./driverLocationProjection');

const DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS = Object.freeze({
  maxLocationsPerRun: 100,
});

const DRIVER_LOCATION_SESSIONS_ROOT = 'driver_location_sessions';
const DRIVER_LOCATION_PICKUPS_ROOT = 'driver_location_pickups';

const queryExpired = async ({ database, root, orderBy, nowMs, limit }) => {
  const snapshot = await database.ref(root)
    .orderByChild(orderBy)
    .startAt(1)
    .endAt(nowMs)
    .limitToFirst(limit)
    .get();
  return snapshot.exists() ? snapshot.val() || {} : {};
};

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
  reconcileProjection = reconcileDriverLocationProjection,
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

  const [candidates, pickupCandidates] = await Promise.all([
    queryExpired({ database, root: DRIVER_LOCATION_SESSIONS_ROOT, orderBy: 'cleanupAtMs', nowMs, limit }),
    queryExpired({ database, root: DRIVER_LOCATION_PICKUPS_ROOT, orderBy: 'expiresAtMs', nowMs, limit }),
  ]);
  let removed = 0;
  let pickupsRemoved = 0;
  const affectedTours = new Set();

  await Promise.all(Object.entries(candidates).map(async ([sourceKey, candidate]) => {
    if (!isExpiredLiveDriverLocation(candidate, nowMs)) return;

    const result = await database.ref(`${DRIVER_LOCATION_SESSIONS_ROOT}/${sourceKey}`).transaction((current) => {
      if (!isSameExpiredLiveDriverLocation(current, candidate, nowMs)) return undefined;
      return null;
    }, undefined, false);
    if (result?.committed) {
      removed += 1;
      affectedTours.add(candidate.tourId);
    }
  }));

  await Promise.all(Object.entries(pickupCandidates).map(async ([tourId, candidate]) => {
    if (!isExpiredDriverLocationPickup(candidate, tourId, nowMs)) return;
    const result = await database.ref(`${DRIVER_LOCATION_PICKUPS_ROOT}/${tourId}`).transaction((current) => {
      if (!isSameExpiredDriverLocationPickup(current, candidate, tourId, nowMs)) return undefined;
      return null;
    }, undefined, false);
    if (result?.committed) {
      pickupsRemoved += 1;
      affectedTours.add(tourId);
    }
  }));

  const reconciledTours = [...affectedTours].sort();
  for (const tourId of reconciledTours) {
    await reconcileProjection({ database, tourId, nowMs });
  }

  return {
    ok: true,
    scanned: Object.keys(candidates).length,
    removed,
    pickupsScanned: Object.keys(pickupCandidates).length,
    pickupsRemoved,
    restoredPickups: 0,
    reconciledTours,
    hasMore: Object.keys(candidates).length >= limit || Object.keys(pickupCandidates).length >= limit,
    cleanedAtMs: nowMs,
  };
}

function isExpiredDriverLocationPickup(location, tourId, nowMs) {
  return Boolean(
    location && typeof location === 'object'
    && location.schemaVersion === 1
    && location.isSharing === true
    && location.mode === 'pickup'
    && location.source === 'manual'
    && location.tourId === tourId
    && typeof location.driverId === 'string' && location.driverId.length > 0
    && Number.isSafeInteger(location.assignmentRevision) && location.assignmentRevision >= 0
    && Number.isSafeInteger(location.publishedAtMs) && location.publishedAtMs > 0
    && Number.isSafeInteger(location.expiresAtMs) && location.expiresAtMs > 0
    && location.expiresAtMs <= nowMs
  );
}

function isSameExpiredDriverLocationPickup(current, candidate, tourId, nowMs) {
  return Boolean(
    isExpiredDriverLocationPickup(current, tourId, nowMs)
    && current.driverId === candidate.driverId
    && current.assignmentRevision === candidate.assignmentRevision
    && current.publishedAtMs === candidate.publishedAtMs
    && current.expiresAtMs === candidate.expiresAtMs
  );
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
    && location.schemaVersion === 2
    && location.source === 'auto'
    && typeof location.appSessionId === 'string'
    && location.appSessionId.length > 0
    && typeof location.liveSharingSessionId === 'string'
    && location.liveSharingSessionId.length > 0
    && typeof location.tourId === 'string'
    && location.tourId.length > 0
    && Number.isSafeInteger(location.timestamp)
    && Number.isSafeInteger(location.cleanupAtMs)
    && location.cleanupAtMs <= nowMs,
  );
}

function isSameExpiredLiveDriverLocation(current, candidate, nowMs) {
  return Boolean(
    isExpiredLiveDriverLocation(current, nowMs)
    && current.appSessionId === candidate.appSessionId
    && current.liveSharingSessionId === candidate.liveSharingSessionId
    && current.tourId === candidate.tourId
    && current.timestamp === candidate.timestamp
    && current.cleanupAtMs === candidate.cleanupAtMs,
  );
}

module.exports = {
  DRIVER_LOCATION_EXPIRY_CLEANUP_LIMITS,
  cleanupExpiredDriverLocations,
  isExpiredLiveDriverLocation,
  isExpiredDriverLocationPickup,
  isSameExpiredLiveDriverLocation,
  isSameExpiredDriverLocationPickup,
  normalizePickupFallback,
};
