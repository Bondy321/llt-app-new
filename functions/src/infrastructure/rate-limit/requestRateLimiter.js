'use strict';

// @ts-check

const { createHash } = require('node:crypto');

const RATE_LIMIT_MAINTENANCE_INTERVAL_MS = 300000;
/** @type {Map<string, { count: number, resetTime: number }>} */
const rateLimitCache = new Map();
let lastRateLimitMaintenanceAt = 0;

/** @param {number} [now] */
const runLazyRateLimitMaintenance = (now = Date.now()) => {
  if (now - lastRateLimitMaintenanceAt < RATE_LIMIT_MAINTENANCE_INTERVAL_MS) return;
  lastRateLimitMaintenanceAt = now;
  for (const [key, record] of rateLimitCache.entries()) {
    if (now > record.resetTime) rateLimitCache.delete(key);
  }
};

/**
 * @param {string} key
 * @param {number} [maxRequests]
 * @param {number} [windowMs]
 */
const checkRateLimit = (key, maxRequests = 10, windowMs = 60000) => {
  const now = Date.now();
  runLazyRateLimitMaintenance(now);
  const record = rateLimitCache.get(key) || { count: 0, resetTime: now + windowMs };
  if (now > record.resetTime) {
    rateLimitCache.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (record.count >= maxRequests) return false;
  record.count += 1;
  rateLimitCache.set(key, record);
  return true;
};

/** @param {any} req */
const getRequestClientKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = Array.isArray(forwardedFor)
    ? forwardedFor[0] || 'unknown'
    : typeof forwardedFor === 'string'
      ? (forwardedFor.split(',')[0] || '').trim()
      : req.ip || req.connection?.remoteAddress || 'unknown';
  const explicitClientId = req.headers['x-client-id'];
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'unknown';
  const normalizedClientId = typeof explicitClientId === 'string' && explicitClientId.trim()
    ? explicitClientId.trim()
    : userAgent;
  return `${clientIp}:${normalizedClientId}`;
};

/** @param {unknown} value */
const hashRateLimitDimension = (value) => createHash('sha256')
  .update(String(value || 'unknown'))
  .digest('hex')
  .slice(0, 24);

module.exports = {
  checkRateLimit,
  getRequestClientKey,
  hashRateLimitDimension,
  runLazyRateLimitMaintenance,
};
