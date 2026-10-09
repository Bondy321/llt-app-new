'use strict';

// @ts-check

const { createHash } = require('node:crypto');

const COACH_TRACKING_ROOT = 'admin_dashboard/v1/coach_tracking';
const COACH_TRACKING_STATUS_PATH = 'admin_dashboard/v1/coach_tracking_status';
const COACH_TRACKING_SCHEMA_VERSION = 1;
const ASSIGNED_DRIVER_LIMIT = 100;

const asRecord = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const cleanText = (value, maxLength, fallback = '') => {
  const text = typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  return text || fallback;
};

const finiteNumber = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string'
    && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timestampNumber = (value) => {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric > 0 && Number.isFinite(new Date(numeric).getTime()) ? numeric : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const validCoordinate = (latitude, longitude) => (
  latitude !== null && longitude !== null
  && latitude >= -90 && latitude <= 90
  && longitude >= -180 && longitude <= 180
);

const buildSafeFallbackPickup = (value) => {
  const pickup = asRecord(value);
  const latitude = finiteNumber(pickup.latitude);
  const longitude = finiteNumber(pickup.longitude);
  if (pickup.schemaVersion !== 1 || pickup.isSharing !== true || pickup.mode !== 'pickup'
    || pickup.source !== 'manual' || !validCoordinate(latitude, longitude)) return null;
  const timestamp = timestampNumber(pickup.timestamp);
  if (timestamp === null) return null;
  const safe = {
    schemaVersion: 1,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude,
    longitude,
    timestamp,
  };
  const accuracy = finiteNumber(pickup.accuracy);
  if (accuracy !== null && accuracy >= 0 && accuracy <= 100_000) safe.accuracy = accuracy;
  const address = cleanText(pickup.address, 500);
  if (address) safe.address = address;
  return safe;
};

const hasSupportedLocationMetadata = (location) => {
  const supportedSchema = !Object.hasOwn(location, 'schemaVersion') || location.schemaVersion === 1;
  const supportedSharing = !Object.hasOwn(location, 'isSharing') || location.isSharing === true;
  const supportedMode = !Object.hasOwn(location, 'mode') || ['live', 'pickup'].includes(location.mode);
  const supportedSource = !Object.hasOwn(location, 'source') || ['auto', 'manual'].includes(location.source);
  const mismatchedPair = (location.mode === 'live' && location.source === 'manual')
    || (location.mode === 'pickup' && location.source === 'auto');
  return supportedSchema && supportedSharing && supportedMode && supportedSource && !mismatchedPair;
};

const readSafeLocationCore = (location) => {
  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);
  if (!validCoordinate(latitude, longitude)) return null;
  const timestamp = timestampNumber(location.timestamp ?? location.lastUpdated);
  if (timestamp === null) return null;
  return { latitude, longitude, timestamp };
};

const addSafeLocationMetadata = (safe, location) => {
  const accuracy = finiteNumber(location.accuracy);
  if (accuracy !== null && accuracy >= 0 && accuracy <= 100_000) safe.accuracy = accuracy;
  const address = cleanText(location.address, 500);
  if (address) safe.address = address;
  const fallbackPickup = buildSafeFallbackPickup(location.fallbackPickup);
  if (fallbackPickup) safe.fallbackPickup = fallbackPickup;
};

/** Keep the admin map projection limited to the public driverLocation contract. */
const buildSafeDriverLocation = (value) => {
  const location = asRecord(value);
  // Legacy public records may omit schema/flag/mode/source, but explicit
  // unsupported values must not be silently reinterpreted as current data.
  if (!hasSupportedLocationMetadata(location)) return null;
  const core = readSafeLocationCore(location);
  if (!core) return null;
  const safe = {
    ...(location.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
    isSharing: true,
    ...(location.mode ? { mode: location.mode } : {}),
    ...(location.source ? { source: location.source } : {}),
    ...core,
  };
  addSafeLocationMetadata(safe, location);
  return safe;
};

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const fingerprint = (value) => createHash('sha256')
  .update(stableStringify(value))
  .digest('hex')
  .slice(0, 32);

const buildAssignedDriverRows = (assignedDrivers) => (Array.isArray(assignedDrivers)
  ? assignedDrivers.slice(0, ASSIGNED_DRIVER_LIMIT).map((driver) => ({
    driverId: cleanText(driver?.driverId, 100),
    name: cleanText(driver?.name, 120, cleanText(driver?.driverId, 100)),
  })).filter((driver) => driver.driverId)
  : []);

const validTourDate = (value) => {
  const date = finiteNumber(value);
  return date !== null && date > 0 && Number.isFinite(new Date(date).getTime()) ? date : null;
};

const buildTourDateRange = (tour) => ({
  startAtMs: validTourDate(tour.startDateEpochMs),
  endAtMs: validTourDate(tour.endDateEpochMs),
});

const buildCoachTrackingRow = ({ tourId, tour = {}, assignedDrivers = [], assignmentOverflow = false, nowMs = Date.now() }) => {
  if (typeof tourId !== 'string' || !tourId || !tour || typeof tour !== 'object') return null;
  const location = buildSafeDriverLocation(tour.driverLocation);
  const drivers = buildAssignedDriverRows(assignedDrivers);
  if (!drivers.length && !location) return null;
  const row = {
    schemaVersion: COACH_TRACKING_SCHEMA_VERSION,
    tourId,
    tourCode: cleanText(tour.tourCode, 120, tourId),
    name: cleanText(tour.name, 160, cleanText(tour.tourCode, 120, tourId)),
    ...buildTourDateRange(tour),
    isActive: tour.isActive !== false,
    assignedDrivers: drivers,
    assignmentOverflow: assignmentOverflow === true,
    location,
    updatedAtMs: Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now(),
  };
  return { ...row, sourceFingerprint: fingerprint({ ...row, updatedAtMs: undefined }) };
};

module.exports = {
  ASSIGNED_DRIVER_LIMIT,
  COACH_TRACKING_ROOT,
  COACH_TRACKING_SCHEMA_VERSION,
  COACH_TRACKING_STATUS_PATH,
  buildCoachTrackingRow,
  buildSafeDriverLocation,
  fingerprint,
};
