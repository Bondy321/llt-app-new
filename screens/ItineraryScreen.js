// screens/ItineraryScreen.js
import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Platform,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourItinerary } from '../services/bookingServiceRealtime';

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  complementaryBlue: '#3498DB',
  lightBlueAccent: '#AECAEC',
  white: '#FFFFFF',
  darkText: '#1A202C',
  secondaryText: '#4A5568',
  appBackground: '#F0F4F8',
  cardBackground: '#FFFFFF',
  timelineColor: '#CBD5E0',
  coralAccent: '#FF7757',
};

// Mock itinerary data
const MOCK_ITINERARY = {
  title: "Loch Lomond Adventure",
  days: [
    {
      day: 1,
      title: "Arrival & Loch Exploration",
      activities: [
        { time: "9:00 AM", description: "Pick-up from Glasgow Central Station" },
        { time: "10:30 AM", description: "Scenic drive to Loch Lomond" },
        { time: "12:00 PM", description: "Lunch at Luss Village" },
        { time: "2:00 PM", description: "Boat tour on Loch Lomond" },
        { time: "4:00 PM", description: "Check-in at hotel" },
        { time: "7:00 PM", description: "Welcome dinner" }
      ]
    },
    {
      day: 2,
      title: "Highland Adventure",
      activities: [
        { time: "8:00 AM", description: "Breakfast at hotel" },
        { time: "9:00 AM", description: "Ben Lomond hiking expedition" },
        { time: "1:00 PM", description: "Picnic lunch with scenic views" },
        { time: "3:00 PM", description: "Visit to local distillery" },
        { time: "5:00 PM", description: "Return to hotel" },
        { time: "7:30 PM", description: "Traditional Scottish dinner" }
      ]
    }
  ]
};

