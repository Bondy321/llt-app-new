// Shared design system for the LLT app
// Centralises the colour palette, gradients, typography helpers and shadows

export const palette = {
  primary: '#0B72E7',
  primaryDark: '#0A63C7',
  secondary: '#6D4AFF',
  accent: '#22C55E',
  accentSoft: '#C7F2D8',
  warning: '#FB923C',
  warningSoft: '#FFEAD5',
  danger: '#F04438',
  info: '#0EA5E9',
  text: '#0F172A',
  muted: '#64748B',
  subtle: '#94A3B8',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FBFF',
  background: '#F3F6FB',
  border: 'rgba(12, 52, 90, 0.08)',
  overlay: 'rgba(15, 23, 42, 0.08)',
};

export const gradients = {
  hero: ['#0B72E7', '#6D4AFF'],
  softHero: ['#E5F1FF', '#F5F3FF'],
  action: ['#22C55E', '#0EA5E9'],
  caution: ['#FB923C', '#F472B6'],
};

export const shadow = {
  card: {
    shadowColor: 'rgba(15, 23, 42, 0.2)',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 14,
    elevation: 8,
  },
  soft: {
    shadowColor: 'rgba(15, 23, 42, 0.12)',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 6,
  },
  subtle: {
    shadowColor: 'rgba(15, 23, 42, 0.08)',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
};

export const radii = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
};

export const spacing = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
};

export const text = {
  heading: { fontSize: 24, fontWeight: '800', color: palette.text },
  subheading: { fontSize: 16, fontWeight: '600', color: palette.muted },
  label: { fontSize: 12, fontWeight: '700', color: palette.subtle, letterSpacing: 0.5 },
};

