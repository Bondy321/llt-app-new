'use strict';

// @ts-check

const { createHash } = require('node:crypto');

const PASSENGER_TRIP_SCHEMA_VERSION = 1;
const PASSENGER_TRIP_PARTS = Object.freeze(['booking', 'tour', 'itinerary']);
const PART_SET = new Set(PASSENGER_TRIP_PARTS);
const VERSION_PATTERN = /^[a-f0-9]{64}$/u;

/** @param {unknown} value */
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** @param {unknown} value */
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(/** @type {Record<string, any>} */ (value))
    .sort()
    .map((key) => [key, canonicalize(/** @type {Record<string, any>} */ (value)[key])]));
};

/** @param {unknown} value */
const fingerprintPassengerTripContent = (value) => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

/** @param {unknown} body */
const normalizePassengerTripRequest = (body) => {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(/** @type {Record<string, any>} */ (body));
  if (keys.some((key) => !['expectedSessionId', 'parts', 'versions'].includes(key))) return null;
  const source = /** @type {Record<string, any>} */ (body);
  if (typeof source.expectedSessionId !== 'string') return null;
  if (!Array.isArray(source.parts) || source.parts.length < 1
    || source.parts.length > PASSENGER_TRIP_PARTS.length) return null;
  const parts = source.parts.map((part) => (typeof part === 'string' ? part : ''));
  if (parts.some((part) => !PART_SET.has(part)) || new Set(parts).size !== parts.length) return null;

  const rawVersions = source.versions === undefined ? {} : source.versions;
  if (!isPlainObject(rawVersions)) return null;
  const versionEntries = Object.entries(/** @type {Record<string, any>} */ (rawVersions));
  if (versionEntries.some(([part, version]) => (
    !PART_SET.has(part) || !parts.includes(part) || typeof version !== 'string' || !VERSION_PATTERN.test(version)
  ))) return null;

  return {
    expectedSessionId: source.expectedSessionId,
    parts,
    versions: Object.fromEntries(versionEntries),
  };
};

/**
 * @param {'booking'|'tour'|'itinerary'} name
 * @param {any} data
 * @param {Record<string, string>} versions
 */
const buildPassengerTripPart = (name, data, versions) => {
  const version = fingerprintPassengerTripContent(data);
  if (versions[name] === version) return { status: 'unchanged', version };
  if (name === 'itinerary' && data === null) return { status: 'absent', version };
  return { status: 'value', version, data };
};

module.exports = {
  PASSENGER_TRIP_PARTS,
  PASSENGER_TRIP_SCHEMA_VERSION,
  VERSION_PATTERN,
  buildPassengerTripPart,
  canonicalize,
  fingerprintPassengerTripContent,
  isPlainObject,
  normalizePassengerTripRequest,
};
