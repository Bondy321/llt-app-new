import React, { useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
import { getTourDayContext } from '../services/itineraryDateParser';

const COLORS = {
  primary: THEME.primary,
  primaryDark: THEME.primaryDark,
  primaryMuted: THEME.primaryMuted,
  primaryLight: THEME.primaryLight,
  accent: THEME.accent,
  accentLight: THEME.accentLight,
  white: THEME.white,
  surface: THEME.surface,
  background: THEME.background,
  border: THEME.border,
  text: THEME.textPrimary,
  textSecondary: THEME.textSecondary,
  textMuted: THEME.textMuted,
  success: THEME.success,
  successLight: THEME.successLight,
};

const parseAgendaHighlights = (rawContent) => {
  if (!rawContent || typeof rawContent !== 'string') {
    return [];
  }

  return rawContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-•\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
};

export default function TodaysAgendaCard({ tourData, onNudge }) {
  const currentDayData = useMemo(() => {
    if (!tourData?.startDate || !tourData?.itinerary?.days) {
      return null;
    }

    const dayContext = getTourDayContext({
      startDate: tourData.startDate,
      itineraryDays: tourData.itinerary.days,
    });

    if (dayContext.status === 'INVALID_START_DATE' || dayContext.status === 'NO_ITINERARY_DAYS') {
      return null;
    }

    return dayContext;
  }, [tourData]);

  if (!currentDayData) return null;

  if (currentDayData.status === 'FUTURE') {
    const daysToGo = currentDayData.daysToGo;

    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>Tour Countdown</Text>
        <LinearGradient colors={[COLORS.primary, COLORS.primaryDark]} style={styles.countdownCard}>
          <View style={styles.countdownTopRow}>
            <View style={styles.countdownIconBadge}>
              <MaterialCommunityIcons name="bus-clock" size={20} color={COLORS.white} />
            </View>
            <View style={styles.countdownMeta}>
              <Text style={styles.countdownTitle}>Your journey begins soon</Text>
              <Text style={styles.countdownSubtitle}>Get ready for premium pickup updates and day-by-day guidance.</Text>
            </View>
          </View>

          <View style={styles.countdownStatCard}>
            <Text style={styles.countdownNumber}>{daysToGo}</Text>
            <Text style={styles.countdownLabel}>{daysToGo === 1 ? 'day to departure' : 'days to departure'}</Text>
          </View>
        </LinearGradient>
      </View>
    );
  }

  if (currentDayData.status === 'COMPLETED') {
    return null;
  }

  const { dayNumber, data } = currentDayData;
  const content = data?.content || '';
  const highlights = parseAgendaHighlights(content);
  const previewLine = highlights.length ? highlights[0] : 'No details available for today yet.';

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>Today&apos;s Itinerary</Text>
        <View style={styles.livePill}>
          <MaterialCommunityIcons name="check-decagram" size={12} color={COLORS.success} />
          <Text style={styles.livePillText}>Live</Text>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.94}
        onPress={onNudge}
        style={styles.card}
        accessibilityRole="button"
        accessibilityLabel={`Day ${dayNumber} itinerary card`}
        accessibilityHint="Double tap to open full itinerary"
      >
        <View style={styles.cardInner}>
          <View style={styles.dayHeader}>
            <LinearGradient colors={[COLORS.primary, COLORS.primaryDark]} style={styles.dayBadge}>
              <MaterialCommunityIcons name="calendar-today" size={14} color={COLORS.white} />
              <Text style={styles.dayBadgeText}>Day {dayNumber}</Text>
            </LinearGradient>

            <TouchableOpacity
              onPress={onNudge}
              style={styles.viewAllButton}
              accessibilityRole="button"
              accessibilityLabel="Open full itinerary"
            >
              <Text style={styles.viewAllText}>Full itinerary</Text>
              <MaterialCommunityIcons name="arrow-right" size={16} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.previewText}>{previewLine}</Text>

          {highlights.length > 1 ? (
            <View style={styles.highlightsWrap}>
              {highlights.slice(1).map((highlight) => (
                <View key={highlight} style={styles.highlightRow}>
                  <View style={styles.highlightDot} />
                  <Text style={styles.highlightText} numberOfLines={2}>
                    {highlight}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.footerRow}>
            <View style={styles.footerPill}>
              <MaterialCommunityIcons name="map-marker-radius-outline" size={14} color={COLORS.accent} />
              <Text style={styles.footerPillText}>Tap to view all stops</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right-circle" size={20} color={COLORS.primary} />
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.xxl,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.text,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.xs,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.successLight,
    borderWidth: 1,
    borderColor: COLORS.success,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
  },
  livePillText: {
    fontSize: 12,
    color: COLORS.success,
    fontWeight: FONT_WEIGHT.semibold,
    textTransform: 'uppercase',
  },
  card: {
    borderRadius: RADIUS.xl,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.lg,
  },
  cardInner: {
    borderRadius: RADIUS.xl,
    padding: SPACING.lg,
    backgroundColor: COLORS.surface,
    gap: SPACING.md,
  },
  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.md,
  },
  dayBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  dayBadgeText: {
    color: COLORS.white,
    fontWeight: FONT_WEIGHT.bold,
    fontSize: 13,
  },
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryMuted,
  },
  viewAllText: {
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: FONT_WEIGHT.semibold,
  },
  previewText: {
    color: COLORS.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: FONT_WEIGHT.semibold,
  },
  highlightsWrap: {
    gap: SPACING.sm,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  highlightDot: {
    width: 7,
    height: 7,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.accent,
    marginTop: 7,
  },
  highlightText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.textSecondary,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  footerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.accentLight,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  footerPillText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.medium,
  },
  countdownCard: {
    borderRadius: RADIUS.xl,
    padding: SPACING.lg,
    gap: SPACING.lg,
    ...SHADOWS.xl,
  },
  countdownTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  countdownIconBadge: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownMeta: {
    flex: 1,
  },
  countdownTitle: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: FONT_WEIGHT.bold,
  },
  countdownSubtitle: {
    marginTop: SPACING.xs,
    color: COLORS.white,
    fontSize: 13,
    lineHeight: 18,
  },
  countdownStatCard: {
    backgroundColor: COLORS.primaryLight,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: RADIUS.lg,
    alignItems: 'center',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
  },
  countdownNumber: {
    color: COLORS.white,
    fontSize: 34,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  countdownLabel: {
    marginTop: SPACING.xs,
    color: COLORS.white,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.semibold,
  },
});
