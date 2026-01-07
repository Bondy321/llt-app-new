import React, { useMemo, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Linking } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS as THEME } from '../theme';

const COLORS = {
  primaryBlue: THEME.primary,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  coralAccent: THEME.accent,
  lightBg: '#F8FAFC',
  successGreen: THEME.success,
};

export default function TodaysAgendaCard({ tourData, onNudge }) {
  const [expanded, setExpanded] = useState(false);
  const [completedActivities, setCompletedActivities] = useState({});

  const currentDayData = useMemo(() => {
    if (!tourData || !tourData.startDate || !tourData.itinerary || !tourData.itinerary.days) {
      return null;
    }

    // 1. Parse Start Date (UK Format dd/MM/yyyy)
    const [day, month, year] = tourData.startDate.split('/').map(Number);
    const start = new Date(year, month - 1, day); // Month is 0-indexed

    // 2. Get "Today" (Reset time to midnight for fair comparison)
    const today = new Date();
    start.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    // 3. Calculate Difference in Days
    const diffTime = today - start;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const dayIndex = diffDays; // Day 1 is index 0

    // 4. Determine Status
    if (dayIndex < 0) {
      return { status: 'FUTURE', daysToGo: Math.abs(dayIndex) };
    }

    const itineraryDays = tourData.itinerary.days;

    // If tour is finished
    if (dayIndex >= itineraryDays.length) {
      return { status: 'COMPLETED' };
    }

    // Return the actual data for today
    return {
      status: 'ACTIVE',
      dayNumber: dayIndex + 1,
      data: itineraryDays[dayIndex]
    };
  }, [tourData]);

  const toggleActivityComplete = (index) => {
    setCompletedActivities(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const getNextActivity = (activities) => {
    if (!activities || activities.length === 0) return null;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;

    for (let i = 0; i < activities.length; i++) {
      if (activities[i].time) {
        const [hour, minute] = activities[i].time.split(':').map(Number);
        const activityTimeInMinutes = hour * 60 + minute;

        if (activityTimeInMinutes > currentTimeInMinutes) {
          return { index: i, activity: activities[i], upcoming: true };
        }
      }
    }

    // If no upcoming activities, return the last one as current
    return { index: activities.length - 1, activity: activities[activities.length - 1], upcoming: false };
  };

  if (!currentDayData) return null;

  // RENDER: Tour hasn't started yet
  if (currentDayData.status === 'FUTURE') {
    const daysToGo = currentDayData.daysToGo;
    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>Tour Countdown</Text>
        <View style={styles.card}>
          <LinearGradient colors={[COLORS.primaryBlue, '#005A8D']} style={styles.headerFuture}>
            <MaterialCommunityIcons name="airplane-takeoff" size={32} color={COLORS.white} />
            <View style={styles.countdownContent}>
              <Text style={styles.headerTitleFuture}>Your Adventure Starts Soon!</Text>
              <View style={styles.countdownBadge}>
                <Text style={styles.countdownNumber}>{daysToGo}</Text>
                <Text style={styles.countdownLabel}>{daysToGo === 1 ? 'day' : 'days'} to go</Text>
              </View>
              <Text style={styles.headerSubtitleFuture}>
                {daysToGo <= 3 ? 'Pack your bags! ' : ''}Get ready for an amazing experience
              </Text>
            </View>
          </LinearGradient>
        </View>
      </View>
    );
  }

  // RENDER: Tour Completed
  if (currentDayData.status === 'COMPLETED') {
    return null;
  }

  // RENDER: Active Tour Day
  const { dayNumber, data } = currentDayData;
  const allActivities = Array.isArray(data.activities) ? data.activities : [];
  const displayActivities = expanded ? allActivities : allActivities.slice(0, 3);
  const nextActivity = getNextActivity(allActivities);

  // Calculate progress
  const totalActivities = allActivities.length;
  const completedCount = Object.values(completedActivities).filter(Boolean).length;
  const progressPercent = totalActivities > 0 ? (completedCount / totalActivities) * 100 : 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>Today's Itinerary</Text>
        {totalActivities > 0 && (
          <View style={styles.progressBadge}>
            <MaterialCommunityIcons name="check-circle" size={14} color={COLORS.successGreen} />
            <Text style={styles.progressText}>{completedCount}/{totalActivities}</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        activeOpacity={0.95}
        onPress={onNudge}
        style={styles.card}
        accessible={true}
        accessibilityLabel={`Day ${dayNumber} itinerary card`}
        accessibilityHint="Double tap to view full itinerary"
      >
        <LinearGradient colors={[COLORS.white, COLORS.lightBg]} style={styles.cardInner}>

          {/* Header */}
          <View style={styles.rowBetween}>
            <View style={styles.badge}>
              <MaterialCommunityIcons name="calendar-today" size={14} color={COLORS.primaryBlue} />
              <Text style={styles.badgeText}>Day {dayNumber}</Text>
            </View>
            <TouchableOpacity
              onPress={onNudge}
              style={styles.viewAllBtn}
              accessible={true}
              accessibilityLabel="View full day"
            >
              <Text style={styles.viewAllText}>View Full Day</Text>
              <MaterialCommunityIcons name="chevron-right" size={16} color={COLORS.primaryBlue} />
            </TouchableOpacity>
          </View>

          {/* Title */}
          <Text style={styles.dayTitle} numberOfLines={2}>{data.title}</Text>

          {/* Progress Bar */}
          {totalActivities > 0 && (
            <View style={styles.progressBarContainer}>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
              </View>
              <Text style={styles.progressLabel}>
                {progressPercent === 100 ? 'All done! 🎉' : `${Math.round(progressPercent)}% complete`}
              </Text>
            </View>
          )}

          {/* Next Activity Highlight */}
          {nextActivity && nextActivity.upcoming && (
            <View style={styles.nextActivityBanner}>
              <MaterialCommunityIcons name="clock-fast" size={18} color={COLORS.coralAccent} />
              <View style={styles.nextActivityContent}>
                <Text style={styles.nextActivityLabel}>Up Next:</Text>
                <Text style={styles.nextActivityText} numberOfLines={1}>
                  {nextActivity.activity.time} - {nextActivity.activity.description}
                </Text>
              </View>
            </View>
          )}

          {/* Activities List */}
          <View style={styles.listContainer}>
            {displayActivities.map((item, index) => {
              const isCompleted = completedActivities[index];
              const isNext = nextActivity?.index === index;

              return (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.activityRow,
                    isCompleted && styles.activityRowCompleted,
                    isNext && styles.activityRowNext
                  ]}
                  onPress={() => toggleActivityComplete(index)}
                  activeOpacity={0.7}
                  accessible={true}
                  accessibilityLabel={`${item.time ? item.time + ', ' : ''}${item.description}${isCompleted ? ', completed' : ''}`}
                  accessibilityRole="button"
                  accessibilityHint="Double tap to mark as complete"
                >
                  {/* Timeline Dot */}
                  <View style={styles.dotLine}>
                    <TouchableOpacity
                      onPress={() => toggleActivityComplete(index)}
                      style={[
                        styles.checkCircle,
                        isCompleted && styles.checkCircleCompleted
                      ]}
                    >
                      {isCompleted && (
                        <MaterialCommunityIcons name="check" size={12} color={COLORS.white} />
                      )}
                    </TouchableOpacity>
                    {index < displayActivities.length - 1 && <View style={styles.line} />}
                  </View>

                  {/* Content */}
                  <View style={[styles.content, isCompleted && styles.contentCompleted]}>
                    <View style={styles.activityHeader}>
                      {item.time && (
                        <View style={styles.timeChip}>
                          <MaterialCommunityIcons name="clock-outline" size={12} color={COLORS.primaryBlue} />
                          <Text style={[styles.timeText, isCompleted && styles.timeTextCompleted]}>
                            {item.time}
                          </Text>
                        </View>
                      )}
                      {isNext && (
                        <View style={styles.nextBadge}>
                          <Text style={styles.nextBadgeText}>Next</Text>
                        </View>
                      )}
                    </View>
                    <Text
                      style={[
                        styles.descText,
                        isCompleted && styles.descTextCompleted
                      ]}
                      numberOfLines={expanded ? undefined : 2}
                    >
                      {item.description}
                    </Text>

                    {/* Location (if available) */}
                    {item.location && (
                      <TouchableOpacity
                        style={styles.locationChip}
                        onPress={(e) => {
                          e.stopPropagation();
                          const query = encodeURIComponent(item.location);
                          Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`);
                        }}
                      >
                        <MaterialCommunityIcons name="map-marker" size={12} color={COLORS.coralAccent} />
                        <Text style={styles.locationText} numberOfLines={1}>{item.location}</Text>
                        <MaterialCommunityIcons name="open-in-new" size={10} color={COLORS.primaryBlue} />
                      </TouchableOpacity>
                    )}

                    {/* Notes (if available) */}
                    {item.notes && expanded && (
                      <View style={styles.notesChip}>
                        <MaterialCommunityIcons name="note-text-outline" size={12} color={COLORS.secondaryText} />
                        <Text style={styles.notesText} numberOfLines={2}>{item.notes}</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Show More/Less */}
          {allActivities.length > 3 && (
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              style={styles.expandButton}
              accessible={true}
              accessibilityLabel={expanded ? "Show less" : "Show more activities"}
            >
              <Text style={styles.expandButtonText}>
                {expanded
                  ? 'Show Less'
                  : `+ ${allActivities.length - 3} more ${allActivities.length - 3 === 1 ? 'activity' : 'activities'}`
                }
              </Text>
              <MaterialCommunityIcons
                name={expanded ? "chevron-up" : "chevron-down"}
                size={16}
                color={COLORS.primaryBlue}
              />
            </TouchableOpacity>
          )}

        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 24 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginLeft: 4 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: COLORS.darkText },
  progressBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FDF4', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  progressText: { marginLeft: 4, fontSize: 12, fontWeight: '700', color: COLORS.successGreen },

  card: {
    borderRadius: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
    backgroundColor: COLORS.white,
  },
  cardInner: { borderRadius: 18, padding: 18 },

  // Future State
  headerFuture: { flexDirection: 'row', alignItems: 'center', padding: 24, borderRadius: 18 },
  countdownContent: { flex: 1, marginLeft: 16 },
  headerTitleFuture: { color: COLORS.white, fontWeight: '700', fontSize: 18, marginBottom: 12 },
  countdownBadge: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, alignSelf: 'flex-start', marginBottom: 8 },
  countdownNumber: { color: COLORS.white, fontSize: 32, fontWeight: '800', textAlign: 'center' },
  countdownLabel: { color: COLORS.white, fontSize: 14, fontWeight: '600', textAlign: 'center', opacity: 0.9 },
  headerSubtitleFuture: { color: COLORS.white, opacity: 0.9, fontSize: 14, fontStyle: 'italic' },

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#E1F0FF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, gap: 6 },
  badgeText: { color: COLORS.primaryBlue, fontWeight: '700', fontSize: 13 },
  viewAllBtn: { flexDirection: 'row', alignItems: 'center' },
  viewAllText: { color: COLORS.primaryBlue, fontSize: 13, fontWeight: '600', marginRight: 2 },

  dayTitle: { fontSize: 20, fontWeight: '800', color: COLORS.darkText, marginBottom: 14, lineHeight: 26 },

  // Progress Bar
  progressBarContainer: { marginBottom: 16 },
  progressBarBg: { height: 6, backgroundColor: '#E5E7EB', borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  progressBarFill: { height: '100%', backgroundColor: COLORS.successGreen, borderRadius: 3 },
  progressLabel: { fontSize: 11, color: COLORS.secondaryText, fontWeight: '600', textAlign: 'right' },

  // Next Activity Banner
  nextActivityBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF5F5', padding: 12, borderRadius: 12, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: COLORS.coralAccent },
  nextActivityContent: { flex: 1, marginLeft: 10 },
  nextActivityLabel: { fontSize: 11, fontWeight: '700', color: COLORS.coralAccent, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  nextActivityText: { fontSize: 14, fontWeight: '600', color: COLORS.darkText },

  listContainer: { marginTop: 4 },
  activityRow: { flexDirection: 'row', marginBottom: 12, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: 'transparent' },
  activityRowCompleted: { opacity: 0.6 },
  activityRowNext: { backgroundColor: '#FFF9E6', borderWidth: 1, borderColor: '#FCD34D' },

  dotLine: { alignItems: 'center', width: 24, marginRight: 12, paddingTop: 2 },
  checkCircle: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#CBD5E0', backgroundColor: COLORS.white, justifyContent: 'center', alignItems: 'center', zIndex: 1 },
  checkCircleCompleted: { backgroundColor: COLORS.successGreen, borderColor: COLORS.successGreen },
  line: { width: 2, backgroundColor: '#E2E8F0', flex: 1, position: 'absolute', top: 22, bottom: -12 },

  content: { flex: 1, paddingTop: 2 },
  contentCompleted: {},
  activityHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  timeChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0F9FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, gap: 4 },
  timeText: { fontWeight: '700', fontSize: 12, color: COLORS.primaryBlue },
  timeTextCompleted: { textDecorationLine: 'line-through', opacity: 0.7 },
  nextBadge: { backgroundColor: COLORS.coralAccent, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  nextBadgeText: { fontSize: 10, fontWeight: '800', color: COLORS.white, textTransform: 'uppercase', letterSpacing: 0.5 },
  descText: { fontSize: 14, color: COLORS.darkText, lineHeight: 20, marginBottom: 4, fontWeight: '500' },
  descTextCompleted: { textDecorationLine: 'line-through', opacity: 0.7 },

  // Location chip
  locationChip: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 4, paddingVertical: 4 },
  locationText: { fontSize: 12, color: COLORS.primaryBlue, fontWeight: '600', flex: 1 },

  // Notes chip
  notesChip: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#F1F5F9', gap: 6 },
  notesText: { fontSize: 12, color: COLORS.secondaryText, fontStyle: 'italic', lineHeight: 16, flex: 1 },

  // Expand button
  expandButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingVertical: 10, gap: 6 },
  expandButtonText: { color: COLORS.primaryBlue, fontSize: 13, fontWeight: '600' },
});
