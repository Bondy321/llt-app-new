import {
  COLORS as THEME_COLORS,
  SPACING as THEME_SPACING,
  RADIUS as THEME_RADIUS,
  SHADOWS as THEME_SHADOWS,
  FONT_WEIGHT as THEME_FONT_WEIGHT,
} from '../../../../theme';

export const COLORS = {
  primaryBlue: THEME_COLORS.primary,
  secondaryBlue: THEME_COLORS.primaryDark,
  lightBlue: THEME_COLORS.primaryMuted,
  white: THEME_COLORS.white,
  errorRed: THEME_COLORS.error,
  errorSoft: THEME_COLORS.errorLight,
  darkText: THEME_COLORS.textPrimary,
  inputBackground: THEME_COLORS.background,
  placeholderText: THEME_COLORS.textMuted,
  border: THEME_COLORS.border,
  subtleText: THEME_COLORS.textSecondary,
  success: THEME_COLORS.success,
  successSoft: THEME_COLORS.successLight,
  warning: THEME_COLORS.warning,
  warningSoft: THEME_COLORS.warningLight,
};
export const SPACING = THEME_SPACING || {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const RADIUS = THEME_RADIUS || {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

export const SHADOWS = THEME_SHADOWS || {
  lg: {},
  xl: {},
};

export const FONT_WEIGHT = THEME_FONT_WEIGHT || {
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};
