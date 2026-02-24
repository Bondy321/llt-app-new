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

  const parsedMs = new Date(trimmed).getTime();
  return Number.isFinite(parsedMs) ? parsedMs : null;
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
