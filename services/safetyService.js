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

// Log a safety event to Firebase
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
  } = params;

  const sanitizedUserId = userId || 'anonymous';
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
    // Write to user's safety log
    const userRef = realtimeDb.ref(`logs/${sanitizedUserId}/safety`).push();
    await userRef.set(payload);

    // Also write to tour's safety log for operations visibility
    if (tourId) {
      const tourRef = realtimeDb.ref(`tours/${tourId}/safetyAlerts`).push();
      await tourRef.set({
        ...payload,
        eventId: userRef.key,
      });
    }

    // For SOS or critical events, write to global alerts for immediate visibility
    if (isSOS || severity === SEVERITY_LEVELS.CRITICAL) {
      const globalRef = realtimeDb.ref('globalSafetyAlerts').push();
      await globalRef.set({
        ...payload,
        eventId: userRef.key,
        tourAlertId: tourId ? `tours/${tourId}/safetyAlerts` : null,
      });
    }

    await logger.warn('Safety', 'Safety event recorded', {
      category,
      severity,
      isSOS,
      tourId,
    });

    return { success: true, eventId: userRef.key, payload };
  } catch (error) {
    await logger.error('Safety', 'Failed to log safety event', { error: error.message });

    // Queue for offline retry
    await queueOfflineSafetyEvent(payload);

    throw error;
  }
}

// Queue safety events when offline
export async function queueOfflineSafetyEvent(payload) {
  try {
    const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    const queue = existingQueue ? JSON.parse(existingQueue) : [];
    queue.push({
      ...payload,
      queuedAt: new Date().toISOString(),
    });
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    await logger.info('Safety', 'Event queued for offline retry', { queueLength: queue.length });
  } catch (error) {
    await logger.error('Safety', 'Failed to queue offline event', { error: error.message });
  }
}

// Process offline queue when back online
export async function processOfflineQueue(userId) {
  try {
    const existingQueue = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!existingQueue) return { processed: 0, failed: 0 };

    const queue = JSON.parse(existingQueue);
    if (queue.length === 0) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;
    const failedEvents = [];

    for (const event of queue) {
      try {
        const sanitizedUserId = userId || event.userId || 'anonymous';
        const ref = realtimeDb.ref(`logs/${sanitizedUserId}/safety`).push();
        await ref.set({
          ...event,
          processedFromQueue: true,
          originalTimestamp: event.timestamp,
          timestamp: new Date().toISOString(),
        });
        processed++;
      } catch (error) {
        failed++;
        failedEvents.push(event);
      }
    }

    // Update queue with only failed events
    if (failedEvents.length > 0) {
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(failedEvents));
    } else {
      await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
    }

    await logger.info('Safety', 'Offline queue processed', { processed, failed });
    return { processed, failed };
  } catch (error) {
    await logger.error('Safety', 'Failed to process offline queue', { error: error.message });
    return { processed: 0, failed: 0, error: error.message };
  }
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
