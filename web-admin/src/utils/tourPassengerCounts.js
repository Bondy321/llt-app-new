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
  const manualCount = normalizePassengerCount(tour?.manualPassengerCount) ?? 0;
  const sourceCounts = ['sold', 'bookedPassengerCount', 'manifestPassengerCount']
    .map(field => ({ field, count: normalizePassengerCount(tour?.[field]) }))
    .filter(item => item.count !== null);
  if (sourceCounts.length > 0) {
    const source = sourceCounts.reduce((largest, candidate) => (
      candidate.count > largest.count ? candidate : largest
    ));
    const total = source.count + manualCount;
    return {
      count: Number.isSafeInteger(total) ? total : source.count,
      source: manualCount > 0 ? `tour.${source.field}+tour.manualPassengerCount` : `tour.${source.field}`,
    };
  }
  const manifestCount = normalizePassengerCount(manifestPassengerCount);
  if (manifestCount > 0) {
    return manifestCount >= manualCount
      ? { count: manifestCount, source: 'tour_manifests.bookings' }
      : { count: manualCount, source: 'tour.manualPassengerCount' };
  }
  const legacyCount = normalizePassengerCount(tour?.currentParticipants);
  if (legacyCount !== null) {
    const total = legacyCount + manualCount;
    return {
      count: Number.isSafeInteger(total) ? total : legacyCount,
      source: manualCount > 0 ? 'tour.currentParticipants+tour.manualPassengerCount' : 'tour.currentParticipants',
    };
  }
  const participants = collectionSize(tour?.participants);
  if (participants > 0) {
    const total = participants + manualCount;
    return {
      count: Number.isSafeInteger(total) ? total : participants,
      source: manualCount > 0 ? 'tours.participants+tour.manualPassengerCount' : 'tours.participants',
    };
  }
  if (manualCount > 0) return { count: manualCount, source: 'tour.manualPassengerCount' };
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
    reportMismatch: reportCount !== null && resolved.source.startsWith('tour.sold')
      && resolved.count - (normalizePassengerCount(tour.manualPassengerCount) ?? 0) !== reportCount,
    loadPercent: known && capacity ? resolved.count / capacity * 100 : null,
    text: known ? `${resolved.count}${capacity ? ` / ${capacity}` : ''} ${label}` : 'Passenger count unavailable',
  };
}
