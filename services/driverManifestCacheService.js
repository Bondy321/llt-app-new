const { createPersistenceProvider } = require('./persistenceProvider');
const { normalizeTourId } = require('./tourIdentityService');

const SCHEMA_VERSION = 1;
const MAX_BOOKINGS = 1_500;
const MAX_PASSENGERS_PER_BOOKING = 80;
const MAX_PICKUP_POINTS_PER_BOOKING = 20;
const MAX_BOOKING_ID_LENGTH = 120;
const MAX_TEXT_LENGTH = 500;
const MANIFEST_STATUSES = new Set(['PENDING', 'BOARDED', 'NO_SHOW', 'PARTIAL']);

const defaultStorage = createPersistenceProvider({
  namespace: 'LLT_DRIVER_MANIFEST',
  preferredStorage: 'async-storage',
  allowMemoryFallback: false,
  migrateFrom: ['secure-store'],
});

const response = {
  ok: (data) => ({ success: true, data }),
  fail: (error) => ({ success: false, error: String(error?.message || error || 'Manifest cache error') }),
};

const text = (value, max = MAX_TEXT_LENGTH) => {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : '';
};

const normalizeDriverId = (value) => {
  const driverId = text(value, 80).toUpperCase();
  return /^D-[A-Z0-9_-]+$/.test(driverId) ? driverId : '';
};

const cacheKey = (tourId, driverId) => `driver_manifest_snapshot_v1_${encodeURIComponent(tourId)}_${encodeURIComponent(driverId)}`;

const deriveStatus = (statuses = []) => {
  if (statuses.length === 0) return 'PENDING';
  if (statuses.every((status) => status === 'BOARDED')) return 'BOARDED';
  if (statuses.every((status) => status === 'NO_SHOW')) return 'NO_SHOW';
  if (statuses.every((status) => status === 'PENDING')) return 'PENDING';
  return 'PARTIAL';
};

const recomputeStats = (bookings) => bookings.reduce((stats, booking) => {
  const statuses = booking.passengerStatus;
  stats.totalBookings += 1;
  stats.totalPax += statuses.length;
  statuses.forEach((status) => {
    if (status === 'BOARDED') stats.checkedIn += 1;
    if (status === 'NO_SHOW') stats.noShows += 1;
  });
  return stats;
}, { totalBookings: 0, totalPax: 0, checkedIn: 0, noShows: 0 });

const normalizeBooking = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = text(input.id, MAX_BOOKING_ID_LENGTH).toUpperCase();
  const passengerNames = Array.isArray(input.passengerNames) ? input.passengerNames.map((name) => text(name, 180)) : [];
  if (!id || passengerNames.length === 0 || passengerNames.length > MAX_PASSENGERS_PER_BOOKING || passengerNames.some((name) => !name)) return null;
  const rawStatuses = Array.isArray(input.passengerStatus) ? input.passengerStatus : [];
  if (rawStatuses.length && rawStatuses.length !== passengerNames.length) return null;
  const passengerStatus = (rawStatuses.length ? rawStatuses : passengerNames.map(() => input.status || 'PENDING'))
    .map((status) => text(status, 20).toUpperCase());
  if (passengerStatus.some((status) => !MANIFEST_STATUSES.has(status))) return null;
  const seatNumbers = Array.isArray(input.seatNumbers) ? input.seatNumbers : [];
  const seatLabels = Array.isArray(input.seatLabels) ? input.seatLabels : [];
  if (seatNumbers.length > passengerNames.length || seatLabels.length > passengerNames.length) return null;
  const normalizedSeatNumbers = passengerNames.map((_, index) => text(String(seatNumbers[index] ?? 'TBA'), 40) || 'TBA');
  const normalizedSeatLabels = passengerNames.map((_, index) => text(String(seatLabels[index] ?? 'TBA'), 80) || 'TBA');
  const rawPickupPoints = Array.isArray(input.pickupPoints) ? input.pickupPoints : [];
  if (rawPickupPoints.length > MAX_PICKUP_POINTS_PER_BOOKING) return null;
  const pickupPoints = rawPickupPoints.map((point) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
    const location = text(point.location, 250);
    const time = text(point.time, 40);
    const date = text(point.date, 40);
    return (location || time || date) ? { location, time, date } : null;
  });
  if (pickupPoints.some((point) => !point)) return null;

  // Cache only fields the manifest screen renders. This deliberately avoids a
  // generic booking copy and keeps the local PII surface bounded.
  return {
    id,
    passengerNames,
    passengerStatus,
    seatNumbers: normalizedSeatNumbers,
    seatLabels: normalizedSeatLabels,
    pickupPoints,
    hasPassengerStatuses: true,
    status: deriveStatus(passengerStatus),
    pickupLocation: text(input.pickupLocation, 250) || 'To be confirmed',
    pickupTime: text(input.pickupTime, 40) || 'TBA',
    notes: text(input.notes, 1_000),
  };
};

