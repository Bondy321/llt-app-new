'use strict';

/** @typedef {Record<string, unknown>} LogData */
/** @typedef {{ log: (...values: unknown[]) => void, error: (...values: unknown[]) => void, warn: (...values: unknown[]) => void }} ConsoleAdapter */

/** @param {unknown} value */
const maskIdentifier = (value) => {
  if (value === null || value === undefined) return value;
  const asString = String(value);
  if (asString.length <= 4) return '***';
  return `${asString.slice(0, 2)}***${asString.slice(-2)}`;
};

/** @param {unknown} key */
const isSensitiveLogKey = (key) => {
  const normalized = String(key || '').toLowerCase();
  return /(token|bookingref|clientkey|userid|senderid|senderuid|authuid|participantid|recipientid|email|clientip|ipaddress)/u.test(normalized);
};

/**
 * @param {unknown} key
 * @param {unknown} value
 * @returns {unknown}
 */
const sanitizeLogValue = (key, value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => (
      isSensitiveLogKey(key) && (typeof item !== 'object' || item === null)
        ? maskIdentifier(item)
        : sanitizeLogValue(key, item)
    ));
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce(/** @param {LogData} sanitized */ (sanitized, [childKey, childValue]) => {
      sanitized[childKey] = sanitizeLogValue(childKey, childValue);
      return sanitized;
    }, /** @type {LogData} */ ({}));
  }
  if (/token/u.test(String(key || '').toLowerCase())) return '[redacted]';
  if (isSensitiveLogKey(key)) return maskIdentifier(value);
  return value;
};

/** @param {LogData} [data] @returns {LogData} */
const sanitizeLogData = (data = {}) => /** @type {LogData} */ (sanitizeLogValue('', data) || {});

/** @param {unknown} value */
const sanitizeLogText = (value) => {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted-email]')
    .replace(/([?&]token=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\bExponentPushToken\[[^\]]+\]/gu, 'ExponentPushToken[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[redacted-jwt]');
};

/**
 * @param {{ consoleAdapter?: ConsoleAdapter, now?: () => string }} [options]
 */
const createSafeLogger = ({ consoleAdapter = console, now = () => new Date().toISOString() } = {}) => ({
  /** @param {string} message @param {LogData} [data] */
  info: (message, data = {}) => consoleAdapter.log(JSON.stringify({
    level: 'info', message, ...sanitizeLogData(data), timestamp: now(),
  })),
  /** @param {string} message @param {unknown} [error] @param {LogData} [data] */
  error: (message, error = {}, data = {}) => consoleAdapter.error(JSON.stringify({
    level: 'error',
    message,
    error: sanitizeLogText((error && typeof error === 'object' && 'message' in error) ? error.message : (error || null)),
    stack: (error && typeof error === 'object' && 'stack' in error && error.stack)
      ? sanitizeLogText(error.stack)
      : null,
    ...sanitizeLogData(data),
    timestamp: now(),
  })),
  /** @param {string} message @param {LogData} [data] */
  warn: (message, data = {}) => consoleAdapter.warn(JSON.stringify({
    level: 'warn', message, ...sanitizeLogData(data), timestamp: now(),
  })),
});

const log = createSafeLogger();

module.exports = {
  createSafeLogger,
  isSensitiveLogKey,
  log,
  maskIdentifier,
  sanitizeLogData,
  sanitizeLogText,
  sanitizeLogValue,
};
