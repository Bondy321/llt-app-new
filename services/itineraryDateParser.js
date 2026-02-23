// Date contract: see docs/date-contract.md for accepted formats and guardrails.
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

module.exports = {
  parseSupportedStartDate,
};
