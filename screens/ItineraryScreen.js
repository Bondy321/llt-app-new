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
  Share
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourItinerary } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
import offlineSyncService from '../services/offlineSyncService';
import logger from '../services/loggerService';
const { parseSupportedStartDate, getTourDayContext } = require('../services/itineraryDateParser');
const { buildItineraryItems } = require('../utils/itineraryPresentation');

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
  primaryMuted: THEME.primaryMuted,
  accentLight: THEME.accentLight,
  border: THEME.border,
  mutedText: THEME.textMuted,
};

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
  const [expandAll, setExpandAll] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const scrollViewRef = useRef(null);
  const searchAnimation = useRef(new Animated.Value(0)).current;
  const realtimeListener = useRef(null);
  const retryTimeoutRef = useRef(null);
  const loadRequestIdRef = useRef(0);

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // --- REAL-TIME SYNC ---
  useEffect(() => {
    loadRequestIdRef.current += 1;

    loadItinerary();

    // Set up real-time listener for live updates
    if (tourId && !isEditing) {
      const itineraryRef = realtimeDb.ref(`tours/${tourId}/itinerary`);

      const onUpdate = (snapshot) => {
        const data = snapshot.val();
        if (data) {
          setItinerary(data);
          setEditedItinerary(JSON.parse(JSON.stringify(data)));
          cacheItinerary(data);
        }
      };

      itineraryRef.on('value', onUpdate);
      realtimeListener.current = { ref: itineraryRef, listener: onUpdate };

      return () => {
        clearRetryTimeout();
        loadRequestIdRef.current += 1;
        if (realtimeListener.current) {
          realtimeListener.current.ref.off('value', realtimeListener.current.listener);
        }
      };
    }
    return () => {
      clearRetryTimeout();
      loadRequestIdRef.current += 1;
    };
  }, [tourId, isEditing, clearRetryTimeout]);

  // --- OFFLINE CACHING ---
  const cacheItinerary = async (data) => {
    try {
      const syncedAt = new Date().toISOString();
      await offlineSyncService.saveTourPack(tourId, isDriver ? 'driver' : 'passenger', { itinerary: data });
      await offlineSyncService.setTourPackMeta(tourId, isDriver ? 'driver' : 'passenger', { lastSyncedAt: syncedAt });
      setLastSyncedAt(syncedAt);
    } catch (error) {
      logger.warn('ItineraryScreen', 'Failed to save itinerary cache', {
        tourId,
        isDriver,
        error: error?.message || String(error)
      });
    }
  };

  const loadCachedItinerary = async () => {
    try {
      const cached = await offlineSyncService.getTourPack(tourId, isDriver ? 'driver' : 'passenger');
      const data = cached?.success ? cached.data?.itinerary : null;
      if (data) {
        try {
          const meta = await offlineSyncService.getTourPackMeta(tourId, isDriver ? 'driver' : 'passenger');
          if (meta?.success && meta.data?.lastSyncedAt) {
            setLastSyncedAt(meta.data.lastSyncedAt);
          }
        } catch (metaError) {
          logger.warn('ItineraryScreen', 'Failed to load itinerary cache metadata', {
            tourId,
            isDriver,
            error: metaError?.message || String(metaError)
          });
        }
        setCachedItinerary(data);
        return data;
      }
    } catch (error) {
      logger.warn('ItineraryScreen', 'Failed to load itinerary cache', {
        tourId,
        isDriver,
        error: error?.message || String(error)
      });
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

  const getDayDate = useCallback((dayNumber) => {
    if (!parsedTourStartDate) {
      return null;
    }
    const dayDate = new Date(parsedTourStartDate);
    dayDate.setDate(parsedTourStartDate.getDate() + (dayNumber - 1));
    return dayDate;
  }, [parsedTourStartDate]);

  const formatShortDate = useCallback((date) => {
    if (!date) return '';
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }, []);

  const formatDayLabel = useMemo(
    () => (dayNumber) => {
      const dayDate = getDayDate(dayNumber);
      if (!dayDate) {
        return `Day ${dayNumber}`;
      }
      const weekday = dayDate.toLocaleDateString(undefined, { weekday: 'short' });
      const monthStr = dayDate.toLocaleDateString(undefined, { month: 'long' });
      const dayStr = getOrdinal(dayDate.getDate());
      return `Day ${dayNumber} - ${weekday} ${dayStr} ${monthStr}`;
    },
    [getDayDate]
  );

  const tourDayContext = useMemo(() => getTourDayContext({
    startDate,
    itineraryDays: itinerary?.days || [],
  }), [itinerary?.days, startDate]);

  const todaysDayNumber = useMemo(() => {
    if (tourDayContext.status !== 'ACTIVE' || !itinerary?.days?.length) return null;
    return itinerary.days[tourDayContext.dayIndex]?.day || tourDayContext.dayNumber;
  }, [itinerary?.days, tourDayContext]);

  useEffect(() => {
    if (!itinerary?.days?.length) return;
    setCollapsedDays((prev) => {
      if (Object.keys(prev).length > 0 && !expandAll) {
        const hasAllDays = itinerary.days.every((day) => Object.prototype.hasOwnProperty.call(prev, day.day));
        if (hasAllDays) return prev;
      }

      const nextState = {};
      itinerary.days.forEach((day) => {
        nextState[day.day] = expandAll ? false : (todaysDayNumber ? day.day !== todaysDayNumber : false);
      });
      return nextState;
    });
  }, [itinerary?.days, todaysDayNumber, expandAll]);

  // --- DATA LOADING WITH RETRY ---
  const loadItinerary = async ({ showSkeleton = true, retry = 0 } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => requestId === loadRequestIdRef.current;

    try {
      clearRetryTimeout();
      setErrorMessage('');
      if (!tourId) {
        if (!isCurrentRequest()) return;
        setItinerary(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showSkeleton) setLoading(true);
      else setRefreshing(true);

      // Try to load from cache first
      const cachedSnapshot = await loadCachedItinerary();
      if (!isCurrentRequest()) return;
      if (cachedSnapshot && showSkeleton) {
        setItinerary(cachedSnapshot);
        setEditedItinerary(JSON.parse(JSON.stringify(cachedSnapshot)));
        setLoading(false);
      }

      const tourItinerary = await getTourItinerary(tourId);
      if (!isCurrentRequest()) return;
      setItinerary(tourItinerary || null);
      setEditedItinerary(JSON.parse(JSON.stringify(tourItinerary || {})));

      if (tourItinerary) {
        await cacheItinerary(tourItinerary);
      }

      setRetryCount(0);
    } catch (error) {
      console.error('Error loading itinerary:', error);
      if (!isCurrentRequest()) return;

      const fallbackSnapshot = await loadCachedItinerary();
      if (!isCurrentRequest()) return;

      if (retry < 3) {
        const delay = Math.pow(2, retry) * 1000;
        retryTimeoutRef.current = setTimeout(() => {
          if (requestId !== loadRequestIdRef.current) return;
          loadItinerary({ showSkeleton: false, retry: retry + 1 });
        }, delay);
        setRetryCount(retry + 1);
        setErrorMessage(`Connection issue. Retrying (${retry + 1}/3)...`);
      } else {
        const terminalFallback = fallbackSnapshot || cachedItinerary;
        if (terminalFallback) {
          setItinerary(terminalFallback);
          setEditedItinerary(JSON.parse(JSON.stringify(terminalFallback)));
          setRetryCount(0);
          setErrorMessage('');
        } else {
          setItinerary(null);
          setErrorMessage('Could not load itinerary. Please check your connection.');
        }
      }
    } finally {
      if (!isCurrentRequest()) return;
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
    const nextExpandAll = !expandAll;
    setExpandAll(nextExpandAll);
    setCollapsedDays((prev) => {
      const nextState = { ...prev };
      itinerary?.days?.forEach((day) => {
        nextState[day.day] = nextExpandAll ? false : true;
      });
      return nextState;
    });
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
      scrollViewRef.current.scrollTo({ y: Math.max(position - 10, 0), animated: true });
    }
  };

  const handleJumpToDay = (dayNumber) => {
    if (!dayNumber) return;
    if (!isEditing && collapsedDays[dayNumber]) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setCollapsedDays((prev) => ({ ...prev, [dayNumber]: false }));
    }
    scrollToDay(dayNumber);
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

  const isSearchActive = searchQuery.trim().length > 0 && !isEditing;

  // --- EMPTY STATE ---
  const renderEmptyState = () => {
    return (
      <View style={styles.emptyContainer}>
        <MaterialCommunityIcons name="calendar-blank-outline" size={80} color={COLORS.timelineColor} />
        <Text style={styles.emptyTitle}>
          {isSearchActive ? 'No Matching Days' : 'No Itinerary Yet'}
        </Text>
        <Text style={styles.emptySubtitle}>
          {isSearchActive
            ? "Try a different search term or clear search to see every day."
            : isDriver
            ? "Tap the edit button to create your first day"
            : "Your tour itinerary will appear here soon"}
        </Text>
        {isSearchActive && (
          <TouchableOpacity
            style={styles.emptySecondaryButton}
            onPress={() => setSearchQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear itinerary search"
          >
            <MaterialCommunityIcons name="close-circle-outline" size={20} color={COLORS.primaryBlue} />
            <Text style={styles.emptySecondaryButtonText}>Clear search</Text>
          </TouchableOpacity>
        )}
        {isDriver && !isSearchActive && (
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
  };

  const dataToRender = isEditing ? editedItinerary : (searchQuery ? filteredItinerary : itinerary);
  const visibleDays = dataToRender?.days || [];
  const itineraryDayCount = itinerary?.days?.length || 0;
  const displayTitle = tourName || dataToRender?.title || itinerary?.title || 'Tour itinerary';

  const formatSyncClock = useCallback((timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, []);

  const syncStatus = useMemo(() => {
    const freshness = offlineSyncService.getStalenessLabel(lastSyncedAt);
    const lastSyncedTime = formatSyncClock(lastSyncedAt);

    if (refreshing) {
      return {
        tone: 'fresh',
        icon: 'sync',
        label: 'Refreshing itinerary',
        detail: lastSyncedTime ? `Last synced ${lastSyncedTime}` : 'Checking for updates',
      };
    }

    if (errorMessage) {
      return {
        tone: 'critical',
        icon: cachedItinerary ? 'cloud-alert' : 'cloud-off-outline',
        label: cachedItinerary ? 'Showing saved itinerary' : 'Unable to refresh',
        detail: cachedItinerary
          ? 'Pull down to retry when your connection improves'
          : 'Pull down to try loading again',
      };
    }

    return {
      tone: freshness.bucket === 'fresh' ? 'fresh' : freshness.bucket === 'stale' ? 'warning' : 'neutral',
      icon: freshness.bucket === 'fresh' ? 'cloud-check-outline' : 'cloud-clock-outline',
      label: freshness.label,
      detail: lastSyncedTime ? `Last synced ${lastSyncedTime}` : 'Live itinerary updates enabled',
    };
  }, [cachedItinerary, errorMessage, formatSyncClock, lastSyncedAt, refreshing]);

  const headerDaySummary = useMemo(() => {
    if (!itineraryDayCount) {
      return {
        icon: 'calendar-blank-outline',
        label: 'Itinerary pending',
      };
    }

    if (tourDayContext.status === 'ACTIVE' && todaysDayNumber) {
      const todayDate = getDayDate(todaysDayNumber);
      return {
        icon: 'calendar-today',
        label: todayDate
          ? `Today: Day ${todaysDayNumber}, ${formatShortDate(todayDate)}`
          : `Today: Day ${todaysDayNumber}`,
      };
    }

    if (tourDayContext.status === 'FUTURE') {
      const firstDate = getDayDate(1);
      return {
        icon: 'calendar-start',
        label: firstDate ? `Starts ${formatShortDate(firstDate)}` : 'Tour starts soon',
      };
    }

    if (tourDayContext.status === 'COMPLETED') {
      return {
        icon: 'calendar-check-outline',
        label: 'Tour dates completed',
      };
    }

    return {
      icon: 'calendar-question',
      label: 'Dates to be confirmed',
    };
  }, [formatShortDate, getDayDate, itineraryDayCount, todaysDayNumber, tourDayContext]);

  const timelineItemsByDay = useMemo(() => {
    const itemsByDay = {};
    visibleDays.forEach((dayData, dayIndex) => {
      const dayNumber = dayData?.day || dayIndex + 1;
      itemsByDay[dayNumber] = buildItineraryItems(dayData?.content || '');
    });
    return itemsByDay;
  }, [visibleDays]);

  const renderHeaderSummary = () => {
    if (isEditing) return null;

    return (
      <View style={styles.readSummaryPanel}>
        <Text style={styles.readSummaryEyebrow}>Daily travel plan</Text>
        <Text style={styles.readSummaryTitle} numberOfLines={2}>
          {displayTitle}
        </Text>

        <View style={styles.summaryPillRow}>
          <View style={styles.summaryPill}>
            <MaterialCommunityIcons name="calendar-multiselect" size={15} color={COLORS.primaryBlue} />
            <Text style={styles.summaryPillText} numberOfLines={1}>
              {itineraryDayCount === 1 ? '1 day' : `${itineraryDayCount} days`}
            </Text>
          </View>

          <View style={[styles.summaryPill, styles.summaryPillWide]}>
            <MaterialCommunityIcons name={headerDaySummary.icon} size={15} color={COLORS.primaryBlue} />
            <Text style={styles.summaryPillText} numberOfLines={1}>
              {headerDaySummary.label}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderDayRail = () => {
    if (isEditing || visibleDays.length === 0) return null;

    return (
      <View style={styles.dayRailContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.dayRailContent}
        >
          {visibleDays.map((dayData, dayIndex) => {
            const dayNumber = dayData?.day || dayIndex + 1;
            const isToday = todaysDayNumber === dayNumber;
            const dayDate = getDayDate(dayNumber);
            const items = timelineItemsByDay[dayNumber] || [];

            return (
              <TouchableOpacity
                key={`rail-${dayNumber}-${dayIndex}`}
                onPress={() => handleJumpToDay(dayNumber)}
                style={[styles.dayRailChip, isToday && styles.dayRailChipToday]}
                activeOpacity={0.86}
                accessibilityRole="button"
                accessibilityLabel={`Jump to Day ${dayNumber}${isToday ? ', today' : ''}`}
              >
                <View style={styles.dayRailTopRow}>
                  <Text style={[styles.dayRailDayText, isToday && styles.dayRailDayTextToday]}>
                    Day {dayNumber}
                  </Text>
                  {isToday ? (
                    <View style={styles.dayRailTodayDot}>
                      <Text style={styles.dayRailTodayText}>Today</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.dayRailDateText, isToday && styles.dayRailDateTextToday]} numberOfLines={1}>
                  {dayDate ? formatShortDate(dayDate) : `${items.length || 0} items`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  const renderTimelineForDay = ({ dayData, dayItems }) => {
    const content = String(dayData?.content || '').trim();

    if (!content) {
      return (
        <View style={styles.emptyDayPanel}>
          <MaterialCommunityIcons name="calendar-edit" size={22} color={COLORS.mutedText} />
          <Text style={styles.emptyDayText}>No detailed plan has been published for this day yet.</Text>
        </View>
      );
    }

    if (!dayItems.length) {
      return (
        <Text style={styles.dayContentText}>
          {content}
        </Text>
      );
    }

    return (
      <View style={styles.timelineList}>
        {dayItems.map((item, itemIndex) => {
          const isLast = itemIndex === dayItems.length - 1;
          const isSingle = dayItems.length === 1;

          return (
            <View
              key={item.id}
              style={styles.timelineItem}
              accessible={true}
              accessibilityLabel={item.text}
            >
              <View style={styles.timelineMarkerColumn}>
                <View
                  style={[
                    styles.timelineConnector,
                    itemIndex === 0 && styles.timelineConnectorFirst,
                    isLast && styles.timelineConnectorLast,
                    isSingle && styles.timelineConnectorHidden,
                  ]}
                />
                <View style={styles.timelineIconCircle}>
                  <MaterialCommunityIcons
                    name={item.iconKey}
                    size={16}
                    color={COLORS.primaryBlue}
                  />
                </View>
              </View>

              <View style={styles.timelineTextColumn}>
                <View style={styles.timelineTitleRow}>
                  <Text style={styles.timelineItemText}>
                    {item.text}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    );
  };

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
              <Text
                style={styles.headerTitle}
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.86}
              >
                {tourName || 'Loading...'}
              </Text>
            </View>
          </View>
        </LinearGradient>
        {renderLoadingSkeleton()}
      </SafeAreaView>
    );
  }

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
            <Text
              style={[styles.headerTitle, isEditing && {color: COLORS.darkText}]}
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.86}
            >
              {displayTitle}
            </Text>
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

        {renderHeaderSummary()}

        {/* QUICK TOOLBAR */}
        {!isEditing && itinerary?.days?.length > 0 && (
          <View style={styles.toolbar}>
            <TouchableOpacity onPress={toggleExpandAll} style={styles.toolbarButton}>
              <MaterialCommunityIcons
                name={expandAll ? "chevron-up-circle" : "chevron-down-circle"}
                size={18}
                color={COLORS.white}
              />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                {expandAll ? 'Collapse All' : 'Expand All'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => handleJumpToDay(todaysDayNumber || visibleDays[0]?.day || 1)} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="calendar-today" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                Today
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleExportToCalendar} style={styles.toolbarButton}>
              <MaterialCommunityIcons name="export-variant" size={18} color={COLORS.white} />
              <Text style={styles.toolbarText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                Export
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </LinearGradient>

      {renderDayRail()}

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
        {!isEditing && (
          <View
            style={[
              styles.syncStatusStrip,
              syncStatus.tone === 'warning' && styles.syncStatusStripWarning,
              syncStatus.tone === 'critical' && styles.syncStatusStripCritical,
            ]}
          >
            <View
              style={[
                styles.syncStatusIcon,
                syncStatus.tone === 'warning' && styles.syncStatusIconWarning,
                syncStatus.tone === 'critical' && styles.syncStatusIconCritical,
              ]}
            >
              <MaterialCommunityIcons
                name={syncStatus.icon}
                size={18}
                color={
                  syncStatus.tone === 'critical'
                    ? COLORS.danger
                    : syncStatus.tone === 'warning'
                    ? '#B45309'
                    : COLORS.primaryBlue
                }
              />
            </View>
            <View style={styles.syncStatusTextWrap}>
              <Text
                style={[
                  styles.syncStatusLabel,
                  syncStatus.tone === 'warning' && styles.syncStatusLabelWarning,
                  syncStatus.tone === 'critical' && styles.syncStatusLabelCritical,
                ]}
                numberOfLines={1}
              >
                {syncStatus.label}
              </Text>
              <Text style={styles.syncStatusDetail} numberOfLines={1}>
                {syncStatus.detail}
              </Text>
            </View>
          </View>
        )}

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
            <Text style={styles.errorText}>{errorMessage}</Text>
            {retryCount > 0 && (
              <ActivityIndicator size="small" color={COLORS.white} style={{ marginLeft: 10 }} />
            )}
          </View>
        ) : null}

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
              const dayNumber = dayData?.day || dayIndex + 1;
              const isCollapsed = !isEditing && !isSearchActive && collapsedDays[dayNumber];
              const dayLabel = formatDayLabel(dayNumber);
              const isToday = todaysDayNumber === dayNumber;
              const content = dayData?.content || '';
              const dayItems = timelineItemsByDay[dayNumber] || [];
              const dayDate = getDayDate(dayNumber);
              const dayMetaLabel = dayItems.length
                ? `${dayItems.length} ${dayItems.length === 1 ? 'highlight' : 'highlights'}`
                : 'No details yet';

              return (
                <View
                  key={`${dayNumber}-${dayIndex}`}
                  style={[
                    styles.dayCard,
                    isToday && styles.todayCard,
                    isEditing && styles.editingCard
                  ]}
                  onLayout={(event) => {
                    const { y } = event.nativeEvent.layout;
                    setDayPositions((prev) => ({ ...prev, [dayNumber]: y }));
                  }}
                >
                  <LinearGradient
                    colors={isToday && !isEditing ? [COLORS.white, '#FFF7ED'] : [COLORS.white, '#F7FAFF']}
                    style={styles.dayCardInner}
                  >
                    <TouchableOpacity
                      onPress={() => toggleDay(dayNumber)}
                      disabled={isSearchActive}
                      activeOpacity={isEditing || isSearchActive ? 1 : 0.9}
                      accessible={true}
                      accessibilityLabel={`${dayLabel}${isToday ? ', today' : ''}`}
                      accessibilityRole={isSearchActive ? undefined : "button"}
                      accessibilityHint={
                        isSearchActive
                          ? "Search matches are expanded"
                          : isCollapsed
                          ? "Double tap to expand"
                          : "Double tap to collapse"
                      }
                    >
                      <View style={styles.dayHeader}>
                        {isEditing ? (
                          <>
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
                          </>
                        ) : (
                          <View style={styles.readDayHeader}>
                            <View style={styles.readDayTitleWrap}>
                              <View style={styles.readDayTitleRow}>
                                <Text style={styles.readDayTitle}>Day {dayNumber}</Text>
                                {isToday ? (
                                  <View style={styles.todayInlineBadge}>
                                    <MaterialCommunityIcons name="calendar-today" size={12} color={COLORS.coralAccent} />
                                    <Text style={styles.todayInlineBadgeText}>Today</Text>
                                  </View>
                                ) : null}
                              </View>
                              <Text style={styles.readDayDateText} numberOfLines={1}>
                                {dayDate ? formatShortDate(dayDate) : 'Travel plan'}
                              </Text>
                              <Text style={styles.readDayMetaText} numberOfLines={1}>
                                {dayMetaLabel}
                              </Text>
                            </View>

                            <View style={styles.readDayChevron}>
                              <MaterialCommunityIcons
                                name={isCollapsed ? 'chevron-down' : 'chevron-up'}
                                size={26}
                                color={COLORS.secondaryText}
                              />
                            </View>
                          </View>
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
                            accessibilityLabel={`Day ${dayNumber} content`}
                          />
                        ) : (
                          renderTimelineForDay({ dayData, dayItems })
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
  headerTitle: { fontSize: 24, lineHeight: 29, fontWeight: '800', color: COLORS.white, marginTop: 2 },
  headerButton: { padding: 8, minWidth: 40, alignItems: 'center' },
  headerIconButton: { padding: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  editButton: { backgroundColor: COLORS.white, borderRadius: 12 },
  readSummaryPanel: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  readSummaryEyebrow: {
    color: COLORS.lightBlueAccent,
    fontSize: 11,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  readSummaryTitle: {
    marginTop: 3,
    color: COLORS.white,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  summaryPillRow: {
    marginTop: SPACING.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  summaryPill: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: 'rgba(255,255,255,0.88)',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
  },
  summaryPillWide: {
    flexShrink: 1,
    maxWidth: '100%',
  },
  summaryPillText: {
    flexShrink: 1,
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.bold,
  },

  // Search Bar
  searchContainer: { marginTop: 12, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 14, color: COLORS.darkText, paddingVertical: 12 },

  // Toolbar
  toolbar: { flexDirection: 'row', marginTop: 12, gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  toolbarButton: { flex: 1, minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.15)' },
  toolbarText: { color: COLORS.white, fontSize: 12, fontWeight: '600', marginLeft: 6, flexShrink: 1 },

  // Day rail
  dayRailContainer: {
    backgroundColor: COLORS.appBackground,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingVertical: SPACING.sm,
  },
  dayRailContent: {
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
  dayRailChip: {
    width: 122,
    minHeight: 58,
    justifyContent: 'center',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm,
  },
  dayRailChipToday: {
    borderColor: COLORS.coralAccent,
    backgroundColor: COLORS.accentLight,
  },
  dayRailTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.xs,
  },
  dayRailDayText: {
    color: COLORS.darkText,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  dayRailDayTextToday: {
    color: COLORS.coralAccent,
  },
  dayRailTodayDot: {
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.coralAccent,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  dayRailTodayText: {
    color: COLORS.white,
    fontSize: 9,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dayRailDateText: {
    marginTop: 4,
    color: COLORS.secondaryText,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.semibold,
  },
  dayRailDateTextToday: {
    color: COLORS.darkText,
  },

  scrollContainer: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40 },

  // Sync Status
  syncStatusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.md,
    ...SHADOWS.sm,
  },
  syncStatusStripWarning: {
    borderColor: '#FCD34D',
    backgroundColor: '#FFFBEB',
  },
  syncStatusStripCritical: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
  },
  syncStatusIcon: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  syncStatusIconWarning: {
    backgroundColor: '#FEF3C7',
  },
  syncStatusIconCritical: {
    backgroundColor: '#FEE2E2',
  },
  syncStatusTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  syncStatusLabel: {
    color: COLORS.primaryBlue,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  syncStatusLabelWarning: {
    color: '#B45309',
  },
  syncStatusLabelCritical: {
    color: COLORS.danger,
  },
  syncStatusDetail: {
    marginTop: 2,
    color: COLORS.secondaryText,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.semibold,
  },

  // Error Banner
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.danger, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16 },
  errorText: { color: COLORS.white, fontSize: 13, fontWeight: '600', marginLeft: 8, flex: 1 },

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
  emptySecondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.primaryBlue,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    ...SHADOWS.sm,
  },
  emptySecondaryButtonText: {
    color: COLORS.primaryBlue,
    fontSize: 15,
    fontWeight: FONT_WEIGHT.bold,
  },


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
  dayCard: { backgroundColor: 'transparent', borderRadius: RADIUS.lg, marginBottom: SPACING.lg, ...SHADOWS.md },
  editingCard: { borderWidth: 2, borderColor: COLORS.primaryBlue, borderStyle: 'dashed' },
  todayCard: { borderWidth: 2, borderColor: COLORS.coralAccent, shadowColor: COLORS.coralAccent, shadowOpacity: 0.15 },
  dayCardInner: { borderRadius: RADIUS.lg, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.lg },

  dayHeader: { flexDirection: 'row', alignItems: 'center' },
  dayBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.primaryBlue, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12 },
  todayBadge: { backgroundColor: COLORS.coralAccent },
  dayBadgeText: { fontSize: 13, fontWeight: '800', color: COLORS.white, letterSpacing: 0.3 },
  dayEditActions: { flexDirection: 'row', gap: 8 },
  dayActionButton: { padding: 8 },
  readDayHeader: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  readDayTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  readDayTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  readDayTitle: {
    color: COLORS.darkText,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: FONT_WEIGHT.extrabold,
  },
  readDayDateText: {
    marginTop: 2,
    color: COLORS.secondaryText,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.semibold,
  },
  readDayMetaText: {
    marginTop: 5,
    color: COLORS.mutedText,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.semibold,
  },
  todayInlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.accentLight,
    borderWidth: 1,
    borderColor: COLORS.coralAccent,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
  },
  todayInlineBadgeText: {
    color: COLORS.coralAccent,
    fontSize: 10,
    fontWeight: FONT_WEIGHT.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  readDayChevron: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.appBackground,
  },

  // Day content
  contentContainer: { marginTop: SPACING.md, paddingTop: SPACING.md, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  dayContentText: { fontSize: 15, color: COLORS.darkText, lineHeight: 24, letterSpacing: 0.1 },
  timelineList: {
    gap: SPACING.xs,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingRight: SPACING.sm,
  },
  timelineMarkerColumn: {
    width: 34,
    alignItems: 'center',
    alignSelf: 'stretch',
    position: 'relative',
  },
  timelineConnector: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 16,
    width: 2,
    borderRadius: RADIUS.full,
    backgroundColor: '#DBEAFE',
  },
  timelineConnectorFirst: {
    top: 18,
  },
  timelineConnectorLast: {
    bottom: 18,
  },
  timelineConnectorHidden: {
    display: 'none',
  },
  timelineIconCircle: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    zIndex: 1,
  },
  timelineTextColumn: {
    flex: 1,
    minWidth: 0,
    paddingTop: 3,
    paddingLeft: SPACING.sm,
  },
  timelineTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  timelineItemText: {
    flex: 1,
    color: COLORS.darkText,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: FONT_WEIGHT.medium,
  },
  emptyDayPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.appBackground,
    padding: SPACING.md,
  },
  emptyDayText: {
    flex: 1,
    color: COLORS.secondaryText,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: FONT_WEIGHT.semibold,
  },

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
