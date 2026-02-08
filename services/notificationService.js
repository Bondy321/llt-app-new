// services/notificationService.js
// Enhanced with better error handling, validation, and retry logic
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
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
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const tokenData = await Promise.race([
          Notifications.getExpoPushTokenAsync(),
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

    // 1. Get the token (will ask for permission if not already granted)
    const token = await registerForPushNotificationsAsync();

    if (!token) {
      // Save preferences without token (user may have denied permissions)
      const userRef = realtimeDb.ref(`users/${validatedUserId}`);

      await Promise.race([
        userRef.update({
          preferences: validatedPreferences,
          lastUpdated: new Date().toISOString(),
          deviceOS: Platform.OS,
          pushToken: null, // Explicitly set to null if no token
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
    const userRef = realtimeDb.ref(`users/${validatedUserId}`);

    const updateData = {
      pushToken: token,
      preferences: validatedPreferences,
      lastUpdated: new Date().toISOString(),
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
