'use strict';

const LOGIN_RATE_LIMIT_ROOT = 'login_rate_limits/v1';
const LOGIN_RATE_LIMIT_RECORD_VERSION = 1;
const LOGIN_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_BATCH_SIZE = 500;
const LOGIN_RATE_LIMIT_CLEANUP_MAX_BATCHES = 5;

const assertPositiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
};

const assertBucketKey = (key) => {
  if (typeof key !== 'string' || !/^[a-z0-9_]{1,180}$/.test(key)) {
    throw new TypeError('Login rate-limit bucket key must be a bounded opaque key');
  }
};

/**
 * Creates an atomic limiter backed by Realtime Database transactions. Every
 * Functions instance points at the same records, so scaling or cold starts do
 * not reset the authoritative quota. Bucket keys must already contain only
 * hashes/labels; raw credentials and network identifiers are never persisted.
 */
const createDistributedLoginRateLimiter = ({
  database,
  rootPath = LOGIN_RATE_LIMIT_ROOT,
  now = () => Date.now(),
  retentionMs = LOGIN_RATE_LIMIT_RETENTION_MS,
} = {}) => {
  if (!database || typeof database.ref !== 'function') {
    throw new TypeError('A Realtime Database instance is required');
  }
  assertPositiveInteger(retentionMs, 'retentionMs');

  return async (key, maxRequests = 10, windowMs = 60000) => {
    assertBucketKey(key);
    assertPositiveInteger(maxRequests, 'maxRequests');
    assertPositiveInteger(windowMs, 'windowMs');

    const attemptAtMs = now();
    assertPositiveInteger(attemptAtMs, 'now()');
    const result = await database.ref(`${rootPath}/${key}`).transaction((current) => {
      const active = current
        && current.version === LOGIN_RATE_LIMIT_RECORD_VERSION
        && Number.isSafeInteger(current.resetAtMs)
        && attemptAtMs < current.resetAtMs;
      const resetAtMs = active ? current.resetAtMs : attemptAtMs + windowMs;
      const previousCount = active && Number.isSafeInteger(current.count) && current.count > 0
        ? current.count
        : 0;

      return {
        version: LOGIN_RATE_LIMIT_RECORD_VERSION,
        // Once denied, a saturated count avoids unbounded integer growth while
        // retaining the denial until this fixed window expires.
        count: Math.min(previousCount + 1, maxRequests + 1),
        resetAtMs,
        expiresAtMs: resetAtMs + retentionMs,
        lastAttemptAtMs: attemptAtMs,
      };
    }, undefined, false);

    if (!result?.committed || !result.snapshot || typeof result.snapshot.val !== 'function') {
      throw new Error('LOGIN_RATE_LIMIT_TRANSACTION_FAILED');
    }
    const record = result.snapshot.val() || {};
    return Number.isSafeInteger(record.count) && record.count <= maxRequests;
  };
};

const cleanupExpiredLoginRateLimits = async ({
  database,
  nowMs = Date.now(),
  limit = LOGIN_RATE_LIMIT_CLEANUP_BATCH_SIZE,
  maxBatches = LOGIN_RATE_LIMIT_CLEANUP_MAX_BATCHES,
  rootPath = LOGIN_RATE_LIMIT_ROOT,
} = {}) => {
  if (!database || typeof database.ref !== 'function') {
    throw new TypeError('A Realtime Database instance is required');
  }
  assertPositiveInteger(nowMs, 'nowMs');
  assertPositiveInteger(limit, 'limit');
  assertPositiveInteger(maxBatches, 'maxBatches');
  if (limit > LOGIN_RATE_LIMIT_CLEANUP_BATCH_SIZE) {
    throw new RangeError(`limit cannot exceed ${LOGIN_RATE_LIMIT_CLEANUP_BATCH_SIZE}`);
  }
  if (maxBatches > LOGIN_RATE_LIMIT_CLEANUP_MAX_BATCHES) {
    throw new RangeError(`maxBatches cannot exceed ${LOGIN_RATE_LIMIT_CLEANUP_MAX_BATCHES}`);
  }

  let deletedCount = 0;
  let retainedCount = 0;
  let scannedCount = 0;
  let batchCount = 0;
  let hasMore = false;

  while (batchCount < maxBatches) {
    const snapshot = await database.ref(rootPath)
      .orderByChild('expiresAtMs')
      .endAt(nowMs)
      .limitToFirst(limit)
      .once('value');
    const records = snapshot.val() || {};
    const entries = Object.entries(records);
    if (!entries.length) {
      hasMore = false;
      break;
    }

    batchCount += 1;
    scannedCount += entries.length;
    const outcomes = await Promise.all(entries.map(async ([key, expected]) => {
      assertBucketKey(key);
      const result = await database.ref(`${rootPath}/${key}`).transaction((current) => {
        // Compare against the queried generation as well as expiry. If a login
        // reset this bucket after the query, abort instead of deleting its new
        // active window.
        if (!current || current.version !== LOGIN_RATE_LIMIT_RECORD_VERSION
          || !Number.isSafeInteger(current.expiresAtMs) || current.expiresAtMs > nowMs
          || current.resetAtMs !== expected?.resetAtMs
          || current.count !== expected?.count) {
          return undefined;
        }
        return null;
      }, undefined, false);
      return result?.committed === true;
    }));
    const deletedThisBatch = outcomes.filter(Boolean).length;
    deletedCount += deletedThisBatch;
    retainedCount += entries.length - deletedThisBatch;
    hasMore = entries.length === limit;
    if (!hasMore) break;
    // A full batch with no deletions consists entirely of records that raced
    // or failed validation. Stop so a corrupt record cannot spin this job.
    if (deletedThisBatch === 0) break;
  }

  return {
    deletedCount,
    retainedCount,
    scannedCount,
    batchCount,
    hasMore,
  };
};

module.exports = {
  LOGIN_RATE_LIMIT_ROOT,
  LOGIN_RATE_LIMIT_RECORD_VERSION,
  LOGIN_RATE_LIMIT_RETENTION_MS,
  LOGIN_RATE_LIMIT_CLEANUP_BATCH_SIZE,
  LOGIN_RATE_LIMIT_CLEANUP_MAX_BATCHES,
  createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits,
};
