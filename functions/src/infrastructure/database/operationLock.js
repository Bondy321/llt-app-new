'use strict';

// @ts-check

const { log } = require('../logging/safeLogger');

const MANUAL_BOOKING_LOCK_TTL_MS = 30 * 1000;

/** @type {(...args: any[]) => Promise<any>} */
const acquireManualBookingLock = async ({ db, path, owner, nowMs, ttlMs = MANUAL_BOOKING_LOCK_TTL_MS }) => {
  const result = await db.ref(path).transaction(/** @param {any} current */ (current) => {
    const activeLock = current
      && typeof current === 'object'
      && Number(current.expiresAtMs) > nowMs
      && current.owner !== owner;
    // A negative transaction result still needs to reach Firebase's compare
    // and set. Returning undefined aborts locally and can reject a stale
    // cached owner even after another connection has released the lock.
    if (activeLock) return current;
    return {
      owner,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
  }, undefined, false);
  return Boolean(result.committed && result.snapshot.val()?.owner === owner);
};

/** @type {(...args: any[]) => Promise<any>} */
const releaseManualBookingLock = async ({ db, path, owner }) => {
  try {
    await db.ref(path).transaction(/** @param {any} current */ (current) => (
      current?.owner === owner ? null : current
    ), undefined, false);
  } catch (error) {
    log.warn('Manual passenger lock release failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};


module.exports = { acquireManualBookingLock, releaseManualBookingLock };
