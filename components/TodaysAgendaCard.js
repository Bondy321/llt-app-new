import React, { useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
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
  const currentDayData = useMemo(() => {
    if (!tourData || !tourData.startDate || !tourData.itinerary || !tourData.itinerary.days) {
      return null;
    }

    // 1. Parse Start Date (UK Format dd/MM/yyyy)
    const [day, month, year] = tourData.startDate.split('/').map(Number);
    const start = new Date(year, month - 1, day);

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
  const content = data.content || '';

  // Detect special states
  const isComingSoon = content.toLowerCase().includes('itinerary coming soon');
  const isMystery = content.toLowerCase().includes("it's a mystery") || content.toLowerCase().includes('mystery');

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>Today's Itinerary</Text>
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
            <View style={[
              styles.badge,
              isMystery && styles.mysteryBadge
            ]}>
              <MaterialCommunityIcons
                name={isMystery ? "help-circle" : "calendar-today"}
                size={14}
                color={isMystery ? COLORS.white : COLORS.primaryBlue}
              />
              <Text style={[
                styles.badgeText,
                isMystery && styles.mysteryBadgeText
              ]}>Day {dayNumber}</Text>
            </View>
            <TouchableOpacity
              onPress={onNudge}
              style={styles.viewAllBtn}
              accessible={true}
              accessibilityLabel="View full itinerary"
            >
              <Text style={styles.viewAllText}>View Full Itinerary</Text>
              <MaterialCommunityIcons name="chevron-right" size={16} color={COLORS.primaryBlue} />
            </TouchableOpacity>
          </View>

          {/* Content */}
          {isComingSoon ? (
            <View style={styles.specialContainer}>
              <MaterialCommunityIcons name="clock-outline" size={32} color={COLORS.secondaryText} />
              <Text style={styles.specialText}>Itinerary Coming Soon!</Text>
              <Text style={styles.specialSubtext}>Check back later for details.</Text>
            </View>
          ) : isMystery ? (
            <View style={styles.specialContainer}>
              <MaterialCommunityIcons name="help-circle-outline" size={32} color={COLORS.coralAccent} />
              <Text style={styles.specialText}>{content}</Text>
              <Text style={styles.specialSubtext}>The destination is a surprise!</Text>
            </View>
          ) : (
            <Text style={styles.contentText} numberOfLines={6}>{content}</Text>
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

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#E1F0FF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, gap: 6 },
  badgeText: { color: COLORS.primaryBlue, fontWeight: '700', fontSize: 13 },
  mysteryBadge: { backgroundColor: '#7C3AED' },
  mysteryBadgeText: { color: COLORS.white },
  viewAllBtn: { flexDirection: 'row', alignItems: 'center' },
  viewAllText: { color: COLORS.primaryBlue, fontSize: 13, fontWeight: '600', marginRight: 2 },

  // Content
  contentText: { fontSize: 15, color: COLORS.darkText, lineHeight: 24, letterSpacing: 0.1 },

  // Special states
  specialContainer: { alignItems: 'center', paddingVertical: 16 },
  specialText: { fontSize: 16, fontWeight: '700', color: COLORS.darkText, marginTop: 10, textAlign: 'center' },
  specialSubtext: { fontSize: 13, color: COLORS.secondaryText, marginTop: 6, textAlign: 'center' },
});
