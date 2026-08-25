import { MANIFEST_STATUS } from '../../services/bookingServiceRealtime';
import { COLORS as THEME } from '../../theme';

export const COLORS = {
  primary: THEME.primary,
  primaryDark: THEME.primaryDark,
  primaryMuted: THEME.primaryMuted,
  bg: THEME.background,
  surface: THEME.surface,
  border: THEME.border,
  searchBg: THEME.white,
  success: THEME.success,
  successSoft: THEME.successLight,
  danger: THEME.error,
  dangerSoft: THEME.errorLight,
  info: THEME.primaryLight,
  warning: THEME.warning,
  warningSoft: THEME.warningLight,
  muted: THEME.textSecondary,
  panel: THEME.textPrimary,
  chipBg: THEME.surfaceSecondary || '#F1F5F9',
  chipActiveBg: THEME.primary,
  chipText: THEME.textSecondary,
  chipActiveText: THEME.white,
  textLight: THEME.textInverse,
};

export const STATUS_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: MANIFEST_STATUS.PENDING, label: 'Pending' },
  { key: MANIFEST_STATUS.PARTIAL, label: 'Partial' },
  { key: MANIFEST_STATUS.BOARDED, label: 'Boarded' },
  { key: MANIFEST_STATUS.NO_SHOW, label: 'No-show' },
];

export const HEADER_WIDGETS_VISIBLE = {
  completion: true,
  syncStatus: true,
  nextPassenger: true,
};
