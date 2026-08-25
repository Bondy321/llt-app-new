import { COLORS as THEME } from '../../theme';

const COLORS = Object.freeze({
  primaryBlue: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryDark: THEME.primaryDark,
  lightBlueAccent: THEME.sync.info.border,
  coralAccent: THEME.accent,
  coralMuted: THEME.accentLight,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  tertiaryText: THEME.textMuted,
  border: THEME.border,
  appBackground: THEME.background,
  chatScreenBackground: THEME.background,
  surfaceSecondary: '#EFF6FF',
  myMessageBackground: THEME.primary,
  theirMessageBackground: THEME.white,
  driverMessageBackground: THEME.accentLight,
  driverMessageBorder: '#FDBA74',
  inputBackground: THEME.white,
  sendButtonColor: THEME.accent,
  chatHeaderColor: THEME.primary,
  onlineIndicator: THEME.success,
  offlineIndicator: THEME.textMuted,
  typingIndicator: THEME.textSecondary,
  linkColor: THEME.primaryLight,
  reactionBackground: `${THEME.primary}10`,
  newMessageBanner: THEME.accent,
  overlay: THEME.overlay,
});

export default COLORS;
