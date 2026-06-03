const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const trimString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value) => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
);

const toRealtimeKeySegment = (value) => {
  const trimmed = trimString(value);
  if (!trimmed) return null;

  return trimmed.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  );
};

const parseBooleanFlag = (argv, name, defaultValue) => {
  const positiveFlag = `--${name}`;
  const negativeFlag = `--no-${name}`;
  let result = defaultValue;

  argv.forEach((arg) => {
    if (arg === positiveFlag) {
      result = true;
      return;
    }

    if (arg === negativeFlag) {
      result = false;
      return;
    }

    if (arg.startsWith(`${positiveFlag}=`)) {
      const raw = arg.slice(`${positiveFlag}=`.length).trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(raw)) result = true;
      if (['false', '0', 'no', 'n'].includes(raw)) result = false;
    }
  });

  return result;
};

const parsePositiveInteger = (value, { defaultValue = null, max = Number.POSITIVE_INFINITY } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
};

const getOptionValue = (argv, name) => {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

module.exports = {
  getOptionValue,
  isPlainObject,
  parseBooleanFlag,
  parsePositiveInteger,
  toRealtimeKeySegment,
  trimString,
};
