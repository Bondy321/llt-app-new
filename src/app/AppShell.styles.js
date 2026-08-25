import { StyleSheet } from 'react-native';
import { COLORS as THEME } from '../../theme';

export const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  errorRed: THEME.error,
  appBackground: THEME.background,
  statusBarBackground: THEME.statusBarBackground,
};

export const styles = StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.appBackground, padding: 30 },
  loadingText: { marginTop: 15, fontSize: 16, color: COLORS.darkText, opacity: 0.8 },
  errorTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.errorRed, marginTop: 20, marginBottom: 10, textAlign: 'center' },
  errorIcon: { fontSize: 52 },
  screenContainer: { flex: 1 },
  statusBarScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.statusBarBackground,
    zIndex: 1000,
  },
  errorText: { fontSize: 16, color: COLORS.darkText, textAlign: 'center', marginBottom: 5 },
  errorDetail: { fontSize: 14, color: COLORS.darkText, opacity: 0.6, textAlign: 'center', marginTop: 15 },
  retryButton: {
    minHeight: 48,
    minWidth: 160,
    marginTop: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.primaryBlue,
  },
  retryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  loginTransitionOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 1001,
    backgroundColor: THEME.sync.info.background,
    borderWidth: 1,
    borderColor: THEME.sync.info.border,
    borderRadius: 10,
    padding: 10,
  },
  loginTransitionText: {
    color: THEME.sync.info.foreground,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  loginTransitionTrack: {
    height: 6,
    borderRadius: 99,
    backgroundColor: THEME.sync.info.background,
    borderWidth: 1,
    borderColor: THEME.sync.info.border,
    overflow: 'hidden',
  },
  loginTransitionFill: {
    height: '100%',
    backgroundColor: THEME.sync.info.foreground,
  },
});
