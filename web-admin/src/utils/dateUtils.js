const UK_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC_STRING_REGEX = /^\d+$/;

const buildValidationError = (code, message, input, expectedFormat) => ({
  code,
  message,
  input,
  expectedFormat,
});

const normalizeToNoon = (date) => {
  const normalized = new Date(date.getTime());
  normalized.setHours(12, 0, 0, 0);
  return normalized;
};

const hasExactDateParts = (date, year, monthIndex, day) => (
  date.getFullYear() === year &&
  date.getMonth() === monthIndex &&
  date.getDate() === day
);

const parseWithPattern = (input, pattern, expectedFormat, formatName, yearIdx, monthIdx, dayIdx) => {
  if (typeof input !== 'string') {
    return {
      success: false,
      error: buildValidationError(
        'TYPE_ERROR',
        `Date value must be a string in ${expectedFormat} format.`,
        input,
        expectedFormat,
      ),
    };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return {
      success: false,
      error: buildValidationError(
        'REQUIRED',
        `Date value is required in ${expectedFormat} format.`,
        input,
        expectedFormat,
      ),
    };
  }

  const match = pattern.exec(trimmed);
  if (!match) {
    return {
      success: false,
      error: buildValidationError(
        'INVALID_FORMAT',
        `Expected date format ${expectedFormat}.`,
        input,
        expectedFormat,
      ),
    };
  }

  const year = Number(match[yearIdx]);
  const month = Number(match[monthIdx]);
  const day = Number(match[dayIdx]);
  const monthIndex = month - 1;
  const parsed = new Date(year, monthIndex, day);

  if (!hasExactDateParts(parsed, year, monthIndex, day)) {
    return {
      success: false,
      error: buildValidationError(
        'INVALID_DATE',
        'Date is not a real calendar day.',
        input,
        expectedFormat,
      ),
    };
  }

  return {
    success: true,
    format: formatName,
    date: normalizeToNoon(parsed),
  };
};

const parseNumericTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }

  if (typeof value === 'string' && NUMERIC_STRING_REGEX.test(value.trim())) {
    return new Date(Number(value.trim()));
  }

  return null;
};

const parseIsoTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ISO_DATETIME_REGEX.test(trimmed)) return null;

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs);
};

export const parseUKDateStrict = (input) => (
  parseWithPattern(input, UK_DATE_REGEX, 'dd/MM/yyyy', 'UK', 3, 2, 1)
);

export const parseISODateStrict = (input) => (
  parseWithPattern(input, ISO_DATE_REGEX, 'yyyy-MM-dd', 'ISO', 1, 2, 3)
);

export const parseTimestampStrict = (input) => {
  if (input === null || input === undefined || input === '') {
    return {
      success: false,
      error: buildValidationError(
        'REQUIRED',
        'Timestamp value is required in ISO-8601 or epoch milliseconds format.',
        input,
        'ISO-8601 datetime or epoch milliseconds',
      ),
    };
  }

  const numericDate = parseNumericTimestamp(input);
  if (numericDate && Number.isFinite(numericDate.getTime())) {
    return { success: true, date: numericDate, format: 'EPOCH_MS' };
  }

  const isoDate = parseIsoTimestamp(input);
  if (isoDate && Number.isFinite(isoDate.getTime())) {
    return { success: true, date: isoDate, format: 'ISO_DATETIME' };
  }

  return {
    success: false,
    error: buildValidationError(
      'INVALID_FORMAT',
      'Timestamp must be an ISO-8601 datetime with timezone or epoch milliseconds.',
      input,
      'ISO-8601 datetime or epoch milliseconds',
    ),
  };
};

export const toEpochMsStrict = (input) => {
  const parsed = parseTimestampStrict(input);
  return parsed.success ? parsed.date.getTime() : null;
};

export const nowAsISOString = () => new Date().toISOString();

export const formatDateToUK = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

export const formatDateToISO = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
};

export const formatDateForDisplay = (value, fallback = '-') => {
  if (!value) return fallback;

  const ukParsed = parseUKDateStrict(value);
  if (ukParsed.success) {
    return formatDateToUK(ukParsed.date);
  }

  const isoParsed = parseISODateStrict(value);
  if (isoParsed.success) {
    return formatDateToUK(isoParsed.date);
  }

  return fallback;
};


export const getCurrentISODateStamp = () => nowAsISOString().split('T')[0];

export const formatLongDateForDisplay = (value, fallback = '-') => {
  const dateValue = value instanceof Date ? value : null;
  const parsed = dateValue && Number.isFinite(dateValue.getTime())
    ? { success: true, date: dateValue }
    : parseTimestampStrict(value);

  if (!parsed.success) return fallback;

  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(parsed.date);
};

export const formatTimeForDisplay = (value, fallback = '-') => {
  const parsed = parseTimestampStrict(value);
  if (!parsed.success) return fallback;

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed.date);
};

export const formatDateTimeForDisplay = (value, fallback = '-') => {
  const parsed = parseTimestampStrict(value);
  if (!parsed.success) return fallback;

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed.date);
};

export const formatDateRangeForDisplay = (startDate, endDate, fallback = '-') => {
  const formattedStart = formatDateForDisplay(startDate, '');
  const formattedEnd = formatDateForDisplay(endDate, '');

  if (!formattedStart && !formattedEnd) return fallback;
  if (!formattedEnd || formattedStart === formattedEnd) return formattedStart || fallback;
  return `${formattedStart} - ${formattedEnd}`;
};
