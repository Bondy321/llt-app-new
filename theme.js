export const colors = {
  primary: '#165DF3',
  primaryMuted: '#E7EEFF',
  accent: '#FF8A3D',
  success: '#1DB981',
  warning: '#F4B000',
  danger: '#E54848',
  ink: '#0F172A',
  graphite: '#1F2937',
  steel: '#4B5563',
  muted: '#94A3B8',
  border: '#E5E7EB',
  surface: '#FFFFFF',
  background: '#F5F6FB',
  cardSoft: '#FBFCFF',
};

export const spacing = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  pill: 999,
};

export const shadows = {
  soft: {
    shadowColor: 'rgba(15, 23, 42, 0.12)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  subtle: {
    shadowColor: 'rgba(15, 23, 42, 0.08)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
};

export const text = {
  heading: { fontSize: 24, fontWeight: '800', color: colors.ink },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  body: { fontSize: 15, fontWeight: '500', color: colors.steel },
  caption: { fontSize: 12, fontWeight: '600', color: colors.muted, letterSpacing: 0.3 },
};
