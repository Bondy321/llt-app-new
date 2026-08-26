'use strict';

// @ts-check

const { resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');

/** @param {unknown} body @returns {{ expectedSessionId: string | null, reason: string | null }} */
const normalizeSessionEndRequest = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { expectedSessionId: null, reason: null };
  }
  const record = /** @type {Record<string, unknown>} */ (body);
  return {
    expectedSessionId: resolveTrimmedString(record.expectedSessionId),
    reason: resolveTrimmedString(record.reason),
  };
};

module.exports = { normalizeSessionEndRequest };
