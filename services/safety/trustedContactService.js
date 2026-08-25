import {
  AsyncStorage,
  MAX_OFFLINE_SAFETY_EVENTS,
  SAFETY_RETRY_BASE_DELAY_MS,
  SAFETY_RETRY_DISPOSITION,
  SAFETY_RETRY_MAX_DELAY_MS,
  boundOfflineSafetyQueue,
  deriveSafetyQueueScope,
  filterSafetyQueueForScope,
  getSafetyQueueEventId,
  getSafetyRetryDelayMs,
  logger,
  normalizeOfflineSafetyEvent,
  normalizeSafetyQueueScope,
  parseTimestampMs,
  readOfflineSafetyQueue,
  safetyEventMatchesScope,
  toRemoteSafetyPayload,
  withTrustedContactsMutationLock,
  writeSafetyEventAtomically,
} from './safetyContext';

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
  } catch (_error) {
    return false;
  }
}

export async function addTrustedContact(principalId, contact) {
  return withTrustedContactsMutationLock(async () => {
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
}

export async function removeTrustedContact(principalId, contactId) {
  return withTrustedContactsMutationLock(async () => {
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
  } catch (_error) {
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
  } catch (_error) {
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
  } catch (_error) {
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
