// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { auth, realtimeDb } from '../../firebase';
import logger, { maskIdentifier } from '../loggerService';
import {
  DEFAULT_MARKETING_PREFERENCES,
} from '../../utils/notificationCategories';
import notificationRouting from '../../utils/notificationRouting';

// Configure how notifications behave when the app is open
const {
  NOTIFICATION_RESPONSE_DISPOSITIONS,
  getNotificationResponseKey,
  readNotificationData,
  resolveNotificationRoute,
} = notificationRouting;
const handledNotificationResponseKeys = new Set();
const handledNotificationResponseTimes = new Map();
const inFlightNotificationResponseKeys = new Set();
const MAX_HANDLED_NOTIFICATION_RESPONSES = 50;
const HANDLED_RESPONSE_KEY = '@LLT:handled-notification-responses:v1';
const PENDING_RESPONSE_KEY = '@LLT:pending-notification-response:v1';
const HANDLED_RESPONSE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_RESPONSE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_RESPONSE_DATA_LENGTH = 8_192;
const NOTIFICATION_IO_TIMEOUT_MS = 10000;

const withTimeout = (promise, message, timeoutMs = NOTIFICATION_IO_TIMEOUT_MS) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
};

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Routes both cold-start and foreground/background notification taps through the
 * app's own navigation contract. Responses are deduplicated because Expo can
 * surface the same response through both APIs during startup.
 */
