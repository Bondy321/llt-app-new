'use strict';

// @ts-check

/** @typedef {{ headers?: Record<string, string | string[] | undefined> }} AuthRequest */

/** @param {AuthRequest} req @returns {string | null} */
const getBearerToken = (req) => {
  const headerValue = req.headers?.authorization || req.headers?.Authorization;
  if (typeof headerValue !== 'string') return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1]?.trim() || null : null;
};

module.exports = { getBearerToken };
