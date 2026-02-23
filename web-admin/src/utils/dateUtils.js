const UK_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

const buildValidationError = (code, message, input, expectedFormat) => ({
  code,
  message,
  input,
  expectedFormat,
});

const normalizeToNoon = (date) => {
  const normalized = new Date(date);
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

export const parseUKDateStrict = (input) => (
  parseWithPattern(input, UK_DATE_REGEX, 'dd/MM/yyyy', 'UK', 3, 2, 1)
);

export const parseISODateStrict = (input) => (
  parseWithPattern(input, ISO_DATE_REGEX, 'yyyy-MM-dd', 'ISO', 1, 2, 3)
);

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

export const formatDateRangeForDisplay = (startDate, endDate, fallback = '-') => {
  const formattedStart = formatDateForDisplay(startDate, '');
  const formattedEnd = formatDateForDisplay(endDate, '');

  if (!formattedStart && !formattedEnd) return fallback;
  if (!formattedEnd || formattedStart === formattedEnd) return formattedStart || fallback;
  return `${formattedStart} - ${formattedEnd}`;
};
