// @ts-check

import { validateRemoteAppSession } from '../contracts/generated/appSession.js';

/** @param {unknown} value */
export const isValidRemoteAppSession = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = /** @type {Record<string, unknown>} */ (value);
  const normalized = {
    ...source,
    ...(source.status === 'active' && source.principalType === 'passenger'
      && !Object.prototype.hasOwnProperty.call(source, 'driverId') ? { driverId: null } : {}),
    ...(source.status === 'active' && source.principalType === 'driver'
      && !Object.prototype.hasOwnProperty.call(source, 'tourId') ? { tourId: null } : {}),
  };
  return validateRemoteAppSession(normalized).valid;
};
