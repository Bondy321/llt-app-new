import { Platform } from 'react-native';

let ExpoHaptics = {};

try {
  ExpoHaptics = require('expo-haptics');
} catch {
  ExpoHaptics = {};
}

export const ImpactFeedbackStyle = ExpoHaptics.ImpactFeedbackStyle || {};
export const NotificationFeedbackType = ExpoHaptics.NotificationFeedbackType || {};
export const AndroidHaptics = ExpoHaptics.AndroidHaptics || {};

const runFallback = (fallback) => (typeof fallback === 'function' ? fallback() : Promise.resolve());

const performAndroidOrFallback = async (androidType, fallback) => {
  if (
    Platform.OS === 'android'
    && androidType
    && typeof ExpoHaptics.performAndroidHapticsAsync === 'function'
  ) {
    try {
      return await ExpoHaptics.performAndroidHapticsAsync(androidType);
    } catch {
      // Fall through to the cross-platform API if Android-specific feedback is unavailable.
    }
  }

  return runFallback(fallback);
};

const androidImpactTypeByStyle = {
  [ImpactFeedbackStyle.Light]: AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Medium]: AndroidHaptics.Keyboard_Tap || AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Heavy]: AndroidHaptics.Long_Press,
  [ImpactFeedbackStyle.Rigid]: AndroidHaptics.Virtual_Key,
  [ImpactFeedbackStyle.Soft]: AndroidHaptics.Segment_Tick || AndroidHaptics.Context_Click,
};

const androidNotificationTypeByType = {
  [NotificationFeedbackType.Success]: AndroidHaptics.Confirm,
  [NotificationFeedbackType.Warning]: AndroidHaptics.Context_Click,
  [NotificationFeedbackType.Error]: AndroidHaptics.Reject,
};

export const impactAsync = (style = ImpactFeedbackStyle.Medium) => (
  performAndroidOrFallback(
    androidImpactTypeByStyle[style] || AndroidHaptics.Context_Click,
    () => ExpoHaptics.impactAsync?.(style)
  )
);

export const notificationAsync = (type = NotificationFeedbackType.Success) => (
  performAndroidOrFallback(
    androidNotificationTypeByType[type] || AndroidHaptics.Context_Click,
    () => ExpoHaptics.notificationAsync?.(type)
  )
);

export const selectionAsync = () => (
  performAndroidOrFallback(
    AndroidHaptics.Segment_Tick || AndroidHaptics.Context_Click,
    () => ExpoHaptics.selectionAsync?.()
  )
);
