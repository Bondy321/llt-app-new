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

module.exports = { deriveTourDateIndexUpdate, parseDateOnly };
