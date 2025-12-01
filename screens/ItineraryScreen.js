// screens/ItineraryScreen.js
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Platform,
  RefreshControl,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
  TextInput,
  Alert,
  Modal
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase'; // Import DB directly for writes

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
  successGreen: '#2ECC71',
  editBg: '#FFF8E1', // Light yellow for edit mode
  danger: '#E53E3E'
};

export default function ItineraryScreen({ onBack, tourId, tourName, startDate, isDriver }) {
  const [itinerary, setItinerary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [collapsedDays, setCollapsedDays] = useState({});
  const [dayPositions, setDayPositions] = useState({});
  
  // --- EDIT MODE STATE ---
  const [isEditing, setIsEditing] = useState(false);
  const [editedItinerary, setEditedItinerary] = useState(null);
  const [saving, setSaving] = useState(false);

  const scrollViewRef = useRef(null);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    loadItinerary();
  }, [tourId]);

  // ... (Keep existing date helper functions: getOrdinal, getParsedStartDate, formatDayLabel, todaysDayNumber) ...
  const getOrdinal = (day) => {
    const j = day % 10;
    const k = day % 100;
    if (j === 1 && k !== 11) return `${day}st`;
    if (j === 2 && k !== 12) return `${day}nd`;
    if (j === 3 && k !== 13) return `${day}rd`;
    return `${day}th`;
  };

  const getParsedStartDate = useMemo(
    () => (rawDate) => {
      let parsedStartDate;
      if (typeof rawDate === 'string' && rawDate.includes('/')) {
        const [day, month, year] = rawDate.split('/').map(Number);
        parsedStartDate = new Date(year, month - 1, day);
      } else {
        parsedStartDate = new Date(rawDate);
      }

      if (isNaN(parsedStartDate.getTime())) {
        return null;
      }

      const normalizedDate = new Date(parsedStartDate);
      normalizedDate.setHours(12, 0, 0, 0);
      return normalizedDate;
    },
    []
  );

  const formatDayLabel = useMemo(
    () => (dayNumber) => {
      if (!startDate) {
        return `Day ${dayNumber}`;
      }
      const parsedStartDate = getParsedStartDate(startDate);
      if (!parsedStartDate) {
        return `Day ${dayNumber}`;
      }
      const dayDate = new Date(parsedStartDate);
      dayDate.setDate(parsedStartDate.getDate() + (dayNumber - 1));
      const weekday = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
      const monthStr = dayDate.toLocaleDateString(undefined, { month: 'long' });
      const dayStr = getOrdinal(dayDate.getDate());
      return `Day ${dayNumber} - ${weekday} ${dayStr} ${monthStr}`;
    },
    [getParsedStartDate, startDate]
  );

  const todaysDayNumber = useMemo(() => {
    if (!startDate || !itinerary?.days?.length) return null;
    const parsedStartDate = getParsedStartDate(startDate);
    if (!parsedStartDate) return null;
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diffTime = today.getTime() - parsedStartDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays < 1 || diffDays > itinerary.days.length) return null;
    return diffDays;
  }, [getParsedStartDate, itinerary?.days?.length, startDate]);

  useEffect(() => {
    if (!itinerary?.days?.length) return;
    setCollapsedDays((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const nextState = {};
      itinerary.days.forEach((day) => {
        nextState[day.day] = todaysDayNumber ? day.day !== todaysDayNumber : false;
      });
      return nextState;
    });
  }, [itinerary?.days, todaysDayNumber]);

  // --- DATA LOADING ---

  const loadItinerary = async ({ showSkeleton = true } = {}) => {
    try {
      setErrorMessage('');
      if (!tourId) {
        setItinerary(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showSkeleton) setLoading(true);
      else setRefreshing(true);
      
      const tourItinerary = await getTourItinerary(tourId);
      setItinerary(tourItinerary || null);
      setEditedItinerary(JSON.parse(JSON.stringify(tourItinerary || {}))); // Deep copy for editing
    } catch (error) {
      console.error('Error loading itinerary:', error);
      setItinerary(null);
      setErrorMessage('We could not load the itinerary right now.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const toggleDay = (day) => {
    if (isEditing) return; // Disable collapsing while editing to avoid confusion
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsedDays((prev) => ({ ...prev, [day]: !prev[day] }));
  };

  // --- EDITING LOGIC ---

  const handleEditActivity = (dayIndex, activityIndex, field, value) => {
    const newItinerary = { ...editedItinerary };
    newItinerary.days[dayIndex].activities[activityIndex][field] = value;
    setEditedItinerary(newItinerary);
  };

  const handleAddActivity = (dayIndex) => {
    const newItinerary = { ...editedItinerary };
    newItinerary.days[dayIndex].activities.push({
      time: '',
      description: 'New Activity'
    });
    setEditedItinerary(newItinerary);
  };

  const handleRemoveActivity = (dayIndex, activityIndex) => {
    Alert.alert(
      "Delete Activity",
      "Are you sure you want to remove this?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: () => {
            const newItinerary = { ...editedItinerary };
            newItinerary.days[dayIndex].activities.splice(activityIndex, 1);
            setEditedItinerary(newItinerary);
          }
        }
      ]
    );
  };

  const handleSaveChanges = async () => {
    setSaving(true);
    try {
      // Direct write to Firebase Realtime Database
      await realtimeDb.ref(`tours/${tourId}/itinerary`).update(editedItinerary);
      
      // Update local state to match saved data
      setItinerary(editedItinerary);
      setIsEditing(false);
      Alert.alert("Success", "Itinerary updated. Passengers will be notified shortly.");
    } catch (error) {
      console.error('Save failed:', error);
      Alert.alert("Error", "Could not save changes. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    // Revert changes
    setEditedItinerary(JSON.parse(JSON.stringify(itinerary)));
    setIsEditing(false);
  };

  // --- RENDERING ---

  const isMajorEvent = (description = '', index, activitiesLength) => {
    if (!description) return false;
    const keywords = ['pick-up','pickup','drop-off','drop off','check-in','check in','departure','arrival','ferry','train','flight','cruise','museum'];
    const lowered = description.toLowerCase();
    const keywordMatch = keywords.some((word) => lowered.includes(word));
    return keywordMatch || index === 0 || index === activitiesLength - 1;
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
      </View>
    );
  }

  const dataToRender = isEditing ? editedItinerary : itinerary;

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* HEADER */}
      <LinearGradient colors={isEditing ? [COLORS.editBg, COLORS.editBg] : [COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          {isEditing ? (
            <TouchableOpacity onPress={handleCancelEdit} style={styles.headerButton}>
              <Text style={{color: COLORS.danger, fontWeight: '700'}}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onBack} style={styles.headerButton}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
          )}
          
          <View style={styles.headerTitleContainer}>
            <Text style={[styles.headerLabel, isEditing && {color: COLORS.secondaryText}]}>
              {isEditing ? 'EDITING MODE' : 'Itinerary'}
            </Text>
            <Text style={[styles.headerTitle, isEditing && {color: COLORS.darkText}]}>
              {tourName || dataToRender?.title}
            </Text>
          </View>

          {isDriver && !isEditing && (
            <TouchableOpacity onPress={() => setIsEditing(true)} style={[styles.headerButton, styles.editButton]}>
              <MaterialCommunityIcons name="pencil" size={22} color={COLORS.primaryBlue} />
            </TouchableOpacity>
          )}
          
          {isEditing && (
            <TouchableOpacity onPress={handleSaveChanges} disabled={saving} style={styles.headerButton}>
              {saving ? <ActivityIndicator color={COLORS.successGreen} /> : (
                <Text style={{color: COLORS.successGreen, fontWeight: '700', fontSize: 16}}>Save</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </LinearGradient>

      {/* CONTENT */}
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        ref={scrollViewRef}
        refreshControl={
          !isEditing ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadItinerary({ showSkeleton: false })}
              tintColor={COLORS.primaryBlue}
            />
          ) : null
        }
      >
        {dataToRender?.days?.map((dayData, dayIndex) => {
          const activities = Array.isArray(dayData.activities) ? dayData.activities : [];
          const isCollapsed = !isEditing && collapsedDays[dayData.day]; // Force expand when editing
          const dayLabel = formatDayLabel(dayData.day);
          const isToday = todaysDayNumber === dayData.day;

          return (
            <View
              key={dayIndex}
              style={[
                styles.dayCard, 
                isToday && styles.todayCard,
                isEditing && styles.editingCard
              ]}
              onLayout={(event) => {
                const { y } = event.nativeEvent.layout;
                setDayPositions((prev) => ({ ...prev, [dayData.day]: y }));
              }}
            >
              <LinearGradient colors={[COLORS.white, '#F7FAFF']} style={styles.dayCardInner}>
                <TouchableOpacity onPress={() => toggleDay(dayData.day)} activeOpacity={isEditing ? 1 : 0.9}>
                  <View style={styles.dayHeader}>
                    <View style={styles.dayBadge}>
                      <Text style={styles.dayBadgeText}>{dayLabel}</Text>
                    </View>
                    <View style={styles.dayTitleWrapper}>
                      {isEditing ? (
                         <TextInput 
                           style={styles.editTitleInput}
                           value={dayData.title}
                           onChangeText={(text) => {
                             const newItinerary = { ...editedItinerary };
                             newItinerary.days[dayIndex].title = text;
                             setEditedItinerary(newItinerary);
                           }}
                         />
                      ) : (
                        <Text style={styles.dayTitleText}>{dayData.title}</Text>
                      )}
                    </View>
                    {!isEditing && (
                      <MaterialCommunityIcons
                        name={isCollapsed ? 'chevron-down' : 'chevron-up'}
                        size={28}
                        color={COLORS.secondaryText}
                      />
                    )}
                  </View>
                </TouchableOpacity>

                {!isCollapsed && (
                  <View style={styles.activitiesContainer}>
                    {activities.map((activity, actIndex) => {
                      const major = isMajorEvent(activity.description, actIndex, activities.length);
                      
                      if (isEditing) {
                        // --- EDIT ROW ---
                        return (
                          <View key={actIndex} style={styles.editRow}>
                            <View style={styles.editTimeContainer}>
                              <TextInput
                                style={styles.editTimeInput}
                                value={activity.time}
                                placeholder="09:00"
                                onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'time', text)}
                              />
                            </View>
                            <View style={styles.editDescContainer}>
                              <TextInput
                                style={styles.editDescInput}
                                value={activity.description}
                                multiline
                                onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'description', text)}
                              />
                            </View>
                            <TouchableOpacity onPress={() => handleRemoveActivity(dayIndex, actIndex)} style={styles.deleteBtn}>
                              <MaterialCommunityIcons name="delete" size={20} color={COLORS.danger} />
                            </TouchableOpacity>
                          </View>
                        );
                      }

                      // --- VIEW ROW ---
                      const hasTime = Boolean(activity.time);
                      const showLine = actIndex < activities.length - 1;
                      
                      return (
                        <View key={actIndex} style={styles.activityItem}>
                          <View style={styles.timelineColumn}>
                            <View style={[styles.timelineDot, major && styles.majorDot]} />
                            {showLine && <View style={[styles.timelineLine, major && styles.majorLine]} />}
                          </View>
                          <View style={[styles.activityContent, !hasTime && styles.activityContentNoTime]}>
                            <View style={[styles.activityHeaderRow, !hasTime && styles.activityHeaderRowNoTime]}>
                              {hasTime && <Text style={styles.activityTime}>{activity.time}</Text>}
                              <View style={[styles.activityTypePill, major ? styles.majorPill : styles.standardPill]}>
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
                    
                    {isEditing && (
                      <TouchableOpacity onPress={() => handleAddActivity(dayIndex)} style={styles.addActivityBtn}>
                        <MaterialCommunityIcons name="plus" size={20} color={COLORS.primaryBlue} />
                        <Text style={styles.addActivityText}>Add Activity</Text>
                      </TouchableOpacity>
                    )}
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
  safeArea: { flex: 1, backgroundColor: COLORS.appBackground },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  
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
  headerContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitleContainer: { flex: 1, marginHorizontal: 10 },
  headerLabel: { color: COLORS.lightBlueAccent, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '700' },
  headerTitle: { fontSize: 24, fontWeight: '800', color: COLORS.white, marginTop: 2 },
  headerButton: { padding: 8, minWidth: 40, alignItems: 'center' },
  editButton: { backgroundColor: COLORS.white, borderRadius: 12 },
  
  scrollContainer: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },
  dayCard: { backgroundColor: 'transparent', borderRadius: 20, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 6 },
  editingCard: { borderWidth: 2, borderColor: COLORS.primaryBlue, borderStyle: 'dashed' },
  todayCard: { borderWidth: 1, borderColor: `${COLORS.coralAccent}55` },
  dayCardInner: { borderRadius: 20, paddingHorizontal: 18, paddingVertical: 16 },
  
  dayHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  dayBadge: { backgroundColor: COLORS.lightBlueAccent, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  dayBadgeText: { fontSize: 12, fontWeight: '800', color: COLORS.white, letterSpacing: 0.5 },
  dayTitleWrapper: { flex: 1, marginLeft: 12 },
  dayTitleText: { fontSize: 18, fontWeight: '800', color: COLORS.darkText },
  
  activitiesContainer: { marginTop: 8 },
  activityItem: { flexDirection: 'row', paddingVertical: 12, alignItems: 'flex-start' },
  timelineColumn: { width: 28, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: COLORS.timelineColor, zIndex: 2 },
  majorDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: COLORS.coralAccent },
  timelineLine: { position: 'absolute', top: 12, width: 2, height: '100%', backgroundColor: COLORS.timelineColor, opacity: 0.7 },
  majorLine: { backgroundColor: COLORS.coralAccent, opacity: 0.5 },
  
  activityContent: { flex: 1, paddingLeft: 6 },
  activityContentNoTime: { paddingLeft: 8 },
  activityHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  activityHeaderRowNoTime: { justifyContent: 'flex-start', gap: 8 },
  activityTime: { fontSize: 15, fontWeight: '800', color: COLORS.primaryBlue, marginBottom: 6 },
  activityTypePill: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#F2F6FC' },
  pillText: { fontSize: 12, color: COLORS.secondaryText, fontWeight: '700' },
  majorPill: { backgroundColor: COLORS.coralAccent },
  majorPillText: { color: COLORS.white },
  standardPill: { backgroundColor: '#E8EEF7' },
  activityDescription: { fontSize: 15, color: COLORS.darkText, lineHeight: 22 },
  
  // Edit Styles
  editRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 15, backgroundColor: '#fff', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#eee' },
  editTimeContainer: { width: 60, marginRight: 10 },
  editTimeInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 6, padding: 8, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  editDescContainer: { flex: 1 },
  editDescInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 6, padding: 8, fontSize: 14, minHeight: 40 },
  editTitleInput: { fontSize: 18, fontWeight: '800', color: COLORS.darkText, borderBottomWidth: 1, borderBottomColor: COLORS.primaryBlue, paddingBottom: 2 },
  deleteBtn: { padding: 8, marginLeft: 5 },
  addActivityBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: 10, borderWidth: 1, borderColor: COLORS.primaryBlue, borderRadius: 10, borderStyle: 'dashed' },
  addActivityText: { color: COLORS.primaryBlue, fontWeight: '700', marginLeft: 8 },
  
  footerSpacer: { height: 20 },
});