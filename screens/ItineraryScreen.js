// screens/ItineraryScreen.js
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, ScrollView, Platform, ActivityIndicator } from 'react-native';
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
        <View style={[styles.header, { backgroundColor: COLORS.complementaryBlue }]}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Loading Itinerary...</Text>
          <View style={styles.headerButton} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        </View>
      </SafeAreaView>
    );
  }

  if (!itinerary || !itinerary.days) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={[styles.header, { backgroundColor: COLORS.complementaryBlue }]}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Tour Itinerary</Text>
          <View style={styles.headerButton} />
        </View>
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyText}>No itinerary available for this tour.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.complementaryBlue }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{itinerary.title}</Text>
        <View style={styles.headerButton} />
      </View>
      
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        {itinerary.days.map((dayData, index) => (
          <View key={index} style={styles.dayCard}>
            <View style={styles.dayHeader}>
              <MaterialCommunityIcons name="calendar-check-outline" size={28} color={COLORS.primaryBlue} />
              <Text style={styles.dayTitleText}>
                {itinerary.days.length === 1 ? 'Tour Itinerary' : `Day ${dayData.day}: ${dayData.title}`}
              </Text>
            </View>
            <View style={styles.activitiesContainer}>
              {dayData.activities.map((activity, actIndex) => (
                <View key={actIndex} style={styles.activityItem}>
                  {/* Only show timeline if there are multiple activities or if time is specified */}
                  {(dayData.activities.length > 1 || activity.time) && (
                    <View style={styles.timeline}>
                      <View style={styles.timelineDot} />
                      {actIndex < dayData.activities.length - 1 && <View style={styles.timelineLine} />}
                    </View>
                  )}
                  <View style={[styles.activityContent, (!activity.time && dayData.activities.length === 1) && styles.fullWidthContent]}>
                    {activity.time && <Text style={styles.activityTime}>{activity.time}</Text>}
                    <Text style={[styles.activityDescription, (!activity.time && dayData.activities.length === 1) && styles.singleActivityDescription]}>
                      {activity.description}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === 'ios' ? 12 : 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  headerButton: {
    padding: 5,
    minWidth: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.white,
    textAlign: 'center',
    flex: 1,
    marginHorizontal: 5,
  },
  scrollContainer: {
    paddingHorizontal: 15,
    paddingTop: 20,
    paddingBottom: 30,
  },
  dayCard: {
    backgroundColor: COLORS.cardBackground,
    borderRadius: 15,
    marginBottom: 25,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 4,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBlueAccent,
    paddingBottom: 15,
  },
  dayTitleText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.primaryBlue,
    marginLeft: 12,
    flex: 1,
  },
  activitiesContainer: {},
  activityItem: {
    flexDirection: 'row',
    marginBottom: 18,
    alignItems: 'flex-start',
  },
  timeline: {
    alignItems: 'center',
    marginRight: 15,
    paddingTop: 3,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.coralAccent,
    zIndex: 1,
  },
  timelineLine: {
    position: 'absolute',
    top: 12,
    width: 2,
    height: '100%',
    backgroundColor: COLORS.timelineColor,
  },
  activityContent: {
    flex: 1,
  },
  fullWidthContent: {
    marginLeft: 0,
  },
  activityTime: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginBottom: 4,
  },
  activityDescription: {
    fontSize: 15,
    color: COLORS.secondaryText,
    lineHeight: 24,
  },
  singleActivityDescription: {
    fontSize: 16,
    lineHeight: 26,
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
});