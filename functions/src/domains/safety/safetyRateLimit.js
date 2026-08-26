'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { createDistributedLoginRateLimiter } = loadLegacyLibrary('loginRateLimiter');

const SAFETY_RATE_LIMIT_ROOT = 'safety_rate_limits/v1';
const SAFETY_RATE_LIMIT_MAX_REQUESTS = 20;
const SAFETY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** @type {null | ((...args: any[]) => Promise<boolean>)} */
let distributedSafetyRateLimiterInstance = null;

/** @type {(...args: any[]) => Promise<boolean>} */
const distributedSafetyRateLimiter = async (...args) => {
  if (distributedSafetyRateLimiterInstance) return distributedSafetyRateLimiterInstance(...args);
  const limiter = /** @type {(...args: any[]) => Promise<boolean>} */ (
    createDistributedLoginRateLimiter({
      database: admin.database(),
      rootPath: SAFETY_RATE_LIMIT_ROOT,
    })
  );
  distributedSafetyRateLimiterInstance = limiter;
  return limiter(...args);
};

/** @type {(...args: any[]) => Promise<boolean>} */
const checkSafetySubmissionRateLimit = async ({ authUid, limiter = distributedSafetyRateLimiter } = {}) => {
  const normalizedAuthUid = resolveTrimmedString(authUid);
  if (!normalizedAuthUid) return false;
  return limiter(
    `safety_uid_${hashRateLimitDimension(normalizedAuthUid)}`,
    SAFETY_RATE_LIMIT_MAX_REQUESTS,
    SAFETY_RATE_LIMIT_WINDOW_MS,
  );
};

module.exports = { checkSafetySubmissionRateLimit };