export const subscribeToNotificationResponses = ({
  getContext = () => ({}),
  onNavigate,
  onRejected = () => {},
  storage = AsyncStorage,
  now = () => Date.now(),
} = {}) => {
  if (typeof onNavigate !== 'function') {
    throw new Error('Notification response navigation callback is required');
  }

  if (Platform.OS === 'web') {
    return () => {};
  }

  let active = true;
  const persistHandled = async () => {
    const cutoff = now() - HANDLED_RESPONSE_RETENTION_MS;
    const entries = [...handledNotificationResponseTimes.entries()]
      .filter(([, handledAtMs]) => handledAtMs > cutoff)
      .slice(-MAX_HANDLED_NOTIFICATION_RESPONSES)
      .map(([key, handledAtMs]) => ({ key, handledAtMs }));
    await storage.setItem(HANDLED_RESPONSE_KEY, JSON.stringify(entries));
  };
  const handledReady = Promise.resolve(storage.getItem(HANDLED_RESPONSE_KEY)).then((raw) => {
    const entries = JSON.parse(raw || '[]');
    const cutoff = now() - HANDLED_RESPONSE_RETENTION_MS;
    if (!Array.isArray(entries)) return;
    entries.slice(-MAX_HANDLED_NOTIFICATION_RESPONSES).forEach((entry) => {
      const key = typeof entry === 'string' ? entry : entry?.key;
      const handledAtMs = typeof entry === 'string' ? now() : Number(entry?.handledAtMs || 0);
      if (typeof key === 'string' && key && handledAtMs > cutoff) {
        handledNotificationResponseKeys.add(key);
        handledNotificationResponseTimes.set(key, handledAtMs);
      }
    });
  }).catch(() => undefined);

  const readPending = async () => {
    try {
      const raw = await storage.getItem(PENDING_RESPONSE_KEY);
      const pending = JSON.parse(raw || 'null');
      const expired = pending?.schemaVersion === 1
        && pending?.response
        && Number.isSafeInteger(pending.storedAtMs)
        && pending.storedAtMs + PENDING_RESPONSE_RETENTION_MS <= now();
      if (expired && typeof pending.responseKey === 'string') {
        handledNotificationResponseKeys.add(pending.responseKey);
        handledNotificationResponseTimes.set(pending.responseKey, now());
        await persistHandled().catch(() => undefined);
      }
      if (!pending || pending.schemaVersion !== 1 || !pending.response
        || !Number.isSafeInteger(pending.storedAtMs) || expired) {
        if (raw) await storage.removeItem(PENDING_RESPONSE_KEY).catch(() => undefined);
        return null;
      }
      return pending;
    } catch (_error) {
      await storage.removeItem(PENDING_RESPONSE_KEY).catch(() => undefined);
      return null;
    }
  };
  const persistPending = async (response) => {
    const data = readNotificationData(response);
    const serializedData = JSON.stringify(data || {});
    if (serializedData.length > MAX_PENDING_RESPONSE_DATA_LENGTH) return false;
    const responseKey = getNotificationResponseKey(response);
    const existing = await readPending();
    const compactResponse = {
      request: {
        identifier: responseKey,
        content: { data },
      },
    };
    await storage.setItem(PENDING_RESPONSE_KEY, JSON.stringify({
      schemaVersion: 1,
      responseKey,
      response: compactResponse,
      storedAtMs: existing?.responseKey === responseKey ? existing.storedAtMs : now(),
    }));
    return true;
  };
  const clearPending = async (responseKey) => {
    const pending = await readPending();
    if (!pending || pending.responseKey === responseKey) {
      await storage.removeItem(PENDING_RESPONSE_KEY).catch(() => undefined);
    }
  };
  const clearNativeIfMatching = async (responseKey) => {
    try {
      const last = await Notifications.getLastNotificationResponseAsync?.();
      if (!last || getNotificationResponseKey(last) === responseKey) {
        await Notifications.clearLastNotificationResponseAsync?.();
      }
    } catch (_error) {
      // A later subscription/retry will consume a lingering handled response.
    }
  };
  const handleResponse = async (response) => {
    if (!active || !response) return;
    await handledReady;
    if (!active) return;
    const responseKey = getNotificationResponseKey(response);
    if (handledNotificationResponseKeys.has(responseKey)) {
      await clearPending(responseKey);
      await clearNativeIfMatching(responseKey);
      return { accepted: true, disposition: NOTIFICATION_RESPONSE_DISPOSITIONS.ACCEPTED, responseKey };
    }
    const route = resolveNotificationRoute(response, getContext?.() || {});
    if (route.disposition === NOTIFICATION_RESPONSE_DISPOSITIONS.TRANSIENTLY_DEFERRED) {
      const retained = await persistPending(response).catch(() => false);
      logger.info('NotificationService', 'Notification response deferred', {
        reason: route.reason,
        retained,
      });
      onRejected(route.reason, route.disposition);
      return route;
    }
    if (!route.accepted) {
      logger.info('NotificationService', 'Notification response ignored', { reason: route.reason });
      onRejected(route.reason, route.disposition);
      await clearPending(responseKey);
      await clearNativeIfMatching(responseKey);
      return route;
    }
    if (inFlightNotificationResponseKeys.has(route.responseKey)) return route;

    inFlightNotificationResponseKeys.add(route.responseKey);

    logger.info('NotificationService', 'Notification response routed', {
      screen: route.screen,
      hasNoticeId: Boolean(route.params?.noticeId),
    });
    try {
      await onNavigate(route);
      handledNotificationResponseKeys.add(route.responseKey);
      handledNotificationResponseTimes.set(route.responseKey, now());
      if (handledNotificationResponseKeys.size > MAX_HANDLED_NOTIFICATION_RESPONSES) {
        const oldestKey = handledNotificationResponseKeys.values().next().value;
        handledNotificationResponseKeys.delete(oldestKey);
        handledNotificationResponseTimes.delete(oldestKey);
      }
      try {
        await persistHandled();
      } catch (error) {
        logger.warn('NotificationService', 'Handled notification response could not be persisted', {
          screen: route.screen,
          error: error?.message || String(error),
        });
      }
      await clearPending(route.responseKey);
      await clearNativeIfMatching(route.responseKey);
    } catch (error) {
      logger.error('NotificationService', 'Notification response navigation failed', {
        screen: route.screen,
        error: error?.message || String(error),
      });
      await persistPending(response).catch(() => undefined);
      onRejected('NAVIGATION_NOT_READY', NOTIFICATION_RESPONSE_DISPOSITIONS.TRANSIENTLY_DEFERRED);
    } finally {
      inFlightNotificationResponseKeys.delete(route.responseKey);
    }
  };

  const subscription = Notifications.addNotificationResponseReceivedListener?.(handleResponse);
  const retryPending = async () => {
    const pending = await readPending();
    if (pending?.response) return handleResponse(pending.response);
    return null;
  };
  Promise.resolve()
    .then(retryPending)
    .then(() => Notifications.getLastNotificationResponseAsync?.())
    .then(handleResponse)
    .catch((error) => {
      logger.warn('NotificationService', 'Cold-start notification response could not be read', {
        error: error?.message || String(error),
      });
    });

  const unsubscribe = () => {
    active = false;
    subscription?.remove?.();
  };
  unsubscribe.retryPending = retryPending;
  return unsubscribe;
};