function normalizeSnapshot(snapshot, { tourId, driverId, now = Date.now() } = {}) {
  const canonicalTourId = normalizeTourId(tourId);
  const canonicalDriverId = normalizeDriverId(driverId);
  if (!canonicalTourId || !canonicalDriverId || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (normalizeTourId(snapshot.tourId) !== canonicalTourId || normalizeDriverId(snapshot.driverId) !== canonicalDriverId) return null;
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.complete !== true) return null;
  if (!Array.isArray(snapshot.bookings) || snapshot.bookings.length > MAX_BOOKINGS) return null;
  const bookings = snapshot.bookings.map(normalizeBooking);
  if (bookings.some((booking) => !booking)) return null;
  const ids = new Set(bookings.map((booking) => booking.id));
  if (ids.size !== bookings.length) return null;
  const fetchedAtMs = Number(snapshot.fetchedAtMs);
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0 || fetchedAtMs > now + 5 * 60 * 1000) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    complete: true,
    tourId: canonicalTourId,
    driverId: canonicalDriverId,
    fetchedAtMs,
    bookings,
    stats: recomputeStats(bookings),
  };
}

function createDriverManifestCacheService({ storage = defaultStorage, now = () => Date.now() } = {}) {
  const locks = new Map();
  const withLock = async (key, operation) => {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  };
  const validateIdentity = (tourId, driverId) => {
    const canonicalTourId = normalizeTourId(tourId);
    const canonicalDriverId = normalizeDriverId(driverId);
    return canonicalTourId && canonicalDriverId ? { tourId: canonicalTourId, driverId: canonicalDriverId } : null;
  };
  const get = async ({ tourId, driverId } = {}) => {
    const identity = validateIdentity(tourId, driverId);
    if (!identity) return response.fail('A canonical tour ID and D-* driver ID are required.');
    try {
      const raw = await storage.getItemAsync(cacheKey(identity.tourId, identity.driverId));
      if (!raw) return response.ok(null);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return response.fail('Cached manifest is malformed.'); }
      const snapshot = normalizeSnapshot(parsed, { ...identity, now: now() });
      return snapshot ? response.ok(snapshot) : response.fail('Cached manifest did not pass validation.');
    } catch (error) { return response.fail(error); }
  };
  const replace = async ({ tourId, driverId, manifest, fetchedAtMs = now() } = {}) => {
    const identity = validateIdentity(tourId, driverId);
    if (!identity) return response.fail('A canonical tour ID and D-* driver ID are required.');
    const snapshot = normalizeSnapshot({
      ...(manifest || {}),
      // The secure Function must explicitly mark a full response. Never turn a
      // partial or legacy payload into a complete local snapshot client-side.
      schemaVersion: SCHEMA_VERSION,
      driverId: identity.driverId,
      fetchedAtMs,
    }, { ...identity, now: now() });
    if (!snapshot) return response.fail('Manifest snapshot did not pass validation.');
    const key = cacheKey(identity.tourId, identity.driverId);
    try {
      await withLock(key, () => storage.setItemAsync(key, JSON.stringify(snapshot)));
      return response.ok(snapshot);
    } catch (error) { return response.fail(error); }
  };
  const applyOptimisticUpdate = async ({ tourId, driverId, bookingRef, passengerStatuses } = {}) => {
    const identity = validateIdentity(tourId, driverId);
    const bookingId = text(bookingRef, MAX_BOOKING_ID_LENGTH).toUpperCase();
    if (!identity || !bookingId || !Array.isArray(passengerStatuses)) return response.fail('A scoped manifest booking update is required.');
    const key = cacheKey(identity.tourId, identity.driverId);
    try {
      return await withLock(key, async () => {
        const raw = await storage.getItemAsync(key);
        if (!raw) return response.fail('No complete manifest snapshot is cached.');
        let parsed; try { parsed = JSON.parse(raw); } catch { return response.fail('Cached manifest is malformed.'); }
        const snapshot = normalizeSnapshot(parsed, { ...identity, now: now() });
        if (!snapshot) return response.fail('Cached manifest did not pass validation.');
        const bookingIndex = snapshot.bookings.findIndex((booking) => booking.id === bookingId);
        if (bookingIndex < 0) return response.fail('Booking is not present in the cached manifest.');
        const booking = snapshot.bookings[bookingIndex];
        if (passengerStatuses.length !== booking.passengerNames.length) return response.fail('Passenger status count does not match the cached booking.');
        const statuses = passengerStatuses.map((status) => text(status, 20).toUpperCase());
        if (statuses.some((status) => !MANIFEST_STATUSES.has(status))) return response.fail('Passenger status is invalid.');
        const bookings = [...snapshot.bookings];
        bookings[bookingIndex] = { ...booking, passengerStatus: statuses, status: deriveStatus(statuses) };
        const next = { ...snapshot, bookings, stats: recomputeStats(bookings) };
        await storage.setItemAsync(key, JSON.stringify(next));
        return response.ok(next);
      });
    } catch (error) { return response.fail(error); }
  };
  const purge = async ({ tourId, driverId } = {}) => {
    const identity = validateIdentity(tourId, driverId);
    if (!identity) return response.fail('A canonical tour ID and D-* driver ID are required.');
    try {
      await withLock(cacheKey(identity.tourId, identity.driverId), () => storage.deleteItemAsync(cacheKey(identity.tourId, identity.driverId)));
      return response.ok(true);
    } catch (error) { return response.fail(error); }
  };
  return { get, replace, applyOptimisticUpdate, purge };
}

const service = createDriverManifestCacheService();
module.exports = { ...service, createDriverManifestCacheService, normalizeSnapshot, recomputeStats, SCHEMA_VERSION, MAX_BOOKINGS };
