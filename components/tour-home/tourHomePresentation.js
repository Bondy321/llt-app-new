import { Vibration } from 'react-native';

import * as Haptics from '../../services/hapticsService';
import { COLORS as THEME } from '../../theme';

export const COLORS = {
  primaryBlue: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryDark: THEME.primaryDark,
  lightBlueAccent: THEME.sync.info.border,
  lightBlue: THEME.primaryMuted,
  coralAccent: THEME.accent,
  white: THEME.white,
  darkText: THEME.textPrimary,
  cardBackground: THEME.surface,
  appBackground: THEME.background,
  border: THEME.border,
  subtleText: THEME.textSecondary,
  success: THEME.success,
  successLight: THEME.successLight,
  warning: THEME.warning,
  warningLight: THEME.warningLight,
  error: THEME.error,
  errorLight: THEME.errorLight,
  overlay: THEME.overlay,
  statusBarBackground: THEME.statusBarBackground,
};

export const triggerHaptic = (type = 'light') => {
  const style = type === 'heavy'
    ? Haptics.ImpactFeedbackStyle.Heavy
    : Haptics.ImpactFeedbackStyle.Light;
  Haptics.impactAsync(style).catch(() => Vibration.vibrate(type === 'heavy' ? 50 : 25));
};

export const getTimeBasedGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return { text: 'Good Morning', icon: 'weather-sunny', color: '#F59E0B' };
  if (hour < 17) return { text: 'Good Afternoon', icon: 'weather-partly-cloudy', color: '#3B82F6' };
  if (hour < 21) return { text: 'Good Evening', icon: 'weather-sunset', color: '#F97316' };
  return { text: 'Good Night', icon: 'weather-night', color: '#6366F1' };
};
