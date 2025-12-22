export const palette = {
  primary: '#0E6BA8',
  primaryDeep: '#0A4E78',
  secondary: '#2EC4B6',
  accent: '#FF8A5C',
  coral: '#FF7757',
  highlight: '#8B5CF6',
  surface: '#FFFFFF',
  mutedSurface: '#F6F8FB',
  background: '#ECF2F8',
  text: '#0F172A',
  secondaryText: '#475569',
  subtleText: '#6B7280',
  outline: '#D8E2F0',
  success: '#2ECC71',
  warning: '#F5A524',
  danger: '#EF4444',
};

export const gradients = {
  hero: [palette.primary, palette.primaryDeep],
  warm: [palette.accent, palette.coral],
  calm: ['#EEF4FF', '#F8FBFF'],
};

export const radii = {
  xl: 28,
  lg: 20,
  md: 14,
  pill: 999,
};

export const shadow = {
  card: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 8,
  },
  soft: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 4,
  },
};
