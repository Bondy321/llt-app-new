'use strict';

const DRIVER_TOUR_PACK_EXPIRY_CLEANUP_LIMITS = Object.freeze({
  maxPacksPerRun: 50,
});

const PACKS_ROOT = 'driver_tour_packs';
const ACTIONS_ROOT = 'driver_tour_pack_actions';
const TOMBSTONES_ROOT = 'driver_tour_pack_tombstones';
const INGESTION_ROOT = 'driver_tour_pack_ingestion';
const ADMIN_STATUS_ROOT = 'driver_tour_pack_admin_status';

/**
 * Removes expired operational payloads in small, idempotent batches.  The
 * residual tombstone deliberately contains only departure identity and timing
 * information; passenger, contact, itinerary and driver-action data is gone.
 */
async function cleanupExpiredDriverTourPacks({
  database,
  nowMs = Date.now(),
  limit = DRIVER_TOUR_PACK_EXPIRY_CLEANUP_LIMITS.maxPacksPerRun,
} = {}) {
  if (!database || typeof database.ref !== 'function') throw new TypeError('A Realtime Database instance is required.');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be a non-negative safe integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DRIVER_TOUR_PACK_EXPIRY_CLEANUP_LIMITS.maxPacksPerRun) {
    throw new RangeError(`limit must be 1-${DRIVER_TOUR_PACK_EXPIRY_CLEANUP_LIMITS.maxPacksPerRun}.`);
  }

  const snapshot = await database.ref(PACKS_ROOT)
    .orderByChild('expiresAtMs')
    .endAt(nowMs)
    .limitToFirst(limit)
    .get();
  const candidates = snapshot.exists() ? snapshot.val() || {} : {};
  const updates = {};
  let removed = 0;

  Object.entries(candidates).forEach(([departureKey, pack]) => {
    if (!isExpiredPack(departureKey, pack, nowMs)) return;
    updates[`${PACKS_ROOT}/${departureKey}`] = null;
    updates[`${ACTIONS_ROOT}/${departureKey}`] = null;
    updates[`${INGESTION_ROOT}/packMetadata/${departureKey}`] = null;
    updates[`${ADMIN_STATUS_ROOT}/${departureKey}`] = buildExpiryAdminStatus(pack, nowMs);
    updates[`${TOMBSTONES_ROOT}/${departureKey}`] = buildExpiryTombstone(pack, nowMs);
    removed += 1;
  });

  if (removed) await database.ref('/').update(updates);
  return {
    ok: true,
    scanned: Object.keys(candidates).length,
    removed,
    hasMore: Object.keys(candidates).length >= limit,
    cleanedAtMs: nowMs,
  };
}

function buildExpiryAdminStatus(pack, purgedAtMs) {
  return {
    schemaVersion: Number.isSafeInteger(pack.schemaVersion) ? pack.schemaVersion : 1,
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    tourCode: pack.tourCode,
    dateISO: pack.dateISO,
    status: 'expired',
    qualityState: pack.quality?.state === 'degraded' ? 'degraded' : 'complete',
    revision: Number.isSafeInteger(pack.revision) ? pack.revision : 1,
    publishedAtMs: Number.isSafeInteger(pack.publishedAtMs) ? pack.publishedAtMs : 0,
    expiresAtMs: pack.expiresAtMs,
    sourceSnapshotDate: pack.sourceSnapshotDate,
    purgedAtMs,
  };
}

function isExpiredPack(departureKey, pack, nowMs) {
  return Boolean(
    isSafeDepartureKey(departureKey)
    && pack
    && typeof pack === 'object'
    && Number.isSafeInteger(pack.expiresAtMs)
    && pack.expiresAtMs <= nowMs,
  );
}

function buildExpiryTombstone(pack, purgedAtMs) {
  return {
    schemaVersion: Number.isSafeInteger(pack.schemaVersion) ? pack.schemaVersion : 1,
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    dateISO: pack.dateISO,
    status: 'expired',
    revision: Number.isSafeInteger(pack.revision) ? pack.revision : 1,
    expiresAtMs: pack.expiresAtMs,
    purgedAtMs,
    reason: 'RETENTION_EXPIRED',
  };
}

function isSafeDepartureKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[.#$\/\[\]\x00-\x1F\x7F]/.test(value);
}

module.exports = {
  DRIVER_TOUR_PACK_EXPIRY_CLEANUP_LIMITS,
  cleanupExpiredDriverTourPacks,
  isExpiredPack,
  buildExpiryTombstone,
  buildExpiryAdminStatus,
};
