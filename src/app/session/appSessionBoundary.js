'use strict';

// @ts-check

const {
  validateClientAppSession,
  validateRemoteAppSession,
} = require('../../shared/contracts/generated/appSession');

const CLIENT_SESSION_KEYS = Object.freeze([
  'schemaVersion', 'sessionId', 'principalId', 'principalType', 'tourId', 'driverId',
  'issuedAtMs', 'expiresAtMs', 'sessionRevision',
]);

/** @param {unknown} value @returns {Record<string, unknown> | null} */
const projectValidatedAppSession = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!validateRemoteAppSession(value).valid) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (validateClientAppSession(record).valid) return record;
  return Object.fromEntries(CLIENT_SESSION_KEYS.map((key) => [key, record[key]]));
};

module.exports = { CLIENT_SESSION_KEYS, projectValidatedAppSession };
