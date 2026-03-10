// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { realtimeDb } from '../firebase';

// Configure how notifications behave when the app is open
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
  chatNotifications: true,
  itineraryNotifications: true,
};

const resolveExpoProjectId = () => {
  const envProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  if (envProjectId) return envProjectId;

  const easProjectId = Constants?.easConfig?.projectId?.trim?.();
  if (easProjectId) return easProjectId;

  const expoConfigProjectId = Constants?.expoConfig?.extra?.eas?.projectId?.trim?.();
  if (expoConfigProjectId) return expoConfigProjectId;

  return null;
};

/**
 * Normalizes legacy preference payloads into one stable schema.
 */
const normalizeNotificationPreferences = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  const source =
    preferences.preferences ||
    preferences.notificationPreferences ||
    preferences.notifications ||
    preferences;

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

  return {
    chatNotifications: toBoolean(chatRaw, DEFAULT_NOTIFICATION_PREFERENCES.chatNotifications),
    itineraryNotifications: toBoolean(
      itineraryRaw,
      DEFAULT_NOTIFICATION_PREFERENCES.itineraryNotifications
    ),
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
    let finalStatus;
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
    } catch (permError) {
      console.error('Error checking/requesting notification permissions:', permError);
      return null;
    }

    if (finalStatus !== 'granted') {
      console.warn('Notification permission not granted');
      return null;
    }

    // Get the Expo push token with retry logic
    let token;
    const projectId = resolveExpoProjectId();
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
    const mergedPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...existingRemotePreferences,
      ...incomingPreferences,
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
    const updateData = {
      pushToken: token,
      pushTokenStatus: 'ACTIVE',
      pushTokenUpdatedAt: nowIso,
      pushTokenProvider: 'expo',
      preferences: mergedPreferences,
      lastUpdated: nowIso,
      deviceOS: Platform.OS,
      deviceModel: Device.modelName || 'Unknown',
      appVersion: Platform.Version,
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
export const getUserPreferences = async (userId) => {
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
    return null;
  }
};
