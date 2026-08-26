'use strict';

// @ts-check

const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/gu;

/** @param {unknown} value @returns {string | null} */
const resolveTrimmedString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** @param {unknown} value @returns {string | null} */
const toRealtimeKeySegment = (value) => {
  const trimmed = resolveTrimmedString(value);
  if (!trimmed) return null;
  return trimmed.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  );
};

/** @param {unknown} value @returns {string | null} */
const normalizeTourKeyForComparison = (value) => {
  const trimmed = resolveTrimmedString(value);
  if (!trimmed) return null;
  const normalized = trimmed
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(REALTIME_KEY_INVALID_GLOBAL_PATTERN, '')
    .replace(/^_+|_+$/g, '');
  return normalized || null;
};

module.exports = { normalizeTourKeyForComparison, resolveTrimmedString, toRealtimeKeySegment };
