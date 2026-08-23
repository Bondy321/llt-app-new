// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { auth, realtimeDb } from '../firebase';
import appMetadataModule from './appMetadata';
import logger, { maskIdentifier } from './loggerService';
import {
  DEFAULT_MARKETING_PREFERENCES,
  TOUR_NOTIFICATION_CATEGORY_KEYS,
  hasMarketingPreferenceInput,
  normalizeMarketingPreferences,
  parsePreferenceBoolean,
} from '../utils/notificationCategories';
import notificationRouting from '../utils/notificationRouting';

// Configure how notifications behave when the app is open
const { resolveAppVersionMetadata } = appMetadataModule;
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
      granted: state === 'granted',
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
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF231F7C',
          enableVibrate: true,
          showBadge: true,
        });
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

const buildUnavailableTokenPatch = ({
  nowIso,
  existingUserData,
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

/**
 * Saves the user's token and preferences to Firebase.
 * Enhanced with validation and better error handling
 * @param {string} userId - The current user's ID
 * @param {object} preferences - The object containing toggle states
 */
export const saveUserPreferences = async (userId, preferences, options = {}) => {
  try {
    // Validate inputs
    const validatedUserId = resolveNotificationUserId(userId);
    const validatedPreferences = validatePreferences(preferences);
    logger.info('NotificationService', 'Preference save started', {
      userId: maskIdentifier(validatedUserId),
      hasOps: Boolean(extractPreferenceSource(validatedPreferences)?.ops),
      hasMarketing: Boolean(extractPreferenceSource(validatedPreferences)?.marketing),
    });

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const userRef = realtimeDb.ref(`users/${validatedUserId}`);

    // Verify the remote destination before triggering an OS permission prompt.
    // Permission decisions can take human time, so keep a bounded one-minute gate.
    const userSnapshot = await withTimeout(
      userRef.once('value'),
      'Existing preferences fetch timeout',
    );
    const suppliedPermissionState = options?.permissionState;
    const permissionProbe = suppliedPermissionState?.state
      ? { success: true, data: suppliedPermissionState }
      : await withTimeout(primeNotificationPermissions({
        userId: validatedUserId,
        requestIfNeeded: true,
        persistState: false,
      }), 'Permission check timeout', 60_000);

    const existingUserData = userSnapshot.val() || {};
    logger.debug('NotificationService', 'Existing notification preference record loaded', {
      userId: maskIdentifier(validatedUserId),
      hasExistingPreferences: Boolean(existingUserData.preferences),
      pushTokenStatus: existingUserData.pushTokenStatus || null,
      permissionState: existingUserData.pushPermissionState || null,
    });
    const existingRemotePreferences = normalizeNotificationPreferences(existingUserData.preferences);
    const incomingPreferences = normalizeNotificationPreferences(validatedPreferences);
    const incomingSource = extractPreferenceSource(validatedPreferences);

    const mergedOps = {
      ...DEFAULT_NOTIFICATION_PREFERENCES.ops,
      ...(existingRemotePreferences.ops || {}),
    };

    if (incomingSource?.ops && typeof incomingSource.ops === 'object') {
      Object.keys(DEFAULT_NOTIFICATION_PREFERENCES.ops).forEach((key) => {
        if (hasOwn(incomingSource.ops, key)) {
          mergedOps[key] = incomingPreferences.ops[key];
        }
      });
    }

    const mergedMarketing = {
      ...DEFAULT_NOTIFICATION_PREFERENCES.marketing,
      ...(existingRemotePreferences.marketing || {}),
    };

    if (incomingSource?.marketing && typeof incomingSource.marketing === 'object') {
      TOUR_NOTIFICATION_CATEGORY_KEYS.forEach((key) => {
        if (hasMarketingPreferenceInput(incomingSource.marketing, key)) {
          mergedMarketing[key] = incomingPreferences.marketing[key];
        }
      });
    }

    const mergedPreferences = {
      ops: mergedOps,
      marketing: mergedMarketing,
    };

    const permissionState = permissionProbe?.success
      ? permissionProbe.data
      : {
        state: 'unavailable',
        granted: false,
        canAskAgain: false,
        status: 'unavailable',
        description: permissionProbe?.error || permissionStateDescriptions.unavailable,
      };

    const nowIso = new Date().toISOString();

    if (!permissionState.granted) {
      await withTimeout(
        userRef.update(buildUnavailableTokenPatch({
          nowIso,
          existingUserData,
          permissionState,
          mergedPreferences,
        })),
        'Preferences save timeout'
      );

      logger.info('NotificationService', 'Preferences saved without active push token', {
        userId: maskIdentifier(validatedUserId),
        permissionState: permissionState.state,
        reason: 'permission_not_granted',
      });
      return {
        success: true,
        warning: 'Preferences saved, but notifications are disabled (no permission or not on physical device)',
        permissionState,
      };
    }

    // 2. Get the token (permission already granted above)
    const token = await registerForPushNotificationsAsync(3, { permissionGranted: true });

    if (!token) {
      await withTimeout(
        userRef.update(buildUnavailableTokenPatch({
          nowIso,
          existingUserData,
          permissionState,
          mergedPreferences,
        })),
        'Preferences save timeout'
      );

      logger.warn('NotificationService', 'Preferences saved but push token unavailable', {
        userId: maskIdentifier(validatedUserId),
        permissionState: permissionState.state,
      });
      return {
        success: true,
        warning: 'Preferences saved, but notifications are disabled (no permission or not on physical device)',
        permissionState,
      };
    }

    // 3. Save token and preferences
    const appVersionMetadata = resolveAppVersionMetadata({
      constants: Constants,
      platform: Platform,
    });

    const updateData = {
      pushToken: token,
      pushTokenStatus: 'ACTIVE',
      pushTokenUpdatedAt: nowIso,
      pushTokenProvider: 'expo',
      pushTokenInvalidReason: null,
      pushPermissionState: permissionState.state,
      pushPermissionCanAskAgain: permissionState.canAskAgain,
      pushPermissionUpdatedAt: nowIso,
      preferences: mergedPreferences,
      lastUpdated: nowIso,
      deviceOS: Platform.OS,
      deviceModel: Device.modelName || 'Unknown',
      appVersion: appVersionMetadata.appVersion,
      appBuild: appVersionMetadata.appBuild,
      osVersion: appVersionMetadata.osVersion,
    };

    await withTimeout(userRef.update(updateData), 'Preferences save timeout');

    logger.info('NotificationService', 'Preferences saved with active push token', {
      userId: maskIdentifier(validatedUserId),
      permissionState: permissionState.state,
      deviceOS: Platform.OS,
      appVersion: appVersionMetadata.appVersion,
      appBuild: appVersionMetadata.appBuild,
    });
    return { success: true, permissionState };
  } catch (error) {
    logger.error('NotificationService', 'Preference save failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, error: error.message };
  }
};

/**
 * Removes this authenticated device from push delivery when its in-app session
 * ends. Firebase Auth intentionally remains anonymous and signed in, so logout
 * must explicitly deactivate the token stored under that auth uid.
 */
export const deactivatePushToken = async (userId) => {
  try {
    const validatedUserId = resolveNotificationUserId(userId);
    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const nowIso = new Date().toISOString();
    await withTimeout(
      realtimeDb.ref(`users/${validatedUserId}`).update({
        pushToken: null,
        pushTokenStatus: 'UNAVAILABLE',
        pushTokenInvalidReason: 'SIGNED_OUT',
        pushTokenUpdatedAt: nowIso,
        lastUpdated: nowIso,
      }),
      'Push token deactivation timeout'
    );

    logger.info('NotificationService', 'Push token deactivated for signed-out session', {
      userId: maskIdentifier(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logger.warn('NotificationService', 'Push token deactivation failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || String(error) };
  }
};

/**
 * Restores push delivery after a successful app login without prompting for
 * permission or changing the traveller's saved preferences.
 */
export const restorePushTokenForSession = async (userId) => {
  try {
    const validatedUserId = resolveNotificationUserId(userId);
    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const userRef = realtimeDb.ref(`users/${validatedUserId}`);
    const snapshot = await withTimeout(
      userRef.once('value'),
      'Push token restore fetch timeout'
    );
    const userData = snapshot.val() || {};
    if (userData.pushTokenStatus === 'ACTIVE' && userData.pushToken) {
      return { success: true, restored: false, reason: 'already_active' };
    }
    if (userData.pushTokenInvalidReason !== 'SIGNED_OUT' || !userData.preferences) {
      return { success: true, restored: false, reason: 'not_signed_out' };
    }

    const permissionProbe = await primeNotificationPermissions({
      userId: validatedUserId,
      requestIfNeeded: false,
      persistState: false,
    });
    if (!permissionProbe?.success || !permissionProbe.data?.granted) {
      return { success: true, restored: false, reason: 'permission_not_granted' };
    }

    const token = await registerForPushNotificationsAsync(3, { permissionGranted: true });
    if (!token) {
      return { success: false, restored: false, error: 'Push token is unavailable' };
    }

    const nowIso = new Date().toISOString();
    await withTimeout(
      userRef.update({
        pushToken: token,
        pushTokenStatus: 'ACTIVE',
        pushTokenProvider: 'expo',
        pushTokenInvalidReason: null,
        pushTokenUpdatedAt: nowIso,
        pushPermissionState: permissionProbe.data.state,
        pushPermissionCanAskAgain: permissionProbe.data.canAskAgain,
        pushPermissionUpdatedAt: nowIso,
        lastUpdated: nowIso,
      }),
      'Push token restore timeout'
    );
    logger.info('NotificationService', 'Push token restored for signed-in session', {
      userId: maskIdentifier(validatedUserId),
    });
    return { success: true, restored: true };
  } catch (error) {
    logger.warn('NotificationService', 'Push token restore failed', {
      userId: maskIdentifier(userId),
      error: error?.message || String(error),
    });
    return { success: false, restored: false, error: error?.message || String(error) };
  }
};

/**
 * Loads existing preferences from Firebase
 * Enhanced with validation and timeout protection
 */
export const getUserPreferences = async (userId, options = {}) => {
  const { throwOnError = false } = options || {};

  try {
    // Validate input
    const validatedUserId = resolveNotificationUserId(userId);
    logger.info('NotificationService', 'Preference fetch started', {
      userId: maskIdentifier(validatedUserId),
      throwOnError,
    });

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const prefsRef = realtimeDb.ref(`users/${validatedUserId}/preferences`);

    const snapshot = await withTimeout(
      prefsRef.once('value'),
      'Preferences fetch timeout'
    );

    const preferences = snapshot.val() || null;
    const normalizedPreferences = preferences ? normalizeNotificationPreferences(preferences) : null;
    logger.info('NotificationService', 'Preference fetch completed', {
      userId: maskIdentifier(validatedUserId),
      hasPreferences: Boolean(preferences),
    });
    return normalizedPreferences;
  } catch (error) {
    logger.error('NotificationService', 'Preference fetch failed', {
      userId: maskIdentifier(userId),
      throwOnError,
      error: error?.message || String(error),
    });

    if (throwOnError) {
      throw error;
    }

    return null;
  }
};
