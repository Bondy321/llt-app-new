import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet, Text, View, SectionList, FlatList, TextInput,
  TouchableOpacity, ActivityIndicator, Modal, Alert
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getTourManifest, updateManifestBooking, MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import offlineSyncService from '../services/offlineSyncService';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import ManifestBookingCard from '../components/ManifestBookingCard';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
const { getBookingSyncState, normalizeSyncState } = require('../utils/manifestSyncState');
const { pickupTimeToMinutes } = require('../services/pickupTimeParser');

const COLORS = {
  primary: THEME.primary,
  primaryDark: THEME.primaryDark,
  primaryMuted: THEME.primaryMuted,
  bg: THEME.background,
  surface: THEME.surface,
  border: THEME.border,
  searchBg: THEME.white,
  success: THEME.success,
  successSoft: THEME.successLight,
  danger: THEME.error,
  dangerSoft: THEME.errorLight,
  info: THEME.primaryLight,
  warning: THEME.warning,
  warningSoft: THEME.warningLight,
  muted: THEME.textSecondary,
  panel: THEME.textPrimary,
  chipBg: THEME.surfaceSecondary || '#F1F5F9',
  chipActiveBg: THEME.primary,
  chipText: THEME.textSecondary,
  chipActiveText: THEME.white,
  textLight: THEME.textInverse,
};

const VIEW_MODE = {
  PRIORITY: 'PRIORITY',
  LOCATION: 'LOCATION',
  SEARCH: 'SEARCH'
};

const STATUS_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: MANIFEST_STATUS.PENDING, label: 'Pending' },
  { key: MANIFEST_STATUS.PARTIAL, label: 'Partial' },
  { key: MANIFEST_STATUS.BOARDED, label: 'Boarded' },
  { key: MANIFEST_STATUS.NO_SHOW, label: 'No-show' }
];

