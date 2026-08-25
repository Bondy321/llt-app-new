'use strict';

// @ts-check

const { log } = require('../../infrastructure/logging/safeLogger');
const { removeInvalidToken } = require('./notificationPolicy');

/** @type {(...args: any[]) => Promise<{ attempted: number, failed: number }>} */
const cleanupInvalidTokens = async (invalidTokens = [], remover = removeInvalidToken) => {
  if (!Array.isArray(invalidTokens) || invalidTokens.length === 0) {
    return { attempted: 0, failed: 0 };
  }
  const results = await Promise.allSettled(invalidTokens.map(({ userId, token, reason }) => (
    remover(userId, token, reason ? { reason } : undefined)
  )));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    log.error('Invalid push token cleanup completed with failures', {
      attempted: results.length,
      failed: failed.length,
    });
  }
  return { attempted: results.length, failed: failed.length };
};

module.exports = { cleanupInvalidTokens };
