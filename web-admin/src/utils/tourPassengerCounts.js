// Source reports describe booked places and passenger-list rows. Runtime
// participation counters have a different owner and must not replace them.
export function normalizePassengerCount(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

const collectionSize = value => Array.isArray(value)
  ? value.filter(item => item !== null && item !== undefined && item !== '').length
  : value && typeof value === 'object' ? Object.keys(value).length : 0;

export function resolveTourPassengerCount(tour = {}, { manifestPassengerCount = 0 } = {}) {
  for (const field of ['sold', 'bookedPassengerCount', 'manifestPassengerCount']) {
    const count = normalizePassengerCount(tour?.[field]);
    if (count !== null) return { count, source: `tour.${field}` };
  }
  const manifestCount = normalizePassengerCount(manifestPassengerCount);
  if (manifestCount > 0) return { count: manifestCount, source: 'tour_manifests.bookings' };
  const legacyCount = normalizePassengerCount(tour?.currentParticipants);
  if (legacyCount !== null) return { count: legacyCount, source: 'tour.currentParticipants' };
  const participants = collectionSize(tour?.participants);
  if (participants > 0) return { count: participants, source: 'tours.participants' };
  return { count: 0, source: 'none' };
}

export function getTourPassengerSummary(tour = {}) {
  const resolved = resolveTourPassengerCount(tour);
  const reportCount = normalizePassengerCount(tour.manifestPassengerCount)
    ?? normalizePassengerCount(tour.bookedPassengerCount);
  const capacityValue = normalizePassengerCount(tour.maxParticipants);
  const capacity = capacityValue > 0 ? capacityValue : null;
  const known = resolved.source !== 'none';
  const label = resolved.source === 'tour.sold' ? 'booked places'
    : resolved.source === 'tour.currentParticipants' || resolved.source === 'tours.participants' ? 'legacy participants'
      : 'passengers';
  return {
    ...resolved, known, label, reportCount, capacity,
    reportMismatch: reportCount !== null && resolved.source === 'tour.sold' && resolved.count !== reportCount,
    loadPercent: known && capacity ? resolved.count / capacity * 100 : null,
    text: known ? `${resolved.count}${capacity ? ` / ${capacity}` : ''} ${label}` : 'Passenger count unavailable',
  };
}
