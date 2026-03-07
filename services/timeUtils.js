const asValidDateFromParts = ({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }) => {
  const monthIndex = month - 1;
  const candidate = new Date(year, monthIndex, day, hour, minute, second, millisecond);

  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== monthIndex ||
    candidate.getDate() !== day ||
    candidate.getHours() !== hour ||
    candidate.getMinutes() !== minute ||
    candidate.getSeconds() !== second ||
    candidate.getMilliseconds() !== millisecond
  ) {
    return null;
  }

  return candidate;
};

const parseStrictDateStringMs = (value) => {
  const isoDateTimeWithZoneMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (isoDateTimeWithZoneMatch) {
    const parsedMs = Date.parse(value);
    return Number.isFinite(parsedMs) ? parsedMs : null;
  }

  const isoDateTimeNoZoneMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (isoDateTimeNoZoneMatch) {
    const [
      ,
      rawYear,
      rawMonth,
      rawDay,
      rawHour,
      rawMinute,
      rawSecond = '0',
      rawMillisecond = '0',
    ] = isoDateTimeNoZoneMatch;

    const date = asValidDateFromParts({
      year: Number(rawYear),
      month: Number(rawMonth),
      day: Number(rawDay),
      hour: Number(rawHour),
      minute: Number(rawMinute),
      second: Number(rawSecond),
      millisecond: Number(rawMillisecond.padEnd(3, '0')),
    });

    return date ? date.getTime() : null;
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDateMatch) {
    const [, rawYear, rawMonth, rawDay] = isoDateMatch;
    const date = asValidDateFromParts({
      year: Number(rawYear),
      month: Number(rawMonth),
      day: Number(rawDay),
    });
    return date ? date.getTime() : null;
  }

  const ukDateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (ukDateMatch) {
    const [, rawDay, rawMonth, rawYear] = ukDateMatch;
    const date = asValidDateFromParts({
      year: Number(rawYear),
      month: Number(rawMonth),
      day: Number(rawDay),
    });
    return date ? date.getTime() : null;
  }

  return null;
};

const parseTimestampMs = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericMs = Number(trimmed);
  if (Number.isFinite(numericMs) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return numericMs;
  }

  return parseStrictDateStringMs(trimmed);
};

const getMinutesAgo = (value, nowMs = Date.now()) => {
  const parsedMs = parseTimestampMs(value);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }

  return Math.floor((nowMs - parsedMs) / 60000);
};

module.exports = {
  parseTimestampMs,
  getMinutesAgo,
};
