// Date contract: see docs/date-contract.md for accepted formats and guardrails.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeToNoon = (date) => {
  const normalized = new Date(date);
  normalized.setHours(12, 0, 0, 0);
  return normalized;
};

const isSameDateParts = (date, year, monthIndex, day) => {
  return (
    date.getFullYear() === year &&
    date.getMonth() === monthIndex &&
    date.getDate() === day
  );
};

const asCalendarDayStampUtc = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
};

const parseSupportedStartDate = (rawDate) => {
  if (!rawDate) return null;

  if (rawDate instanceof Date) {
    if (Number.isNaN(rawDate.getTime())) return null;
    return normalizeToNoon(rawDate);
  }

  if (typeof rawDate !== 'string') {
    return null;
  }

  const trimmed = rawDate.trim();

  const ukMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (ukMatch) {
    const day = Number(ukMatch[1]);
    const month = Number(ukMatch[2]);
    const year = Number(ukMatch[3]);
    const monthIndex = month - 1;
    const parsed = new Date(year, monthIndex, day);

    if (!isSameDateParts(parsed, year, monthIndex, day)) {
      return null;
    }

    return normalizeToNoon(parsed);
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const monthIndex = month - 1;
    const parsed = new Date(year, monthIndex, day);

    if (!isSameDateParts(parsed, year, monthIndex, day)) {
      return null;
    }

    return normalizeToNoon(parsed);
  }

  return null;
};

const getTourDayContext = ({ startDate, itineraryDays, now = new Date() }) => {
  const parsedStart = parseSupportedStartDate(startDate);

  if (!parsedStart) {
    return { status: 'INVALID_START_DATE' };
  }

  if (!Array.isArray(itineraryDays) || itineraryDays.length === 0) {
    return { status: 'NO_ITINERARY_DAYS' };
  }

  const startStamp = asCalendarDayStampUtc(parsedStart);
  const todayStamp = asCalendarDayStampUtc(now);

  if (startStamp === null || todayStamp === null) {
    return { status: 'INVALID_DATE_CONTEXT' };
  }

  const dayIndex = Math.round((todayStamp - startStamp) / MS_PER_DAY);

  if (dayIndex < 0) {
    return {
      status: 'FUTURE',
      daysToGo: Math.abs(dayIndex),
      dayIndex,
    };
  }

  if (dayIndex >= itineraryDays.length) {
    return {
      status: 'COMPLETED',
      dayIndex,
    };
  }

  return {
    status: 'ACTIVE',
    dayIndex,
    dayNumber: dayIndex + 1,
    data: itineraryDays[dayIndex],
  };
};

module.exports = {
  parseSupportedStartDate,
  getTourDayContext,
};
