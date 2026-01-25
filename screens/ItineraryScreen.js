// screens/ItineraryScreen.js
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
  RefreshControl,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
  TextInput,
  Alert,
  Modal,
  Animated,
  Dimensions,
  Linking,
  Share
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  complementaryBlue: THEME.primaryLight,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  cardBackground: THEME.surface,
  timelineColor: '#CBD5E0',
  coralAccent: THEME.accent,
  successGreen: THEME.success,
  editBg: THEME.warningLight,
  danger: THEME.error,
  warningYellow: '#FCD34D',
  infoBlue: '#60A5FA'
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function ItineraryScreen({ onBack, tourId, tourName, startDate, isDriver }) {
  const [itinerary, setItinerary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [collapsedDays, setCollapsedDays] = useState({});
  const [dayPositions, setDayPositions] = useState({});
  const [retryCount, setRetryCount] = useState(0);

  // --- EDIT MODE STATE ---
  const [isEditing, setIsEditing] = useState(false);
  const [editedItinerary, setEditedItinerary] = useState(null);
  const [saving, setSaving] = useState(false);

  // --- NEW: ENHANCED FEATURES STATE ---
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [timePickerVisible, setTimePickerVisible] = useState(false);
  const [selectedTime, setSelectedTime] = useState({ dayIndex: null, actIndex: null, value: '' });
  const [showQuickActions, setShowQuickActions] = useState(null); // {dayIndex, actIndex}
  const [cachedItinerary, setCachedItinerary] = useState(null);
  const [isOnline, setIsOnline] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [expandAll, setExpandAll] = useState(false);
  const [showJumpToDay, setShowJumpToDay] = useState(false);

  const scrollViewRef = useRef(null);
  const searchAnimation = useRef(new Animated.Value(0)).current;
  const realtimeListener = useRef(null);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // --- REAL-TIME SYNC ---
  useEffect(() => {
    loadItinerary();

    // Set up real-time listener for live updates
    if (tourId && !isEditing) {
      const itineraryRef = realtimeDb.ref(`tours/${tourId}/itinerary`);

      const onUpdate = (snapshot) => {
        const data = snapshot.val();
        if (data) {
          setItinerary(data);
          setEditedItinerary(JSON.parse(JSON.stringify(data)));
          setLastSync(new Date());
          // Cache the data
          cacheItinerary(data);
        }
      };

      itineraryRef.on('value', onUpdate);
      realtimeListener.current = { ref: itineraryRef, listener: onUpdate };

      return () => {
        if (realtimeListener.current) {
          realtimeListener.current.ref.off('value', realtimeListener.current.listener);
        }
      };
    }
  }, [tourId, isEditing]);

  // --- OFFLINE CACHING ---
  const cacheItinerary = async (data) => {
    try {
      await AsyncStorage.setItem(`itinerary_${tourId}`, JSON.stringify(data));
    } catch (error) {
      console.log('Cache save failed:', error);
    }
  };

  const loadCachedItinerary = async () => {
    try {
      const cached = await AsyncStorage.getItem(`itinerary_${tourId}`);
      if (cached) {
        const data = JSON.parse(cached);
        setCachedItinerary(data);
        return data;
      }
    } catch (error) {
      console.log('Cache load failed:', error);
    }
    return null;
  };

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
      if (Object.keys(prev).length > 0 && !expandAll) return prev;
      const nextState = {};
      itinerary.days.forEach((day) => {
        nextState[day.day] = expandAll ? false : (todaysDayNumber ? day.day !== todaysDayNumber : false);
      });
      return nextState;
    });
  }, [itinerary?.days, todaysDayNumber, expandAll]);

  // --- DATA LOADING WITH RETRY ---
  const loadItinerary = async ({ showSkeleton = true, retry = 0 } = {}) => {
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

      // Try to load from cache first
      const cached = await loadCachedItinerary();
      if (cached && showSkeleton) {
        setItinerary(cached);
        setEditedItinerary(JSON.parse(JSON.stringify(cached)));
        setLoading(false);
      }

      const tourItinerary = await getTourItinerary(tourId);
      setItinerary(tourItinerary || null);
      setEditedItinerary(JSON.parse(JSON.stringify(tourItinerary || {}))); // Deep copy for editing
      setIsOnline(true);
      setLastSync(new Date());

      // Cache the fresh data
      if (tourItinerary) {
        await cacheItinerary(tourItinerary);
      }

      setRetryCount(0);
    } catch (error) {
      console.error('Error loading itinerary:', error);

      // Retry logic with exponential backoff
      if (retry < 3) {
        const delay = Math.pow(2, retry) * 1000; // 1s, 2s, 4s
        setTimeout(() => {
          loadItinerary({ showSkeleton: false, retry: retry + 1 });
        }, delay);
        setRetryCount(retry + 1);
        setErrorMessage(`Connection issue. Retrying (${retry + 1}/3)...`);
      } else {
        // Use cached data if available
        if (cachedItinerary) {
          setItinerary(cachedItinerary);
          setEditedItinerary(JSON.parse(JSON.stringify(cachedItinerary)));
          setIsOnline(false);
          setErrorMessage('Using offline data. Pull to refresh when online.');
        } else {
          setItinerary(null);
          setErrorMessage('Could not load itinerary. Please check your connection.');
        }
      }
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

  const toggleExpandAll = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandAll(!expandAll);
  };

  // --- SEARCH FUNCTIONALITY ---
  const filteredItinerary = useMemo(() => {
    if (!searchQuery.trim() || !itinerary?.days) return itinerary;

    const query = searchQuery.toLowerCase();
    const filtered = {
      ...itinerary,
      days: itinerary.days.map(day => ({
        ...day,
        activities: day.activities.filter(activity =>
          activity.description?.toLowerCase().includes(query) ||
          activity.time?.toLowerCase().includes(query) ||
          activity.location?.toLowerCase().includes(query) ||
          activity.notes?.toLowerCase().includes(query)
        )
      })).filter(day => day.activities.length > 0)
    };

    return filtered;
  }, [itinerary, searchQuery]);

  const toggleSearch = () => {
    setShowSearch(!showSearch);
    Animated.timing(searchAnimation, {
      toValue: showSearch ? 0 : 1,
      duration: 300,
      useNativeDriver: false,
    }).start();

    if (showSearch) {
      setSearchQuery('');
    }
  };

  // --- EDITING LOGIC ---
  const handleEditActivity = (dayIndex, activityIndex, field, value) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    newItinerary.days[dayIndex].activities[activityIndex][field] = value;
    setEditedItinerary(newItinerary);
  };

  const handleAddActivity = (dayIndex) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    newItinerary.days[dayIndex].activities.push({
      time: '',
      description: 'New Activity',
      location: '',
      notes: ''
    });
    setEditedItinerary(newItinerary);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
            const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
            newItinerary.days[dayIndex].activities.splice(activityIndex, 1);
            setEditedItinerary(newItinerary);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  // --- NEW: QUICK ACTIONS ---
  const handleDuplicateActivity = (dayIndex, activityIndex) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    const activityToCopy = { ...newItinerary.days[dayIndex].activities[activityIndex] };
    newItinerary.days[dayIndex].activities.splice(activityIndex + 1, 0, activityToCopy);
    setEditedItinerary(newItinerary);
    setShowQuickActions(null);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  };

  const handleDuplicateDay = (dayIndex) => {
    Alert.alert(
      "Duplicate Day",
      "Create a copy of this day?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Duplicate",
          onPress: () => {
            const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
            const dayToCopy = JSON.parse(JSON.stringify(newItinerary.days[dayIndex]));
            dayToCopy.day = newItinerary.days.length + 1;
            dayToCopy.title = `${dayToCopy.title} (Copy)`;
            newItinerary.days.push(dayToCopy);
            setEditedItinerary(newItinerary);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  const handleAddDay = () => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    const newDayNumber = (newItinerary.days?.length || 0) + 1;

    if (!newItinerary.days) {
      newItinerary.days = [];
    }

    newItinerary.days.push({
      day: newDayNumber,
      title: `Day ${newDayNumber}`,
      activities: [
        { time: '', description: 'New Activity', location: '', notes: '' }
      ]
    });

    setEditedItinerary(newItinerary);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  };

  const handleRemoveDay = (dayIndex) => {
    Alert.alert(
      "Delete Day",
      "Are you sure you want to delete this entire day?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
            newItinerary.days.splice(dayIndex, 1);
            // Re-number remaining days
            newItinerary.days.forEach((day, idx) => {
              day.day = idx + 1;
            });
            setEditedItinerary(newItinerary);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  // --- DRAG AND DROP ---
  const handleActivityReorder = (dayIndex, newOrder) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    newItinerary.days[dayIndex].activities = newOrder;
    setEditedItinerary(newItinerary);
  };

  // --- TIME PICKER ---
  const showTimePicker = (dayIndex, actIndex, currentValue) => {
    setSelectedTime({ dayIndex, actIndex, value: currentValue || '' });
    setTimePickerVisible(true);
  };

  const handleTimeSelect = (time) => {
    if (selectedTime.dayIndex !== null && selectedTime.actIndex !== null) {
      handleEditActivity(selectedTime.dayIndex, selectedTime.actIndex, 'time', time);
    }
    setTimePickerVisible(false);
  };

  // --- SAVE WITH RETRY ---
  const handleSaveChanges = async (retryAttempt = 0) => {
    setSaving(true);
    try {
      // Direct write to Firebase Realtime Database
      await realtimeDb.ref(`tours/${tourId}/itinerary`).update(editedItinerary);

      // Update local state to match saved data
      setItinerary(editedItinerary);
      await cacheItinerary(editedItinerary);
      setIsEditing(false);
      setLastSync(new Date());
      Alert.alert("✓ Success", "Itinerary updated. Passengers will be notified shortly.");
    } catch (error) {
      console.error('Save failed:', error);

      if (retryAttempt < 2) {
        Alert.alert(
          "Connection Issue",
          "Failed to save. Retry?",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Retry",
              onPress: () => handleSaveChanges(retryAttempt + 1)
            }
          ]
        );
      } else {
        Alert.alert("Error", "Could not save changes after multiple attempts. Please check your connection.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    Alert.alert(
      "Discard Changes?",
      "All unsaved changes will be lost.",
      [
        { text: "Keep Editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            // Revert changes
            setEditedItinerary(JSON.parse(JSON.stringify(itinerary)));
            setIsEditing(false);
          }
        }
      ]
    );
  };

  // --- EXPORT TO CALENDAR ---
  const handleExportToCalendar = async () => {
    if (!itinerary?.days || !startDate) {
      Alert.alert("Error", "Cannot export: missing itinerary data");
      return;
    }

    try {
      const parsedStart = getParsedStartDate(startDate);
      let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LLT Tours//Itinerary//EN\n";

      itinerary.days.forEach((day, dayIndex) => {
        const dayDate = new Date(parsedStart);
        dayDate.setDate(parsedStart.getDate() + dayIndex);
        const dateStr = dayDate.toISOString().split('T')[0].replace(/-/g, '');

        day.activities.forEach((activity, actIndex) => {
          const eventTime = activity.time || '09:00';
          const [hours, minutes] = eventTime.split(':');
          const eventDate = new Date(dayDate);
          eventDate.setHours(parseInt(hours) || 9, parseInt(minutes) || 0);

          icsContent += `BEGIN:VEVENT\n`;
          icsContent += `DTSTART:${dateStr}T${eventTime.replace(':', '')}00\n`;
          icsContent += `SUMMARY:${activity.description}\n`;
          if (activity.location) {
            icsContent += `LOCATION:${activity.location}\n`;
          }
          if (activity.notes) {
            icsContent += `DESCRIPTION:${activity.notes}\n`;
          }
          icsContent += `END:VEVENT\n`;
        });
      });

      icsContent += "END:VCALENDAR";

      // Share the ICS file
      await Share.share({
        message: icsContent,
        title: `${tourName || 'Tour'} Itinerary`
      });
    } catch (error) {
      console.error('Export failed:', error);
      Alert.alert("Export Failed", "Could not export to calendar");
    }
  };

  // --- JUMP TO DAY ---
  const scrollToDay = (dayNumber) => {
    const position = dayPositions[dayNumber];
    if (position !== undefined && scrollViewRef.current) {
      scrollViewRef.current.scrollTo({ y: position, animated: true });
      setShowJumpToDay(false);
    }
  };

  // --- RENDERING ---
  const isMajorEvent = (description = '', index, activitiesLength) => {
    if (!description) return false;
    const keywords = ['pick-up','pickup','drop-off','drop off','check-in','check in','departure','arrival','ferry','train','flight','cruise','museum'];
    const lowered = description.toLowerCase();
    const keywordMatch = keywords.some((word) => lowered.includes(word));
    return keywordMatch || index === 0 || index === activitiesLength - 1;
  };

  // --- LOADING SKELETON ---
  const renderLoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      {[1, 2, 3].map((i) => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonHeader} />
          <View style={styles.skeletonLine} />
          <View style={styles.skeletonLine} />
          <View style={[styles.skeletonLine, { width: '60%' }]} />
        </View>
      ))}
    </View>
  );

  // --- EMPTY STATE ---
  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <MaterialCommunityIcons name="calendar-blank-outline" size={80} color={COLORS.timelineColor} />
      <Text style={styles.emptyTitle}>No Itinerary Yet</Text>
      <Text style={styles.emptySubtitle}>
        {isDriver
          ? "Tap the edit button to create your first day"
          : "Your tour itinerary will appear here soon"}
      </Text>
      {isDriver && (
        <TouchableOpacity
          style={styles.emptyButton}
          onPress={() => {
            setIsEditing(true);
            const emptyItinerary = {
              title: tourName || 'Tour',
              days: [
                {
                  day: 1,
                  title: 'Day 1',
                  activities: [{ time: '', description: 'New Activity', location: '', notes: '' }]
                }
              ]
            };
            setEditedItinerary(emptyItinerary);
          }}
        >
          <MaterialCommunityIcons name="plus" size={20} color={COLORS.white} />
          <Text style={styles.emptyButtonText}>Create Itinerary</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.primaryBlue, COLORS.complementaryBlue]} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity onPress={onBack} style={styles.headerButton}>
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>Itinerary</Text>
              <Text style={styles.headerTitle}>{tourName || 'Loading...'}</Text>
            </View>
          </View>
        </LinearGradient>
        {renderLoadingSkeleton()}
      </SafeAreaView>
    );
  }

  const dataToRender = isEditing ? editedItinerary : (searchQuery ? filteredItinerary : itinerary);

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* HEADER */}
      <LinearGradient
        colors={isEditing ? [COLORS.editBg, COLORS.editBg] : [COLORS.primaryBlue, COLORS.complementaryBlue]}
        style={styles.headerGradient}
      >
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
            {!isOnline && (
              <View style={styles.offlineBadge}>
                <MaterialCommunityIcons name="cloud-off-outline" size={12} color={COLORS.white} />
                <Text style={styles.offlineText}>Offline</Text>
              </View>
            )}
          </View>

          {isDriver && !isEditing && !showSearch && (
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={toggleSearch} style={[styles.headerIconButton, { marginRight: 8 }]}>
                <MaterialCommunityIcons name="magnify" size={22} color={COLORS.white} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setIsEditing(true)} style={[styles.headerButton, styles.editButton]}>
                <MaterialCommunityIcons name="pencil" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          )}

          {!isDriver && !isEditing && !showSearch && (
            <TouchableOpacity onPress={toggleSearch} style={styles.headerIconButton}>
              <MaterialCommunityIcons name="magnify" size={22} color={COLORS.white} />
            </TouchableOpacity>
          )}

          {showSearch && !isEditing && (
            <TouchableOpacity onPress={toggleSearch} style={styles.headerIconButton}>
              <MaterialCommunityIcons name="close" size={22} color={COLORS.white} />
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

        {/* SEARCH BAR */}
        {showSearch && (
          <Animated.View
            style={[
              styles.searchContainer,
              {
                opacity: searchAnimation,
                height: searchAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 50]
                })
              }
            ]}
          >
            <MaterialCommunityIcons name="magnify" size={20} color={COLORS.secondaryText} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search activities, times, locations..."
              placeholderTextColor={COLORS.secondaryText}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <MaterialCommunityIcons name="close-circle" size={20} color={COLORS.secondaryText} />
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {/* QUICK TOOLBAR */}
        {!isEditing && itinerary?.days?.length > 0 && (
          <View style={styles.toolbar}>
            <TouchableOpacity onPress={toggleExpandAll} style={styles.toolbarButton}>
              <MaterialCommunityIcons
                name={expandAll ? "chevron-up-circle" : "chevron-down-circle"}
                size={18}
                color={COLORS.white}
              />
              <Text style={styles.toolbarText}>{expandAll ? 'Collapse All' : 'Expand All'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => scrollToDay(todaysDayNumber || 1)} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="calendar-today" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText}>Today</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleExportToCalendar} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="export-variant" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText}>Export</Text>
            </TouchableOpacity>
          </View>
        )}
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
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
            <Text style={styles.errorText}>{errorMessage}</Text>
            {retryCount > 0 && (
              <ActivityIndicator size="small" color={COLORS.white} style={{ marginLeft: 10 }} />
            )}
          </View>
        ) : null}

        {lastSync && !isEditing && (
          <Text style={styles.syncText}>
            Last synced: {lastSync.toLocaleTimeString()}
          </Text>
        )}

        {(!dataToRender?.days || dataToRender.days.length === 0) ? (
          renderEmptyState()
        ) : (
          <>
            {dataToRender.days.map((dayData, dayIndex) => {
              const activities = Array.isArray(dayData.activities) ? dayData.activities : [];
              const isCollapsed = !isEditing && collapsedDays[dayData.day];
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
                    <TouchableOpacity
                      onPress={() => toggleDay(dayData.day)}
                      activeOpacity={isEditing ? 1 : 0.9}
                      accessible={true}
                      accessibilityLabel={`${dayLabel}, ${dayData.title}`}
                      accessibilityRole="button"
                      accessibilityHint={isCollapsed ? "Double tap to expand" : "Double tap to collapse"}
                    >
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
                                const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
                                newItinerary.days[dayIndex].title = text;
                                setEditedItinerary(newItinerary);
                              }}
                              accessible={true}
                              accessibilityLabel="Day title"
                            />
                          ) : (
                            <Text style={styles.dayTitleText}>{dayData.title}</Text>
                          )}
                        </View>
                        {isEditing ? (
                          <View style={styles.dayEditActions}>
                            <TouchableOpacity
                              onPress={() => handleDuplicateDay(dayIndex)}
                              style={styles.dayActionButton}
                              accessible={true}
                              accessibilityLabel="Duplicate day"
                            >
                              <MaterialCommunityIcons name="content-copy" size={20} color={COLORS.primaryBlue} />
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPress={() => handleRemoveDay(dayIndex)}
                              style={styles.dayActionButton}
                              accessible={true}
                              accessibilityLabel="Delete day"
                            >
                              <MaterialCommunityIcons name="delete" size={20} color={COLORS.danger} />
                            </TouchableOpacity>
                          </View>
                        ) : (
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
                                <View style={styles.editMainRow}>
                                  <TouchableOpacity
                                    style={styles.editTimeContainer}
                                    onPress={() => showTimePicker(dayIndex, actIndex, activity.time)}
                                  >
                                    <TextInput
                                      style={styles.editTimeInput}
                                      value={activity.time}
                                      placeholder="09:00"
                                      onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'time', text)}
                                      editable={false}
                                    />
                                    <MaterialCommunityIcons
                                      name="clock-outline"
                                      size={16}
                                      color={COLORS.secondaryText}
                                      style={styles.timeIcon}
                                    />
                                  </TouchableOpacity>
                                  <View style={styles.editDescContainer}>
                                    <TextInput
                                      style={styles.editDescInput}
                                      value={activity.description}
                                      placeholder="Activity description"
                                      multiline
                                      onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'description', text)}
                                    />
                                  </View>
                                  <View style={styles.editActionsRow}>
                                    <TouchableOpacity
                                      onPress={() => handleDuplicateActivity(dayIndex, actIndex)}
                                      style={styles.actionBtn}
                                    >
                                      <MaterialCommunityIcons name="content-copy" size={18} color={COLORS.primaryBlue} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => handleRemoveActivity(dayIndex, actIndex)}
                                      style={styles.actionBtn}
                                    >
                                      <MaterialCommunityIcons name="delete" size={18} color={COLORS.danger} />
                                    </TouchableOpacity>
                                  </View>
                                </View>
                                {/* Location Field */}
                                <View style={styles.editExtraRow}>
                                  <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.secondaryText} />
                                  <TextInput
                                    style={styles.editExtraInput}
                                    value={activity.location || ''}
                                    placeholder="Location (optional)"
                                    onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'location', text)}
                                  />
                                </View>
                                {/* Notes Field */}
                                <View style={styles.editExtraRow}>
                                  <MaterialCommunityIcons name="note-text" size={16} color={COLORS.secondaryText} />
                                  <TextInput
                                    style={styles.editExtraInput}
                                    value={activity.notes || ''}
                                    placeholder="Notes (optional)"
                                    multiline
                                    onChangeText={(text) => handleEditActivity(dayIndex, actIndex, 'notes', text)}
                                  />
                                </View>
                              </View>
                            );
                          }

                          // --- VIEW ROW ---
                          const hasTime = Boolean(activity.time);
                          const showLine = actIndex < activities.length - 1;

                          return (
                            <View
                              key={actIndex}
                              style={styles.activityItem}
                              accessible={true}
                              accessibilityLabel={`${activity.time ? activity.time + ', ' : ''}${activity.description}${activity.location ? ', at ' + activity.location : ''}`}
                            >
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

                                {/* Location Display */}
                                {activity.location && (
                                  <TouchableOpacity
                                    style={styles.locationRow}
                                    onPress={() => {
                                      const query = encodeURIComponent(activity.location);
                                      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`);
                                    }}
                                  >
                                    <MaterialCommunityIcons name="map-marker" size={14} color={COLORS.coralAccent} />
                                    <Text style={styles.locationText}>{activity.location}</Text>
                                    <MaterialCommunityIcons name="open-in-new" size={12} color={COLORS.primaryBlue} />
                                  </TouchableOpacity>
                                )}

                                {/* Notes Display */}
                                {activity.notes && (
                                  <View style={styles.notesRow}>
                                    <MaterialCommunityIcons name="note-text-outline" size={14} color={COLORS.secondaryText} />
                                    <Text style={styles.notesText}>{activity.notes}</Text>
                                  </View>
                                )}
                              </View>
                            </View>
                          );
                        })}

                        {isEditing && (
                          <TouchableOpacity
                            onPress={() => handleAddActivity(dayIndex)}
                            style={styles.addActivityBtn}
                            accessible={true}
                            accessibilityLabel="Add activity"
                            accessibilityRole="button"
                          >
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

            {isEditing && (
              <TouchableOpacity
                onPress={handleAddDay}
                style={styles.addDayBtn}
                accessible={true}
                accessibilityLabel="Add new day"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="calendar-plus" size={24} color={COLORS.white} />
                <Text style={styles.addDayText}>Add New Day</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <View style={styles.footerSpacer} />
      </ScrollView>

      {/* TIME PICKER MODAL */}
      <Modal
        visible={timePickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setTimePickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setTimePickerVisible(false)}
        >
          <View style={styles.timePickerContainer}>
            <View style={styles.timePickerHeader}>
              <Text style={styles.timePickerTitle}>Select Time</Text>
              <TouchableOpacity onPress={() => setTimePickerVisible(false)}>
                <MaterialCommunityIcons name="close" size={24} color={COLORS.darkText} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.timePickerScroll}>
              {Array.from({ length: 24 }, (_, hour) =>
                ['00', '30'].map(minute => {
                  const time = `${String(hour).padStart(2, '0')}:${minute}`;
                  return (
                    <TouchableOpacity
                      key={time}
                      style={styles.timeOption}
                      onPress={() => handleTimeSelect(time)}
                    >
                      <Text style={styles.timeOptionText}>{time}</Text>
                      {selectedTime.value === time && (
                        <MaterialCommunityIcons name="check" size={20} color={COLORS.successGreen} />
                      )}
                    </TouchableOpacity>
                  );
                })
              ).flat()}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.appBackground },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  headerGradient: {
    paddingTop: Platform.OS === 'ios' ? 18 : 10,
    paddingBottom: 16,
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
  headerIconButton: { padding: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  editButton: { backgroundColor: COLORS.white, borderRadius: 12 },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.2)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginTop: 4 },
  offlineText: { color: COLORS.white, fontSize: 10, fontWeight: '600', marginLeft: 4 },

  // Search Bar
  searchContainer: { marginTop: 12, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 14, color: COLORS.darkText, paddingVertical: 12 },

  // Toolbar
  toolbar: { flexDirection: 'row', marginTop: 12, justifyContent: 'space-around', paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  toolbarButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.15)' },
  toolbarText: { color: COLORS.white, fontSize: 12, fontWeight: '600', marginLeft: 6 },

  scrollContainer: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },

  // Error Banner
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.danger, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16 },
  errorText: { color: COLORS.white, fontSize: 13, fontWeight: '600', marginLeft: 8, flex: 1 },

  // Sync Text
  syncText: { fontSize: 11, color: COLORS.secondaryText, textAlign: 'center', marginBottom: 12, fontStyle: 'italic' },

  // Loading Skeleton
  skeletonContainer: { paddingHorizontal: 16, paddingTop: 20 },
  skeletonCard: { backgroundColor: COLORS.white, borderRadius: 20, padding: 20, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  skeletonHeader: { height: 24, backgroundColor: '#E2E8F0', borderRadius: 8, marginBottom: 16, width: '60%' },
  skeletonLine: { height: 16, backgroundColor: '#F1F5F9', borderRadius: 6, marginBottom: 10 },

  // Empty State
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: COLORS.darkText, marginTop: 20, marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: COLORS.secondaryText, textAlign: 'center', lineHeight: 22 },
  emptyButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.primaryBlue, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 24, shadowColor: COLORS.primaryBlue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  emptyButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '700', marginLeft: 8 },

  // Day Cards
  dayCard: { backgroundColor: 'transparent', borderRadius: 20, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 6 },
  editingCard: { borderWidth: 2, borderColor: COLORS.primaryBlue, borderStyle: 'dashed' },
  todayCard: { borderWidth: 2, borderColor: COLORS.coralAccent, shadowColor: COLORS.coralAccent, shadowOpacity: 0.15 },
  dayCardInner: { borderRadius: 20, paddingHorizontal: 18, paddingVertical: 16 },

  dayHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  dayBadge: { backgroundColor: COLORS.lightBlueAccent, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  dayBadgeText: { fontSize: 12, fontWeight: '800', color: COLORS.white, letterSpacing: 0.5 },
  dayTitleWrapper: { flex: 1, marginLeft: 12 },
  dayTitleText: { fontSize: 18, fontWeight: '800', color: COLORS.darkText },
  dayEditActions: { flexDirection: 'row', gap: 8 },
  dayActionButton: { padding: 8 },

  activitiesContainer: { marginTop: 8 },
  activityItem: { flexDirection: 'row', paddingVertical: 12, alignItems: 'flex-start' },
  timelineColumn: { width: 28, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: COLORS.timelineColor, zIndex: 2 },
  majorDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: COLORS.coralAccent },
  timelineLine: { position: 'absolute', top: 12, width: 2, height: '100%', backgroundColor: COLORS.timelineColor, opacity: 0.7 },
  majorLine: { backgroundColor: COLORS.coralAccent, opacity: 0.5 },

  activityContent: { flex: 1, paddingLeft: 6 },
  activityContentNoTime: { paddingLeft: 8 },
  activityHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  activityHeaderRowNoTime: { justifyContent: 'flex-start', gap: 8 },
  activityTime: { fontSize: 15, fontWeight: '800', color: COLORS.primaryBlue, marginRight: 8 },
  activityTypePill: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#F2F6FC' },
  pillText: { fontSize: 11, color: COLORS.secondaryText, fontWeight: '700' },
  majorPill: { backgroundColor: COLORS.coralAccent },
  majorPillText: { color: COLORS.white },
  standardPill: { backgroundColor: '#E8EEF7' },
  activityDescription: { fontSize: 15, color: COLORS.darkText, lineHeight: 22, marginBottom: 4 },

  // Location & Notes
  locationRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  locationText: { fontSize: 13, color: COLORS.primaryBlue, marginLeft: 6, flex: 1, fontWeight: '600' },
  notesRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  notesText: { fontSize: 13, color: COLORS.secondaryText, marginLeft: 6, flex: 1, fontStyle: 'italic', lineHeight: 18 },

  // Edit Styles
  editRow: { marginBottom: 16, backgroundColor: '#fff', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  editMainRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  editTimeContainer: { width: 70, marginRight: 10, position: 'relative' },
  editTimeInput: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, padding: 10, fontSize: 13, fontWeight: '700', textAlign: 'center', backgroundColor: '#F9FAFB' },
  timeIcon: { position: 'absolute', bottom: 6, right: 6 },
  editDescContainer: { flex: 1 },
  editDescInput: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, padding: 10, fontSize: 14, minHeight: 44, backgroundColor: '#F9FAFB' },
  editActionsRow: { flexDirection: 'row', gap: 4, marginLeft: 6 },
  actionBtn: { padding: 6 },
  editExtraRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  editExtraInput: { flex: 1, marginLeft: 8, fontSize: 13, color: COLORS.darkText, paddingVertical: 6 },
  editTitleInput: { fontSize: 18, fontWeight: '800', color: COLORS.darkText, borderBottomWidth: 2, borderBottomColor: COLORS.primaryBlue, paddingBottom: 4 },

  addActivityBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 14, marginTop: 12, borderWidth: 2, borderColor: COLORS.primaryBlue, borderRadius: 12, borderStyle: 'dashed', backgroundColor: '#F0F9FF' },
  addActivityText: { color: COLORS.primaryBlue, fontWeight: '700', marginLeft: 8, fontSize: 15 },

  addDayBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 18, marginTop: 12, marginBottom: 20, backgroundColor: COLORS.primaryBlue, borderRadius: 16, shadowColor: COLORS.primaryBlue, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 6 },
  addDayText: { color: COLORS.white, fontWeight: '800', marginLeft: 10, fontSize: 16 },

  footerSpacer: { height: 20 },

  // Time Picker Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  timePickerContainer: { backgroundColor: COLORS.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: Platform.OS === 'ios' ? 34 : 20, maxHeight: '70%' },
  timePickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  timePickerTitle: { fontSize: 18, fontWeight: '800', color: COLORS.darkText },
  timePickerScroll: { maxHeight: 400 },
  timeOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  timeOptionText: { fontSize: 16, color: COLORS.darkText, fontWeight: '600' },
});
