// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { realtimeDb } from '../firebase';
import appMetadataModule from './appMetadata';

// Configure how notifications behave when the app is open
const { resolveAppVersionMetadata } = appMetadataModule;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
  marketing: {
    steam_trains: false,
    mystery_tours: false,
    scotland_classics: false,
    vip_experiences: false,
    hiking_nature: false,
  },
};

const DEFAULT_LEGACY_NOTIFICATION_FLAGS = {
  chatNotifications: true,
  itineraryNotifications: true,
};


const extractPreferenceSource = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {};
  }

  return (
    preferences.preferences ||
    preferences.notificationPreferences ||
    preferences.notifications ||
    preferences
  );
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

/**
 * Normalizes legacy preference payloads into one stable schema.
 */
const normalizeNotificationPreferences = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return {
      ...DEFAULT_LEGACY_NOTIFICATION_FLAGS,
      ops: { ...DEFAULT_NOTIFICATION_PREFERENCES.ops },
      marketing: { ...DEFAULT_NOTIFICATION_PREFERENCES.marketing },
    };
  }

  const source = extractPreferenceSource(preferences);

  const toBoolean = (value, fallback) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === 'enabled' || normalized === 'on') return true;
      if (normalized === 'false' || normalized === 'disabled' || normalized === 'off') return false;
    }
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return fallback;
  };

  const chatRaw =
    source.chatNotifications ??
    source.chatNotification ??
    source.chat ??
    source.messages ??
    source.messageNotifications;

  const itineraryRaw =
    source.itineraryNotifications ??
    source.itineraryNotification ??
    source.itinerary ??
    source.schedule ??
    source.tripUpdates;

  const normalizedOps = {
    driver_updates: toBoolean(
      source?.ops?.driver_updates,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.driver_updates
    ),
    itinerary_changes: toBoolean(
      source?.ops?.itinerary_changes ?? itineraryRaw,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.itinerary_changes
    ),
    group_chat: toBoolean(
      source?.ops?.group_chat ?? chatRaw,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_chat
    ),
    group_photos: toBoolean(
      source?.ops?.group_photos,
      DEFAULT_NOTIFICATION_PREFERENCES.ops.group_photos
    ),
  };

  const normalizedMarketing = {
    steam_trains: toBoolean(
      source?.marketing?.steam_trains,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.steam_trains
    ),
    mystery_tours: toBoolean(
      source?.marketing?.mystery_tours,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.mystery_tours
    ),
    scotland_classics: toBoolean(
      source?.marketing?.scotland_classics,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.scotland_classics
    ),
    vip_experiences: toBoolean(
      source?.marketing?.vip_experiences,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.vip_experiences
    ),
    hiking_nature: toBoolean(
      source?.marketing?.hiking_nature,
      DEFAULT_NOTIFICATION_PREFERENCES.marketing.hiking_nature
    ),
  };

  const normalizedLegacy = {
    chatNotifications: normalizedOps.group_chat,
    itineraryNotifications: normalizedOps.itinerary_changes,
  };

  return {
    ...normalizedLegacy,
    ops: normalizedOps,
    marketing: normalizedMarketing,
  };
};

/**
 * Registers the device for push notifications and returns the Expo Push Token.
 * Enhanced with better error handling and retry logic
 */
export const registerForPushNotificationsAsync = async (retries = 3) => {
  try {
    // Check if running on physical device
    if (!Device.isDevice) {
      console.warn('Push notifications require a physical device');
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
        console.error('Error setting up Android notification channel:', channelError);
        // Continue anyway, channel setup failure shouldn't block registration
      }
    }

    // Get or request permissions
    let finalPermissions;
    try {
      const existingPermissions = await Notifications.getPermissionsAsync();
      finalPermissions = existingPermissions;

      if (!isGrantedNotificationPermission(existingPermissions)) {
        finalPermissions = await Notifications.requestPermissionsAsync();
      }
    } catch (permError) {
      console.error('Error checking/requesting notification permissions:', permError);
      return null;
    }

    if (!isGrantedNotificationPermission(finalPermissions)) {
      console.warn('Notification permission not granted');
      return null;
    }

    // Get the Expo push token with retry logic
    let token;
    const projectId = resolveExpoProjectId();
    if (!projectId) {
      console.warn('No Expo EAS project ID found while fetching push token; using legacy token fetch fallback');
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const tokenData = await Promise.race([
          Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Token fetch timeout')), 10000)
          )
        ]);
        token = tokenData.data;
        break;
      } catch (tokenError) {
        console.error(`Error getting push token (attempt ${attempt}/${retries}):`, tokenError);
        if (attempt === retries) {
          return null;
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    return token;
  } catch (error) {
    console.error('Fatal error in registerForPushNotificationsAsync:', error);
    return null;
  }
};

