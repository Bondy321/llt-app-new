import React, { useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing, radius, shadows, text as textStyles } from '../theme';

const palette = colors;

export default function TodaysAgendaCard({ tourData, onNudge }) {
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

  if (!currentDayData) return null;

  // RENDER: Tour hasn't started yet
  if (currentDayData.status === 'FUTURE') {
    return (
      <View style={styles.card}>
        <LinearGradient colors={[palette.primary, '#0F3FBF']} style={styles.headerFuture}>
          <MaterialCommunityIcons name="airplane-takeoff" size={24} color={palette.surface} />
          <View style={{marginLeft: spacing.sm}}>
            <Text style={styles.headerTitleFuture}>Countdown to Tour</Text>
            <Text style={styles.headerSubtitleFuture}>{currentDayData.daysToGo} days to go!</Text>
          </View>
        </LinearGradient>
      </View>
    );
  }

  // RENDER: Tour Completed
  if (currentDayData.status === 'COMPLETED') {
    return null; 
  }

  // RENDER: Active Tour Day
  const { dayNumber, data } = currentDayData;
  const activities = Array.isArray(data.activities) ? data.activities.slice(0, 3) : []; // Show max 3 items

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Happening Today</Text>
      <TouchableOpacity activeOpacity={0.9} onPress={onNudge} style={styles.card}>
        <LinearGradient colors={[palette.surface, palette.cardSoft]} style={styles.cardInner}>
          
          {/* Header */}
          <View style={styles.rowBetween}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Day {dayNumber}</Text>
            </View>
            <TouchableOpacity onPress={onNudge} style={styles.viewAllBtn}>
              <Text style={styles.viewAllText}>View Full Day</Text>
              <MaterialCommunityIcons name="chevron-right" size={16} color={palette.primary} />
            </TouchableOpacity>
          </View>

          {/* Title */}
          <Text style={styles.dayTitle} numberOfLines={1}>{data.title}</Text>

          {/* Preview List */}
          <View style={styles.listContainer}>
            {activities.map((item, index) => (
              <View key={index} style={styles.activityRow}>
                <View style={styles.dotLine}>
                  <View style={[styles.dot, item.time ? styles.dotTime : styles.dotStandard]} />
                  {index < activities.length - 1 && <View style={styles.line} />}
                </View>
                <View style={styles.content}>
                  {item.time ? <Text style={styles.timeText}>{item.time}</Text> : null}
                  <Text style={styles.descText} numberOfLines={1}>{item.description}</Text>
                </View>
              </View>
            ))}
            {Array.isArray(data.activities) && data.activities.length > 3 && (
              <Text style={styles.moreText}>+ {data.activities.length - 3} more activities...</Text>
            )}
          </View>

        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: spacing.lg },
  sectionTitle: { ...textStyles.title, marginBottom: spacing.sm, marginLeft: 4 },
  card: {
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
    ...shadows.subtle,
  },
  cardInner: { borderRadius: radius.lg, padding: spacing.md },
  headerFuture: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, borderRadius: radius.lg },
  headerTitleFuture: { ...textStyles.title, color: palette.surface },
  headerSubtitleFuture: { ...textStyles.body, color: palette.surface, opacity: 0.9 },
  
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  badge: { backgroundColor: palette.primaryMuted, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.md },
  badgeText: { color: palette.primary, fontWeight: '800', fontSize: 12 },
  viewAllBtn: { flexDirection: 'row', alignItems: 'center' },
  viewAllText: { color: palette.primary, fontSize: 13, fontWeight: '700', marginRight: 2 },
  
  dayTitle: { ...textStyles.heading, fontSize: 18, marginBottom: spacing.sm },
  
  listContainer: { marginTop: 4 },
  activityRow: { flexDirection: 'row', marginBottom: 0, height: 32 }, 
  dotLine: { alignItems: 'center', width: 20, marginRight: spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, zIndex: 1 },
  dotTime: { backgroundColor: palette.accent },
  dotStandard: { backgroundColor: palette.muted },
  line: { width: 1, backgroundColor: palette.border, flex: 1, position: 'absolute', top: 10, bottom: -10 },
  
  content: { flex: 1, flexDirection: 'row', alignItems: 'flex-start' },
  timeText: { fontWeight: '700', fontSize: 13, color: palette.graphite, marginRight: spacing.sm, width: 60 },
  descText: { fontSize: 13, color: palette.steel, flex: 1 },
  moreText: { marginLeft: 28, fontSize: 12, color: palette.primary, fontStyle: 'italic', marginTop: 4 },
});
