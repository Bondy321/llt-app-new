const TIME_24H_REGEX = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const TIME_12H_REGEX = /^(\d{1,2}):([0-5]\d)\s*([AP]M)$/;
const ISO_DATE_REGEX = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const UK_DATE_REGEX = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

const normalizePickupTimeInput = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
};

const parsePickupTime = (pickupTimeRaw) => {
  const normalized = normalizePickupTimeInput(pickupTimeRaw);
  if (!normalized) {
    return { success: false, error: 'EMPTY_TIME' };
  }

  const as24Hour = normalized.match(TIME_24H_REGEX);
  if (as24Hour) {
    return {
      success: true,
      parsed: {
        hours: Number(as24Hour[1]),
        minutes: Number(as24Hour[2]),
        sourceFormat: '24H',
        normalized,
      },
    };
  }

  const as12Hour = normalized.match(TIME_12H_REGEX);
  if (as12Hour) {
    const rawHours = Number(as12Hour[1]);
    const minutes = Number(as12Hour[2]);
    const meridiem = as12Hour[3];

    if (rawHours < 1 || rawHours > 12) {
      return { success: false, error: 'INVALID_HOUR_12H' };
    }

    const normalizedHours = rawHours % 12 + (meridiem === 'PM' ? 12 : 0);

    return {
      success: true,
      parsed: {
        hours: normalizedHours,
        minutes,
        sourceFormat: '12H',
        normalized,
      },
    };
  }

  return { success: false, error: 'UNSUPPORTED_TIME_FORMAT', normalized };
};

const parseDateContext = (dateRaw) => {
  if (typeof dateRaw !== 'string' || !dateRaw.trim()) return null;
  const value = dateRaw.trim();

  const ukMatch = value.match(UK_DATE_REGEX);
  if (ukMatch) {
    const day = Number(ukMatch[1]);
    const month = Number(ukMatch[2]);
    const year = Number(ukMatch[3]);
    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() === year
      && candidate.getMonth() === month - 1
      && candidate.getDate() === day
    ) {
      return candidate;
    }
  }

  const isoMatch = value.match(ISO_DATE_REGEX);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() === year
      && candidate.getMonth() === month - 1
      && candidate.getDate() === day
    ) {
      return candidate;
    }
  }

  return null;
};

const parsePickupDateTime = ({ pickupTime, pickupDate, now = new Date() }) => {
  const timeResult = parsePickupTime(pickupTime);
  if (!timeResult.success) {
    return { success: false, reason: 'TIME_PARSE_FAILED', timeError: timeResult.error };
  }

  const pickup = new Date(now);
  const parsedDate = parseDateContext(pickupDate);

  if (parsedDate) {
    pickup.setFullYear(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
  }

  pickup.setHours(timeResult.parsed.hours, timeResult.parsed.minutes, 0, 0);

  if (!parsedDate && pickup < now) {
    pickup.setDate(pickup.getDate() + 1);
  }

  return {
    success: true,
    pickup,
    hasExplicitDate: Boolean(parsedDate),
    normalizedTime: timeResult.parsed.normalized,
  };
};

const getPickupCountdownState = ({ pickupTime, pickupDate, now = new Date() }) => {
  const pickupDateTimeResult = parsePickupDateTime({ pickupTime, pickupDate, now });
  if (!pickupDateTimeResult.success) {
    return {
      mode: 'invalid',
      reason: pickupDateTimeResult.timeError || pickupDateTimeResult.reason,
    };
  }

  const diff = pickupDateTimeResult.pickup.getTime() - now.getTime();

  if (diff < 0) {
    return { mode: 'passed' };
  }

  const hoursLeft = Math.floor(diff / (1000 * 60 * 60));
  const minutesLeft = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const secondsLeft = Math.floor((diff % (1000 * 60)) / 1000);

  return {
    mode: 'countdown',
    hoursLeft,
    minutesLeft,
    secondsLeft,
  };
};

module.exports = {
  normalizePickupTimeInput,
  parsePickupTime,
  parsePickupDateTime,
  getPickupCountdownState,
};
