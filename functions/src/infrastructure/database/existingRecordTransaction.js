'use strict';

// @ts-check

/**
 * Admin RTDB transactions can first observe null with an empty local cache.
 * Propose null so the server compares and retries with its actual value. Missing
 * records remain missing; a committed null no-op is not an acquired authority.
 * `applied` describes only the final callback, never an abandoned retry proposal.
 * The caller still owns all eligibility, owner, revision and expiry predicates.
 * @param {any} ref
 * @param {(current: any) => any} update
 */
const transactExistingRecord = async (ref, update) => {
  let matched = false;
  const result = await ref.transaction((current) => {
    matched = false;
    if (current === null || current === undefined) return null;
    const proposed = update(current);
    matched = proposed !== undefined;
    return proposed;
  }, undefined, false);
  return { ...result, applied: Boolean(matched && result?.committed) };
};

module.exports = { transactExistingRecord };
