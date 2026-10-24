'use strict';
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { hashRateLimitDimension } = require('./requestRateLimiter');
const { createDistributedLoginRateLimiter } = loadLegacyLibrary('loginRateLimiter');

// Cloud Run appends client and platform hops; do not include caller-controlled
// x-client-id, User-Agent or the leftmost spoofable forwarding prefix in quotas.
const getTrustedRequestNetworkKey = req => {
  const forwarded = req.headers?.['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded : [forwarded])
    .flatMap(value => typeof value === 'string' ? value.split(',') : [])
    .map(value => value.trim()).filter(Boolean);
  return String(chain.length >= 2 ? chain[chain.length - 2]
    : chain[0] || req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown').trim().slice(0, 128) || 'unknown';
};

const checkDistributedRequestLimit = async ({ req, authUid, action, maxRequests = 30,
  networkMaxRequests = Math.max(300, maxRequests * 100), db = admin.database(), limiter }) => {
  if (!/^[a-z_]{1,50}$/.test(action) || typeof authUid !== 'string' || !authUid) return false;
  const consume = limiter || createDistributedLoginRateLimiter({ database: db });
  try {
    const results = await Promise.all([
      consume(`api_${action}_uid_${hashRateLimitDimension(authUid)}`, maxRequests, 60000),
      consume(`api_${action}_network_${hashRateLimitDimension(getTrustedRequestNetworkKey(req))}`, networkMaxRequests, 60000),
    ]);
    return results.every(Boolean);
  } catch {
    // Quota service unavailable is retryable, never permission to skip quotas.
    return false;
  }
};
module.exports = { checkDistributedRequestLimit, getTrustedRequestNetworkKey };
