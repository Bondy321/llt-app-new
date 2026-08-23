import { parseTimestampMs } from '../services/timeUtils.js';

export const DRIVER_LOCATION_SCHEMA_VERSION = 1;
export const DRIVER_LOCATION_LIVE_MS = 4 * 60 * 1000;
export const DRIVER_LOCATION_RECENT_MS = 10 * 60 * 1000;
export const DRIVER_LOCATION_STALE_MS = 30 * 60 * 1000;
export const DRIVER_LOCATION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const DRIVER_LOCATION_CLEANUP_MS = DRIVER_LOCATION_STALE_MS;
export const DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS = 500;

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
  const accuracy = Number(record?.accuracy);
  const hasLowAccuracy = Number.isFinite(accuracy)
    && accuracy > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS;
  if (mode === 'pickup') {
    return {
      available: true,
      actionable: !hasLowAccuracy,
      coordinates,
      freshness: hasLowAccuracy ? 'low_accuracy' : 'pickup',
      mode,
      timestampMs,
      ageMs: Math.max(0, ageMs),
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
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
    actionable: !hasLowAccuracy && (freshness === 'live' || freshness === 'recent'),
    coordinates: freshness === 'expired' ? null : coordinates,
    freshness: freshness !== 'expired' && hasLowAccuracy ? 'low_accuracy' : freshness,
    mode,
    timestampMs,
    ageMs: normalizedAgeMs,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
  };
};

export const getDriverLocationStatusMeta = (presentation) => {
  switch (presentation?.freshness) {
    case 'live':
      return { label: 'Live', tone: 'success', pulse: true, needsRefresh: false };
    case 'recent':
      return { label: 'Recent live update', tone: 'info', pulse: false, needsRefresh: false };
    case 'stale':
      return { label: 'Live sharing paused', tone: 'warning', pulse: false, needsRefresh: true };
    case 'expired':
      return { label: 'Live location expired', tone: 'warning', pulse: false, needsRefresh: true };
    case 'pickup':
      return { label: 'Fixed pickup point', tone: 'info', pulse: false, needsRefresh: false };
    case 'low_accuracy':
      return { label: 'Low accuracy — refresh needed', tone: 'warning', pulse: false, needsRefresh: true };
    default:
      return { label: 'No location shared', tone: 'muted', pulse: false, needsRefresh: false };
  }
};

export const getDriverLocationSnapshotKey = (record) => {
  const coordinates = normalizeDriverCoordinates(record);
  const timestampMs = parseTimestampMs(record?.timestamp ?? record?.lastUpdated);
  if (!coordinates || !Number.isFinite(timestampMs)) return '';
  return [
    timestampMs,
    coordinates.latitude,
    coordinates.longitude,
    resolveDriverLocationMode(record),
    record?.sessionId || '',
  ].join('|');
};

export const getDriverPickupFallback = (record) => {
  const candidate = resolveDriverLocationMode(record) === 'pickup'
    ? record
    : record?.fallbackPickup;
  const coordinates = normalizeDriverCoordinates(candidate);
  const timestamp = parseTimestampMs(candidate?.timestamp ?? candidate?.lastUpdated);
  if (
    !candidate
    || candidate.schemaVersion !== DRIVER_LOCATION_SCHEMA_VERSION
    || candidate.isSharing !== true
    || candidate.mode !== 'pickup'
    || candidate.source !== 'manual'
    || !coordinates
    || !Number.isSafeInteger(timestamp)
  ) return null;

  const fallback = {
    schemaVersion: DRIVER_LOCATION_SCHEMA_VERSION,
    isSharing: true,
    mode: 'pickup',
    source: 'manual',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp,
  };
  const accuracy = Number(candidate.accuracy);
  if (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 10000) fallback.accuracy = accuracy;
  const address = readBoundedText(candidate.address, 500);
  if (address) fallback.address = address;
  const updatedBy = readBoundedText(candidate.updatedBy, 100);
  if (updatedBy) fallback.updatedBy = updatedBy;
  return fallback;
};

export const buildDriverLocationPayload = ({
  latitude,
  longitude,
  accuracy,
  address,
  updatedBy,
  source = 'manual',
  sessionId,
  nowMs = Date.now(),
}) => {
  const coordinates = normalizeDriverCoordinates({ latitude, longitude });
  if (!coordinates) throw new Error('Valid driver coordinates are required');

  const normalizedSource = source === 'auto' ? 'auto' : 'manual';
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('A valid location publication time is required');
  const payload = {
    schemaVersion: DRIVER_LOCATION_SCHEMA_VERSION,
    isSharing: true,
    mode: normalizedSource === 'auto' ? 'live' : 'pickup',
    source: normalizedSource,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp: { '.sv': 'timestamp' },
  };

  if (normalizedSource === 'auto') {
    const normalizedSessionId = readBoundedText(sessionId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(normalizedSessionId)) {
      throw new Error('A valid live-sharing session ID is required');
    }
    payload.sessionId = normalizedSessionId;
    payload.cleanupAtMs = nowMs + DRIVER_LOCATION_CLEANUP_MS;
  }

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
