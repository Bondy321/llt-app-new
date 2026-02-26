import { parseISODateStrict, parseUKDateStrict } from './dateUtils.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeToStartOfDay = (date) => {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
};

export const parseTriageDate = (value) => {
  const ukParsed = parseUKDateStrict(value);
  if (ukParsed.success) {
    return { success: true, date: ukParsed.date, format: 'UK' };
  }

  const isoParsed = parseISODateStrict(value);
  if (isoParsed.success) {
    return { success: true, date: isoParsed.date, format: 'ISO' };
  }

  return {
    success: false,
    error: ukParsed.error || isoParsed.error,
  };
};

export const calculateDayDelta = (date, now = new Date()) => {
  const startOfToday = normalizeToStartOfDay(now);
  const startOfTarget = normalizeToStartOfDay(date);
  return Math.round((startOfTarget - startOfToday) / MS_PER_DAY);
};

export const isWithinTriageWindow = (
  dayDelta,
  {
    maxFutureDays = 7,
    maxOverdueDays = 7,
  } = {},
) => dayDelta <= maxFutureDays && dayDelta >= (maxOverdueDays * -1);

export const getUrgencyBadge = (dayDelta) => {
  if (dayDelta < 0) {
    return { label: `${Math.abs(dayDelta)}d overdue`, color: 'red' };
  }

  if (dayDelta === 0) {
    return { label: 'Today', color: 'red' };
  }

  if (dayDelta <= 2) {
    return { label: `In ${dayDelta}d`, color: 'orange' };
  }

  return { label: `In ${dayDelta}d`, color: 'yellow' };
};

export const getTriageMeta = (dateValue, options = {}) => {
  const parsed = parseTriageDate(dateValue);
  if (!parsed.success) return null;

  const dayDelta = calculateDayDelta(parsed.date, options.now);
  if (!isWithinTriageWindow(dayDelta, options)) return null;

  return {
    parsedDate: parsed.date,
    dayDelta,
    ...getUrgencyBadge(dayDelta),
  };
};
