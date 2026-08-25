// services/safetyService.js - Enhanced Safety & Emergency Services
import { auth, realtimeDb } from '../../firebase';
import logger from '../loggerService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseTimestampMs } from '../timeUtils';
import { normalizeTourId } from '../tourIdentityService';

// Safety event categories with metadata
export const SAFETY_CATEGORIES = {
  DELAY: 'delay',
  INCIDENT: 'incident',
  MEDICAL: 'medical',
  LOST_PASSENGER: 'lost_passenger',
  VEHICLE_ISSUE: 'vehicle_issue',
  SOS: 'sos',
  HARASSMENT: 'harassment',
  WEATHER: 'weather',
  CUSTOM: 'custom',
};

// Category metadata for UI display
export const CATEGORY_META = {
  [SAFETY_CATEGORIES.DELAY]: {
    title: 'Delayed pickup',
    description: 'Running late to a pickup point',
    icon: 'clock-alert-outline',
    color: '#F59E0B',
    driverOnly: false,
  },
  [SAFETY_CATEGORIES.VEHICLE_ISSUE]: {
    title: 'Vehicle issue',
    description: 'Mechanical issue, flat tyre, or breakdown',
    icon: 'car-wrench',
    color: '#6366F1',
    driverOnly: true,
  },
  [SAFETY_CATEGORIES.MEDICAL]: {
    title: 'Medical emergency',
    description: 'Passenger requires medical attention',
    icon: 'medical-bag',
    color: '#DC2626',
    driverOnly: false,
  },
  [SAFETY_CATEGORIES.LOST_PASSENGER]: {
    title: 'Missing passenger',
    description: 'Passenger not at meeting point',
    icon: 'account-search',
    color: '#8B5CF6',
    driverOnly: true,
  },
  [SAFETY_CATEGORIES.INCIDENT]: {
    title: 'Safety incident',
    description: 'General safety concern or emergency',
    icon: 'alert-octagon',
    color: '#EF4444',
    driverOnly: false,
  },
  [SAFETY_CATEGORIES.SOS]: {
    title: 'SOS Emergency',
    description: 'Immediate assistance required',
    icon: 'alarm-light',
    color: '#DC2626',
    driverOnly: false,
  },
  [SAFETY_CATEGORIES.HARASSMENT]: {
    title: 'Harassment report',
    description: 'Inappropriate behavior or harassment',
    icon: 'shield-alert',
    color: '#BE123C',
    driverOnly: false,
  },
  [SAFETY_CATEGORIES.WEATHER]: {
    title: 'Weather concern',
    description: 'Unsafe weather conditions affecting tour',
    icon: 'weather-lightning-rainy',
    color: '#0284C7',
    driverOnly: true,
  },
  [SAFETY_CATEGORIES.CUSTOM]: {
    title: 'Other issue',
    description: 'Report a custom safety concern',
    icon: 'message-alert',
    color: '#64748B',
    driverOnly: false,
  },
};

// Severity levels for safety events
export const SEVERITY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const SEVERITY_META = {
  [SEVERITY_LEVELS.LOW]: {
    label: 'Low',
    description: 'Non-urgent issue, can wait',
    color: '#22C55E',
    icon: 'information',
  },
  [SEVERITY_LEVELS.MEDIUM]: {
    label: 'Medium',
    description: 'Needs attention soon',
    color: '#F59E0B',
    icon: 'alert-circle',
  },
  [SEVERITY_LEVELS.HIGH]: {
    label: 'High',
    description: 'Urgent, requires prompt response',
    color: '#EF4444',
    icon: 'alert',
  },
  [SEVERITY_LEVELS.CRITICAL]: {
    label: 'Critical',
    description: 'Life-threatening emergency',
    color: '#DC2626',
    icon: 'alarm-light',
  },
};

// Event status tracking
export const EVENT_STATUS = {
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
};

