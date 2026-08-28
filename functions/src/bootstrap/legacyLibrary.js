'use strict';

// @ts-check

const path = require('node:path');

const ALLOWED_LIBRARY_MODULES = new Set([
  'appSessionCleanup',
  'appSession',
  'appSessionAccess',
  'appSessionLock',
  'chatPresenceProjection',
  'driverLocationExpiryCleanup',
  'driverLocationProjection',
  'driverTourPackExpiryCleanup',
  'driverTourPackOperations',
  'driverTourPackPublisher',
  'loginRateLimiter',
  'manifestPassengers',
  'managementOidc',
  'passengerIdentity',
  'tourDateIndex',
]);

/**
 * Temporary typed boundary around pre-architecture CommonJS modules. Domains
 * should replace these entries with focused, checked modules as each library
 * is migrated; arbitrary paths are deliberately rejected.
 *
 * @param {string} moduleName
 * @returns {any}
 */
const loadLegacyLibrary = (moduleName) => {
  if (!ALLOWED_LIBRARY_MODULES.has(moduleName)) {
    throw new Error(`Unapproved legacy Functions library: ${moduleName}`);
  }
  return require(path.join(__dirname, '../../lib', moduleName));
};

module.exports = { loadLegacyLibrary };
