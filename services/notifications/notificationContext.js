// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { auth, realtimeDb } from '../../firebase';
import logger, { maskIdentifier } from '../loggerService';
import {
  DEFAULT_MARKETING_PREFERENCES,
} from '../../utils/notificationCategories';
import notificationRouting from '../../utils/notificationRouting';

// Configure how notifications behave when the app is open
const { resolveNotificationRoute } = notificationRouting;
const handledNotificationResponseKeys = new Set();
const inFlightNotificationResponseKeys = new Set();
const MAX_HANDLED_NOTIFICATION_RESPONSES = 50;
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
} = {}) => {
  if (typeof onNavigate !== 'function') {
    throw new Error('Notification response navigation callback is required');
  }

  if (Platform.OS === 'web') {
    return () => {};
  }

  let active = true;
  const handleResponse = async (response) => {
    if (!active || !response) return;
    const route = resolveNotificationRoute(response, getContext?.() || {});
    if (!route.accepted) {
      logger.info('NotificationService', 'Notification response ignored', { reason: route.reason });
      onRejected(route.reason);
      return;
    }
    if (handledNotificationResponseKeys.has(route.responseKey)
      || inFlightNotificationResponseKeys.has(route.responseKey)) return;

    inFlightNotificationResponseKeys.add(route.responseKey);

    logger.info('NotificationService', 'Notification response routed', {
      screen: route.screen,
      hasNoticeId: Boolean(route.params?.noticeId),
    });
    try {
      await onNavigate(route);
      handledNotificationResponseKeys.add(route.responseKey);
      if (handledNotificationResponseKeys.size > MAX_HANDLED_NOTIFICATION_RESPONSES) {
        const oldestKey = handledNotificationResponseKeys.values().next().value;
        handledNotificationResponseKeys.delete(oldestKey);
      }
    } catch (error) {
      logger.error('NotificationService', 'Notification response navigation failed', {
        screen: route.screen,
        error: error?.message || String(error),
      });
    } finally {
      inFlightNotificationResponseKeys.delete(route.responseKey);
    }
  };

  const subscription = Notifications.addNotificationResponseReceivedListener?.(handleResponse);
  Promise.resolve(Notifications.getLastNotificationResponseAsync?.())
    .then(handleResponse)
    .catch((error) => {
      logger.warn('NotificationService', 'Cold-start notification response could not be read', {
        error: error?.message || String(error),
      });
    });

  return () => {
    active = false;
    subscription?.remove?.();
  };
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
  if (isGrantedNotificationPermission(permissionResponse)) {
    return 'granted';
  }

  const canAskAgain = permissionResponse?.canAskAgain;
  if (canAskAgain === false) {
    return 'blocked';
  }

  return 'denied';
};

const permissionStateDescriptions = {
  granted: 'Notifications are enabled.',
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
