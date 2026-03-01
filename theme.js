// theme.js - Centralized design system for Loch Lomond Travel app

export const COLORS = {
  // Primary Brand Colors
  primary: '#1E40AF',        // Deep professional blue
  primaryLight: '#3B82F6',   // Lighter blue for accents
  primaryDark: '#1E3A8A',    // Darker blue for gradients
  primaryMuted: '#DBEAFE',   // Very light blue backgrounds

  // Secondary/Accent Colors
  accent: '#F97316',         // Warm orange for CTAs and highlights
  accentLight: '#FFEDD5',    // Light orange background

  // Success/Status Colors
  success: '#16A34A',        // Green for success states
  successLight: '#DCFCE7',   // Light green background

  // Warning/Alert Colors
  warning: '#EAB308',        // Yellow for warnings
  warningLight: '#FEF9C3',   // Light yellow background

  // Error/Danger Colors
  error: '#DC2626',          // Red for errors
  errorLight: '#FEE2E2',     // Light red background

  // Neutral Colors
  white: '#FFFFFF',
  background: '#F8FAFC',     // App background
  surface: '#FFFFFF',        // Card backgrounds
  border: '#E2E8F0',         // Borders and dividers

  // Text Colors
  textPrimary: '#0F172A',    // Main text
  textSecondary: '#475569',  // Secondary text
  textMuted: '#94A3B8',      // Placeholder/muted text
  textInverse: '#FFFFFF',    // Text on dark backgrounds

  // Special Purpose
  overlay: 'rgba(15, 23, 42, 0.5)',  // Modal overlays
  shadow: '#000000',

  // Sync Semantic Colors
  sync: {
    info: {
      foreground: '#1E40AF',
      foregroundMuted: '#1E3A8A',
      background: '#DBEAFE',
      border: '#93C5FD',
    },
    warning: {
      foreground: '#B45309',
      foregroundMuted: '#92400E',
      background: '#FEF3C7',
      border: '#FCD34D',
    },
    critical: {
      foreground: '#B91C1C',
      foregroundMuted: '#991B1B',
      background: '#FEE2E2',
      border: '#FCA5A5',
    },
    success: {
      foreground: '#15803D',
      foregroundMuted: '#166534',
      background: '#DCFCE7',
      border: '#86EFAC',
    },
  },
};

// Consistent spacing scale
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

// Consistent border radius
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

// Font weights (for reference)
export const FONT_WEIGHT = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};

// Consistent shadow styles
export const SHADOWS = {
  sm: {
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  lg: {
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  xl: {
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
};

// Status colors for manifest/booking states
export const STATUS_COLORS = {
  pending: { main: '#64748B', light: '#F1F5F9' },
  boarded: { main: '#16A34A', light: '#DCFCE7' },
  noShow: { main: '#DC2626', light: '#FEE2E2' },
  partial: { main: '#EAB308', light: '#FEF9C3' },
};

export default { COLORS, SPACING, RADIUS, FONT_WEIGHT, SHADOWS, STATUS_COLORS };