// Offline queue storage key
const OFFLINE_QUEUE_KEY = '@LLT:safetyOfflineQueue';
const OFFLINE_QUEUE_CORRUPT_BACKUP_KEY = '@LLT:safetyOfflineQueue:corruptBackup';
const MAX_OFFLINE_SAFETY_EVENTS = 250;
const SAFETY_QUEUE_SCOPE_VERSION = 1;
const SAFETY_SUBMISSION_TIMEOUT_MS = 12000;
const SAFETY_RETRY_BASE_DELAY_MS = 15000;
const SAFETY_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const SAFETY_RETRY_DISPOSITION = {
  RETRYABLE: 'retryable',
  REQUIRES_ATTENTION: 'requires_attention',
};
let safetyQueueMutationTail = Promise.resolve();
let trustedContactsMutationTail = Promise.resolve();
const activeSafetyQueueReplays = new Set();

const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const safeRealtimeKey = (value, fallback = 'anonymous') => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const source = raw || fallback;
  return source.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  ) || fallback;
};

const resolveAuthUid = () => {
  const currentUid = auth?.currentUser?.uid;
  return typeof currentUid === 'string' && currentUid.trim() ? currentUid.trim() : null;
};

const resolveSafetyLogUserKey = () => {
  const authUid = resolveAuthUid();
  return authUid ? safeRealtimeKey(authUid, 'authenticated_user') : null;
};

const isCriticalSafetyEvent = (event) => (
  event?.isSOS === true || event?.severity === SEVERITY_LEVELS.CRITICAL
);

const normalizeSafetyQueueScope = (scope) => {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const tourId = normalizeTourId(scope.tourId);
  const principalId = typeof (scope.principalId || scope.userId) === 'string'
    ? (scope.principalId || scope.userId).trim()
    : '';
  const role = typeof scope.role === 'string' ? scope.role.trim().toLowerCase() : '';
  if (!tourId || !principalId || (role !== 'passenger' && role !== 'driver')) return null;
  return {
    version: SAFETY_QUEUE_SCOPE_VERSION,
    tourId,
    principalId,
    role,
  };
};

const deriveSafetyQueueScope = (event) => normalizeSafetyQueueScope(
  event?.sessionScope || {
    tourId: event?.tourId,
    principalId: event?.principalId || event?.userId,
    role: event?.role,
  },
);

const safetyEventMatchesScope = (event, scope) => {
  const eventScope = deriveSafetyQueueScope(event);
  const normalizedScope = normalizeSafetyQueueScope(scope);
  return Boolean(
    eventScope
    && normalizedScope
    && eventScope.tourId === normalizedScope.tourId
    && eventScope.principalId === normalizedScope.principalId
    && eventScope.role === normalizedScope.role
  );
};

const filterSafetyQueueForScope = (queue, scope) => (
  Array.isArray(queue) ? queue.filter((event) => safetyEventMatchesScope(event, scope)) : []
);

const withSafetyQueueMutationLock = async (operation) => {
  const current = safetyQueueMutationTail.catch(() => {}).then(operation);
  safetyQueueMutationTail = current.catch(() => {});
  return current;
};

const withTrustedContactsMutationLock = (operation) => {
  const result = trustedContactsMutationTail.catch(() => {}).then(operation);
  trustedContactsMutationTail = result.catch(() => {});
  return result;
};

const getSafetyQueueScopeKey = (scope) => {
  const normalized = normalizeSafetyQueueScope(scope);
  return normalized
    ? `${normalized.tourId}|${normalized.role}|${normalized.principalId}`
    : null;
};

const getSafetyQueueEventId = (event) => {
  if (typeof event?.queueId === 'string' && event.queueId.trim()) return event.queueId.trim();
  const source = [
    event?.queuedAt,
    event?.timestamp,
    event?.tourId,
    event?.principalId || event?.userId,
    event?.role,
    event?.category,
    event?.message,
  ].map((value) => String(value ?? '')).join('|');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `safety_${(hash >>> 0).toString(36)}`;
};

