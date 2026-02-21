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
  Animated,
  Dimensions,
  Share
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';
import offlineSyncService from '../services/offlineSyncService';
const { parseSupportedStartDate } = require('../services/itineraryDateParser');

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

  // --- SEARCH ---
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // --- UI STATE ---
  const [cachedItinerary, setCachedItinerary] = useState(null);
  const [isOnline, setIsOnline] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [expandAll, setExpandAll] = useState(false);

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
      await offlineSyncService.saveTourPack(tourId, isDriver ? 'driver' : 'passenger', { itinerary: data });
      await offlineSyncService.setTourPackMeta(tourId, isDriver ? 'driver' : 'passenger', { lastSyncedAt: new Date().toISOString() });
    } catch (error) {
      console.log('Cache save failed:', error);
    }
  };

  const loadCachedItinerary = async () => {
    try {
      const cached = await offlineSyncService.getTourPack(tourId, isDriver ? 'driver' : 'passenger');
      const data = cached?.success ? cached.data?.itinerary : null;
      if (data) {
        setCachedItinerary(data);
        return data;
      }
    } catch (error) {
      console.log('Cache load failed:', error);
    }
    return null;
  };

  // --- DATE HELPERS ---
  const getOrdinal = (day) => {
    const j = day % 10;
    const k = day % 100;
    if (j === 1 && k !== 11) return `${day}st`;
    if (j === 2 && k !== 12) return `${day}nd`;
    if (j === 3 && k !== 13) return `${day}rd`;
    return `${day}th`;
  };

  const getParsedStartDate = useMemo(
    () => (rawDate) => parseSupportedStartDate(rawDate),
    []
  );

  const parsedTourStartDate = useMemo(() => getParsedStartDate(startDate), [getParsedStartDate, startDate]);
  const hasUnsupportedStartDate = Boolean(startDate) && !parsedTourStartDate;

  const formatDayLabel = useMemo(
    () => (dayNumber) => {
      if (!parsedTourStartDate) {
        return `Day ${dayNumber}`;
      }
      const dayDate = new Date(parsedTourStartDate);
      dayDate.setDate(parsedTourStartDate.getDate() + (dayNumber - 1));
      const weekday = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
      const monthStr = dayDate.toLocaleDateString(undefined, { month: 'long' });
      const dayStr = getOrdinal(dayDate.getDate());
      return `Day ${dayNumber} - ${weekday} ${dayStr} ${monthStr}`;
    },
    [parsedTourStartDate]
  );

  const todaysDayNumber = useMemo(() => {
    if (!parsedTourStartDate || !itinerary?.days?.length) return null;
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diffTime = today.getTime() - parsedTourStartDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays < 1 || diffDays > itinerary.days.length) return null;
    return diffDays;
  }, [itinerary?.days?.length, parsedTourStartDate]);

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
      setEditedItinerary(JSON.parse(JSON.stringify(tourItinerary || {})));
      setIsOnline(true);
      setLastSync(new Date());

      if (tourItinerary) {
        await cacheItinerary(tourItinerary);
      }

      setRetryCount(0);
    } catch (error) {
      console.error('Error loading itinerary:', error);

      if (retry < 3) {
        const delay = Math.pow(2, retry) * 1000;
        setTimeout(() => {
          loadItinerary({ showSkeleton: false, retry: retry + 1 });
        }, delay);
        setRetryCount(retry + 1);
        setErrorMessage(`Connection issue. Retrying (${retry + 1}/3)...`);
      } else {
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
    if (isEditing) return;
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
      days: itinerary.days.filter(day => {
        const content = day.content || '';
        return content.toLowerCase().includes(query);
      })
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
  const handleEditDayContent = (dayIndex, value) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    newItinerary.days[dayIndex].content = value;
    setEditedItinerary(newItinerary);
  };

  const handleAddDay = () => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    const newDayNumber = (newItinerary.days?.length || 0) + 1;

    if (!newItinerary.days) {
      newItinerary.days = [];
    }

    newItinerary.days.push({
      day: newDayNumber,
      content: ''
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
            newItinerary.days.push(dayToCopy);
            setEditedItinerary(newItinerary);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  // --- SAVE WITH RETRY ---
  const handleSaveChanges = async (retryAttempt = 0) => {
    setSaving(true);
    try {
      await realtimeDb.ref(`tours/${tourId}/itinerary`).update(editedItinerary);

      setItinerary(editedItinerary);
      await cacheItinerary(editedItinerary);
      setIsEditing(false);
      setLastSync(new Date());
      Alert.alert("Success", "Itinerary updated. Passengers will be notified shortly.");
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
      const parsedStart = parsedTourStartDate;
      if (!parsedStart) {
        Alert.alert("Unsupported start date", "Calendar export supports dd/MM/yyyy or yyyy-MM-dd dates.");
        return;
      }
      let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LLT Tours//Itinerary//EN\n";

      itinerary.days.forEach((day, dayIndex) => {
        const dayDate = new Date(parsedStart);
        dayDate.setDate(parsedStart.getDate() + dayIndex);
        const dateStr = dayDate.toISOString().split('T')[0].replace(/-/g, '');

        const content = day.content || '';
        if (content) {
          icsContent += `BEGIN:VEVENT\n`;
          icsContent += `DTSTART;VALUE=DATE:${dateStr}\n`;
          icsContent += `DTEND;VALUE=DATE:${dateStr}\n`;
          icsContent += `SUMMARY:Day ${day.day} - ${itinerary.title || tourName || 'Tour'}\n`;
          icsContent += `DESCRIPTION:${content.replace(/\n/g, '\\n')}\n`;
          icsContent += `END:VEVENT\n`;
        }
      });

      icsContent += "END:VCALENDAR";

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
    }
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
                  content: ''
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
              placeholder="Search itinerary..."
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
        <View style={styles.cacheMetaRow}><Text style={styles.cacheMetaText}>{offlineSyncService.getStalenessLabel(lastSync).label}</Text></View>
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

        {isDriver && isEditing && hasUnsupportedStartDate && (
          <View style={styles.dateWarningBanner}>
            <MaterialCommunityIcons name="alert-outline" size={14} color={COLORS.secondaryText} />
            <Text style={styles.dateWarningText}>
              Start date format not supported. Showing Day numbers only.
            </Text>
          </View>
        )}

        {(!dataToRender?.days || dataToRender.days.length === 0) ? (
          renderEmptyState()
        ) : (
          <>
            {dataToRender.days.map((dayData, dayIndex) => {
              const isCollapsed = !isEditing && collapsedDays[dayData.day];
              const dayLabel = formatDayLabel(dayData.day);
              const isToday = todaysDayNumber === dayData.day;
              const content = dayData.content || '';

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
                      accessibilityLabel={dayLabel}
                      accessibilityRole="button"
                      accessibilityHint={isCollapsed ? "Double tap to expand" : "Double tap to collapse"}
                    >
                      <View style={styles.dayHeader}>
                        <View style={[styles.dayBadge, isToday && styles.todayBadge]}>
                          <MaterialCommunityIcons
                            name={isToday ? "calendar-today" : "calendar-blank"}
                            size={14}
                            color={COLORS.white}
                            style={{ marginRight: 6 }}
                          />
                          <Text style={styles.dayBadgeText}>{dayLabel}</Text>
                        </View>
                        <View style={{ flex: 1 }} />
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
                      <View style={styles.contentContainer}>
                        {isEditing ? (
                          <TextInput
                            style={styles.editContentInput}
                            value={content}
                            onChangeText={(text) => handleEditDayContent(dayIndex, text)}
                            placeholder="Enter the itinerary for this day..."
                            placeholderTextColor={COLORS.secondaryText}
                            multiline
                            textAlignVertical="top"
                            accessible={true}
                            accessibilityLabel={`Day ${dayData.day} content`}
                          />
                        ) : (
                          <Text style={styles.dayContentText}>
                            {content || 'No details available for this day.'}
                          </Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.appBackground },

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


  dateWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.appBackground,
  },
  dateWarningText: {
    color: COLORS.secondaryText,
    fontSize: 12,
  },

  // Day Cards
  dayCard: { backgroundColor: 'transparent', borderRadius: 20, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 6 },
  editingCard: { borderWidth: 2, borderColor: COLORS.primaryBlue, borderStyle: 'dashed' },
  todayCard: { borderWidth: 2, borderColor: COLORS.coralAccent, shadowColor: COLORS.coralAccent, shadowOpacity: 0.15 },
  dayCardInner: { borderRadius: 20, paddingHorizontal: 18, paddingVertical: 16 },

  dayHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dayBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.primaryBlue, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12 },
  todayBadge: { backgroundColor: COLORS.coralAccent },
  dayBadgeText: { fontSize: 13, fontWeight: '800', color: COLORS.white, letterSpacing: 0.3 },
  dayEditActions: { flexDirection: 'row', gap: 8 },
  dayActionButton: { padding: 8 },

  // Day content
  contentContainer: { marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  dayContentText: { fontSize: 15, color: COLORS.darkText, lineHeight: 24, letterSpacing: 0.1 },

  // Edit mode
  editContentInput: {
    fontSize: 15,
    color: COLORS.darkText,
    lineHeight: 24,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    padding: 14,
    minHeight: 100,
    backgroundColor: '#F9FAFB',
    textAlignVertical: 'top',
  },

  addDayBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 18, marginTop: 12, marginBottom: 20, backgroundColor: COLORS.primaryBlue, borderRadius: 16, shadowColor: COLORS.primaryBlue, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 6 },
  addDayText: { color: COLORS.white, fontWeight: '800', marginLeft: 10, fontSize: 16 },

  footerSpacer: { height: 20 },
});
