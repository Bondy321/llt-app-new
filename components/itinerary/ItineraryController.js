// screens/ItineraryScreen.js
import ItineraryView, { ItineraryLoadingView } from './ItineraryView';
import createItineraryEditActions from './itineraryEditActions';
import useItineraryRenderers from './useItineraryRenderers';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Platform,
  LayoutAnimation,
  UIManager,
  Animated
} from 'react-native';
import { getTourItinerary } from '../../services/bookingServiceRealtime';
import { subscribeToItinerary } from '../../services/itineraryRealtimeService';
import offlineSyncService from '../../services/offlineSyncService';
import logger from '../../services/loggerService';
const { parseSupportedStartDate, getTourDayContext } = require('../../services/itineraryDateParser');
const {
  ITINERARY_DATA_SOURCE,
} = require('../../utils/itinerarySyncPresentation');
const {
  createItineraryContentSignature,
  normalizeItineraryDocument,
} = require('../../services/itineraryService');

export default function ItineraryController({ onBack, tourId, tourName, startDate, isDriver, offlineCacheOwnerId }) {
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
  const [dataSource, setDataSource] = useState(ITINERARY_DATA_SOURCE.NONE);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [freshnessNow, setFreshnessNow] = useState(Date.now());
  const [editConflict, setEditConflict] = useState(null);
  const [operationMessage, setOperationMessage] = useState('');

  const scrollViewRef = useRef(null);
  const searchAnimation = useRef(new Animated.Value(0)).current;
  const realtimeListener = useRef(null);
  const cacheItineraryRef = useRef(null);
  const loadItineraryRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const activeTourIdRef = useRef(tourId);
  const editBaseSignatureRef = useRef(createItineraryContentSignature(null));

  activeTourIdRef.current = tourId;

  const canUpdateForTour = useCallback((targetTourId = tourId) => (
    mountedRef.current && activeTourIdRef.current === targetTourId
  ), [tourId]);

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

  useEffect(() => {
    logger.trackScreen('Itinerary', {
      tourId,
      tourName,
      startDate,
      isDriver: Boolean(isDriver),
    });
  }, [isDriver, startDate, tourId, tourName]);

  useEffect(() => {
    if (!lastSyncedAt) return undefined;
    const timer = setInterval(() => setFreshnessNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, [lastSyncedAt]);

  // --- INITIAL LOAD LIFECYCLE ---
  useEffect(() => {
    mountedRef.current = true;
    loadRequestIdRef.current += 1;
    logger.info('ItineraryScreen', 'Itinerary effect started', {
      tourId,
      isDriver: Boolean(isDriver),
    });

    loadItineraryRef.current?.();
    return () => {
      mountedRef.current = false;
      clearRetryTimeout();
      loadRequestIdRef.current += 1;
      logger.debug('ItineraryScreen', 'Itinerary load lifecycle cleaned up', { tourId });
    };
  }, [tourId, isDriver, clearRetryTimeout, canUpdateForTour, offlineCacheOwnerId]);

  // Editing deliberately pauses live replacement so a remote snapshot cannot erase a draft.
  useEffect(() => {
    if (!tourId || isEditing) return undefined;
    logger.info('ItineraryScreen', 'Realtime itinerary listener starting', { tourId, isDriver: Boolean(isDriver) });

    const onUpdate = (snapshot) => {
      if (!canUpdateForTour(tourId)) return;
      const data = normalizeItineraryDocument(snapshot.val());
      setItinerary(data || null);
      setEditedItinerary(data ? JSON.parse(JSON.stringify(data)) : null);
      setCachedItinerary(data || null);
      setDataSource(ITINERARY_DATA_SOURCE.LIVE);
      setCheckingForUpdates(false);
      setErrorMessage('');
      editBaseSignatureRef.current = createItineraryContentSignature(data || null);
      cacheItineraryRef.current?.(data || null);
      logger.info('ItineraryScreen', 'Realtime itinerary snapshot received', {
        tourId,
        dayCount: Array.isArray(data?.days) ? data.days.length : 0,
        hasItinerary: Boolean(data),
      });
    };

    const onListenerError = (error) => {
      logger.warn('ItineraryScreen', 'Realtime itinerary listener failed', {
        tourId,
        isDriver: Boolean(isDriver),
        error: error?.message || String(error),
      });
      if (canUpdateForTour(tourId)) {
        setErrorMessage('Live itinerary updates are unavailable.');
        setCheckingForUpdates(false);
      }
    };

    const unsubscribe = subscribeToItinerary({ onError: onListenerError, onValue: onUpdate, tourId });
    realtimeListener.current = { listener: onUpdate, unsubscribe };
    return () => {
      logger.debug('ItineraryScreen', 'Realtime itinerary listener stopping', { tourId });
      unsubscribe();
      if (realtimeListener.current?.listener === onUpdate) realtimeListener.current = null;
    };
  }, [tourId, isDriver, isEditing, canUpdateForTour]);

  // --- OFFLINE CACHING ---
  const cacheItinerary = async (data, syncedAt = new Date().toISOString()) => {
    const targetTourId = tourId;
    try {
      const role = isDriver ? 'driver' : 'passenger';
      const cacheResult = await offlineSyncService.saveTourPack(
        targetTourId,
        role,
        { itinerary: data ?? null },
        { ownerId: offlineCacheOwnerId },
      );
      const metaResult = await offlineSyncService.setTourPackMeta(
        targetTourId,
        role,
        {
          lastSyncedAt: syncedAt,
          itineraryLastSyncedAt: syncedAt,
          itineraryRevision: Number.isInteger(data?.revision) ? data.revision : 0,
        },
        { ownerId: offlineCacheOwnerId },
      );
      if (!cacheResult?.success || !metaResult?.success) {
        throw new Error(cacheResult?.error || metaResult?.error || 'Itinerary cache write failed');
      }
      if (canUpdateForTour(targetTourId)) {
        setLastSyncedAt(syncedAt);
        setCachedItinerary(data ?? null);
      }
      logger.info('ItineraryScreen', 'Itinerary cache saved', {
        tourId: targetTourId,
        isDriver: Boolean(isDriver),
        dayCount: Array.isArray(data?.days) ? data.days.length : null,
        syncedAt,
      });
    } catch (error) {
      logger.warn('ItineraryScreen', 'Failed to save itinerary cache', {
        tourId: targetTourId,
        isDriver,
        error: error?.message || String(error)
      });
    }
  };

  const loadCachedItinerary = async () => {
    const targetTourId = tourId;
    try {
      const cached = await offlineSyncService.getTourPack(
        targetTourId,
        isDriver ? 'driver' : 'passenger',
        { ownerId: offlineCacheOwnerId },
      );
      const data = cached?.success ? cached.data?.itinerary : null;
      if (data) {
        let itineraryLastSyncedAt = null;
        try {
          const meta = await offlineSyncService.getTourPackMeta(
            targetTourId,
            isDriver ? 'driver' : 'passenger',
            { ownerId: offlineCacheOwnerId },
          );
          itineraryLastSyncedAt = meta?.success
            ? (meta.data?.itineraryLastSyncedAt || meta.data?.lastSyncedAt || cached.data?.fetchedAt || null)
            : (cached.data?.fetchedAt || null);
          if (itineraryLastSyncedAt && canUpdateForTour(targetTourId)) {
            setLastSyncedAt(itineraryLastSyncedAt);
          }
        } catch (metaError) {
          logger.warn('ItineraryScreen', 'Failed to load itinerary cache metadata', {
            tourId: targetTourId,
            isDriver,
            error: metaError?.message || String(metaError)
          });
        }
        if (canUpdateForTour(targetTourId)) {
          setCachedItinerary(data);
        }
        return { data, syncedAt: itineraryLastSyncedAt || cached.data?.fetchedAt || null };
      }
    } catch (error) {
      logger.warn('ItineraryScreen', 'Failed to load itinerary cache', {
        tourId: targetTourId,
        isDriver,
        error: error?.message || String(error)
      });
    }
    return { data: null, syncedAt: null };
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
    logger.info('ItineraryScreen', 'Itinerary load started', {
      tourId,
      isDriver: Boolean(isDriver),
      showSkeleton,
      retry,
      requestId,
    });

    try {
      clearRetryTimeout();
      setErrorMessage('');
      setOperationMessage('');
      setCheckingForUpdates(true);
      if (!tourId) {
        logger.warn('ItineraryScreen', 'Itinerary load skipped without tour id', { isDriver: Boolean(isDriver), requestId });
        if (!isCurrentRequest()) return;
        setItinerary(null);
        setLoading(false);
        setRefreshing(false);
        setCheckingForUpdates(false);
        setDataSource(ITINERARY_DATA_SOURCE.NONE);
        return;
      }

      if (showSkeleton) setLoading(true);
      else setRefreshing(true);

      // Try to load from cache first
      const cachedResult = await loadCachedItinerary();
      const cachedSnapshot = cachedResult?.data || null;
      if (!isCurrentRequest()) return;
      if (cachedSnapshot && showSkeleton) {
        setItinerary(cachedSnapshot);
        setEditedItinerary(JSON.parse(JSON.stringify(cachedSnapshot)));
        setDataSource(ITINERARY_DATA_SOURCE.CACHE);
        if (cachedResult.syncedAt) setLastSyncedAt(cachedResult.syncedAt);
        setLoading(false);
        logger.info('ItineraryScreen', 'Itinerary cache used before network load', {
          tourId,
          requestId,
          dayCount: Array.isArray(cachedSnapshot?.days) ? cachedSnapshot.days.length : null,
        });
      }

      const tourItinerary = await getTourItinerary(tourId);
      if (!isCurrentRequest()) return;
      setItinerary(tourItinerary || null);
      setEditedItinerary(JSON.parse(JSON.stringify(tourItinerary || {})));
      setDataSource(ITINERARY_DATA_SOURCE.LIVE);
      editBaseSignatureRef.current = createItineraryContentSignature(tourItinerary || null);
      logger.info('ItineraryScreen', 'Itinerary network load completed', {
        tourId,
        requestId,
        hasItinerary: Boolean(tourItinerary),
        dayCount: Array.isArray(tourItinerary?.days) ? tourItinerary.days.length : null,
      });

      if (tourItinerary) {
        await cacheItinerary(tourItinerary);
      } else {
        await cacheItinerary(null);
      }

      setRetryCount(0);
      setErrorMessage('');
    } catch (error) {
      logger.error('ItineraryScreen', 'Itinerary load failed', {
        tourId,
        requestId,
        retry,
        error: error?.message || String(error),
      });
      if (!isCurrentRequest()) return;

      const fallbackResult = await loadCachedItinerary();
      const fallbackSnapshot = fallbackResult?.data || null;
      if (!isCurrentRequest()) return;

      if (retry < 3) {
        const delay = Math.pow(2, retry) * 1000;
        logger.warn('ItineraryScreen', 'Itinerary load scheduling retry', {
          tourId,
          requestId,
          nextRetry: retry + 1,
          delay,
        });
        retryTimeoutRef.current = setTimeout(() => {
          if (requestId !== loadRequestIdRef.current) return;
          loadItinerary({ showSkeleton: false, retry: retry + 1 });
        }, delay);
        setRetryCount(retry + 1);
        setErrorMessage(`Could not reach the live itinerary. Retrying (${retry + 1}/3).`);
        if (fallbackSnapshot) {
          setItinerary(fallbackSnapshot);
          setEditedItinerary(JSON.parse(JSON.stringify(fallbackSnapshot)));
          setDataSource(ITINERARY_DATA_SOURCE.CACHE);
        }
      } else {
        const terminalFallback = fallbackSnapshot || cachedItinerary;
        if (terminalFallback) {
          logger.warn('ItineraryScreen', 'Itinerary load using terminal cache fallback', {
            tourId,
            requestId,
            dayCount: Array.isArray(terminalFallback?.days) ? terminalFallback.days.length : null,
          });
          setItinerary(terminalFallback);
          setEditedItinerary(JSON.parse(JSON.stringify(terminalFallback)));
          setDataSource(ITINERARY_DATA_SOURCE.CACHE);
          setRetryCount(0);
          setErrorMessage('Live itinerary updates are unavailable.');
        } else {
          logger.error('ItineraryScreen', 'Itinerary load failed with no cache fallback', {
            tourId,
            requestId,
          });
          setItinerary(null);
          setDataSource(ITINERARY_DATA_SOURCE.NONE);
          setErrorMessage('Could not load itinerary. Please check your connection.');
        }
      }
    } finally {
      if (!isCurrentRequest()) return;
      setLoading(false);
      setRefreshing(false);
      setCheckingForUpdates(false);
    }
  };

  cacheItineraryRef.current = cacheItinerary;
  loadItineraryRef.current = loadItinerary;

  const toggleDay = (day) => {
    if (isEditing) return;
    logger.debug('ItineraryScreen', 'Day collapse toggled', { tourId, day, nextCollapsed: !collapsedDays[day] });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsedDays((prev) => ({ ...prev, [day]: !prev[day] }));
  };

  const toggleExpandAll = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextExpandAll = !expandAll;
    logger.debug('ItineraryScreen', 'Expand all toggled', { tourId, nextExpandAll });
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
    logger.debug('ItineraryScreen', 'Search visibility toggled', { tourId, nextVisible: !showSearch });
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

  const {
    beginEditing, handleAddDay, handleCancelEdit, handleDuplicateDay, handleEditDayContent,
    handleExportToCalendar, handleKeepDraftAfterConflict, handleRemoveDay, handleSaveChanges,
    handleUseLatestItinerary,
  } = createItineraryEditActions({
    cacheItinerary, editBaseSignatureRef, editConflict, editedItinerary, itinerary, parsedTourStartDate,
    setDataSource, setEditConflict, setEditedItinerary, setIsEditing, setItinerary, setOperationMessage,
    setSaving, startDate, tourId, tourName,
  });

  // --- JUMP TO DAY ---
  const scrollToDay = (dayNumber) => {
    const position = dayPositions[dayNumber];
    if (position !== undefined && scrollViewRef.current) {
      scrollViewRef.current.scrollTo({ y: Math.max(position - 10, 0), animated: true });
    }
  };

  const handleJumpToDay = (dayNumber) => {
    if (!dayNumber) return;
    logger.debug('ItineraryScreen', 'Jump to day requested', { tourId, dayNumber });
    if (!isEditing && collapsedDays[dayNumber]) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setCollapsedDays((prev) => ({ ...prev, [dayNumber]: false }));
    }
    scrollToDay(dayNumber);
  };

  const {
    dataToRender, displayTitle, isSearchActive, renderDayRail, renderEmptyState,
    renderHeaderSummary, renderLoadingSkeleton, renderTimelineForDay, syncAccessibilityLabel,
    syncStatus, timelineItemsByDay, visibleDays,
  } = useItineraryRenderers({
    beginEditing, checkingForUpdates, dataSource, editedItinerary, errorMessage, filteredItinerary,
    formatShortDate, freshnessNow, getDayDate, handleJumpToDay, isDriver, isEditing, itinerary,
    lastSyncedAt, refreshing, searchQuery, setSearchQuery, todaysDayNumber, tourDayContext, tourName,
  });

  if (loading) {
    return <ItineraryLoadingView onBack={onBack} renderLoadingSkeleton={renderLoadingSkeleton} tourName={tourName} />;
  }

  return <ItineraryView {...{
      beginEditing, collapsedDays, dataSource, dataToRender, displayTitle, editConflict, errorMessage, expandAll,
      formatDayLabel, formatShortDate, getDayDate, handleAddDay, handleCancelEdit, handleDuplicateDay,
      handleEditDayContent, handleExportToCalendar, handleJumpToDay, handleKeepDraftAfterConflict,
      handleRemoveDay, handleSaveChanges, handleUseLatestItinerary, hasUnsupportedStartDate, isDriver, isEditing,
      isSearchActive, itinerary, loadItinerary, onBack, operationMessage, refreshing, renderDayRail,
      renderEmptyState, renderHeaderSummary, renderTimelineForDay, retryCount, saving, scrollViewRef,
      searchAnimation, searchQuery, setDayPositions, setOperationMessage, setSearchQuery, showSearch,
      syncAccessibilityLabel, syncStatus, timelineItemsByDay, todaysDayNumber, toggleDay, toggleExpandAll,
      toggleSearch, visibleDays,
  }} />;
}
