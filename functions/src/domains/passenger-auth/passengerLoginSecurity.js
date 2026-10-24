'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { createDistributedLoginRateLimiter } = loadLegacyLibrary('loginRateLimiter');

/** @type {null | ((...args: any[]) => Promise<boolean>)} */
let distributedLoginRateLimiterInstance = null;

/** @type {(...args: any[]) => Promise<boolean>} */
const distributedLoginRateLimiter = async (...args) => {
  if (distributedLoginRateLimiterInstance) return distributedLoginRateLimiterInstance(...args);
  const limiter = /** @type {(...args: any[]) => Promise<boolean>} */ (
    createDistributedLoginRateLimiter({ database: admin.database() })
  );
  distributedLoginRateLimiterInstance = limiter;
  return limiter(...args);
};

/** @type {(...args: any[]) => Promise<any>} */
const checkPassengerLoginRateLimits = async ({
  authUid,
  clientKey,
  bookingRef,
  email,
  limiter = distributedLoginRateLimiter,
}) => {
  const authDimension = hashRateLimitDimension(authUid);
  const networkDimension = hashRateLimitDimension(clientKey);
  const credentialDimension = hashRateLimitDimension(`${bookingRef}:${email}`);
  const accountDimension = hashRateLimitDimension(bookingRef);
  const checks = [
    { scope: 'credential', key: `passenger_credential_${credentialDimension}`, maxRequests: 8 },
    { scope: 'account', key: `passenger_account_${accountDimension}`, maxRequests: 24 },
    { scope: 'network', key: `passenger_network_${networkDimension}`, maxRequests: 300 },
  ];
  const results = await Promise.all(checks.map(async (check) => ({
    ...check,
    allowed: await limiter(check.key, check.maxRequests, 60000),
  })));
  const denied = results.find((check) => !check.allowed);
  if (denied) return { allowed: false, scope: denied.scope, authDimension, networkDimension };
  return { allowed: true, authDimension, networkDimension };
};

const { getTrustedRequestNetworkKey } = require('../../infrastructure/rate-limit/distributedRequestLimiter');

module.exports = {
  checkPassengerLoginRateLimits,
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
};
