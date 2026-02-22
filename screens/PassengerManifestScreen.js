import React, { useState, useEffect, useMemo } from 'react';
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
import { COLORS as THEME, SPACING } from '../theme';
const { getBookingSyncState, normalizeSyncState } = require('../utils/manifestSyncState');

const COLORS = {
  primary: THEME.primary,
  bg: THEME.background,
  border: THEME.border,
  searchBg: THEME.white,
  success: THEME.success,
  danger: THEME.error,
  info: THEME.primaryLight,
  muted: THEME.textSecondary,
  panel: THEME.textPrimary,
  chipBg: THEME.surfaceSecondary,
  chipActiveBg: THEME.primary,
  chipText: THEME.textSecondary,
  chipActiveText: THEME.white,
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

  useEffect(() => {
    loadManifest();
  }, [tourId]);

  useEffect(() => {
    const unsubscribe = offlineSyncService.subscribeQueueState((stats) => setQueueStats(stats));
    return () => unsubscribe?.();
  }, []);

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

  const toPickupTimeSortValue = (pickupTime) => {
    const rawValue = String(pickupTime || '').trim();
    if (!rawValue || rawValue.toUpperCase() === 'TBA') return Number.MAX_SAFE_INTEGER;

    const hhmmMatch = rawValue.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmmMatch) {
      const hours = Number(hhmmMatch[1]);
      const minutes = Number(hhmmMatch[2]);
      if (hours <= 23 && minutes <= 59) return (hours * 60) + minutes;
    }

    const ampmMatch = rawValue.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      let hours = Number(ampmMatch[1]);
      const minutes = Number(ampmMatch[2]);
      const period = ampmMatch[3].toUpperCase();
      if (hours >= 1 && hours <= 12 && minutes <= 59) {
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        return (hours * 60) + minutes;
      }
    }

    return Number.MAX_SAFE_INTEGER;
  };

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

        setStatusFeedback({
          message: `${parts.join(' • ')}. ${unresolvedSummary} (${syncStateLabel})`,
          nextBooking,
          unresolvedDelta,
          syncStateLabel,
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to update manifest: ' + error.message);
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


  const handleSyncNow = async () => {
    const replay = await offlineSyncService.replayQueue({ services: { bookingService, chatService } });
    if (!replay.success) {
      Alert.alert('Sync issue', replay.error || 'Could not sync now.');
    }
    await loadManifest();
  };

  const handleRetryFailed = async () => {
    const queued = await offlineSyncService.getQueuedActions();
    if (!queued.success) return;
    await Promise.all(
      queued.data
        .filter((action) => action.type === 'MANIFEST_UPDATE' && action.status === 'failed')
        .map((action) => offlineSyncService.updateAction(action.id, { status: 'queued', nextAttemptAt: null }))
    );
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
        <MaterialCommunityIcons name="arrow-left" size={24} color="white" />
        <Text style={styles.backText}>Console</Text>
      </TouchableOpacity>

      {/* --- NEW: DASHBOARD METRICS --- */}
      <View style={styles.dashboardContainer}>
        
        {/* Total Expected */}
        <View style={styles.dashboardItem}>
          <Text style={styles.dashLabel}>TOTAL</Text>
          <Text style={styles.dashValue}>{filteredStats.totalPax}</Text>
          <Text style={styles.dashSubValue}>of {totalStats.totalPax}</Text>
        </View>

        {/* Vertical Divider */}
        <View style={styles.dashDivider} />

        {/* Boarded (Green) */}
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, { color: '#ABEBC6' }]}>BOARDED</Text>
          <Text style={[styles.dashValue, { color: COLORS.success }]}>
            {filteredStats.checkedIn}
          </Text>
          <Text style={styles.dashSubValue}>of {totalStats.checkedIn}</Text>
        </View>

        {/* Vertical Divider */}
        <View style={styles.dashDivider} />

        {/* No Shows (Red) */}
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, { color: '#F1948A' }]}>NO SHOW</Text>
          <Text style={[styles.dashValue, { color: COLORS.danger }]}>
            {filteredStats.noShows}
          </Text>
          <Text style={styles.dashSubValue}>of {totalStats.noShows}</Text>
        </View>

      </View>

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
        <MaterialCommunityIcons name="magnify" size={24} color="#BDC3C7" />
        <TextInput 
          style={styles.searchInput}
          placeholder="Search booking, passenger, or pickup..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="characters"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <MaterialCommunityIcons name="close-circle" size={20} color="#BDC3C7" />
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
        <View style={styles.statusBanner}>
          <View style={styles.statusBannerTextWrap}>
            <Text style={styles.statusBannerText}>{statusFeedback.message}</Text>
          </View>
          {statusFeedback.nextBooking && (
            <TouchableOpacity
              style={styles.statusBannerBtn}
              onPress={() => {
                handleOpenBooking(statusFeedback.nextBooking);
                setStatusFeedback(null);
              }}
            >
              <Text style={styles.statusBannerBtnText}>Open next</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setStatusFeedback(null)} style={styles.statusBannerDismiss}>
            <MaterialCommunityIcons name="close" size={16} color={COLORS.info} />
          </TouchableOpacity>
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
        isSearchView ? (
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
            onRefresh={loadManifest}
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
            onRefresh={loadManifest}
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
    backgroundColor: COLORS.panel,
    padding: 16,
    paddingTop: 12,
    paddingBottom: 22,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.lg,
    marginBottom: 15
  },
  backText: { color: 'white', fontSize: 16, fontWeight: 'bold', marginLeft: 5 },

  dashboardContainer: {
    flexDirection: 'row',
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 14,
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 3,
  },
  nextActionCard: {
    marginBottom: 14,
    backgroundColor: COLORS.searchBg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nextActionMeta: {
    flex: 1,
    paddingRight: 10,
  },
  nextActionEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.info,
    marginBottom: 2,
  },
  nextActionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.panel,
  },
  nextActionDetail: {
    marginTop: 2,
    fontSize: 13,
    color: COLORS.muted,
  },
  nextActionButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
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
    backgroundColor: '#1F2937',
  },
  dashLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#CBD5E1',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  dashValue: {
    fontSize: 26,
    fontWeight: 'bold',
    color: 'white',
  },
  dashSubValue: {
    marginTop: 2,
    fontSize: 11,
    color: '#CBD5E1',
    fontWeight: '600'
  },

  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#1F2937',
    borderRadius: 10,
    padding: 4,
    marginTop: 12,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: '#374151',
  },
  segmentBtnText: {
    color: '#D1D5DB',
    fontWeight: '700',
    fontSize: 12,
  },
  segmentBtnTextActive: {
    color: 'white',
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
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBannerTextWrap: {
    flex: 1,
  },
  statusBannerText: {
    color: '#1E3A8A',
    fontSize: 12,
    fontWeight: '700',
  },
  statusBannerBtn: {
    backgroundColor: COLORS.info,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusBannerBtnText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '700',
  },
  statusBannerDismiss: {
    padding: 2,
  },

  syncRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  syncText: { color: 'white', flex: 1, fontWeight: '600' },
  syncBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#2563EB' },
  retryBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#B45309' },
  syncBtnText: { color: 'white', fontWeight: '700', fontSize: 12 },
  conflictText: { color: '#FDE68A', marginBottom: 8, fontSize: 12 },
  searchContainer: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchInput: {
    flex: 1,
    marginLeft: 10,
    fontSize: 16,
    color: COLORS.primary,
  },
  
  listContent: { padding: 15 },
  sectionHeader: {
    backgroundColor: '#EEF2FF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 10,
    marginTop: 5,
  },
  sectionTitle: {
    fontWeight: 'bold',
    color: COLORS.muted,
    fontSize: 14,
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
