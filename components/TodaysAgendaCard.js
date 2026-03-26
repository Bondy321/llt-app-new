import React, { useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  COLORS as THEME,
  SPACING,
  RADIUS,
  SHADOWS,
  FONT_WEIGHT,
} from '../theme';
import { getTourDayContext } from '../services/itineraryDateParser';

const COLORS = {
  primary: THEME.primary,
  primaryDark: THEME.primaryDark,
  primaryMuted: THEME.primaryMuted,
  accent: THEME.accent,
  white: THEME.white,
  surface: THEME.surface,
  background: THEME.background,
  border: THEME.border,
  text: THEME.textPrimary,
  textSecondary: THEME.textSecondary,
  textMuted: THEME.textMuted,
  success: THEME.success,
};

const buildAgendaHighlights = (content) => {
  if (!content) return [];

  const pieces = content
    .split(/(?:\n|•|-)/g)
    .map((item) => item.trim())
    .filter(Boolean);

  return pieces.slice(0, 3);
};

export default function TodaysAgendaCard({ tourData, onNudge }) {
  const dayContext = useMemo(() => {
    if (!tourData?.startDate || !tourData?.itinerary?.days) {
      return null;
    }

    const context = getTourDayContext({
      startDate: tourData.startDate,
      itineraryDays: tourData.itinerary.days,
    });

    if (context.status === 'INVALID_START_DATE' || context.status === 'NO_ITINERARY_DAYS') {
      return null;
    }

    return context;
  }, [tourData]);

  if (!dayContext || dayContext.status === 'COMPLETED') {
    return null;
  }

  if (dayContext.status === 'FUTURE') {
    const daysToGo = dayContext.daysToGo;

    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>Tour countdown</Text>
        <LinearGradient colors={[COLORS.primary, COLORS.primaryDark]} style={styles.futureCard}>
          <View style={styles.futureHeaderRow}>
            <View style={styles.futureIconWrap}>
              <MaterialCommunityIcons name="bus-clock" size={24} color={COLORS.white} />
            </View>
            <View style={styles.futureTextWrap}>
              <Text style={styles.futureTitle}>Your journey is almost here</Text>
              <Text style={styles.futureSubtitle}>We’ll keep this card updated as departure gets closer.</Text>
            </View>
          </View>

          <View style={styles.futureCounterPill}>
            <Text style={styles.futureCounterNumber}>{daysToGo}</Text>
            <Text style={styles.futureCounterLabel}>{daysToGo === 1 ? 'day to departure' : 'days to departure'}</Text>
          </View>
        </LinearGradient>
      </View>
    );
  }

  const { dayNumber, data } = dayContext;
  const dayContent = data?.content?.trim() || 'No detailed plan has been published for today yet.';
  const highlights = buildAgendaHighlights(data?.content);

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={styles.sectionTitle}>Today’s agenda</Text>
        <View style={styles.livePill}>
          <MaterialCommunityIcons name="check-decagram" size={12} color={COLORS.success} />
          <Text style={styles.livePillText}>Live</Text>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.95}
        onPress={onNudge}
        style={styles.cardTouchable}
        accessibilityLabel={`Day ${dayNumber} agenda card`}
        accessibilityHint="Double tap to open the full itinerary"
        accessibilityRole="button"
      >
        <LinearGradient colors={[COLORS.surface, COLORS.background]} style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.dayPill}>
              <MaterialCommunityIcons name="calendar-today" size={14} color={COLORS.primary} />
              <Text style={styles.dayPillText}>Day {dayNumber}</Text>
            </View>

            <View style={styles.viewCta}>
              <Text style={styles.viewCtaText}>Open full itinerary</Text>
              <MaterialCommunityIcons name="chevron-right" size={16} color={COLORS.primary} />
            </View>
          </View>

          {highlights.length ? (
            <View style={styles.highlightsWrap}>
              {highlights.map((highlight) => (
                <View key={highlight} style={styles.highlightRow}>
                  <MaterialCommunityIcons name="circle-medium" size={16} color={COLORS.accent} />
                  <Text style={styles.highlightText} numberOfLines={1}>
                    {highlight}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <Text style={styles.dayContent} numberOfLines={highlights.length ? 4 : 6}>
            {dayContent}
          </Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.xl,
  },
  titleRow: {
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.xs,
  },
  sectionTitle: {
    fontSize: 20,
    color: COLORS.text,
    fontWeight: FONT_WEIGHT.bold,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.success,
    borderRadius: RADIUS.full,
    backgroundColor: THEME.successLight,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
  },
  livePillText: {
    fontSize: 11,
    color: COLORS.success,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardTouchable: {
    borderRadius: RADIUS.xl,
  },
  card: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    ...SHADOWS.lg,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  dayPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  dayPillText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.bold,
  },
  viewCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  viewCtaText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.semibold,
  },
  highlightsWrap: {
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  highlightText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.medium,
  },
  dayContent: {
    marginTop: SPACING.sm,
    color: COLORS.text,
    fontSize: 15,
    lineHeight: 22,
  },
  futureCard: {
    borderRadius: RADIUS.xl,
    padding: SPACING.xl,
    ...SHADOWS.lg,
  },
  futureHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
  },
  futureIconWrap: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  futureTextWrap: {
    flex: 1,
  },
  futureTitle: {
    color: COLORS.white,
    fontSize: 20,
    fontWeight: FONT_WEIGHT.bold,
  },
  futureSubtitle: {
    marginTop: SPACING.xs,
    color: COLORS.primaryMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  futureCounterPill: {
    marginTop: SPACING.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.34)',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: RADIUS.lg,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  futureCounterNumber: {
    color: COLORS.white,
    fontSize: 34,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  futureCounterLabel: {
    marginTop: 2,
    color: COLORS.white,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.medium,
  },
});
