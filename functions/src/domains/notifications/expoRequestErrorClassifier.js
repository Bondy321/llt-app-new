'use strict';

// @ts-check

const RETRYABLE_HTTP_STATUSES = new Set([429]);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);
const PRECONNECT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
]);
const AMBIGUOUS_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
]);
const RETRYABLE_EXPO_CODES = new Set([
  'ExpoServerError',
  'InternalError',
  'MessageRateExceeded',
]);
const CONFIGURATION_EXPO_CODES = new Set([
  'InvalidCredentials',
  'MismatchSenderId',
]);
const PERMANENT_EXPO_CODES = new Set([
  ...CONFIGURATION_EXPO_CODES,
  'InvalidRequest',
  'MessageTooBig',
  'PayloadTooLarge',
  'UnsupportedField',
]);

/** @param {unknown} value */
const normalizedCode = (value) => (typeof value === 'string' ? value.trim() : '');

/** @param {any} error */
const findExpoCode = (error) => {
  const candidates = [
    error?.code,
    error?.details?.error,
    error?.details?.code,
    error?.others?.error,
  ].map(normalizedCode).filter(Boolean);
  return candidates.find((code) => RETRYABLE_EXPO_CODES.has(code)
    || PERMANENT_EXPO_CODES.has(code)) || candidates[0] || '';
};

/**
 * Classifies only failures thrown by expo-server-sdk 4.x request submission.
 * HTTP responses prove that Expo rejected the request. A transport timeout or
 * reset does not prove whether the request reached Expo, so it is never retried.
 * @param {any} error
 */
// eslint-disable-next-line complexity -- precedence is the safety boundary between retry and possible duplication
const classifyExpoRequestError = (error) => {
  const statusCode = Number(error?.statusCode);
  const code = findExpoCode(error);
  const transportCode = normalizedCode(error?.code).toUpperCase();
  const type = normalizedCode(error?.type).toLowerCase();

  if (statusCode === 429 || (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599)) {
    return {
      outcome: 'retryable',
      safeErrorCode: statusCode === 429 ? 'EXPO_RATE_LIMITED' : `EXPO_HTTP_${statusCode}`,
      configuration: false,
    };
  }
  if (RETRYABLE_EXPO_CODES.has(code)) {
    return { outcome: 'retryable', safeErrorCode: code.slice(0, 80), configuration: false };
  }
  if (PRECONNECT_ERROR_CODES.has(transportCode)) {
    return { outcome: 'retryable', safeErrorCode: transportCode, configuration: false };
  }

  if (PERMANENT_HTTP_STATUSES.has(statusCode)
    || (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499 && statusCode !== 408 && statusCode !== 429)
    || PERMANENT_EXPO_CODES.has(code)) {
    const configuration = statusCode === 401 || statusCode === 403 || CONFIGURATION_EXPO_CODES.has(code);
    const safeErrorCode = configuration
      ? 'INVALID_CREDENTIALS'
      : (statusCode === 413 || ['MessageTooBig', 'PayloadTooLarge'].includes(code)
        ? 'PAYLOAD_TOO_LARGE'
        : (code || (Number.isInteger(statusCode) ? `EXPO_HTTP_${statusCode}` : 'INVALID_REQUEST')));
    return { outcome: 'permanent', safeErrorCode: safeErrorCode.slice(0, 80), configuration };
  }

  if (type === 'request-timeout' || type === 'body-timeout' || AMBIGUOUS_ERROR_CODES.has(transportCode)) {
    return { outcome: 'unknown', safeErrorCode: 'SUBMISSION_UNKNOWN', configuration: false };
  }

  return { outcome: 'unknown', safeErrorCode: 'SUBMISSION_UNKNOWN', configuration: false };
};

module.exports = {
  AMBIGUOUS_ERROR_CODES,
  CONFIGURATION_EXPO_CODES,
  PERMANENT_EXPO_CODES,
  PRECONNECT_ERROR_CODES,
  RETRYABLE_EXPO_CODES,
  RETRYABLE_HTTP_STATUSES,
  classifyExpoRequestError,
};
