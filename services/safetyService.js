// services/safetyService.js - Enhanced Safety & Emergency Services
import { realtimeDb } from '../firebase';
import logger from './loggerService';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

// Cap retries so a permanently-bad payload (e.g. revoked tour, stale auth)
// can't loop forever on every reconnect.
const MAX_REPLAY_ATTEMPTS = 5;

// In-flight processOfflineQueue promise. Prevents duplicate ops alerts when
// NetInfo flips connectivity rapidly and several listeners fire at once.
let replayLock = null;

const generateSafetyEventId = () =>
  `safety_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

const normalizeEventId = (candidate) =>
  typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;

// Build the absolute-path multi-location update that delivers a safety event
// to every audience in a single atomic Firebase write. Reusing the same
// `eventId` across audiences makes retries idempotent: a second write to the
// same key is an upsert, not a duplicate record.
const buildSafetyMultiPathUpdates = ({ payload, eventId }) => {
  if (!eventId) {
    throw new Error('Safety event id is required for atomic write');
  }

  const userId = payload.userId || 'anonymous';
  const updates = {};

  updates[`logs/${userId}/safety/${eventId}`] = payload;

  if (payload.tourId) {
    updates[`tours/${payload.tourId}/safetyAlerts/${eventId}`] = {
      ...payload,
      eventId,
    };
  }

  if (payload.isSOS || payload.severity === SEVERITY_LEVELS.CRITICAL) {
    updates[`globalSafetyAlerts/${eventId}`] = {
      ...payload,
      eventId,
      tourAlertId: payload.tourId
        ? `tours/${payload.tourId}/safetyAlerts/${eventId}`
        : null,
    };
  }

  return updates;
};

// Build standardized payload
const buildPayload = ({
  userId,
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
}) => ({
  category,
  severity: severity || SEVERITY_LEVELS.MEDIUM,
  message,
  customMessage: customMessage || null,
  role,
  tourId: tourId || null,
  bookingId: bookingId || null,
  timestamp: new Date().toISOString(),
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
  userId: userId || 'anonymous',
});

// Log a safety event to Firebase as a single atomic multi-path write so the
// user log, tour alert, and (for SOS/CRITICAL) global alert either all land
// or none does. A partial write here would leave operations dispatchers
// blind to an SOS that the passenger believes was sent.
export async function logSafetyEvent(params) {
  const {
    userId,
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
    eventId: providedEventId,
  } = params;

  const sanitizedUserId = userId || 'anonymous';
  const eventId = normalizeEventId(providedEventId) || generateSafetyEventId();
  const payload = buildPayload({
    userId: sanitizedUserId,
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
  });

  try {
    const updates = buildSafetyMultiPathUpdates({ payload, eventId });
    await realtimeDb.ref().update(updates);

    await logger.warn('Safety', 'Safety event recorded', {
      category,
      severity,
      isSOS,
      tourId,
      eventId,
    });

    return { success: true, eventId, payload };
  } catch (error) {
    await logger.error('Safety', 'Failed to log safety event; queuing for retry', {
      error: error.message,
      eventId,
    });

    // Persist with the same eventId so the eventual replay overwrites
    // the same Firebase keys instead of producing duplicate records.
    await queueOfflineSafetyEvent({ ...payload, eventId });

    throw error;
  }
}

// Queue safety events when offline. Idempotent: re-queueing the same eventId
// replaces the prior entry rather than stacking duplicates.
export async function queueOfflineSafetyEvent(payload) {
  try {
    const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    const parsed = existingQueue ? JSON.parse(existingQueue) : [];
    const queue = Array.isArray(parsed) ? parsed : [];

    const eventId = normalizeEventId(payload?.eventId) || generateSafetyEventId();
    const previousIndex = queue.findIndex((entry) => entry?.eventId === eventId);
    const previousAttempts = previousIndex >= 0
      ? Number(queue[previousIndex]?.attempts) || 0
      : 0;

    const queuedEntry = {
      ...payload,
      eventId,
      queuedAt: payload?.queuedAt || new Date().toISOString(),
      attempts: previousAttempts,
    };

    if (previousIndex >= 0) {
      queue[previousIndex] = queuedEntry;
    } else {
      queue.push(queuedEntry);
    }

    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    await logger.info('Safety', 'Event queued for offline retry', {
      queueLength: queue.length,
      eventId,
    });
  } catch (error) {
    await logger.error('Safety', 'Failed to queue offline event', { error: error.message });
  }
}

// Process offline queue when back online. Single-flight: a second concurrent
// caller short-circuits so we never double-publish ops alerts when NetInfo
// flips and several listeners fire in the same tick.
export async function processOfflineQueue(userId) {
  if (replayLock) {
    return { processed: 0, failed: 0, dropped: 0, alreadyRunning: true };
  }

  replayLock = (async () => {
    try {
      const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (!existingQueue) return { processed: 0, failed: 0, dropped: 0 };

      const parsedQueue = JSON.parse(existingQueue);
      const queue = Array.isArray(parsedQueue) ? parsedQueue : [];
      if (queue.length === 0) return { processed: 0, failed: 0, dropped: 0 };

      let processed = 0;
      let failed = 0;
      let dropped = 0;
      const remaining = [];

      for (const event of queue) {
        const sanitizedUserId = userId || event?.userId || 'anonymous';
        const eventId = normalizeEventId(event?.eventId) || generateSafetyEventId();
        const attemptsSoFar = (Number(event?.attempts) || 0) + 1;

        try {
          const replayPayload = {
            ...event,
            userId: sanitizedUserId,
            processedFromQueue: true,
            originalTimestamp: event?.timestamp,
            timestamp: new Date().toISOString(),
          };
          delete replayPayload.attempts;
          delete replayPayload.queuedAt;
          delete replayPayload.lastError;
          delete replayPayload.lastAttemptAt;
          delete replayPayload.eventId;

          const updates = buildSafetyMultiPathUpdates({
            payload: replayPayload,
            eventId,
          });
          await realtimeDb.ref().update(updates);
          processed++;
        } catch (error) {
          if (attemptsSoFar >= MAX_REPLAY_ATTEMPTS) {
            dropped++;
            await logger.fatal('Safety', 'Dropping safety event after max retries', {
              eventId,
              attempts: attemptsSoFar,
              error: error.message,
              category: event?.category,
              severity: event?.severity,
              isSOS: event?.isSOS,
              tourId: event?.tourId,
            });
          } else {
            failed++;
            remaining.push({
              ...event,
              eventId,
              attempts: attemptsSoFar,
              lastError: error.message,
              lastAttemptAt: new Date().toISOString(),
            });
          }
        }
      }

      if (remaining.length > 0) {
        await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      } else {
        await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
      }

      await logger.info('Safety', 'Offline queue processed', { processed, failed, dropped });
      return { processed, failed, dropped };
    } catch (error) {
      await logger.error('Safety', 'Failed to process offline queue', { error: error.message });
      return { processed: 0, failed: 0, dropped: 0, error: error.message };
    } finally {
      replayLock = null;
    }
  })();

  return replayLock;
}

// Update live location sharing status
export async function updateLiveLocationSharing(tourId, userId, isSharing, coords = null) {
  if (!tourId || !userId) return false;

  try {
    const ref = realtimeDb.ref(`tours/${tourId}/liveTracking/${userId}`);

    if (isSharing && coords) {
      await ref.set({
        isSharing: true,
        coords: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
        },
        lastUpdate: new Date().toISOString(),
        userId,
      });
    } else {
      await ref.remove();
    }

    return true;
  } catch (error) {
    await logger.error('Safety', 'Failed to update live location', { error: error.message });
    return false;
  }
}

// Subscribe to safety alerts for a tour (for drivers/operations)
export function subscribeToSafetyAlerts(tourId, callback) {
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
    alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    callback(alerts);
  };

  ref.on('value', handleData);

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
    const snapshot = await realtimeDb
      .ref(`logs/${userId}/safety`)
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
    return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (error) {
    await logger.error('Safety', 'Failed to get safety history', { error: error.message });
    return [];
  }
}

// Trusted contacts storage
const TRUSTED_CONTACTS_KEY = '@LLT:trustedContacts';

export async function getTrustedContacts() {
  try {
    const data = await AsyncStorage.getItem(TRUSTED_CONTACTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    return [];
  }
}

export async function saveTrustedContacts(contacts) {
  try {
    await AsyncStorage.setItem(TRUSTED_CONTACTS_KEY, JSON.stringify(contacts));
    return true;
  } catch (error) {
    return false;
  }
}

export async function addTrustedContact(contact) {
  const contacts = await getTrustedContacts();
  const newContact = {
    id: Date.now().toString(),
    ...contact,
    addedAt: new Date().toISOString(),
  };
  contacts.push(newContact);
  await saveTrustedContacts(contacts);
  return newContact;
}

export async function removeTrustedContact(contactId) {
  const contacts = await getTrustedContacts();
  const filtered = contacts.filter(c => c.id !== contactId);
  await saveTrustedContacts(filtered);
  return true;
}

// Emergency SMS template
export function generateEmergencySMS(coords, tourData, userName) {
  const locationUrl = coords
    ? `https://maps.google.com/?q=${coords.latitude},${coords.longitude}`
    : 'Location unavailable';

  return `SOS EMERGENCY from ${userName || 'Tour Passenger'}!\n\nTour: ${tourData?.name || 'Unknown'}\nTour Code: ${tourData?.tourCode || 'N/A'}\n\nMy location: ${locationUrl}\n\nPlease send help immediately!`;
}

// Get offline queue count
export async function getOfflineQueueCount() {
  try {
    const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!existingQueue) return 0;
    const queue = JSON.parse(existingQueue);
    return queue.length;
  } catch (error) {
    return 0;
  }
}

export async function getOfflineQueuedSafetyEvents(limit = 20) {
  try {
    const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!existingQueue) return [];

    const queue = JSON.parse(existingQueue);
    if (!Array.isArray(queue) || queue.length === 0) return [];

    const mapped = queue.map((event, index) => ({
      id: `queued_${index}_${event.queuedAt || event.timestamp || Date.now()}`,
      ...event,
      isQueued: true,
    }));

    return mapped
      .sort((a, b) => new Date(b.timestamp || b.queuedAt) - new Date(a.timestamp || a.queuedAt))
      .slice(0, limit);
  } catch (error) {
    return [];
  }
}
