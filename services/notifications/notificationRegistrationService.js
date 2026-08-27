export const primeNotificationPermissions = async ({
  userId = null,
  requestIfNeeded = true,
  persistState = true,
} = {}) => {
  try {
    logger.info('NotificationService', 'Permission probe started', {
      userId: maskIdentifier(userId),
      requestIfNeeded,
      isDevice: Boolean(Device.isDevice),
    });
    if (!Device.isDevice) {
      const unavailable = {
        state: 'unavailable',
        granted: false,
        canAskAgain: false,
        status: 'unavailable',
        description: permissionStateDescriptions.unavailable,
      };
      if (persistState) {
        await persistPermissionState({ userId, permissionState: unavailable.state, canAskAgain: unavailable.canAskAgain });
      }
      logger.info('NotificationService', 'Permission probe completed for unavailable device', {
        userId: maskIdentifier(userId),
      });
      return { success: true, data: unavailable };
    }

    let permissionResponse = await Notifications.getPermissionsAsync();

    if (requestIfNeeded && !isGrantedNotificationPermission(permissionResponse) && permissionResponse?.canAskAgain !== false) {
      permissionResponse = await Notifications.requestPermissionsAsync();
    }

    const state = resolvePermissionState(permissionResponse);
    const result = {
      state,
      granted: ['granted', 'provisional', 'ephemeral'].includes(state),
      canAskAgain: permissionResponse?.canAskAgain !== false,
      status: permissionResponse?.status || 'unknown',
      description: permissionStateDescriptions[state] || permissionStateDescriptions.denied,
    };

    if (persistState) {
      await persistPermissionState({ userId, permissionState: result.state, canAskAgain: result.canAskAgain });
    }
    logger.info('NotificationService', 'Permission probe completed', {
      userId: maskIdentifier(userId),
      state: result.state,
      granted: result.granted,
      canAskAgain: result.canAskAgain,
      requestIfNeeded,
    });
    return { success: true, data: result };
  } catch (error) {
    logger.error('NotificationService', 'Permission probe failed', {
      userId: maskIdentifier(userId),
      requestIfNeeded,
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || 'Permission check failed' };
  }
};

/**
 * Normalizes preference payloads into the stored schema.
 */
const normalizeNotificationPreferences = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {
      ops: { ...DEFAULT_NOTIFICATION_PREFERENCES.ops },
      marketing: { ...DEFAULT_NOTIFICATION_PREFERENCES.marketing },
    };
  }

  const source = extractPreferenceSource(preferences);

  const normalizedOps = {
    driver_updates: parsePreferenceBoolean(
      source?.ops?.driver_updates,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.driver_updates
    ),
    itinerary_changes: parsePreferenceBoolean(
      source?.ops?.itinerary_changes,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.itinerary_changes
    ),
    group_chat: parsePreferenceBoolean(
      source?.ops?.group_chat,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_chat
    ),
    group_photos: parsePreferenceBoolean(
      source?.ops?.group_photos,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_photos
    ),
  };

  const normalizedMarketing = normalizeMarketingPreferences(
    source?.marketing,
    DEFAULT_NOTIFICATION_PREFERENCES.marketing
  );

  return {
    ops: normalizedOps,
    marketing: normalizedMarketing,
  };
};

/**
 * Registers the device for push notifications and returns the Expo Push Token.
 * Enhanced with better error handling and retry logic
 */
