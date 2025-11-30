// services/notificationService.js
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

/**
 * Registers the device for push notifications and returns the Expo Push Token.
 */
export const registerForPushNotificationsAsync = async () => {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    
    if (finalStatus !== 'granted') {
      // User refused permissions
      return null;
    }

    // Get the token that identifies this specific device
    token = (await Notifications.getExpoPushTokenAsync()).data;
    console.log('Expo Push Token:', token);
  } else {
    console.log('Must use physical device for Push Notifications');
  }

  return token;
};

/**
 * Saves the user's token and preferences to Firebase.
 * @param {string} userId - The current user's ID
 * @param {object} preferences - The object containing toggle states
 */
export const saveUserPreferences = async (userId, preferences) => {
  if (!userId) return;

  try {
    // 1. Get the token (will ask for permission if not already granted)
    const token = await registerForPushNotificationsAsync();

    if (!token) {
      throw new Error('Permission denied or emulator used');
    }

    // 2. Prepare the payload
    const userRef = realtimeDb.ref(`users/${userId}`);
    
    await userRef.update({
      pushToken: token,
      preferences: preferences,
      lastUpdated: new Date().toISOString(),
      deviceOS: Platform.OS
    });

    return { success: true };
  } catch (error) {
    console.error('Error saving preferences:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Loads existing preferences from Firebase
 */
export const getUserPreferences = async (userId) => {
  if (!userId) return null;
  
  try {
    const snapshot = await realtimeDb.ref(`users/${userId}/preferences`).once('value');
    return snapshot.val();
  } catch (error) {
    console.error('Error fetching preferences:', error);
    return null;
  }
};