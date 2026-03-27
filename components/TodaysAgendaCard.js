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
  primaryLight: THEME.primaryLight,
  primaryMuted: THEME.primaryMuted,
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
  warning: THEME.warning,
};

const splitAgendaLines = (content) => {
  if (!content) return [];
  return content
    .split(/(?:\n|•|-)/g)
    .map((item) => item.trim())
    .filter(Boolean);
};

const toMinutesFrom24Hour = (hours, minutes) => (hours * 60) + minutes;

const parseTimeToken = (line) => {
  const amPmMatch = line.match(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s?(AM|PM)\b/i);
  if (amPmMatch) {
    const hoursRaw = Number(amPmMatch[1]);
    const minutes = Number(amPmMatch[2]);
    const period = amPmMatch[3].toUpperCase();
    const normalizedHours = hoursRaw % 12;
    const hours24 = period === 'PM' ? normalizedHours + 12 : normalizedHours;
    return {
      display: `${hoursRaw}:${amPmMatch[2]} ${period}`,
      minutesFromMidnight: toMinutesFrom24Hour(hours24, minutes),
    };
  }

  const twentyFourHourMatch = line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHourMatch) {
    const hours = Number(twentyFourHourMatch[1]);
    const minutes = Number(twentyFourHourMatch[2]);
    return {
      display: `${String(hours).padStart(2, '0')}:${twentyFourHourMatch[2]}`,
      minutesFromMidnight: toMinutesFrom24Hour(hours, minutes),
    };
  }

  return null;
};

const getAgendaIcon = (line) => {
  const normalized = line.toLowerCase();
  if (normalized.includes('pickup') || normalized.includes('depart')) return 'bus-clock';
  if (normalized.includes('breakfast') || normalized.includes('lunch') || normalized.includes('dinner')) return 'silverware-fork-knife';
  if (normalized.includes('photo') || normalized.includes('viewpoint')) return 'camera-outline';
  if (normalized.includes('walk') || normalized.includes('hike') || normalized.includes('trail')) return 'shoe-print';
  if (normalized.includes('castle') || normalized.includes('museum') || normalized.includes('visit')) return 'map-marker-path';
  return 'circle-medium';
};

const buildAgendaHighlights = (content) => {
  const lines = splitAgendaLines(content);

  return lines.slice(0, 4).map((line, index) => {
    const parsedTime = parseTimeToken(line);
    return {
      id: `${line}-${index}`,
      text: line,
      icon: getAgendaIcon(line),
      time: parsedTime?.display || null,
      minutesFromMidnight: typeof parsedTime?.minutesFromMidnight === 'number' ? parsedTime.minutesFromMidnight : null,
    };
  });
};

