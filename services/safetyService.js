// services/safetyService.js - Enhanced Safety & Emergency Services
import { auth, realtimeDb } from '../firebase';
import logger from './loggerService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseTimestampMs } from './timeUtils';
import { normalizeTourId } from './tourIdentityService';

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

// Log a safety event to Firebase
export async function logSafetyEvent(params) {
  const {
    userId,
    principalId,
    bookingId,
    tourId,
    role,
    category,
    severity = SEVERITY_LEVELS.MEDIUM,
    message,
    customMessage,
    coords = null,
    attachments = [],
    isSOS = false,
    online = true,
  } = params;

  const sanitizedUserId = userId || 'anonymous';
  const payload = buildPayload({
    userId: sanitizedUserId,
    principalId: principalId || sanitizedUserId,
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
    online,
  });

  try {
    if (online === false || !resolveSafetyLogUserKey()) {
      const queueResult = await queueOfflineSafetyEvent(payload);
      return { success: true, queued: true, payload, queueLength: queueResult.queueLength };
    }

    const { eventId } = await writeSafetyEventAtomically(payload);

    await logger.warn('Safety', 'Safety event recorded', {
      category,
      severity,
      isSOS,
      tourId,
    });

    return { success: true, eventId, payload };
  } catch (error) {
    await logger.error('Safety', 'Failed to log safety event', { error: error.message });

    if (error?.retryable === false) {
      throw error;
    }

    // Queue for offline retry
    try {
      const queueResult = await queueOfflineSafetyEvent(payload);
      return {
        success: true,
        queued: true,
        payload,
        queueLength: queueResult.queueLength,
        deferredReason: error?.code || 'REMOTE_WRITE_FAILED',
      };
    } catch (queueError) {
      const combinedError = new Error('The safety report could not be submitted or saved on this device');
      combinedError.code = 'SAFETY_REPORT_NOT_SAVED';
      combinedError.remoteError = error;
      combinedError.storageError = queueError;
      throw combinedError;
    }
  }
}

