'use strict';

// @ts-check

/**
 * @template T
 * @param {string | null | undefined} raw
 * @param {(value: unknown, options?: unknown) => T | null} validator
 * @param {unknown} [options]
 * @returns {T | null}
 */
const parseValidatedJson = (raw, validator, options) => {
  if (!raw) return null;
  try {
    return validator(JSON.parse(raw), options);
  } catch (_error) {
    return null;
  }
};

module.exports = { parseValidatedJson };