const normalizeOfflineSafetyEvent = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const timestampMs = parseTimestampMs(event.queuedAt || event.timestamp);
  return {
    ...event,
    queueId: getSafetyQueueEventId(event),
    sessionScope: deriveSafetyQueueScope(event),
    queuedAt: Number.isFinite(timestampMs)
      ? new Date(timestampMs).toISOString()
      : new Date().toISOString(),
    retryCount: Number.isFinite(Number(event.retryCount))
      ? Math.max(0, Math.trunc(Number(event.retryCount)))
      : 0,
    retryDisposition: event.retryDisposition === SAFETY_RETRY_DISPOSITION.REQUIRES_ATTENTION
      ? SAFETY_RETRY_DISPOSITION.REQUIRES_ATTENTION
      : SAFETY_RETRY_DISPOSITION.RETRYABLE,
    nextRetryAtMs: event.nextRetryAtMs !== null
      && event.nextRetryAtMs !== undefined
      && Number.isFinite(Number(event.nextRetryAtMs))
      ? Math.max(0, Math.trunc(Number(event.nextRetryAtMs)))
      : null,
  };
};

const getSafetyRetryDelayMs = (retryCount) => Math.min(
  SAFETY_RETRY_MAX_DELAY_MS,
  SAFETY_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, Math.min(10, retryCount - 1))),
);

const boundOfflineSafetyQueue = (events) => {
  const normalized = Array.isArray(events)
    ? events.map(normalizeOfflineSafetyEvent).filter(Boolean)
    : [];
  if (normalized.length <= MAX_OFFLINE_SAFETY_EVENTS) return normalized;

  // Preserve the newest critical reports first, then use remaining capacity for
  // the newest routine reports. The final queue is restored to chronological
  // order so replay remains fair and deterministic.
  const critical = normalized.filter(isCriticalSafetyEvent).slice(-MAX_OFFLINE_SAFETY_EVENTS);
  const routineCapacity = Math.max(0, MAX_OFFLINE_SAFETY_EVENTS - critical.length);
  const routine = normalized.filter((event) => !isCriticalSafetyEvent(event)).slice(-routineCapacity);
  return [...critical, ...routine]
    .sort((left, right) => (
      (parseTimestampMs(left.queuedAt) ?? 0) - (parseTimestampMs(right.queuedAt) ?? 0)
    ));
};

const readOfflineSafetyQueue = async () => {
  const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
  if (!raw) return [];

  try {
    return boundOfflineSafetyQueue(JSON.parse(raw));
  } catch (error) {
    // Retain the damaged payload for support diagnostics before replacing the
    // active queue. A corrupt JSON value must never make all future reports
    // impossible to save.
    await AsyncStorage.setItem(OFFLINE_QUEUE_CORRUPT_BACKUP_KEY, raw);
    await logger.warn('Safety', 'Recovered malformed offline safety queue', {
      error: error?.message || 'Invalid queue JSON',
      rawLength: raw.length,
    });
    return [];
  }
};

const writeOfflineSafetyQueue = async (events) => {
  const bounded = boundOfflineSafetyQueue(events);
  if (bounded.length === 0) {
    await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
  } else {
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(bounded));
  }
  return bounded;
};

const createSafetyEventId = () => (
  `safety_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
);

const buildSafetySubmissionEndpoint = () => {
  const explicitUrl = process.env.EXPO_PUBLIC_SUBMIT_SAFETY_REPORT_URL?.trim();
  if (explicitUrl) return explicitUrl;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  return projectId
    ? `https://europe-west1-${projectId}.cloudfunctions.net/submitSafetyReport`
    : null;
};

const fetchSafetySubmission = async (endpoint, options) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SAFETY_SUBMISSION_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const toRemoteSafetyPayload = (payload, { processedFromQueue = false } = {}) => {
  const {
    queueId: _queueId,
    queuedAt: _queuedAt,
    retryCount: _retryCount,
    lastRetryAt: _lastRetryAt,
    lastErrorCode: _lastErrorCode,
    sessionScope: _sessionScope,
    ...remotePayload
  } = payload || {};
  return {
    ...remotePayload,
    ...(processedFromQueue ? {
      processedFromQueue: true,
      originalTimestamp: payload?.timestamp || null,
      timestamp: new Date().toISOString(),
    } : {}),
  };
};

