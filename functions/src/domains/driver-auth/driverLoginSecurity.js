'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { enforceLoginAppCheck } = require('../../infrastructure/auth/loginAppCheckGate');
const { log } = require('../../infrastructure/logging/safeLogger');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const {
  distributedLoginRateLimiter: sharedDistributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
} = require('../passenger-auth/public');
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
const checkDriverLoginRateLimits = async ({
  authUid,
  clientKey,
  driverId,
  limiter = distributedLoginRateLimiter,
}) => {
  const authDimension = hashRateLimitDimension(authUid);
  const networkDimension = hashRateLimitDimension(clientKey);
  const credentialDimension = hashRateLimitDimension(driverId);
  const checks = [
    { scope: 'credential', key: `driver_credential_${authDimension}_${credentialDimension}`, maxRequests: 8 },
    { scope: 'account', key: `driver_account_${credentialDimension}`, maxRequests: 24 },
    { scope: 'network', key: `driver_network_${networkDimension}`, maxRequests: 200 },
  ];
  const results = await Promise.all(checks.map(async (check) => ({
    ...check,
    allowed: await limiter(check.key, check.maxRequests, 60000),
  })));
  const denied = results.find((check) => !check.allowed);
  if (denied) return { allowed: false, scope: denied.scope, authDimension, networkDimension };
  return { allowed: true, authDimension, networkDimension };
};

/** @type {(...args: any[]) => Promise<any>} */
const authorizeDriverLoginSecurity = async ({ req, authUid, driverId }) => {
  const networkKey = getTrustedRequestNetworkKey(req);
  const networkDimension = hashRateLimitDimension(networkKey);
  try {
    const appCheckValid = await enforceLoginAppCheck({ req, networkDimension, loginType: 'Driver' });
    if (!appCheckValid) return { allowed: false, status: 401, reason: 'INVALID_CREDENTIALS' };
  } catch (configurationError) {
    log.error('Driver login disabled by unsafe App Check configuration', configurationError, { networkDimension });
    return { allowed: false, status: 503, reason: 'SERVICE_UNAVAILABLE' };
  }
  try {
    const rateLimit = await checkDriverLoginRateLimits({
      authUid,
      clientKey: networkKey,
      driverId,
      limiter: sharedDistributedLoginRateLimiter,
    });
    if (rateLimit.allowed) return { allowed: true, networkDimension };
    log.warn('Driver login rate limit exceeded', {
      scope: rateLimit.scope,
      authDimension: rateLimit.authDimension,
      driverId,
      networkDimension: rateLimit.networkDimension,
    });
    return { allowed: false, status: 429, reason: 'TRY_AGAIN_LATER' };
  } catch (rateLimitError) {
    log.error('Driver login disabled because distributed rate limiting failed', rateLimitError, { networkDimension });
    return { allowed: false, status: 503, reason: 'SERVICE_UNAVAILABLE' };
  }
};

module.exports = { authorizeDriverLoginSecurity, checkDriverLoginRateLimits };
