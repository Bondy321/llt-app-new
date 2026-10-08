import { buildDriverLocationSessionKey } from '../../utils/driverLocation.js';

export const TRACKING_STORAGE_KEY = '@LLT:driverTracking:v1';
export const TRACKING_TASK_NAME = 'llt.driver-tracking.v1';
export const MAX_SAMPLE_AGE_MS = 90_000;
export const TRACKING_INTERVAL_MS = 60_000;

const safeSegment = value => typeof value === 'string' && value.length > 0
  && value.length <= 100 && !/[.#$\/\[\]]/.test(value);
export const normalizeTrackingScope = (scope, nowMs = Date.now()) => {
  if (!scope || scope.role !== 'driver' || !safeSegment(scope.authUid)
    || !safeSegment(scope.cacheOwnerId) || !safeSegment(scope.tourId)
    || scope.principalId !== `driver:${scope.cacheOwnerId}`
    || !/^sess_v1_[a-f0-9]{32}$/.test(scope.sessionId || '')
    || !Number.isSafeInteger(scope.expiresAtMs) || scope.expiresAtMs <= nowMs) return null;
  return { role: 'driver', authUid: scope.authUid, cacheOwnerId: scope.cacheOwnerId,
    principalId: scope.principalId, tourId: scope.tourId, sessionId: scope.sessionId,
    expiresAtMs: scope.expiresAtMs };
};
export const sameTrackingScope = (left, right) => Boolean(left && right
  && ['authUid', 'sessionId', 'cacheOwnerId', 'tourId', 'principalId']
    .every(field => left[field] === right[field]));

export const validateTrackingIntent = value => {
  if (!value || value.schemaVersion !== 1 || !['active', 'stopping'].includes(value.status)
    || !normalizeTrackingScope(value.scope, 0) || !Number.isSafeInteger(value.startedAtMs)
    || value.startedAtMs <= 0 || value.startedAtMs >= value.scope.expiresAtMs
    || !/^track_[A-Za-z0-9_-]{8,74}$/.test(value.liveSharingSessionId || '')) return null;
  try { buildDriverLocationSessionKey(value.scope.sessionId, value.liveSharingSessionId); }
  catch { return null; }
  return { schemaVersion: 1, status: value.status, scope: normalizeTrackingScope(value.scope, 0),
    startedAtMs: value.startedAtMs, liveSharingSessionId: value.liveSharingSessionId };
};
export const trackingFencePayload = (intent, status) => ({ schemaVersion: 1, status,
  authUid: intent.scope.authUid, appSessionId: intent.scope.sessionId,
  driverId: intent.scope.cacheOwnerId, tourId: intent.scope.tourId,
  liveSharingSessionId: intent.liveSharingSessionId, startedAtMs: intent.startedAtMs,
  expiresAtMs: intent.scope.expiresAtMs });
export const latestTrackingSample = (locations, intent, nowMs) => {
  if (!Array.isArray(locations)) return null;
  return locations.filter(sample => Number.isFinite(sample?.timestamp)
    && sample.timestamp >= intent.startedAtMs && sample.timestamp <= nowMs + 5_000
    && nowMs - sample.timestamp <= MAX_SAMPLE_AGE_MS
    && typeof sample.coords?.latitude === 'number' && Number.isFinite(sample.coords.latitude)
    && Math.abs(sample.coords.latitude) <= 90
    && typeof sample.coords?.longitude === 'number' && Number.isFinite(sample.coords.longitude)
    && Math.abs(sample.coords.longitude) <= 180
    && typeof sample.coords?.accuracy === 'number' && Number.isFinite(sample.coords.accuracy)
    && sample.coords.accuracy >= 0 && sample.coords.accuracy <= 10_000)
    .sort((left, right) => right.timestamp - left.timestamp)[0] || null;
};