const writeSafetyEventAtomically = async (payload, options = {}) => {
  const currentUser = auth?.currentUser;
  if (!currentUser || typeof currentUser.getIdToken !== 'function') {
    const error = new Error('Authenticated safety identity is still starting');
    error.code = 'SAFETY_AUTH_REQUIRED';
    error.retryable = true;
    throw error;
  }
  const endpoint = buildSafetySubmissionEndpoint();
  if (!endpoint) {
    const error = new Error('Safety submission service is not configured');
    error.code = 'SAFETY_SERVICE_UNAVAILABLE';
    error.retryable = true;
    throw error;
  }

  const token = await currentUser.getIdToken();
  if (typeof token !== 'string' || !token.trim()) {
    const error = new Error('Authenticated safety identity is not ready');
    error.code = 'SAFETY_AUTH_REQUIRED';
    error.retryable = true;
    throw error;
  }
  const requestPayload = toRemoteSafetyPayload(payload, options);
  const response = await fetchSafetySubmission(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ...requestPayload,
      clientEventId: safeRealtimeKey(
        requestPayload.clientEventId || requestPayload.queueId || createSafetyEventId(),
        createSafetyEventId(),
      ),
      clientCreatedAtMs: parseTimestampMs(requestPayload.clientCreatedAt || requestPayload.timestamp) || Date.now(),
      processedFromQueue: options.processedFromQueue === true,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true) {
    const reason = result?.reason || `HTTP_${response.status}`;
    const error = new Error('Safety report was not accepted by the submission service');
    error.code = reason;
    error.retryable = reason === 'SUBMISSION_IN_PROGRESS'
      || reason === 'TRY_AGAIN_LATER'
      || response.status === 401
      || response.status >= 500;
    throw error;
  }
  return {
    eventId: result.eventId,
    alreadySubmitted: result.alreadySubmitted === true,
    receivedAtMs: Number(result.receivedAtMs) || null,
  };
};

// Build standardized payload
const buildPayload = ({
  userId,
  principalId,
  bookingId,
  tourId,
  role,
  category,
  severity,
  message,
  customMessage,
  coords,
  attachments,
  isSOS,
  online = true,
}) => ({
  category,
  severity: severity || SEVERITY_LEVELS.MEDIUM,
  message,
  customMessage: customMessage || null,
  role,
  tourId: tourId || null,
  bookingId: bookingId || null,
  timestamp: new Date().toISOString(),
  clientCreatedAt: new Date().toISOString(),
  coords: coords
    ? {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        altitude: coords.altitude || null,
        heading: coords.heading || null,
        speed: coords.speed || null,
      }
    : null,
  attachments: attachments || [],
  isSOS: isSOS || false,
  status: EVENT_STATUS.PENDING,
  clientVersion: 'app-2.0',
  clientEventId: createSafetyEventId(),
  userId: userId || 'anonymous',
  principalId: principalId || userId || 'anonymous',
  online: online !== false,
});

export {
  AsyncStorage,
  MAX_OFFLINE_SAFETY_EVENTS,
  SAFETY_RETRY_BASE_DELAY_MS,
  SAFETY_RETRY_DISPOSITION,
  SAFETY_RETRY_MAX_DELAY_MS,
  activeSafetyQueueReplays,
  boundOfflineSafetyQueue,
  buildPayload,
  deriveSafetyQueueScope,
  filterSafetyQueueForScope,
  getSafetyQueueEventId,
  getSafetyQueueScopeKey,
  getSafetyRetryDelayMs,
  logger,
  normalizeOfflineSafetyEvent,
  normalizeSafetyQueueScope,
  parseTimestampMs,
  readOfflineSafetyQueue,
  realtimeDb,
  resolveAuthUid,
  resolveSafetyLogUserKey,
  safetyEventMatchesScope,
  toRemoteSafetyPayload,
  withSafetyQueueMutationLock,
  withTrustedContactsMutationLock,
  writeOfflineSafetyQueue,
  writeSafetyEventAtomically,
};

// Log a safety event to Firebase