// ==================== VALIDATION HELPERS ====================

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

const resolveAuthUid = () => {
  const currentUid = auth?.currentUser?.uid;
  if (typeof currentUid !== 'string') {
    return null;
  }
  const trimmed = currentUid.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveNotificationUserId = (candidateUserId) => {
  const authUid = resolveAuthUid();
  const normalizedCandidate = typeof candidateUserId === 'string' ? candidateUserId.trim() : '';

  if (authUid) {
    if (normalizedCandidate && normalizedCandidate !== authUid) {
      logger.warn('NotificationService', 'Non-auth user id ignored in favor of authenticated uid', {
        candidateUserId: maskIdentifier(normalizedCandidate),
        authUid: maskIdentifier(authUid),
      });
    }
    return authUid;
  }

  return validateUserId(candidateUserId);
};

/**
 * Validates preferences object
 */
const validatePreferences = (preferences) => {
  if (!preferences || typeof preferences !== 'object') {
    throw new Error('Preferences must be an object');
  }
  return preferences;
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  ops: {
    driver_updates: true,
    itinerary_changes: true,
    group_chat: true,
    group_photos: false,
  },
  marketing: DEFAULT_MARKETING_PREFERENCES,
};

const extractPreferenceSource = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {};
  }

  return preferences.preferences || preferences;
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const resolveExpoProjectId = () => {
  const fromExpoConfig = Constants?.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExpoConfig === 'string' && fromExpoConfig.trim().length > 0) {
    return fromExpoConfig.trim();
  }

  const fromEasConfig = Constants?.easConfig?.projectId;
  if (typeof fromEasConfig === 'string' && fromEasConfig.trim().length > 0) {
    return fromEasConfig.trim();
  }

  return null;
};

const isGrantedNotificationPermission = (permissionResponse) => {
  const status = permissionResponse?.status;
  if (status === 'granted') {
    return true;
  }

  const iosPermissionStatus = permissionResponse?.ios?.status;
  return iosPermissionStatus === Notifications.IosAuthorizationStatus?.PROVISIONAL
    || iosPermissionStatus === Notifications.IosAuthorizationStatus?.EPHEMERAL;
};

const resolvePermissionState = (permissionResponse) => {
  const iosStatus = permissionResponse?.ios?.status;
  if (iosStatus === Notifications.IosAuthorizationStatus?.PROVISIONAL) return 'provisional';
  if (iosStatus === Notifications.IosAuthorizationStatus?.EPHEMERAL) return 'ephemeral';
  if (permissionResponse?.status === 'granted') return 'granted';

  const canAskAgain = permissionResponse?.canAskAgain;
  if (canAskAgain === false) {
    return 'blocked';
  }

  return 'denied';
};

const permissionStateDescriptions = {
  granted: 'Notifications are enabled.',
  provisional: 'Notifications are enabled quietly.',
  ephemeral: 'Notifications are enabled temporarily.',
  denied: 'Notifications are not enabled yet.',
  blocked: 'Notifications are blocked in device settings.',
  unavailable: 'Notifications are unavailable on this device.',
};

const persistPermissionState = async ({ userId, permissionState, canAskAgain }) => {
  if (!userId || !realtimeDb) {
    return;
  }

  try {
    const nowIso = new Date().toISOString();
    await realtimeDb.ref(`users/${userId}`).update({
      pushPermissionState: permissionState,
      pushPermissionCanAskAgain: typeof canAskAgain === 'boolean' ? canAskAgain : null,
      pushPermissionUpdatedAt: nowIso,
      lastUpdated: nowIso,
    });
    logger.info('NotificationService', 'Push permission state persisted', {
      userId: maskIdentifier(userId),
      permissionState,
      canAskAgain,
    });
  } catch (error) {
    logger.warn('NotificationService', 'Failed to persist push permission state', {
      userId: maskIdentifier(userId),
      permissionState,
      error: error?.message || String(error),
    });
  }
};

export {
  DEFAULT_NOTIFICATION_PREFERENCES,
  extractPreferenceSource,
  hasOwn,
  isGrantedNotificationPermission,
  logger,
  maskIdentifier,
  permissionStateDescriptions,
  persistPermissionState,
  realtimeDb,
  resolveExpoProjectId,
  resolveNotificationUserId,
  resolvePermissionState,
  validatePreferences,
  withTimeout,
};