const getTimelineState = (highlights) => {
  const now = new Date();
  const nowMinutes = toMinutesFrom24Hour(now.getHours(), now.getMinutes());

  const timedHighlights = highlights.filter((item) => typeof item.minutesFromMidnight === 'number');
  if (!timedHighlights.length) {
    return { activeId: null, nextId: null, label: 'No specific times published yet' };
  }

  let active = null;
  let next = null;

  timedHighlights.forEach((item) => {
    if (item.minutesFromMidnight <= nowMinutes) {
      if (!active || item.minutesFromMidnight > active.minutesFromMidnight) {
        active = item;
      }
    } else if (!next || item.minutesFromMidnight < next.minutesFromMidnight) {
      next = item;
    }
  });

  if (!active && timedHighlights.length) {
    next = timedHighlights.slice().sort((a, b) => a.minutesFromMidnight - b.minutesFromMidnight)[0];
  }

  const label = next
    ? `Next: ${next.time}`
    : active
      ? 'Later events are flexible timing'
      : 'Today starts soon';

  return {
    activeId: active?.id || null,
    nextId: next?.id || null,
    label,
  };
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
    const countdownTitle = daysToGo <= 1 ? 'You depart tomorrow' : 'Your journey is almost here';

    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>Tour countdown</Text>
        <LinearGradient colors={[COLORS.primary, COLORS.primaryDark]} style={styles.futureCard}>
          <View style={styles.futureHeaderRow}>
            <View style={styles.futureIconWrap}>
              <MaterialCommunityIcons name="bus-clock" size={24} color={COLORS.white} />
            </View>
            <View style={styles.futureTextWrap}>
              <Text style={styles.futureTitle}>{countdownTitle}</Text>
              <Text style={styles.futureSubtitle}>We’ll keep this card updated as departure gets closer.</Text>
            </View>
          </View>

          <View style={styles.futureCounterPill}>
            <Text style={styles.futureCounterNumber}>{daysToGo}</Text>
            <Text style={styles.futureCounterLabel}>{daysToGo === 1 ? 'day to departure' : 'days to departure'}</Text>
          </View>

          <View style={styles.futureChecklistRow}>
            <View style={styles.futureChecklistPill}>
              <MaterialCommunityIcons name="ticket-confirmation-outline" size={14} color={COLORS.white} />
              <Text style={styles.futureChecklistText}>Booking synced</Text>
            </View>
            <View style={styles.futureChecklistPill}>
              <MaterialCommunityIcons name="bell-ring-outline" size={14} color={COLORS.white} />
              <Text style={styles.futureChecklistText}>Alerts ready</Text>
            </View>
          </View>
        </LinearGradient>
      </View>
    );
  }

  const { dayNumber, data } = dayContext;
  const dayContent = data?.content?.trim() || 'No detailed plan has been published for today yet.';
  const highlights = buildAgendaHighlights(data?.content);
  const timelineState = getTimelineState(highlights);

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
        <LinearGradient
          colors={[COLORS.surface, COLORS.background]}
          style={styles.card}
        >
          <View style={styles.cardTopGlow} pointerEvents="none" />

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

          <View style={styles.timelineSummaryPill}>
            <MaterialCommunityIcons name="clock-time-four-outline" size={14} color={COLORS.primary} />
            <Text style={styles.timelineSummaryText}>{timelineState.label}</Text>
          </View>

          {highlights.length ? (
            <View style={styles.highlightsWrap}>
              {highlights.map((highlight) => {
                const isActive = highlight.id === timelineState.activeId;
                const isNext = highlight.id === timelineState.nextId;
                return (
                  <View
                    key={highlight.id}
                    style={[
                      styles.highlightCard,
                      isActive && styles.highlightCardActive,
                      isNext && styles.highlightCardNext,
                    ]}
                  >
                    <View style={styles.highlightLeading}>
                      <View style={[styles.highlightIconWrap, isActive && styles.highlightIconWrapActive]}>
                        <MaterialCommunityIcons
                          name={highlight.icon}
                          size={14}
                          color={isActive ? COLORS.white : COLORS.primary}
                        />
                      </View>

                      <View style={styles.highlightTextWrap}>
                        <Text style={styles.highlightText} numberOfLines={2}>
                          {highlight.text}
                        </Text>
                        {highlight.time ? (
                          <Text style={styles.highlightTime}>{highlight.time}</Text>
                        ) : null}
                      </View>
                    </View>

                    {isActive ? (
                      <View style={styles.highlightTagActive}>
                        <Text style={styles.highlightTagText}>Now</Text>
                      </View>
                    ) : null}

                    {!isActive && isNext ? (
                      <View style={styles.highlightTagNext}>
                        <Text style={styles.highlightTagNextText}>Next</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          <Text style={styles.dayContent} numberOfLines={highlights.length ? 3 : 6}>
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
    backgroundColor: COLORS.successLight,
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
    overflow: 'hidden',
  },
  cardTopGlow: {
    position: 'absolute',
    top: -42,
    right: -22,
    width: 130,
    height: 130,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(59,130,246,0.16)',
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
  timelineSummaryPill: {
    marginTop: SPACING.md,
    borderRadius: RADIUS.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    alignSelf: 'flex-start',
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  timelineSummaryText: {
    fontSize: 12,
    color: COLORS.primaryDark,
    fontWeight: FONT_WEIGHT.semibold,
  },
  highlightsWrap: {
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
  highlightCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  highlightCardActive: {
    borderColor: COLORS.primaryLight,
    backgroundColor: COLORS.primaryMuted,
  },
  highlightCardNext: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentLight,
  },
  highlightLeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flex: 1,
  },
  highlightIconWrap: {
    width: 24,
    height: 24,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryMuted,
  },
  highlightIconWrapActive: {
    backgroundColor: COLORS.primary,
  },
  highlightTextWrap: {
    flex: 1,
  },
  highlightText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.medium,
    lineHeight: 18,
  },
  highlightTime: {
    marginTop: 2,
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: FONT_WEIGHT.semibold,
  },
  highlightTagActive: {
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
  },
  highlightTagText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  highlightTagNext: {
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
  },
  highlightTagNextText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dayContent: {
    marginTop: SPACING.md,
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 21,
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
  futureChecklistRow: {
    marginTop: SPACING.md,
    flexDirection: 'row',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  futureChecklistPill: {
    flexDirection: 'row',
    gap: SPACING.xs,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.34)',
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  futureChecklistText: {
    color: COLORS.white,
    fontSize: 11,
    fontWeight: FONT_WEIGHT.semibold,
  },
});
