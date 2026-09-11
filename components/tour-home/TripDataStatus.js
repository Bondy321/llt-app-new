import { StyleSheet, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS, FONT_WEIGHT, RADIUS, SPACING } from '../../theme';

const formatCheckedTime = (checkedAtMs, nowMs) => {
  if (!Number.isFinite(checkedAtMs)) return 'Not checked yet';
  const checked = new Date(checkedAtMs);
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const sameDay = checked.getFullYear() === now.getFullYear()
    && checked.getMonth() === now.getMonth()
    && checked.getDate() === now.getDate();
  if (sameDay) {
    return `Checked at ${checked.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `Last checked ${checked.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};

const afterSeparator = (text) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

export const getTripPartPresentation = (part, nowMs) => {
  const checked = formatCheckedTime(part?.checkedAtMs, nowMs);
  if (!part) return { icon: 'cloud-question-outline', text: 'Not available yet', tone: COLORS.textSecondary };
  if (part.status === 'checking') {
    return { icon: 'cloud-sync-outline', text: `Checking for updates · ${afterSeparator(checked)}`, tone: COLORS.primary };
  }
  if (part.status === 'error') {
    return {
      icon: part.data ? 'cloud-alert' : 'cloud-off-outline',
      text: part.data
        ? `${part.persisted ? 'Saved details' : 'Previously loaded details'} · ${afterSeparator(checked)}`
        : 'Could not check these details',
      tone: COLORS.warning || '#B45309',
    };
  }
  if (part.status === 'empty') {
    return { icon: 'cloud-check-outline', text: checked, tone: COLORS.textSecondary };
  }
  if (part.status === 'saved') {
    return { icon: 'cloud-clock-outline', text: `${part.persisted ? 'Saved details' : 'Loaded details · not saved offline'} · ${afterSeparator(checked)}`, tone: COLORS.primary };
  }
  return {
    icon: 'cloud-check-outline',
    text: part.persisted ? `${checked} · saved offline` : `${checked} · not saved offline`,
    tone: part.persisted === false ? (COLORS.warning || '#B45309') : COLORS.success,
  };
};

export default function TripDataStatus({ parts, nowMs, refreshNotice = '' }) {
  const items = [
    ['booking', 'Booking'],
    ['tour', 'Tour'],
    ['itinerary', 'Itinerary'],
  ];
  return (
    <View style={styles.container} accessibilityRole="summary">
      {items.map(([key, label]) => {
        const presentation = getTripPartPresentation(parts?.[key], nowMs);
        return (
          <View key={key} style={styles.item}>
            <MaterialCommunityIcons name={presentation.icon} size={15} color={presentation.tone} />
            <Text style={styles.label}>{label}</Text>
            <Text style={[styles.detail, { color: presentation.tone }]}>{presentation.text}</Text>
          </View>
        );
      })}
      {refreshNotice ? (
        <Text accessibilityRole="status" style={styles.notice}>{refreshNotice}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    gap: SPACING.xs,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  label: { minWidth: 58, color: COLORS.textPrimary, fontSize: 12, fontWeight: FONT_WEIGHT.semibold },
  detail: { flex: 1, fontSize: 12 },
  notice: { marginTop: SPACING.xs, color: COLORS.textSecondary, fontSize: 12 },
});
