function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  let year; let month; let day;
  if (match) [, day, month, year] = match.map(Number);
  else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    [, year, month, day] = match.map(Number);
  }
  const epochMs = Date.UTC(year, month - 1, day);
  const date = new Date(epochMs);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? epochMs : null;
}

function deriveTourDateIndexUpdate(tour) {
  if (!tour || typeof tour !== 'object') return null;
  const startDateEpochMs = parseDateOnly(tour.startDate);
  const endDateEpochMs = parseDateOnly(tour.endDate || tour.startDate);
  if (startDateEpochMs === null || endDateEpochMs === null || endDateEpochMs < startDateEpochMs) {
    return (tour.startDateEpochMs == null && tour.endDateEpochMs == null)
      ? null
      : { startDateEpochMs: null, endDateEpochMs: null };
  }
  if (tour.startDateEpochMs === startDateEpochMs && tour.endDateEpochMs === endDateEpochMs) return null;
  return { startDateEpochMs, endDateEpochMs };
}

// Derive inside the transaction: a delayed date trigger or maintenance scan
// must not overwrite indexes for dates that changed since its initial read.
async function reconcileTourDateIndexes(tourRef) {
  if (typeof tourRef?.transaction !== 'function') throw new Error('A tour reference is required');
  const result = await tourRef.transaction((current) => {
    // The SDK can first invoke this with an empty local cache. Returning null
    // lets its compare-and-set load/retry the existing server value; aborting
    // here would silently skip an uncached tour. An absent tour stays absent.
    if (current === null) return null;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const update = deriveTourDateIndexUpdate(current);
    return update ? { ...current, ...update } : undefined;
  }, undefined, false);
  return { committed: result?.committed === true && Boolean(result.snapshot?.val?.()), snapshot: result?.snapshot };
}

module.exports = { deriveTourDateIndexUpdate, parseDateOnly, reconcileTourDateIndexes };