export const registerForPushNotificationsAsync = async (
  retries = 3,
  { permissionGranted = false, requestIfNeeded = true } = {},
) => {
  try {
    logger.info('NotificationService', 'Push registration started', {
      retries,
      platform: Platform.OS,
      isDevice: Boolean(Device.isDevice),
    });
    // Check if running on physical device
    if (!Device.isDevice) {
      logger.warn('NotificationService', 'Push registration blocked on non-device runtime');
      return null;
    }

    // Set up Android notification channel
    if (Platform.OS === 'android') {
      try {
        await initializeNotificationChannels();
      } catch (channelError) {
        logger.warn('NotificationService', 'Android notification channel setup failed', {
          error: channelError?.message || String(channelError),
        });
        // Continue anyway, channel setup failure shouldn't block registration
      }
    }

    // Reuse a permission decision already made by the caller to avoid prompting
    // or probing twice during one save/restore action.
    if (!permissionGranted) {
      let finalPermissions;
      try {
        const existingPermissions = await Notifications.getPermissionsAsync();
        finalPermissions = existingPermissions;

        if (requestIfNeeded
          && !isGrantedNotificationPermission(existingPermissions)
          && existingPermissions?.canAskAgain !== false) {
          finalPermissions = await Notifications.requestPermissionsAsync();
        }
      } catch (permError) {
        logger.error('NotificationService', 'Push registration permission check failed', {
          error: permError?.message || String(permError),
        });
        return null;
      }

      if (!isGrantedNotificationPermission(finalPermissions)) {
        logger.warn('NotificationService', 'Push registration blocked by permission state', {
          status: finalPermissions?.status || 'unknown',
          canAskAgain: finalPermissions?.canAskAgain,
        });
        return null;
      }
    }

    // Get the Expo push token with retry logic
    let token;
    const projectId = resolveExpoProjectId();
    if (!projectId) {
      logger.warn('NotificationService', 'Push token project id missing');
      return null;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.debug('NotificationService', 'Push token fetch attempt started', {
          attempt,
          retries,
          hasProjectId: true,
        });
        const tokenData = await withTimeout(
          Notifications.getExpoPushTokenAsync({ projectId }),
          'Token fetch timeout'
        );
        token = tokenData.data;
        logger.info('NotificationService', 'Push token fetch succeeded', {
          attempt,
          retries,
          tokenPresent: Boolean(token),
        });
        break;
      } catch (tokenError) {
        logger.warn('NotificationService', 'Push token fetch attempt failed', {
          attempt,
          retries,
          error: tokenError?.message || String(tokenError),
        });
        if (attempt === retries) {
          return null;
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    return token;
  } catch (error) {
    logger.error('NotificationService', 'Push registration failed fatally', {
      error: error?.message || String(error),
    });
    return null;
  }
};

// Versioned IDs let Android users retain any explicit choices on the legacy
// default channel while new server policy can target purpose-specific channels.
export const initializeNotificationChannels = async () => {
  if (Platform.OS !== 'android') return;
  const max = Notifications.AndroidImportance.MAX;
  const high = Notifications.AndroidImportance.HIGH || max;
  const normal = Notifications.AndroidImportance.DEFAULT || high;
  const channels = [
    ['default', 'Loch Lomond Travel', max],
    ['llt_safety_v2', 'LLT Safety', max],
    ['llt_driver_operations_v2', 'Driver Operations', high],
    ['llt_tour_updates_v2', 'Tour Updates', high],
    ['llt_group_chat_v2', 'Group Chat', normal],
    ['llt_group_photos_v2', 'Group Photos', normal],
    ['llt_future_tours_v2', 'Future Tour Alerts', normal],
  ];
  await Promise.all(channels.map(([id, name, importance]) => Notifications.setNotificationChannelAsync(id, {
    name,
    importance,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#007DC3',
    enableVibrate: true,
    showBadge: true,
  })));
};

const buildUnavailableTokenPatch = ({
  nowIso,
  existingUserData: _existingUserData,
  permissionState,
  mergedPreferences,
}) => ({
  pushToken: null,
  pushTokenStatus: 'UNAVAILABLE',
  pushTokenProvider: 'expo',
  pushTokenInvalidReason: null,
  pushTokenUpdatedAt: nowIso,
  pushPermissionState: permissionState.state,
  pushPermissionCanAskAgain: permissionState.canAskAgain,
  pushPermissionUpdatedAt: nowIso,
  preferences: mergedPreferences,
  lastUpdated: nowIso,
  deviceOS: Platform.OS,
});

export { buildUnavailableTokenPatch, normalizeNotificationPreferences };

/**
 * Saves the user's token and preferences to Firebase.
 * Enhanced with validation and better error handling
 * @param {string} userId - The current user's ID
 * @param {object} preferences - The object containing toggle states
 */
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  normalizeMarketingPreferences,
  parsePreferenceBoolean,
} from '../../utils/notificationCategories';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  extractPreferenceSource,
  isGrantedNotificationPermission,
  logger,
  maskIdentifier,
  permissionStateDescriptions,
  persistPermissionState,
  resolveExpoProjectId,
  resolvePermissionState,
  withTimeout,
} from './notificationContext';