export default function PassengerManifestScreen({ route, navigation }) {
  const { tourId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [manifestData, setManifestData] = useState({ bookings: [], stats: {} });
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState(VIEW_MODE.PRIORITY);
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Modal State
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [partialMode, setPartialMode] = useState(false);
  const [partialStatuses, setPartialStatuses] = useState([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [queueStats, setQueueStats] = useState({ pending: 0, syncing: 0, failed: 0, total: 0 });
  const [bookingSyncState, setBookingSyncState] = useState({});
  const [conflictNote, setConflictNote] = useState('');
  const [statusFeedback, setStatusFeedback] = useState(null);
  const feedbackTimeoutRef = useRef(null);

  const clearFeedbackTimeout = () => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  };

  const showStatusFeedback = (feedback) => {
    clearFeedbackTimeout();
    setStatusFeedback(feedback);

    if (feedback?.autoDismissMs) {
      feedbackTimeoutRef.current = setTimeout(() => {
        setStatusFeedback((current) => (current === feedback ? null : current));
        feedbackTimeoutRef.current = null;
      }, feedback.autoDismissMs);
    }
  };

  const loadManifest = async () => {
    try {
      const data = await getTourManifest(tourId);
      setManifestData(data);
      return data;
    } catch (error) {
      Alert.alert('Error', 'Failed to load manifest: ' + error.message);
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await handleSyncNow({ isManualRefresh: true });
  };

  useEffect(() => {
    loadManifest();
  }, [tourId]);

  useEffect(() => {
    const unsubscribe = offlineSyncService.subscribeQueueState((stats) => setQueueStats(stats));
    return () => unsubscribe?.();
  }, []);

  useEffect(() => () => clearFeedbackTimeout(), []);

  useEffect(() => {
    const map = {};
    offlineSyncService.getQueuedActions().then((res) => {
      if (!res.success) return;
      res.data.forEach((action) => {
        if (action.type !== 'MANIFEST_UPDATE') return;
        const bookingRef = action.payload?.bookingRef;
        if (!bookingRef) return;
        map[bookingRef] = normalizeSyncState(action.status);
      });
      setBookingSyncState(map);
    });
  }, [manifestData.bookings.length, queueStats.pending, queueStats.failed, queueStats.syncing]);

  const computeStats = (bookings = []) => bookings.reduce((acc, booking) => {
    const paxCount = booking.passengerNames?.length || 0;
    acc.totalBookings += 1;
    acc.totalPax += paxCount;

    if (booking.hasPassengerStatuses && Array.isArray(booking.passengerStatus) && booking.passengerStatus.length > 0) {
      booking.passengerStatus.forEach((status) => {
        if (status === MANIFEST_STATUS.BOARDED) acc.checkedIn += 1;
        if (status === MANIFEST_STATUS.NO_SHOW) acc.noShows += 1;
      });
    } else {
      if (booking.status === MANIFEST_STATUS.BOARDED) acc.checkedIn += paxCount;
      if (booking.status === MANIFEST_STATUS.NO_SHOW) acc.noShows += paxCount;
    }

    return acc;
  }, { totalBookings: 0, totalPax: 0, checkedIn: 0, noShows: 0 });

  const getUnresolvedBookingCount = (bookings = []) => bookings
    .filter((booking) => priorityRank(booking.status) === 0)
    .length;

  const toPickupTimeSortValue = (pickupTime) => pickupTimeToMinutes(pickupTime);

  const priorityRank = (status) => {
    if (status === MANIFEST_STATUS.PENDING || status === MANIFEST_STATUS.PARTIAL) return 0;
    if (status === MANIFEST_STATUS.BOARDED) return 1;
    return 2;
  };

  const matchesSearch = (booking, query) => {
    if (!query) return true;
    const queryValue = query.toLowerCase();
    const names = (booking.passengerNames || []).join(' ').toLowerCase();
    const location = String(booking.pickupLocation || '').toLowerCase();
    return booking.id.toLowerCase().includes(queryValue)
      || names.includes(queryValue)
      || location.includes(queryValue);
  };

  const filteredBookings = useMemo(() => {
    const query = searchQuery.trim();
    return manifestData.bookings.filter((booking) => {
      const statusPass = statusFilter === 'ALL' || booking.status === statusFilter;
      return statusPass && matchesSearch(booking, query);
    });
  }, [manifestData.bookings, searchQuery, statusFilter]);

  const sortedFilteredBookings = useMemo(() => [...filteredBookings].sort((a, b) => {
    const priorityDelta = priorityRank(a.status) - priorityRank(b.status);
    if (priorityDelta !== 0) return priorityDelta;

    const pickupDelta = toPickupTimeSortValue(a.pickupTime) - toPickupTimeSortValue(b.pickupTime);
    if (pickupDelta !== 0) return pickupDelta;

    return a.id.localeCompare(b.id);
  }), [filteredBookings]);

  const sectionedPriorityBookings = useMemo(() => {
    const groups = {};
    sortedFilteredBookings.forEach((booking) => {
      const unresolved = priorityRank(booking.status) === 0;
      const bucket = unresolved ? 'Unresolved' : 'Resolved';
      const pickupLabel = booking.pickupTime || 'TBA';
      const key = `${bucket}__${pickupLabel}`;
      if (!groups[key]) {
        groups[key] = { title: `${bucket} • ${pickupLabel}`, data: [], unresolved, pickupLabel };
      }
      groups[key].data.push(booking);
    });

    return Object.values(groups).sort((a, b) => {
      if (a.unresolved !== b.unresolved) return a.unresolved ? -1 : 1;
      return toPickupTimeSortValue(a.pickupLabel) - toPickupTimeSortValue(b.pickupLabel);
    });
  }, [sortedFilteredBookings]);

  const sectionedLocationBookings = useMemo(() => {
    const groups = {};
    filteredBookings.forEach((booking) => {
      const location = booking.pickupLocation || 'Unknown Location';
      if (!groups[location]) groups[location] = [];
      groups[location].push(booking);
    });

    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, data]) => ({
        title,
        data: data.sort((a, b) => {
          const priorityDelta = priorityRank(a.status) - priorityRank(b.status);
          if (priorityDelta !== 0) return priorityDelta;
          return toPickupTimeSortValue(a.pickupTime) - toPickupTimeSortValue(b.pickupTime);
        })
      }));
  }, [filteredBookings]);

  const totalStats = useMemo(() => computeStats(manifestData.bookings), [manifestData.bookings]);
  const filteredStats = useMemo(() => computeStats(filteredBookings), [filteredBookings]);
  const resolutionStats = useMemo(() => {
    const resolved = Math.max(filteredStats.checkedIn + filteredStats.noShows, 0);
    const total = Math.max(filteredStats.totalPax, 0);
    const unresolved = Math.max(total - resolved, 0);
    const completionPercent = total === 0 ? 0 : Math.round((resolved / total) * 100);

    return { resolved, unresolved, total, completionPercent };
  }, [filteredStats]);
  const nextPriorityBooking = useMemo(
    () => sortedFilteredBookings.find((booking) => priorityRank(booking.status) === 0) || null,
    [sortedFilteredBookings]
  );

  const isSearchView = viewMode === VIEW_MODE.SEARCH;
  const sectionListData = viewMode === VIEW_MODE.LOCATION ? sectionedLocationBookings : sectionedPriorityBookings;

  // --- Actions ---
  const handleOpenBooking = (booking) => {
    setSelectedBooking(booking);
    const existingStatuses = Array.isArray(booking.passengerStatus) ? booking.passengerStatus : [];
    const normalized = booking.passengerNames.map((_, idx) => existingStatuses[idx] || MANIFEST_STATUS.PENDING);
    setPartialStatuses(normalized);
    setPartialMode(false);
    setModalVisible(true);
  };

  const submitUpdate = async (passengerStatuses) => {
    if (!selectedBooking) return;

    try {
      setActionLoading(true);
      const beforeStats = computeStats(manifestData.bookings);
      const beforeUnresolved = getUnresolvedBookingCount(manifestData.bookings);
      const statusesToPersist = passengerStatuses && passengerStatuses.length > 0
        ? passengerStatuses
        : selectedBooking.passengerNames.map(() => MANIFEST_STATUS.PENDING);

      const result = await updateManifestBooking(tourId, selectedBooking.id, statusesToPersist, { online: true });
      if (result?.conflictMessage) {
        setConflictNote(result.conflictMessage);
      }
      if (result?.queued) {
        setBookingSyncState((prev) => ({ ...prev, [selectedBooking.id]: normalizeSyncState('queued') }));
      } else {
        setBookingSyncState((prev) => ({ ...prev, [selectedBooking.id]: normalizeSyncState('synced') }));
      }

      const syncStateLabel = result?.queued ? 'queued for sync' : 'synced';
      setModalVisible(false);
      setSelectedBooking(null);
      setPartialMode(false);

      const refreshedManifest = await loadManifest();
      if (refreshedManifest) {
        const afterStats = computeStats(refreshedManifest.bookings || []);
        const unresolvedCount = getUnresolvedBookingCount(refreshedManifest.bookings || []);
        const boardedDelta = Math.max(0, afterStats.checkedIn - beforeStats.checkedIn);
        const noShowDelta = Math.max(0, afterStats.noShows - beforeStats.noShows);
        const unresolvedDelta = beforeUnresolved - unresolvedCount;
        const nextBooking = (refreshedManifest.bookings || []).find((booking) => priorityRank(booking.status) === 0) || null;

        const parts = [];
        if (boardedDelta > 0) parts.push(`${boardedDelta} passenger${boardedDelta === 1 ? '' : 's'} boarded`);
        if (noShowDelta > 0) parts.push(`${noShowDelta} marked no-show`);
        if (parts.length === 0) parts.push('Status updated');

        const unresolvedSummary = unresolvedCount === 0
          ? 'All bookings resolved.'
          : `${unresolvedCount} unresolved booking${unresolvedCount === 1 ? '' : 's'} remaining.`;

        showStatusFeedback({
          variant: 'success',
          message: `${parts.join(' • ')}. ${unresolvedSummary} (${syncStateLabel})`,
          nextBooking,
          unresolvedDelta,
          syncStateLabel,
          autoDismissMs: 4000,
        });
      }
    } catch (error) {
      showStatusFeedback({
        variant: 'error',
        message: 'Save failed. Retry now.',
        ctaLabel: 'Retry now',
        onCtaPress: () => submitUpdate(passengerStatuses),
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetAll = (status) => {
    if (!selectedBooking) return;
    const statuses = selectedBooking.passengerNames.map(() => status);
    submitUpdate(statuses);
  };

  const handleConfirmPartial = () => submitUpdate(partialStatuses);

  const updatePassengerStatus = (index, status) => {
    setPartialStatuses((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  };


  const handleSyncNow = async ({ isManualRefresh = false } = {}) => {
    if (!isManualRefresh) {
      setRefreshing(true);
    }

    try {
      const replay = await offlineSyncService.replayQueue({ services: { bookingService, chatService } });
      if (!replay.success) {
        showStatusFeedback({
          variant: 'error',
          message: replay.error ? `Sync failed: ${replay.error}` : 'Sync failed. Retry now.',
          ctaLabel: 'Retry now',
          onCtaPress: () => handleSyncNow(),
        });
        await loadManifest();
        return;
      }

      const queued = await offlineSyncService.getQueuedActions();
      if (queued.success) {
        const pendingActions = queued.data.filter((action) => action.status === 'queued').length;
        const failedActions = queued.data.filter((action) => action.status === 'failed').length;

        if (failedActions > 0) {
          showStatusFeedback({
            variant: 'warning',
            message: `${failedActions} failed action${failedActions === 1 ? '' : 's'}.`,
            ctaLabel: 'Retry failed',
            onCtaPress: handleRetryFailed,
          });
        } else if (pendingActions > 0) {
          showStatusFeedback({
            variant: 'warning',
            message: `${pendingActions} action${pendingActions === 1 ? '' : 's'} still queued.`,
            ctaLabel: 'View pending',
            onCtaPress: () => setStatusFilter(MANIFEST_STATUS.PENDING),
            autoDismissMs: 5000,
          });
        } else {
          showStatusFeedback({
            variant: 'success',
            message: 'Sync complete. All clear.',
            autoDismissMs: 3500,
          });
        }
      }

      await loadManifest();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRetryFailed = async () => {
    await offlineSyncService.retryFailedActions({ types: ['MANIFEST_UPDATE'] });
    await handleSyncNow();
  };

  // --- Render Functions ---
  const renderHeader = () => (
    <View style={styles.header}>
      {/* Back Button (Added from Phase 4 fix) */}
      <TouchableOpacity
        onPress={() => navigation.goBack()} 
        style={styles.backButton}
      >
        <MaterialCommunityIcons name="arrow-left" size={24} color={COLORS.textLight} />
        <Text style={styles.backText}>Console</Text>
      </TouchableOpacity>

      <Text style={styles.headerTitle}>Passenger Manifest</Text>
      <Text style={styles.headerSubtitle}>Live boarding control for tour {tourId}</Text>

      <View style={styles.dashboardContainer}>
        <View style={styles.dashboardItem}>
          <Text style={styles.dashLabel}>EXPECTED</Text>
          <Text style={styles.dashValue}>{filteredStats.totalPax}</Text>
          <Text style={styles.dashSubValue}>of {totalStats.totalPax}</Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.successTint]}>BOARDED</Text>
          <Text style={[styles.dashValue, { color: COLORS.success }]}>
            {filteredStats.checkedIn}
          </Text>
          <Text style={styles.dashSubValue}>of {totalStats.checkedIn}</Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.dangerTint]}>NO SHOW</Text>
          <Text style={[styles.dashValue, { color: COLORS.danger }]}>
            {filteredStats.noShows}
          </Text>
          <Text style={styles.dashSubValue}>of {totalStats.noShows}</Text>
        </View>
      </View>

      <View style={styles.progressShell}>
        <View style={styles.progressHeader}>
          <Text style={styles.progressTitle}>Boarding completion</Text>
          <Text style={styles.progressValue}>{resolutionStats.completionPercent}%</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${resolutionStats.completionPercent}%` }]} />
        </View>
        <Text style={styles.progressMeta}>
          {resolutionStats.resolved} resolved • {resolutionStats.unresolved} unresolved
        </Text>
      </View>

      <View style={styles.syncRow}>
        <View style={styles.syncStatusPill}>
          <MaterialCommunityIcons name="cloud-sync-outline" size={14} color={COLORS.primaryDark} />
          <Text style={styles.syncStatusText}>
            {queueStats.pending} pending · {queueStats.failed} failed
          </Text>
        </View>
        <TouchableOpacity onPress={() => handleSyncNow()} style={styles.syncBtn} disabled={refreshing}>
          <Text style={styles.syncBtnText}>{refreshing ? 'Syncing…' : 'Sync now'}</Text>
        </TouchableOpacity>
      </View>
      {conflictNote ? <Text style={styles.conflictText}>{conflictNote}</Text> : null}

      {nextPriorityBooking && (
        <TouchableOpacity
          style={styles.nextActionCard}
          onPress={() => handleOpenBooking(nextPriorityBooking)}
          activeOpacity={0.9}
        >
          <View style={styles.nextActionMeta}>
            <Text style={styles.nextActionEyebrow}>NEXT ACTION</Text>
            <Text style={styles.nextActionTitle}>{nextPriorityBooking.id}</Text>
            <Text style={styles.nextActionDetail} numberOfLines={1}>
              {(nextPriorityBooking.pickupTime || 'TBA')} • {nextPriorityBooking.pickupLocation || 'Unknown pickup'}
            </Text>
          </View>
          <View style={styles.nextActionButton}>
            <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.white} />
          </View>
        </TouchableOpacity>
      )}

      {/* Search Bar (Existing) */}
      <View style={styles.searchContainer}>
        <MaterialCommunityIcons name="magnify" size={20} color={COLORS.muted} />
        <TextInput 
          style={styles.searchInput}
          placeholder="Search booking, passenger, or pickup..."
          placeholderTextColor={THEME.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="characters"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <MaterialCommunityIcons name="close-circle" size={20} color={COLORS.muted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.segmentedControl}>
        {Object.values(VIEW_MODE).map((mode) => (
          <TouchableOpacity
            key={mode}
            style={[styles.segmentBtn, viewMode === mode && styles.segmentBtnActive]}
            onPress={() => setViewMode(mode)}
          >
            <Text style={[styles.segmentBtnText, viewMode === mode && styles.segmentBtnTextActive]}>
              {mode === VIEW_MODE.PRIORITY ? 'Priority' : mode === VIEW_MODE.LOCATION ? 'Location' : 'Search'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        horizontal
        data={STATUS_FILTERS}
        keyExtractor={(item) => item.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterChipRow}
        renderItem={({ item }) => {
          const isActive = statusFilter === item.key;
          return (
            <TouchableOpacity
              style={[styles.filterChip, isActive && styles.filterChipActive]}
              onPress={() => setStatusFilter(item.key)}
            >
              <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        }}
      />

      {statusFeedback && (
        <View style={[styles.statusBanner, styles[`statusBanner_${statusFeedback.variant || 'success'}`]]}>
          <View style={styles.statusBannerTextWrap}>
            <Text style={[styles.statusBannerText, styles[`statusBannerText_${statusFeedback.variant || 'success'}`]]}>
              {statusFeedback.message}
            </Text>
          </View>
          {statusFeedback.nextBooking && (
            <TouchableOpacity
              style={[styles.statusBannerBtn, styles[`statusBannerBtn_${statusFeedback.variant || 'success'}`]]}
              onPress={() => {
                handleOpenBooking(statusFeedback.nextBooking);
                showStatusFeedback(null);
              }}
            >
              <Text style={styles.statusBannerBtnText}>Open next</Text>
            </TouchableOpacity>
          )}
          {statusFeedback.ctaLabel && statusFeedback.onCtaPress && (
            <TouchableOpacity
              style={[styles.statusBannerBtn, styles[`statusBannerBtn_${statusFeedback.variant || 'success'}`]]}
              onPress={statusFeedback.onCtaPress}
            >
              <Text style={styles.statusBannerBtnText}>{statusFeedback.ctaLabel}</Text>
            </TouchableOpacity>
          )}
          {!statusFeedback.autoDismissMs && (
            <TouchableOpacity onPress={() => showStatusFeedback(null)} style={styles.statusBannerDismiss}>
              <MaterialCommunityIcons name="close" size={16} color={COLORS.info} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {renderHeader()}

      {loading && !refreshing ? (
        <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 20 }} />
      ) : (
        sortedFilteredBookings.length === 0 ? (
          <View style={styles.emptyStateCard}>
            <MaterialCommunityIcons name="clipboard-search-outline" size={34} color={COLORS.primary} />
            <Text style={styles.emptyStateTitle}>No matching bookings</Text>
            <Text style={styles.emptyStateBody}>
              Adjust search or filters to find passengers, then update statuses.
            </Text>
          </View>
        ) : isSearchView ? (
          <FlatList
            data={sortedFilteredBookings}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ManifestBookingCard 
                booking={item} 
                onPress={() => handleOpenBooking(item)} 
                isSearchResult={true} 
                syncState={getBookingSyncState(bookingSyncState, item.id) || 'synced'}
              />
            )}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        ) : (
          <SectionList
            sections={sectionListData}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ManifestBookingCard 
                booking={item} 
                onPress={() => handleOpenBooking(item)} 
                isSearchResult={false} 
                syncState={getBookingSyncState(bookingSyncState, item.id) || 'synced'}
              />
            )}
            renderSectionHeader={({ section: { title } }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{title}</Text>
              </View>
            )}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        )
      )}

      {/* --- CHECK IN MODAL --- */}
      <Modal
        visible={modalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedBooking && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{selectedBooking.passengerNames[0]}</Text>
                  <Text style={styles.modalSubtitle}>Ref: {selectedBooking.id} • {selectedBooking.passengerNames.length} Pax</Text>
                </View>

                {partialMode ? (
                  <>
                    <Text style={styles.modalSectionLabel}>Select Passengers</Text>
                    <View style={styles.passengerList}>
                      {selectedBooking.passengerNames.map((name, idx) => {
                        const status = partialStatuses[idx] || MANIFEST_STATUS.PENDING;
                        return (
                          <View key={`${selectedBooking.id}-${idx}`} style={styles.passengerRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.passengerName}>{name}</Text>
                              <Text style={styles.passengerSeat}>Passenger {idx + 1}</Text>
                            </View>
                            <View style={styles.passengerActions}>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.BOARDED && styles.statusPillActiveSuccess]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.BOARDED)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.BOARDED && styles.statusPillTextActive]}>Boarded</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillActiveDanger]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.NO_SHOW)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillTextActive]}>No Show</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.PENDING && styles.statusPillActivePending]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.PENDING)}
                                disabled={actionLoading}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.PENDING && styles.statusPillTextActive]}>Pending</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })}
                    </View>

                    <View style={styles.partialFooter}>
                      <TouchableOpacity
                        style={[styles.partialFooterBtn, styles.partialFooterCancel]}
                        onPress={() => setPartialMode(false)}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.partialFooterText, { color: COLORS.info }]}>Back</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.partialFooterBtn, styles.partialFooterConfirm]}
                        onPress={handleConfirmPartial}
                        disabled={actionLoading}
                      >
                        <Text style={[styles.partialFooterText, { color: 'white' }]}>Confirm</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.modalSectionLabel}>Actions</Text>

                    <View style={styles.actionRow}>
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.success }]}
                        onPress={() => handleSetAll(MANIFEST_STATUS.BOARDED)}
                        disabled={actionLoading}
                      >
                        <MaterialCommunityIcons name="check-all" size={28} color="white" />
                        <Text style={styles.actionBtnText}>All Here</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.danger }]}
                        onPress={() => handleSetAll(MANIFEST_STATUS.NO_SHOW)}
                        disabled={actionLoading}
                      >
                        <MaterialCommunityIcons name="close-circle-outline" size={28} color="white" />
                        <Text style={styles.actionBtnText}>No Show</Text>
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity
                      style={[styles.secondaryActionBtn, { borderColor: COLORS.info }]}
                      onPress={() => setPartialMode(true)}
                      disabled={actionLoading}
                    >
                        <Text style={{ color: COLORS.info, fontWeight: 'bold' }}>Some Here (Select Individuals)</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.closeBtn}
                      onPress={() => setModalVisible(false)}
                      disabled={actionLoading}
                    >
                      <Text style={styles.closeBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.primaryDark,
    paddingHorizontal: SPACING.lg,
    paddingTop: 12,
    paddingBottom: SPACING.xl,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  backText: { color: COLORS.textLight, fontSize: 16, fontWeight: FONT_WEIGHT.bold, marginLeft: 5 },
  headerTitle: {
    color: COLORS.textLight,
    fontWeight: FONT_WEIGHT.extrabold,
    fontSize: 26,
  },
  headerSubtitle: {
    color: '#C7D2FE',
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
    fontSize: 13,
    fontWeight: FONT_WEIGHT.medium,
  },

  dashboardContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.35)',
  },
  nextActionCard: {
    marginBottom: SPACING.md,
    backgroundColor: COLORS.searchBg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...SHADOWS.sm,
  },
  nextActionMeta: {
    flex: 1,
    paddingRight: 10,
  },
  nextActionEyebrow: {
    fontSize: 11,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.info,
    marginBottom: 2,
  },
  nextActionTitle: {
    fontSize: 17,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.primaryDark,
  },
  nextActionDetail: {
    marginTop: 2,
    fontSize: 13,
    color: COLORS.muted,
  },
  nextActionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.info,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dashboardItem: {
    flex: 1,
    alignItems: 'center',
  },
  dashDivider: {
    width: 1,
    height: '70%',
    backgroundColor: 'rgba(203, 213, 225, 0.35)',
  },
  dashLabel: {
    fontSize: 11,
    fontWeight: FONT_WEIGHT.bold,
    color: '#D1D5DB',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  dashValue: {
    fontSize: 26,
    fontWeight: FONT_WEIGHT.extrabold,
    color: COLORS.textLight,
  },
  dashSubValue: {
    marginTop: 2,
    fontSize: 11,
    color: '#E2E8F0',
    fontWeight: FONT_WEIGHT.semibold,
  },
  successTint: { color: '#BBF7D0' },
  dangerTint: { color: '#FECACA' },
  progressShell: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(191, 219, 254, 0.45)',
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  progressTitle: {
    color: COLORS.textLight,
    fontWeight: FONT_WEIGHT.semibold,
    fontSize: 13,
  },
  progressValue: {
    color: COLORS.textLight,
    fontWeight: FONT_WEIGHT.bold,
    fontSize: 13,
  },
  progressTrack: {
    height: 8,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: RADIUS.full,
    backgroundColor: '#BFDBFE',
  },
  progressMeta: {
    marginTop: SPACING.sm,
    color: '#DBEAFE',
    fontSize: 12,
    fontWeight: FONT_WEIGHT.medium,
  },

  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    borderRadius: RADIUS.md,
    padding: 4,
    marginTop: 12,
    marginBottom: SPACING.xs,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.35)',
  },
  segmentBtnText: {
    color: '#E2E8F0',
    fontWeight: FONT_WEIGHT.bold,
    fontSize: 12,
  },
  segmentBtnTextActive: {
    color: COLORS.textLight,
  },
  filterChipRow: {
    gap: 8,
    marginTop: 12,
    paddingBottom: 4,
  },
  filterChip: {
    backgroundColor: COLORS.chipBg,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterChipActive: {
    backgroundColor: COLORS.chipActiveBg,
    borderColor: COLORS.chipActiveBg,
  },
  filterChipText: {
    color: COLORS.chipText,
    fontWeight: '700',
    fontSize: 12,
  },
  filterChipTextActive: {
    color: COLORS.chipActiveText,
  },
  statusBanner: {
    marginTop: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  statusBanner_success: {
    borderColor: COLORS.success,
    backgroundColor: COLORS.successSoft,
  },
  statusBanner_warning: {
    borderColor: COLORS.warning,
    backgroundColor: COLORS.warningSoft,
  },
  statusBanner_error: {
    borderColor: COLORS.danger,
    backgroundColor: COLORS.dangerSoft,
  },
  statusBannerTextWrap: {
    flex: 1,
  },
  statusBannerText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusBannerText_success: {
    color: COLORS.success,
  },
  statusBannerText_warning: {
    color: COLORS.warning,
  },
  statusBannerText_error: {
    color: COLORS.danger,
  },
  statusBannerBtn: {
    borderRadius: 999,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  statusBannerBtn_success: {
    backgroundColor: COLORS.success,
  },
  statusBannerBtn_warning: {
    backgroundColor: COLORS.warning,
  },
  statusBannerBtn_error: {
    backgroundColor: COLORS.danger,
  },
  statusBannerBtnText: {
    color: COLORS.chipActiveText,
    fontSize: 11,
    fontWeight: '700',
  },
  statusBannerDismiss: {
    padding: 2,
  },

  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  syncStatusPill: {
    flex: 1,
    backgroundColor: COLORS.primaryMuted,
    borderColor: '#93C5FD',
    borderWidth: 1,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  syncStatusText: {
    color: COLORS.primaryDark,
    fontWeight: FONT_WEIGHT.semibold,
    fontSize: 12,
  },
  syncBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.info,
  },
  syncBtnText: { color: COLORS.textLight, fontWeight: FONT_WEIGHT.bold, fontSize: 12 },
  conflictText: { color: '#FDE68A', marginBottom: 8, fontSize: 12, fontWeight: FONT_WEIGHT.semibold },
  searchContainer: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.sm,
  },
  searchInput: {
    flex: 1,
    marginLeft: SPACING.sm,
    fontSize: 15,
    color: COLORS.primaryDark,
    fontWeight: FONT_WEIGHT.medium,
  },
  
  listContent: { padding: SPACING.lg, paddingBottom: SPACING.xxxl },
  emptyStateCard: {
    margin: SPACING.lg,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    padding: SPACING.xl,
    alignItems: 'center',
    ...SHADOWS.md,
  },
  emptyStateTitle: {
    marginTop: SPACING.sm,
    fontSize: 17,
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.primaryDark,
  },
  emptyStateBody: {
    marginTop: SPACING.xs,
    fontSize: 13,
    color: COLORS.muted,
    textAlign: 'center',
    lineHeight: 18,
  },
  sectionHeader: {
    backgroundColor: '#EEF2FF',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.sm,
    marginBottom: SPACING.sm,
    marginTop: SPACING.xs,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  sectionTitle: {
    fontWeight: FONT_WEIGHT.bold,
    color: COLORS.primaryDark,
    fontSize: 13,
  },

  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    minHeight: 350,
  },
  modalHeader: { marginBottom: 20, borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 15 },
  modalTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.primary },
  modalSubtitle: { fontSize: 16, color: COLORS.muted, marginTop: 5 },
  
  modalSectionLabel: { fontSize: 14, fontWeight: 'bold', color: COLORS.muted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 15, marginBottom: 15 },
  actionBtn: {
    flex: 1,
    paddingVertical: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: { color: 'white', fontSize: 16, fontWeight: 'bold', marginTop: 5 },
  
  secondaryActionBtn: {
    padding: 15,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    marginBottom: 20,
    borderStyle: 'dashed'
  },
  closeBtn: { padding: 15, alignItems: 'center' },
  closeBtnText: { color: COLORS.muted, fontWeight: 'bold', fontSize: 16 },

  passengerList: { gap: 10, marginBottom: 15 },
  passengerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  passengerName: { fontWeight: 'bold', color: COLORS.primary },
  passengerSeat: { color: COLORS.muted, marginTop: 4 },
  passengerActions: { flexDirection: 'row', gap: 8 },
  statusPill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'white'
  },
  statusPillText: { fontSize: 12, fontWeight: '600', color: COLORS.primary },
  statusPillActiveSuccess: { backgroundColor: '#ECFDF3', borderColor: '#BBF7D0' },
  statusPillActiveDanger: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  statusPillActivePending: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  statusPillTextActive: { color: COLORS.primary },
  partialFooter: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  partialFooterBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    alignItems: 'center'
  },
  partialFooterCancel: {
    borderWidth: 1,
    borderColor: COLORS.info,
    backgroundColor: 'white'
  },
  partialFooterConfirm: {
    backgroundColor: COLORS.info
  },
  partialFooterText: { fontWeight: 'bold' }
});
