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
  const source = /** @type {Record<string, unknown>} */ (value);
  const record = /** @type {Record<string, unknown>} */ ({
    ...source,
    ...(source.status === 'active' && source.principalType === 'passenger'
      && !Object.prototype.hasOwnProperty.call(source, 'driverId') ? { driverId: null } : {}),
    ...(source.status === 'active' && source.principalType === 'driver'
      && !Object.prototype.hasOwnProperty.call(source, 'tourId') ? { tourId: null } : {}),
  });
  if (!validateRemoteAppSession(record).valid) return null;
  if (validateClientAppSession(record).valid) return record;
  return Object.fromEntries(CLIENT_SESSION_KEYS.map((key) => [key, record[key]]));
};

module.exports = { CLIENT_SESSION_KEYS, projectValidatedAppSession };
