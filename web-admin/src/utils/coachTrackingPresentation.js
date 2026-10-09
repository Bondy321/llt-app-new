// Same cadence thresholds as the passenger location contract. No coordinates
// are persisted, and expired/malformed points never enter the map renderer.
export const TRACKING_LIVE_MS = 4 * 60_000;
export const TRACKING_RECENT_MS = 10 * 60_000;
export const TRACKING_EXPIRED_MS = 30 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '', max = 180) => typeof value === 'string' ? value.trim().slice(0, max) || fallback : fallback;
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => numeric(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const timestamp = value => numeric(value) && value > 0 ? value
  : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;

export const TRACKING_STATUS_META = Object.freeze({
  live: { label: 'Live', color: 'teal', rank: 0 },
  recent: { label: 'Recent', color: 'blue', rank: 1 },
  low_accuracy: { label: 'Low accuracy', color: 'orange', rank: 2 },
  stale: { label: 'Stale', color: 'orange', rank: 3 },
  unavailable: { label: 'No live position', color: 'gray', rank: 4 },
});

export function presentCoachLocation(value, nowMs) {
  const empty = { state: 'unavailable', position: null, pickup: null, timestampMs: null,
    accuracy: null, ageMs: null, reason: 'No live location is being shared.' };
  if (!record(value) || value.isSharing === false) return empty;
  const coordinatesValid = candidate => record(candidate) && numeric(candidate.latitude) && Math.abs(candidate.latitude) <= 90
    && numeric(candidate.longitude) && Math.abs(candidate.longitude) <= 180;
  const isLive = value.mode === 'live' || value.source === 'auto';
  const pickup = !isLive ? value : value.fallbackPickup;
  const pickupWhen = timestamp(pickup?.timestamp ?? pickup?.lastUpdated);
  const validPickup = coordinatesValid(pickup) && pickup.isSharing !== false
    && pickup.mode !== 'live' && pickup.source !== 'auto' && Number.isFinite(pickupWhen)
    && pickupWhen <= nowMs + FUTURE_TOLERANCE_MS;
  const fixed = validPickup ? { latitude: pickup.latitude, longitude: pickup.longitude,
    address: text(pickup.address, 'Published pickup point', 500), timestampMs: pickupWhen } : null;
  const when = timestamp(value.timestamp ?? value.lastUpdated);
  if (!coordinatesValid(value) || !validDate(when) || when > nowMs + FUTURE_TOLERANCE_MS) {
    return { ...empty, pickup: fixed, reason: 'The shared position is invalid or has an invalid timestamp.' };
  }
  if (!isLive) return { ...empty, pickup: fixed, reason: 'Only a fixed pickup point is shared; this is not the coach’s live position.' };
  const ageMs = Math.max(0, nowMs - when);
  const accuracy = numeric(value.accuracy) && value.accuracy >= 0 && value.accuracy <= 100_000 ? value.accuracy : null;
  if (ageMs >= TRACKING_EXPIRED_MS) return { ...empty, pickup: fixed, timestampMs: when, ageMs, accuracy,
    reason: 'The last position is over 30 minutes old and is hidden from the map.' };
  const state = ageMs >= TRACKING_RECENT_MS ? 'stale' : accuracy !== null && accuracy > 500 ? 'low_accuracy'
    : ageMs >= TRACKING_LIVE_MS ? 'recent' : 'live';
  return { state, position: { latitude: value.latitude, longitude: value.longitude }, pickup: fixed,
    timestampMs: when, accuracy, ageMs, reason: state === 'stale' ? 'Last known position; the coach may have moved.'
      : state === 'low_accuracy' ? 'Approximate position; GPS accuracy is worse than 500 metres.'
        : state === 'recent' ? 'A recent update, not a current GPS fix.' : 'A fresh location update has been received.' };
}

export function buildCoachRows(rawRows, nowMs, { connected = true } = {}) {
  if (!record(rawRows)) return [];
  return Object.entries(rawRows).map(([key, value]) => {
    if (!record(value) || value.deleted === true || value.listed === false || value.schemaVersion !== 1 || value.tourId !== key || !key || /[.#$/[\]]/.test(key)) return null;
    const location = presentCoachLocation(value.location, nowMs);
    const state = !connected && location.position && location.state === 'live' ? 'recent' : location.state;
    return { tourId: key, tourCode: text(value.tourCode, key, 100), name: text(value.name, 'Unnamed tour'),
      isActive: value.isActive === true, startAtMs: validDate(value.startAtMs) ? value.startAtMs : null,
      endAtMs: validDate(value.endAtMs) ? value.endAtMs : null,
      assignedDrivers: (Array.isArray(value.assignedDrivers) ? value.assignedDrivers : [])
        .filter(driver => record(driver) && text(driver.driverId)).map(driver => ({ driverId: text(driver.driverId, '', 100), name: text(driver.name, 'Unnamed driver', 120) })),
      assignmentOverflow: value.assignmentOverflow === true,
      ...location, state, meta: TRACKING_STATUS_META[state],
      ...(connected ? {} : { reason: 'Connection lost. This is cached information; the coach may have moved.' }),
    };
  }).filter(Boolean).sort((a, b) => a.meta.rank - b.meta.rank || a.tourCode.localeCompare(b.tourCode));
}

export function filterCoachRows(rows, { search = '', status = 'all' } = {}) {
  const needle = search.trim().toLocaleLowerCase();
  return rows.filter(row => (status === 'all' || (status === 'attention' ? ['stale', 'low_accuracy', 'recent'].includes(row.state) : row.state === status))
    && (!needle || [row.tourCode, row.tourId, row.name, ...row.assignedDrivers.flatMap(driver => [driver.name, driver.driverId])]
      .some(value => value.toLocaleLowerCase().includes(needle))));
}

export const formatPositionAge = ageMs => ageMs === null ? 'No update' : ageMs < 60_000 ? 'Just now'
  : `${Math.floor(ageMs / 60_000)} min ago`;
const coachTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
export const formatCoachTime = value => !validDate(value) ? 'Unavailable' : coachTimeFormatter.format(value);