/**
 * Saves the user's token and preferences to Firebase.
 * Enhanced with validation and better error handling
 * @param {string} userId - The current user's ID
 * @param {object} preferences - The object containing toggle states
 */
export const saveUserPreferences = async (userId, preferences) => {
  try {
    // Validate inputs
    const validatedUserId = validateUserId(userId);
    const validatedPreferences = validatePreferences(preferences);

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const userRef = realtimeDb.ref(`users/${validatedUserId}`);

    const userSnapshot = await Promise.race([
      userRef.once('value'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Existing preferences fetch timeout')), 10000)
      )
    ]);

    const existingUserData = userSnapshot.val() || {};
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

    const includesLegacyChatToggle = ['chatNotifications', 'chatNotification', 'chat', 'messages', 'messageNotifications']
      .some((key) => hasOwn(incomingSource, key));
    const includesLegacyItineraryToggle = ['itineraryNotifications', 'itineraryNotification', 'itinerary', 'schedule', 'tripUpdates']
      .some((key) => hasOwn(incomingSource, key));

    if (includesLegacyChatToggle) {
      mergedOps.group_chat = incomingPreferences.chatNotifications;
    }

    if (includesLegacyItineraryToggle) {
      mergedOps.itinerary_changes = incomingPreferences.itineraryNotifications;
    }

    const mergedMarketing = {
      ...DEFAULT_NOTIFICATION_PREFERENCES.marketing,
      ...(existingRemotePreferences.marketing || {}),
    };

    if (incomingSource?.marketing && typeof incomingSource.marketing === 'object') {
      Object.keys(DEFAULT_NOTIFICATION_PREFERENCES.marketing).forEach((key) => {
        if (hasOwn(incomingSource.marketing, key)) {
          mergedMarketing[key] = incomingPreferences.marketing[key];
        }
      });
    }

    const mergedPreferences = {
      chatNotifications: mergedOps.group_chat,
      itineraryNotifications: mergedOps.itinerary_changes,
      ops: mergedOps,
      marketing: mergedMarketing,
    };

    // 1. Get the token (will ask for permission if not already granted)
    const token = await registerForPushNotificationsAsync();
    const nowIso = new Date().toISOString();

    if (!token) {
      // Preserve existing token details unless they are absent, while making status explicit
      const tokenStatusPatch = {
        pushTokenStatus: 'UNAVAILABLE',
        pushTokenProvider: existingUserData.pushTokenProvider || 'expo',
        pushTokenUpdatedAt: existingUserData.pushTokenUpdatedAt || nowIso,
      };

      await Promise.race([
        userRef.update({
          preferences: mergedPreferences,
          lastUpdated: nowIso,
          deviceOS: Platform.OS,
          ...tokenStatusPatch,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Preferences save timeout')), 10000)
        )
      ]);

      return {
        success: true,
        warning: 'Preferences saved, but notifications are disabled (no permission or not on physical device)'
      };
    }

    // 2. Save token and preferences
    const appVersionMetadata = resolveAppVersionMetadata({
      constants: Constants,
      platform: Platform,
    });

    const updateData = {
      pushToken: token,
      pushTokenStatus: 'ACTIVE',
      pushTokenUpdatedAt: nowIso,
      pushTokenProvider: 'expo',
      preferences: mergedPreferences,
      lastUpdated: nowIso,
      deviceOS: Platform.OS,
      deviceModel: Device.modelName || 'Unknown',
      appVersion: appVersionMetadata.appVersion,
      appBuild: appVersionMetadata.appBuild,
      osVersion: appVersionMetadata.osVersion,
    };

    await Promise.race([
      userRef.update(updateData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Preferences save timeout')), 10000)
      )
    ]);

    return { success: true };
  } catch (error) {
    console.error('Error saving preferences:', error);
    return { success: false, error: error.message };
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
    const validatedUserId = validateUserId(userId);

    if (!realtimeDb) {
      throw new Error('Database not initialized');
    }

    const prefsRef = realtimeDb.ref(`users/${validatedUserId}/preferences`);

    const snapshot = await Promise.race([
      prefsRef.once('value'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Preferences fetch timeout')), 10000)
      )
    ]);

    return snapshot.val() || null;
  } catch (error) {
    console.error('Error fetching preferences:', error);

    if (throwOnError) {
      throw error;
    }

    return null;
  }
};