export default function ItineraryScreen({ onBack, tourId, tourName }) {
  const [itinerary, setItinerary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collapsedDays, setCollapsedDays] = useState({});

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    loadItinerary();
  }, [tourId]);

  const loadItinerary = async () => {
    if (!tourId) {
      // Fall back to mock data if no tourId
      setItinerary(MOCK_ITINERARY);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const tourItinerary = await getTourItinerary(tourId);
      
      if (tourItinerary && tourItinerary.days) {
        setItinerary(tourItinerary);
      } else {
        // Use mock data if no itinerary in database
        setItinerary(MOCK_ITINERARY);
      }
    } catch (error) {
      console.error('Error loading itinerary:', error);
      // Fall back to mock data on error
      setItinerary(MOCK_ITINERARY);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>Itinerary</Text>
              <Text style={styles.headerTitle}>Loading...</Text>
            </View>
            <View style={styles.headerButton} />
          </View>
        </LinearGradient>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        </View>
      </SafeAreaView>
    );
  }

  if (!itinerary || !itinerary.days) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>Itinerary</Text>
              <Text style={styles.headerTitle}>Tour Itinerary</Text>
            </View>
            <View style={styles.headerButton} />
          </View>
        </LinearGradient>
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyText}>No itinerary available for this tour.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const toggleDay = (day) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsedDays((prev) => ({ ...prev, [day]: !prev[day] }));
  };

  const isMajorEvent = (description, index, activitiesLength) => {
    const keywords = ['pick-up', 'pickup', 'drop-off', 'drop off', 'check-in', 'check in', 'departure', 'arrival'];
    const lowered = description.toLowerCase();
    const keywordMatch = keywords.some((word) => lowered.includes(word));
    return keywordMatch || index === 0 || index === activitiesLength - 1;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={[COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerLabel}>Itinerary</Text>
            <Text style={styles.headerTitle}>{tourName || itinerary.title}</Text>
          </View>
          <TouchableOpacity onPress={loadItinerary} style={[styles.headerButton, styles.refreshButton]} activeOpacity={0.8}>
            <MaterialCommunityIcons name="refresh" size={22} color={COLORS.white} />
          </TouchableOpacity>
        </View>
        <View style={styles.headerSubtitleRow}>
          <MaterialCommunityIcons name="map-marker-distance" size={18} color={COLORS.white} />
          <Text style={styles.headerSubtitle}>{itinerary.title}</Text>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        {itinerary.days.map((dayData, index) => {
          const isCollapsed = collapsedDays[dayData.day];
          return (
            <View key={index} style={styles.dayCard}>
              <LinearGradient colors={[COLORS.white, '#F7FAFF']} style={styles.dayCardInner}>
                <TouchableOpacity onPress={() => toggleDay(dayData.day)} activeOpacity={0.9}>
                  <View style={styles.dayHeader}>
                    <View style={styles.dayBadge}>
                      <Text style={styles.dayBadgeText}>Day {dayData.day}</Text>
                    </View>
                    <View style={styles.dayTitleWrapper}>
                      <Text style={styles.dayTitleText}>{dayData.title}</Text>
                      <View style={styles.dayMetaRow}>
                        <MaterialCommunityIcons name="weather-sunny" size={16} color={COLORS.lightBlueAccent} />
                        <Text style={styles.dayMetaText}>{dayData.activities.length} planned moments</Text>
                      </View>
                    </View>
                    <MaterialCommunityIcons
                      name={isCollapsed ? 'chevron-down' : 'chevron-up'}
                      size={28}
                      color={COLORS.secondaryText}
                    />
                  </View>
                </TouchableOpacity>

                {!isCollapsed && (
                  <View style={styles.activitiesContainer}>
                    {dayData.activities.map((activity, actIndex) => {
                      const major = isMajorEvent(activity.description, actIndex, dayData.activities.length);
                      const showLine = actIndex < dayData.activities.length - 1;
                      return (
                        <View key={actIndex} style={styles.activityItem}>
                          <View style={styles.timelineColumn}>
                            <View style={[styles.timelineDot, major && styles.majorDot]} />
                            {showLine && <View style={[styles.timelineLine, major && styles.majorLine]} />}
                          </View>
                          <View style={styles.activityContent}>
                            <View style={styles.activityHeaderRow}>
                              {activity.time && <Text style={styles.activityTime}>{activity.time}</Text>}
                              <View style={[styles.activityTypePill, major ? styles.majorPill : styles.standardPill]}>
                                <MaterialCommunityIcons
                                  name={major ? 'map-marker-path' : 'clock-outline'}
                                  size={14}
                                  color={major ? COLORS.white : COLORS.secondaryText}
                                  style={styles.pillIcon}
                                />
                                <Text style={[styles.pillText, major && styles.majorPillText]}>
                                  {major ? 'Major' : 'Activity'}
                                </Text>
                              </View>
                            </View>
                            <Text style={styles.activityDescription}>{activity.description}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </LinearGradient>
            </View>
          );
        })}
        <View style={styles.footerSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  headerGradient: {
    paddingTop: Platform.OS === 'ios' ? 18 : 10,
    paddingBottom: 22,
    paddingHorizontal: 18,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitleContainer: {
    flex: 1,
    marginHorizontal: 10,
  },
  headerLabel: {
    color: COLORS.lightBlueAccent,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.white,
    marginTop: 2,
  },
  headerButton: {
    padding: 8,
    minWidth: 40,
    alignItems: 'center',
  },
  refreshButton: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
  },
  headerSubtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  headerSubtitle: {
    color: COLORS.white,
    marginLeft: 8,
    fontSize: 14,
    opacity: 0.9,
  },
  scrollContainer: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 40,
  },
  dayCard: {
    backgroundColor: 'transparent',
    borderRadius: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
  },
  dayCardInner: {
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  dayBadge: {
    backgroundColor: COLORS.lightBlueAccent,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  dayBadgeText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.white,
    letterSpacing: 0.5,
  },
  dayTitleWrapper: {
    flex: 1,
    marginLeft: 12,
  },
  dayTitleText: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  dayMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  dayMetaText: {
    marginLeft: 6,
    color: COLORS.secondaryText,
    fontSize: 12,
  },
  activitiesContainer: {
    marginTop: 8,
  },
  activityItem: {
    flexDirection: 'row',
    paddingVertical: 12,
    alignItems: 'flex-start',
  },
  timelineColumn: {
    width: 28,
    alignItems: 'center',
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.timelineColor,
    zIndex: 2,
  },
  majorDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.coralAccent,
  },
  timelineLine: {
    position: 'absolute',
    top: 12,
    width: 2,
    height: '100%',
    backgroundColor: COLORS.timelineColor,
    opacity: 0.7,
  },
  majorLine: {
    backgroundColor: COLORS.coralAccent,
    opacity: 0.5,
  },
  activityContent: {
    flex: 1,
    paddingLeft: 6,
  },
  activityHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  activityTime: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.primaryBlue,
    marginBottom: 6,
  },
  activityTypePill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#F2F6FC',
  },
  pillIcon: {
    marginRight: 6,
  },
  pillText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '700',
  },
  majorPill: {
    backgroundColor: COLORS.coralAccent,
  },
  majorPillText: {
    color: COLORS.white,
  },
  standardPill: {
    backgroundColor: '#E8EEF7',
  },
  activityDescription: {
    fontSize: 15,
    color: COLORS.darkText,
    lineHeight: 22,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.secondaryText,
    textAlign: 'center',
  },
  footerSpacer: {
    height: 20,
  },
});