// Queue safety events when offline
export async function queueOfflineSafetyEvent(payload) {
  return withSafetyQueueMutationLock(async () => {
    const sessionScope = deriveSafetyQueueScope(payload);
    if (!sessionScope) {
      const scopeError = new Error('A signed-in tour identity is required before a safety report can be queued');
      scopeError.code = 'SAFETY_QUEUE_SCOPE_REQUIRED';
      throw scopeError;
    }
    try {
    const queue = await readOfflineSafetyQueue();
    const nextQueue = await writeOfflineSafetyQueue([...queue, {
      ...payload,
      sessionScope,
      queueId: `safety_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      queuedAt: new Date().toISOString(),
      retryCount: 0,
      retryDisposition: SAFETY_RETRY_DISPOSITION.RETRYABLE,
      nextRetryAtMs: null,
    }]);
      const ownedQueueLength = filterSafetyQueueForScope(nextQueue, sessionScope).length;
      await logger.info('Safety', 'Event queued for offline retry', {
        queueLength: ownedQueueLength,
        retainedForOtherSessions: nextQueue.length - ownedQueueLength,
      });
      return { success: true, queueLength: ownedQueueLength };
    } catch (error) {
      await logger.error('Safety', 'Failed to queue offline event', { error: error.message });
      throw error;
    }
  });
}

// Process offline queue when back online
export async function processOfflineQueue(scope, options = {}) {
  const normalizedScope = normalizeSafetyQueueScope(scope);
  const replayScopeKey = getSafetyQueueScopeKey(normalizedScope);
  const manual = options?.manual === true;
  const nowMs = Number.isFinite(Number(options?.nowMs)) ? Number(options.nowMs) : Date.now();
  if (!normalizedScope || !replayScopeKey) {
    return { processed: 0, failed: 0, deferred: true, reason: 'scope_required' };
  }
  if (activeSafetyQueueReplays.has(replayScopeKey)) {
    return { processed: 0, failed: 0, deferred: true, reason: 'replay_in_progress' };
  }

  activeSafetyQueueReplays.add(replayScopeKey);
  try {
    const safetyLogUserKey = resolveSafetyLogUserKey();
    if (!safetyLogUserKey) return { processed: 0, failed: 0, deferred: true };

    const queue = await withSafetyQueueMutationLock(() => readOfflineSafetyQueue());
    const ownedQueue = filterSafetyQueueForScope(queue, normalizedScope);
    const retainedQueue = queue.filter((event) => !safetyEventMatchesScope(event, normalizedScope));
    if (ownedQueue.length === 0) {
      return { processed: 0, failed: 0, retainedForOtherSessions: retainedQueue.length };
    }

    let processed = 0;
    let failed = 0;
    let deferred = 0;
    let requiresAttention = 0;
    const processedEventIds = new Set();
    const failedEventsById = new Map();

    for (const event of ownedQueue) {
      const retryDisposition = event.retryDisposition || SAFETY_RETRY_DISPOSITION.RETRYABLE;
      const nextRetryAtMs = Number(event.nextRetryAtMs);
      if (!manual && retryDisposition === SAFETY_RETRY_DISPOSITION.REQUIRES_ATTENTION) {
        requiresAttention += 1;
        deferred += 1;
        continue;
      }
      if (!manual && Number.isFinite(nextRetryAtMs) && nextRetryAtMs > nowMs) {
        deferred += 1;
        continue;
      }
      try {
        await writeSafetyEventAtomically(event, { processedFromQueue: true });
        processed++;
        processedEventIds.add(getSafetyQueueEventId(event));
      } catch (error) {
        failed++;
        const retryCount = (event.retryCount || 0) + 1;
        const retryable = error?.retryable !== false;
        const retryDisposition = retryable
          ? SAFETY_RETRY_DISPOSITION.RETRYABLE
          : SAFETY_RETRY_DISPOSITION.REQUIRES_ATTENTION;
        if (!retryable) requiresAttention += 1;
        failedEventsById.set(getSafetyQueueEventId(event), {
          ...event,
          retryCount,
          retryDisposition,
          lastRetryAt: new Date(nowMs).toISOString(),
          lastErrorCode: error?.code || 'REMOTE_WRITE_FAILED',
          nextRetryAtMs: retryable ? nowMs + getSafetyRetryDelayMs(retryCount) : null,
        });
      }
    }

    // Re-read under the mutation lock so reports queued while network writes
    // were in flight are preserved. Only records from this exact snapshot are
    // removed or updated.
    await withSafetyQueueMutationLock(async () => {
      const latestQueue = await readOfflineSafetyQueue();
      const reconciledQueue = latestQueue.flatMap((event) => {
        if (!safetyEventMatchesScope(event, normalizedScope)) return [event];
        const eventId = getSafetyQueueEventId(event);
        if (processedEventIds.has(eventId)) return [];
        if (failedEventsById.has(eventId)) return [failedEventsById.get(eventId)];
        return [event];
      });
      await writeOfflineSafetyQueue(reconciledQueue);
    });

    await logger.info('Safety', 'Offline queue processed', {
      processed,
      failed,
      deferred,
      requiresAttention,
      retainedForOtherSessions: retainedQueue.length,
    });
    return { processed, failed, deferred, requiresAttention, retainedForOtherSessions: retainedQueue.length };
  } catch (error) {
    await logger.error('Safety', 'Failed to process offline queue', { error: error.message });
    return { processed: 0, failed: 0, error: error.message };
  } finally {
    activeSafetyQueueReplays.delete(replayScopeKey);
  }
}

// Update live location sharing status
export async function updateLiveLocationSharing(tourId, userId, isSharing, coords = null) {
  const authUid = resolveAuthUid();
  if (!tourId || !userId || !authUid || userId !== authUid) return false;

  try {
    const ref = realtimeDb.ref(`tours/${tourId}/liveTracking/${authUid}`);
    const disconnectHandler = typeof ref.onDisconnect === 'function' ? ref.onDisconnect() : null;

    if (isSharing && coords) {
      const latitude = Number(coords.latitude);
      const longitude = Number(coords.longitude);
      const accuracy = Number(coords.accuracy);
      if (
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
        || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000
      ) {
        return false;
      }
      if (!disconnectHandler || typeof disconnectHandler.remove !== 'function') {
        throw new Error('Live location disconnect cleanup is unavailable');
      }
      await disconnectHandler.remove();
      try {
        await ref.set({
          schemaVersion: 2,
          isSharing: true,
          coords: {
            latitude,
            longitude,
            accuracy,
          },
          lastUpdate: { '.sv': 'timestamp' },
          clientUpdatedAtMs: Date.now(),
          userId: authUid,
        });
      } catch (error) {
        await disconnectHandler.cancel?.().catch(() => {});
        throw error;
      }
    } else {
      // Keep the disconnect cleanup armed until the server confirms deletion.
      // If remove fails during a network transition, the scheduled cleanup is
      // still able to remove the precise location when the connection closes.
      await ref.remove();
      await disconnectHandler?.cancel?.();
    }

    return true;
  } catch (error) {
    await logger.error('Safety', 'Failed to update live location', { error: error.message });
    return false;
  }
}

// Subscribe to safety alerts for a tour (for drivers/operations)
export function subscribeToSafetyAlerts(tourId, callback, onError) {
  if (!tourId) return () => {};

  const ref = realtimeDb.ref(`tours/${tourId}/safetyAlerts`);

  const handleData = (snapshot) => {
    const alerts = [];
    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        alerts.push({
          id: child.key,
          ...child.val(),
        });
      });
    }
    // Sort by timestamp descending (newest first)
    alerts.sort((a, b) => (parseTimestampMs(b.timestamp) ?? 0) - (parseTimestampMs(a.timestamp) ?? 0));
    callback(alerts);
  };

  const handleError = (error) => {
    logger.error('Safety', 'Safety alert subscription failed', {
      tourId,
      error: error?.message || String(error),
    });
    onError?.(error);
  };

  ref.on('value', handleData, handleError);

  return () => ref.off('value', handleData);
}

// Update safety event status
export async function updateEventStatus(tourId, eventId, newStatus, notes = '') {
  if (!tourId || !eventId) return false;

  try {
    const updates = {
      status: newStatus,
      statusUpdatedAt: new Date().toISOString(),
      statusNotes: notes,
    };

    await realtimeDb.ref(`tours/${tourId}/safetyAlerts/${eventId}`).update(updates);

    await logger.info('Safety', 'Event status updated', { eventId, newStatus });
    return true;
  } catch (error) {
    await logger.error('Safety', 'Failed to update event status', { error: error.message });
    return false;
  }
}

// Get user's safety event history
export async function getSafetyHistory(userId, limit = 20) {
  if (!userId) return [];

  try {
    const safetyLogUserKey = resolveSafetyLogUserKey();
    if (!safetyLogUserKey) return [];
    const snapshot = await realtimeDb
      .ref(`logs/${safetyLogUserKey}/safety`)
      .orderByChild('timestamp')
      .limitToLast(limit)
      .once('value');

    const events = [];
    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        events.push({
          id: child.key,
          ...child.val(),
        });
      });
    }

    // Sort descending
    return events.sort((a, b) => (parseTimestampMs(b.timestamp) ?? 0) - (parseTimestampMs(a.timestamp) ?? 0));
  } catch (error) {
    await logger.error('Safety', 'Failed to get safety history', { error: error.message });
    return [];
  }
}

// Trusted contacts storage
const LEGACY_TRUSTED_CONTACTS_KEY = '@LLT:trustedContacts';
const TRUSTED_CONTACTS_KEY_PREFIX = '@LLT:trustedContacts:v2:';
const MAX_TRUSTED_CONTACTS = 5;

const getTrustedContactsStorageKey = (principalId) => {
  const normalized = typeof principalId === 'string' ? principalId.trim() : '';
  return normalized ? `${TRUSTED_CONTACTS_KEY_PREFIX}${encodeURIComponent(normalized)}` : null;
};

const readTrustedContactsStrict = async (principalId) => {
  const storageKey = getTrustedContactsStorageKey(principalId);
  if (!storageKey) return [];
  const data = await AsyncStorage.getItem(storageKey);
  if (!data) return [];
  const parsed = JSON.parse(data);
  if (!Array.isArray(parsed)) throw new Error('Trusted contacts payload is invalid');
  const contactsAreValid = parsed.every((contact) => (
    contact
    && typeof contact.id === 'string'
    && typeof contact.name === 'string'
    && typeof contact.phone === 'string'
  ));
  if (!contactsAreValid || parsed.length > MAX_TRUSTED_CONTACTS) {
    throw new Error('Trusted contacts payload is invalid');
  }
  return parsed;
};

export async function getTrustedContacts(principalId) {
  try {
    return await readTrustedContactsStrict(principalId);
  } catch (error) {
    await logger.warn('Safety', 'Trusted contacts could not be loaded', {
      error: error?.message || String(error),
    });
    return [];
  }
}

export async function saveTrustedContacts(principalId, contacts) {
  try {
    const storageKey = getTrustedContactsStorageKey(principalId);
    if (!storageKey) return false;
    await AsyncStorage.setItem(storageKey, JSON.stringify(contacts));
    return true;
  } catch (error) {
    return false;
  }
}

export async function addTrustedContact(principalId, contact) {
  const operation = trustedContactsMutationTail.catch(() => {}).then(async () => {
    const name = typeof contact?.name === 'string' ? contact.name.trim().slice(0, 80) : '';
    const phone = typeof contact?.phone === 'string' ? contact.phone.trim().slice(0, 40) : '';
    if (!name || (phone.match(/\d/g) || []).length < 7) {
      const error = new Error('Trusted contact details are invalid');
      error.code = 'TRUSTED_CONTACT_INVALID';
      throw error;
    }
    const contacts = await readTrustedContactsStrict(principalId);
    if (contacts.length >= MAX_TRUSTED_CONTACTS) {
      const error = new Error(`You can save up to ${MAX_TRUSTED_CONTACTS} trusted contacts`);
      error.code = 'TRUSTED_CONTACT_LIMIT';
      throw error;
    }
    const newContact = {
      id: `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      phone,
      addedAt: new Date().toISOString(),
    };
    const saved = await saveTrustedContacts(principalId, [...contacts, newContact]);
    if (!saved) {
      const error = new Error('Trusted contact could not be saved on this device');
      error.code = 'TRUSTED_CONTACT_SAVE_FAILED';
      throw error;
    }
    return newContact;
  });
  trustedContactsMutationTail = operation.catch(() => {});
  return operation;
}

export async function removeTrustedContact(principalId, contactId) {
  const operation = trustedContactsMutationTail.catch(() => {}).then(async () => {
    const contacts = await readTrustedContactsStrict(principalId);
    const filtered = contacts.filter(c => c.id !== contactId);
    const saved = await saveTrustedContacts(principalId, filtered);
    if (!saved) {
      const error = new Error('Trusted contact could not be removed from this device');
      error.code = 'TRUSTED_CONTACT_SAVE_FAILED';
      throw error;
    }
    return true;
  });
  trustedContactsMutationTail = operation.catch(() => {});
  return operation;
}

// Emergency SMS template
export function generateEmergencySMS(coords, tourData, userName) {
  const locationUrl = coords
    ? `https://maps.google.com/?q=${coords.latitude},${coords.longitude}`
    : 'Location unavailable';

  return `SOS EMERGENCY from ${userName || 'Tour Passenger'}!\n\nTour: ${tourData?.name || 'Unknown'}\nTour Code: ${tourData?.tourCode || 'N/A'}\n\nMy location: ${locationUrl}\n\nPlease send help immediately!`;
}

// Get offline queue count
export async function getOfflineQueueCount(scope) {
  try {
    const queue = await readOfflineSafetyQueue();
    return filterSafetyQueueForScope(queue, scope).length;
  } catch (error) {
    return 0;
  }
}

export async function getOfflineQueuedSafetyEvents(scope, limit = 20) {
  try {
    const queue = filterSafetyQueueForScope(await readOfflineSafetyQueue(), scope);
    if (!Array.isArray(queue) || queue.length === 0) return [];

    const mapped = queue.map((event, index) => ({
      id: `queued_${index}_${event.queuedAt || event.timestamp || Date.now()}`,
      ...event,
      isQueued: true,
    }));

    return mapped
      .sort((a, b) => (parseTimestampMs(b.timestamp || b.queuedAt) ?? 0) - (parseTimestampMs(a.timestamp || a.queuedAt) ?? 0))
      .slice(0, limit);
  } catch (error) {
    return [];
  }
}

export async function getOfflineQueueSummary(scope, nowMs = Date.now()) {
  try {
    const queue = filterSafetyQueueForScope(await readOfflineSafetyQueue(), scope);
    return queue.reduce((summary, event) => {
      summary.total += 1;
      if (event.retryDisposition === SAFETY_RETRY_DISPOSITION.REQUIRES_ATTENTION) {
        summary.requiresAttention += 1;
        return summary;
      }
      const nextRetryAtMs = Number(event.nextRetryAtMs);
      if (Number.isFinite(nextRetryAtMs) && nextRetryAtMs > nowMs) {
        summary.waiting += 1;
        summary.nextRetryAtMs = summary.nextRetryAtMs === null
          ? nextRetryAtMs
          : Math.min(summary.nextRetryAtMs, nextRetryAtMs);
      } else {
        summary.readyToRetry += 1;
      }
      return summary;
    }, {
      total: 0,
      readyToRetry: 0,
      waiting: 0,
      requiresAttention: 0,
      nextRetryAtMs: null,
    });
  } catch (error) {
    return { total: 0, readyToRetry: 0, waiting: 0, requiresAttention: 0, nextRetryAtMs: null };
  }
}

export const __testables = {
  MAX_OFFLINE_SAFETY_EVENTS,
  SAFETY_RETRY_BASE_DELAY_MS,
  SAFETY_RETRY_MAX_DELAY_MS,
  SAFETY_RETRY_DISPOSITION,
  boundOfflineSafetyQueue,
  normalizeOfflineSafetyEvent,
  normalizeSafetyQueueScope,
  deriveSafetyQueueScope,
  safetyEventMatchesScope,
  getSafetyQueueEventId,
  getSafetyRetryDelayMs,
  writeSafetyEventAtomically,
  toRemoteSafetyPayload,
  getTrustedContactsStorageKey,
  LEGACY_TRUSTED_CONTACTS_KEY,
};
