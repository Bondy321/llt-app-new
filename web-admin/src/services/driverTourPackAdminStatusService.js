import { limitToLast, onValue, orderByChild, query, ref } from 'firebase/database';
import { formatDateToISO, parseISODateStrict, parseUKDateStrict } from '../utils/dateUtils';

const ADMIN_STATUS_ROOT = 'driver_tour_pack_admin_status';
// One publication can contain 1,000 packs. Two full cohorts keeps the query
// bounded while avoiding silent truncation during an ordinary maximum run.
export const DRIVER_TOUR_PACK_ADMIN_STATUS_LIMIT = 2_000;
export const DRIVER_TOUR_PACK_ADMIN_STATUS_QUERY = Object.freeze({ orderByChild: 'publishedAtMs', limit: DRIVER_TOUR_PACK_ADMIN_STATUS_LIMIT });
const STATUS_VALUES = new Set(['active', 'cancelled', 'withdrawn', 'expired']);
const QUALITY_VALUES = new Set(['complete', 'degraded']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dateISOForTour(tour) {
  const uk = parseUKDateStrict(tour?.startDate);
  if (uk.success) return formatDateToISO(uk.date);
  const iso = parseISODateStrict(tour?.startDate);
  return iso.success ? formatDateToISO(iso.date) : null;
}

function isSafeStatus(value) {
  return value
    && value.schemaVersion === 1
    && typeof value.departureKey === 'string'
    && value.departureKey.length <= 180
    && typeof value.tourId === 'string'
    && value.tourId.length > 0
    && value.tourId.length <= 100
    && !/[.#$/[\]]/.test(value.departureKey)
    && !/[.#$/[\]]/.test(value.tourId)
    && typeof value.dateISO === 'string'
    && parseISODateStrict(value.dateISO).success
    && STATUS_VALUES.has(value.status)
    && QUALITY_VALUES.has(value.qualityState)
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && Number.isSafeInteger(value.publishedAtMs) && value.publishedAtMs >= 0
    && Number.isSafeInteger(value.expiresAtMs) && value.expiresAtMs >= 0
    && typeof value.sourceSnapshotDate === 'string'
    && parseISODateStrict(value.sourceSnapshotDate).success
    && value.departureKey === `${value.dateISO}::${value.tourId}`;
}

export function sanitizeDriverTourPackAdminStatuses(value) {
  return Object.fromEntries(Object.entries(asRecord(value))
    .filter(([departureKey, status]) => departureKey === status?.departureKey && isSafeStatus(status))
    .map(([departureKey, status]) => [departureKey, {
      schemaVersion: status.schemaVersion,
      departureKey: status.departureKey,
      tourId: status.tourId,
      tourCode: typeof status.tourCode === 'string' ? status.tourCode : '',
      dateISO: status.dateISO,
      status: status.status,
      qualityState: status.qualityState,
      revision: status.revision,
      publishedAtMs: status.publishedAtMs,
      expiresAtMs: status.expiresAtMs,
      sourceSnapshotDate: status.sourceSnapshotDate,
      runId: typeof status.runId === 'string' ? status.runId : '',
      ...(Number.isSafeInteger(status.purgedAtMs) ? { purgedAtMs: status.purgedAtMs } : {}),
    }]));
}

export function resolveTourPackAdminStatus({ tourId, tour, statuses, nowMs = Date.now() }) {
  const dateISO = dateISOForTour(tour);
  const candidates = Object.values(sanitizeDriverTourPackAdminStatuses(statuses))
    .filter((status) => status.tourId === tourId);
  return resolveTourPackAdminStatusFromCandidates({ tourId, tour, dateISO, candidates, nowMs });
}

function resolveTourPackAdminStatusFromCandidates({ tourId, tour, dateISO = dateISOForTour(tour), candidates = [], nowMs }) {
  if (!dateISO) {
    return candidates.length ? { state: 'ambiguous', reason: 'Tour start date is missing or invalid.' } : { state: 'missing' };
  }
  const matches = candidates.filter((status) => status.dateISO === dateISO && status.departureKey === `${dateISO}::${tourId}`);
  if (matches.length !== 1) return matches.length > 1 ? { state: 'ambiguous', reason: 'More than one publication matches this departure.' } : { state: 'missing' };
  const status = matches[0];
  if (status.status === 'cancelled' || status.status === 'withdrawn' || status.status === 'expired') return { ...status, state: status.status };
  if (status.expiresAtMs <= nowMs) return { ...status, state: 'stale', reason: 'The published pack has passed its retention deadline.' };
  if (status.qualityState === 'degraded') return { ...status, state: 'degraded' };
  return { ...status, state: 'ready' };
}

export function buildTourPackCoverage({ tours = {}, drivers = {}, statuses = {}, nowMs = Date.now() } = {}) {
  const driversByTour = new Map();
  Object.entries(asRecord(drivers)).forEach(([driverId, driver]) => {
    const currentTourId = driver?.currentTourId;
    const tourId = typeof currentTourId === 'string' ? currentTourId.trim() : '';
    if (!tourId) return;
    const assigned = driversByTour.get(tourId);
    if (assigned) assigned.push(driverId);
    else driversByTour.set(tourId, [driverId]);
  });
  const statusesByTour = new Map();
  Object.values(sanitizeDriverTourPackAdminStatuses(statuses)).forEach((status) => {
    const candidates = statusesByTour.get(status.tourId);
    if (candidates) candidates.push(status);
    else statusesByTour.set(status.tourId, [status]);
  });

  return Object.fromEntries(Object.entries(asRecord(tours)).map(([tourId, tour]) => {
    const tourDriverId = typeof tour?.driverId === 'string' ? tour.driverId.trim() : '';
    const currentDriverIds = driversByTour.get(tourId) || [];
    const assignedDriverIds = [...new Set([tourDriverId, ...currentDriverIds].filter(Boolean))];
    const hasLegacyNameOnly = assignedDriverIds.length === 0
      && typeof tour?.driverName === 'string'
      && tour.driverName.trim()
      && tour.driverName.trim().toUpperCase() !== 'TBA';
    const assignmentState = assignedDriverIds.length > 1
      ? 'inconsistent'
      : assignedDriverIds.length === 1
        ? 'assigned'
        : hasLegacyNameOnly ? 'legacy' : 'unassigned';
    const pack = resolveTourPackAdminStatusFromCandidates({
      tourId,
      tour,
      candidates: statusesByTour.get(tourId) || [],
      nowMs,
    });
    return [tourId, {
      pack,
      assignedDriverCount: assignedDriverIds.length,
      assignmentState,
      assignmentCoverage: assignmentState === 'assigned'
        ? ['ready', 'degraded'].includes(pack.state) ? 'covered' : 'uncovered'
        : assignmentState,
    }];
  }));
}

export function subscribeToDriverTourPackAdminStatuses(database, onData, onError, limit = DRIVER_TOUR_PACK_ADMIN_STATUS_LIMIT) {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= DRIVER_TOUR_PACK_ADMIN_STATUS_LIMIT
    ? limit : DRIVER_TOUR_PACK_ADMIN_STATUS_LIMIT;
  const statusQuery = query(ref(database, ADMIN_STATUS_ROOT), orderByChild('publishedAtMs'), limitToLast(boundedLimit));
  return onValue(statusQuery, (snapshot) => {
    const statuses = sanitizeDriverTourPackAdminStatuses(snapshot.val());
    onData({ statuses, atLimit: Object.keys(statuses).length >= boundedLimit, limit: boundedLimit });
  }, onError);
}
