import {
  SAFETY_RETRY_DISPOSITION,
  SEVERITY_LEVELS,
  activeSafetyQueueReplays,
  buildPayload,
  deriveSafetyQueueScope,
  filterSafetyQueueForScope,
  getSafetyQueueEventId,
  getSafetyQueueScopeKey,
  getSafetyRetryDelayMs,
  logger,
  normalizeSafetyQueueScope,
  parseTimestampMs,
  readOfflineSafetyQueue,
  realtimeDb,
  resolveAuthUid,
  resolveSafetyLogUserKey,
  safetyEventMatchesScope,
  withSafetyQueueMutationLock,
  writeOfflineSafetyQueue,
  writeSafetyEventAtomically,
} from './safetyContext';
import { getSafetyAlertDetail } from '../notifications/notificationDeviceApiService';

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
    const action = {
      acknowledged: 'acknowledge',
      in_progress: 'start_response',
      escalated: 'escalate',
      resolved: 'resolve',
    }[String(newStatus || '').trim().toLowerCase()];
    if (!action) return false;
    await getSafetyAlertDetail({ tourId, eventId, action, notes: String(notes || '').slice(0, 500) });

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
