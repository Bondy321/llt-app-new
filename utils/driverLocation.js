import { parseTimestampMs } from '../services/timeUtils.js';

export const DRIVER_LOCATION_SCHEMA_VERSION = 1;
export const DRIVER_LOCATION_LIVE_MS = 2 * 60 * 1000;
export const DRIVER_LOCATION_RECENT_MS = 10 * 60 * 1000;
export const DRIVER_LOCATION_STALE_MS = 30 * 60 * 1000;
export const DRIVER_LOCATION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const readBoundedText = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

export const normalizeDriverCoordinates = (value) => {
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng);
  if (
    !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
};

export const resolveDriverLocationMode = (record) => {
  if (record?.mode === 'live' || record?.source === 'auto') return 'live';
  return 'pickup';
};

export const getDriverLocationPresentation = (record, nowMs = Date.now()) => {
  const coordinates = normalizeDriverCoordinates(record);
  const timestampMs = parseTimestampMs(record?.timestamp ?? record?.lastUpdated);
  const isExplicitlyWithdrawn = record?.isSharing === false;

  if (!record || !coordinates || !Number.isFinite(timestampMs) || isExplicitlyWithdrawn) {
    return {
      available: false,
      actionable: false,
      coordinates: null,
      freshness: 'unavailable',
      mode: null,
      timestampMs: null,
    };
  }

  const ageMs = nowMs - timestampMs;
  if (ageMs < -DRIVER_LOCATION_FUTURE_TOLERANCE_MS) {
    return {
      available: false,
      actionable: false,
      coordinates: null,
      freshness: 'invalid',
      mode: resolveDriverLocationMode(record),
      timestampMs,
    };
  }

  const mode = resolveDriverLocationMode(record);
  if (mode === 'pickup') {
    return {
      available: true,
      actionable: true,
      coordinates,
      freshness: 'pickup',
      mode,
      timestampMs,
      ageMs: Math.max(0, ageMs),
    };
  }

  const normalizedAgeMs = Math.max(0, ageMs);
  const freshness = normalizedAgeMs < DRIVER_LOCATION_LIVE_MS
    ? 'live'
    : normalizedAgeMs < DRIVER_LOCATION_RECENT_MS
      ? 'recent'
      : normalizedAgeMs < DRIVER_LOCATION_STALE_MS
        ? 'stale'
        : 'expired';

  return {
    available: freshness !== 'expired',
    actionable: freshness === 'live' || freshness === 'recent',
    coordinates: freshness === 'expired' ? null : coordinates,
    freshness,
    mode,
    timestampMs,
    ageMs: normalizedAgeMs,
  };
};

export const buildDriverLocationPayload = ({
  latitude,
  longitude,
  accuracy,
  address,
  updatedBy,
  source = 'manual',
}) => {
  const coordinates = normalizeDriverCoordinates({ latitude, longitude });
  if (!coordinates) throw new Error('Valid driver coordinates are required');

  const normalizedSource = source === 'auto' ? 'auto' : 'manual';
  const payload = {
    schemaVersion: DRIVER_LOCATION_SCHEMA_VERSION,
    isSharing: true,
    mode: normalizedSource === 'auto' ? 'live' : 'pickup',
    source: normalizedSource,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp: { '.sv': 'timestamp' },
  };

  const normalizedAccuracy = Number(accuracy);
  if (Number.isFinite(normalizedAccuracy) && normalizedAccuracy >= 0) {
    payload.accuracy = Math.min(normalizedAccuracy, 10000);
  }

  const safeAddress = readBoundedText(address, 500);
  if (safeAddress) payload.address = safeAddress;
  const safeUpdatedBy = readBoundedText(updatedBy, 100);
  if (safeUpdatedBy) payload.updatedBy = safeUpdatedBy;

  return payload;
};
