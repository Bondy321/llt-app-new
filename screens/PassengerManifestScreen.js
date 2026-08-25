import createPassengerManifestScreenStyles from './styles/PassengerManifestScreen.styles';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text, View, SectionList, FlatList, TextInput,
  TouchableOpacity, ActivityIndicator, Modal, Alert, Linking, ScrollView,
  KeyboardAvoidingView, Keyboard, Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { getTourManifest, updateManifestBooking, MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import offlineSyncService from '../services/offlineSyncService';
import * as driverManifestCache from '../services/driverManifestCacheService';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import ManifestBookingCard from '../components/ManifestBookingCard';
import ManifestConflictCard from '../components/ManifestConflictCard';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS, FONT_WEIGHT } from '../theme';
import logger, { maskIdentifier } from '../services/loggerService';
const { getBookingSyncState, normalizeSyncState } = require('../utils/manifestSyncState');
const { pickupTimeToMinutes } = require('../services/pickupTimeParser');
const { normalizeTourId } = require('../services/tourIdentityService');
const {
  buildBookingLeadPhoneIndex,
  normalizeBookingReference,
  toTelephoneUrl,
} = require('../utils/bookingLeadPhone');

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

const STATUS_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: MANIFEST_STATUS.PENDING, label: 'Pending' },
  { key: MANIFEST_STATUS.PARTIAL, label: 'Partial' },
  { key: MANIFEST_STATUS.BOARDED, label: 'Boarded' },
  { key: MANIFEST_STATUS.NO_SHOW, label: 'No-show' }
];

const HEADER_WIDGETS_VISIBLE = {
  completion: true,
  syncStatus: true,
  nextPassenger: true,
};

export default function PassengerManifestScreen({ route, navigation, driverTourPack = null, isConnected = true }) {
  const { tourId, actorPrincipalId, authUid, offlineCacheOwnerId, sessionGeneration = 0 } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [manifestData, setManifestData] = useState({ bookings: [], stats: {} });
  const [manifestSource, setManifestSource] = useState('none');
  const [manifestLoadError, setManifestLoadError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Modal State
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [partialMode, setPartialMode] = useState(false);
  const [partialStatuses, setPartialStatuses] = useState([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [queueStats, setQueueStats] = useState({ pending: 0, syncing: 0, failed: 0, total: 0 });
  const [bookingSyncState, setBookingSyncState] = useState({});
  const [manifestConflict, setManifestConflict] = useState(null);
  const [statusFeedback, setStatusFeedback] = useState(null);
  const feedbackTimeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const manifestLoadSeqRef = useRef(0);
  const scopeKey = `${normalizeTourId(tourId)}|${String(offlineCacheOwnerId || '').trim().toUpperCase()}|${sessionGeneration}`;
  const activeScopeKeyRef = useRef(scopeKey);
  const manifestSourceRef = useRef('none');
  const cacheScopeEnabled = /^D-[A-Z0-9_-]+$/.test(String(offlineCacheOwnerId || '').trim().toUpperCase());
  const manifestQueueScope = useMemo(() => {
    const normalizedTourId = normalizeTourId(tourId);
    const principalId = String(actorPrincipalId || '').trim();
    if (!normalizedTourId || !principalId) return null;
    return {
      tourId: normalizedTourId,
      principalId,
      role: 'driver',
      authUid: authUid || null,
      cacheOwnerId: offlineCacheOwnerId || principalId,
    };
  }, [actorPrincipalId, authUid, offlineCacheOwnerId, tourId]);

  useEffect(() => {
    manifestSourceRef.current = manifestSource;
  }, [manifestSource]);

  useEffect(() => {
    logger.trackScreen('PassengerManifest', { tourId });
  }, [tourId]);

  const clearFeedbackTimeout = () => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  };

  const showStatusFeedback = (feedback) => {
    if (!mountedRef.current) return;
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
    const requestSeq = ++manifestLoadSeqRef.current;
    const requestScope = scopeKey;
    const canApplyRequest = () => mountedRef.current
      && requestSeq === manifestLoadSeqRef.current
      && activeScopeKeyRef.current === requestScope;

    logger.info('PassengerManifest', 'Manifest load started', { tourId });
    try {
      const data = await getTourManifest(tourId);
      if (!canApplyRequest()) return null;
      const cacheResult = cacheScopeEnabled
        ? await driverManifestCache.replace({ tourId, driverId: offlineCacheOwnerId, manifest: data })
        : null;
      if (cacheScopeEnabled && !cacheResult.success) {
        logger.warn('PassengerManifest', 'Remote manifest was not cached because it failed strict local validation', {
          tourId,
          error: cacheResult.error,
        });
        // A malformed response must never replace either the cache or the
        // visible last-known-good snapshot.
        throw new Error('The server returned an incomplete manifest. Please try again.');
      }
      if (!canApplyRequest()) return null;
      setManifestData(cacheResult?.data || data);
      setManifestLoadError('');
      manifestSourceRef.current = 'live';
      setManifestSource('live');
      logger.info('PassengerManifest', 'Manifest load completed', {
        tourId,
        bookingCount: data?.bookings?.length || 0,
        hasStats: Boolean(data?.stats),
      });
      return data;
    } catch (error) {
      logger.error('PassengerManifest', 'Manifest load failed', {
        tourId,
        error: error?.message || String(error),
      });
      if (canApplyRequest() && manifestSourceRef.current !== 'cache') {
        setManifestLoadError('Could not load the passenger manifest. Check your connection and retry.');
      }
      return null;
    } finally {
      if (canApplyRequest()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const handleRefresh = async () => {
    logger.info('PassengerManifest', 'Pull refresh started', { tourId });
    setRefreshing(true);
    await handleSyncNow({ isManualRefresh: true });
  };

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    manifestLoadSeqRef.current += 1;
    let cancelled = false;
    const loadCacheThenRemote = async () => {
      const cached = cacheScopeEnabled
        ? await driverManifestCache.get({ tourId, driverId: offlineCacheOwnerId })
        : { success: true, data: null };
      if (!cancelled && activeScopeKeyRef.current === scopeKey && cached.success && cached.data) {
        setManifestData(cached.data);
        manifestSourceRef.current = 'cache';
        setManifestSource('cache');
        setLoading(false);
      }
      if (!cancelled && activeScopeKeyRef.current === scopeKey) await loadManifest();
    };
    loadCacheThenRemote();
    return () => {
      cancelled = true;
      manifestLoadSeqRef.current += 1;
    };
  }, [scopeKey]);

  useEffect(() => {
    const activeTourId = normalizeTourId(tourId);
    const unsubscribe = offlineSyncService.subscribeQueuedActions((actions = []) => {
      if (!mountedRef.current) return;
      const scopedActions = actions.filter((action) => (
        action.type === 'MANIFEST_UPDATE'
        && normalizeTourId(action.tourId) === activeTourId
      ));
      const stats = scopedActions.reduce((summary, action) => {
        if (action.status === 'syncing') summary.syncing += 1;
        else if (action.status === 'failed') summary.failed += 1;
        else summary.pending += 1;
        summary.total += 1;
        return summary;
      }, { pending: 0, syncing: 0, failed: 0, total: 0 });
      const statePriority = { synced: 0, queued: 1, syncing: 2, failed: 3 };
      const syncMap = {};
      scopedActions.forEach((action) => {
        const bookingRef = action.payload?.bookingRef;
        if (!bookingRef) return;
        const nextState = normalizeSyncState(action.status);
        const currentState = syncMap[bookingRef] || 'synced';
        if (statePriority[nextState] >= statePriority[currentState]) syncMap[bookingRef] = nextState;
      });

      setQueueStats(stats);
      setBookingSyncState(syncMap);
      logger.debug('PassengerManifest', 'Scoped manifest queue state updated', {
        tourId: activeTourId,
        pending: stats.pending,
        syncing: stats.syncing,
        failed: stats.failed,
        bookingCount: Object.keys(syncMap).length,
      });
    }, manifestQueueScope ? { scope: manifestQueueScope } : undefined);
    return () => unsubscribe?.();
  }, [manifestQueueScope, scopeKey, tourId]);

  useEffect(() => () => {
    mountedRef.current = false;
    manifestLoadSeqRef.current += 1;
    clearFeedbackTimeout();
  }, []);

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
    const groups = new Map();
    sortedFilteredBookings.forEach((booking) => {
      const unresolved = priorityRank(booking.status) === 0;
      const pickupLabel = booking.pickupTime || 'TBA';
      const pickupLocation = String(booking.pickupLocation || '').trim() || 'Pickup point unavailable';
      const key = `${pickupLocation.toUpperCase()}__${pickupLabel.toUpperCase()}`;
      if (!groups.has(key)) {
        groups.set(key, {
          title: `${pickupLocation} - ${pickupLabel}`,
          data: [],
          unresolved,
          pickupLabel,
          pickupLocation,
        });
      }
      const group = groups.get(key);
      group.unresolved = group.unresolved || unresolved;
      group.data.push(booking);
    });

    return [...groups.values()].sort((a, b) => {
      if (a.unresolved !== b.unresolved) return a.unresolved ? -1 : 1;
      const pickupDelta = toPickupTimeSortValue(a.pickupLabel) - toPickupTimeSortValue(b.pickupLabel);
      if (pickupDelta !== 0) return pickupDelta;
      return a.pickupLocation.localeCompare(b.pickupLocation);
    });
  }, [sortedFilteredBookings]);

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
  const bookingLeadPhones = useMemo(
    () => buildBookingLeadPhoneIndex(driverTourPack, tourId),
    [driverTourPack, tourId]
  );
  const selectedBookingPhone = selectedBooking
    ? bookingLeadPhones.get(normalizeBookingReference(selectedBooking.id))
    : null;

  const sectionListData = sectionedPriorityBookings;
  const resultsDescriptor = `${sortedFilteredBookings.length} of ${manifestData.bookings.length} bookings`;
  const unresolvedDescriptor = `${resolutionStats.unresolved} unresolved`;
  const pendingQueueCount = queueStats.pending || 0;
  const syncingQueueCount = queueStats.syncing || 0;
  const failedQueueCount = queueStats.failed || 0;
  const activeQueueCount = pendingQueueCount + syncingQueueCount + failedQueueCount;
  const showHeaderProgressRow = (HEADER_WIDGETS_VISIBLE.completion && resolutionStats.unresolved > 0)
    || (HEADER_WIDGETS_VISIBLE.syncStatus && activeQueueCount > 0);
  const isNarrowedView = searchQuery.trim().length > 0 || statusFilter !== 'ALL';
  const queueDescriptor = syncingQueueCount > 0
    ? `${pendingQueueCount} pending - ${syncingQueueCount} syncing - ${failedQueueCount} failed`
    : `${pendingQueueCount} pending - ${failedQueueCount} failed`;

  // --- Actions ---
  const handleOpenBooking = (booking) => {
    logger.info('PassengerManifest', 'Booking detail opened', {
      tourId,
      bookingRef: maskIdentifier(booking?.id),
      status: booking?.status || null,
      passengerCount: booking?.passengerNames?.length || 0,
      hasPassengerStatuses: Boolean(booking?.hasPassengerStatuses),
    });
    Keyboard.dismiss();
    setSelectedBooking(booking);
    const existingStatuses = Array.isArray(booking.passengerStatus) ? booking.passengerStatus : [];
    const normalized = booking.passengerNames.map((_, idx) => existingStatuses[idx] || MANIFEST_STATUS.PENDING);
    setPartialStatuses(normalized);
    setPartialMode(false);
    setModalVisible(true);
  };

  const handlePhoneBooking = () => {
    const telephoneUrl = toTelephoneUrl(selectedBookingPhone);
    if (!telephoneUrl || !selectedBooking) return;

    logger.info('PassengerManifest', 'Booking lead phone handoff started', {
      tourId,
      bookingRef: maskIdentifier(selectedBooking.id),
    });
    Linking.openURL(telephoneUrl).catch((error) => {
      logger.warn('PassengerManifest', 'Booking lead phone handoff failed', {
        tourId,
        bookingRef: maskIdentifier(selectedBooking.id),
        error: error?.message || String(error),
      });
      Alert.alert('Phone unavailable', 'The phone app could not be opened. Please try again.');
    });
  };

  const submitUpdate = async (passengerStatuses) => {
    if (!selectedBooking) return;

    try {
      setActionLoading(true);
      logger.info('PassengerManifest', 'Manifest update started', {
        tourId,
        bookingRef: maskIdentifier(selectedBooking.id),
        passengerCount: selectedBooking.passengerNames?.length || 0,
        passengerStatuses: passengerStatuses || null,
      });
      const beforeStats = computeStats(manifestData.bookings);
      const beforeUnresolved = getUnresolvedBookingCount(manifestData.bookings);
      const statusesToPersist = passengerStatuses && passengerStatuses.length > 0
        ? passengerStatuses
        : selectedBooking.passengerNames.map(() => MANIFEST_STATUS.PENDING);

      const result = await updateManifestBooking(tourId, selectedBooking.id, statusesToPersist, {
        online: isConnected,
        actorPrincipalId,
        authUid,
      });
      if (!mountedRef.current) return;
      logger.info('PassengerManifest', 'Manifest update result received', {
        tourId,
        bookingRef: maskIdentifier(selectedBooking.id),
        queued: Boolean(result?.queued),
        hasConflictMessage: Boolean(result?.conflictMessage),
      });
      if (result?.conflict) {
        logger.warn('PassengerManifest', 'Manifest update conflict surfaced', {
          tourId,
          bookingRef: maskIdentifier(selectedBooking.id),
          conflictMessage: result.conflictMessage,
          serverStatus: result.conflict.serverStatus,
          attemptedStatus: result.conflict.attemptedStatus,
        });
        setManifestConflict(result.conflict);
      }
      if (result?.queued) {
        setBookingSyncState((prev) => ({ ...prev, [selectedBooking.id]: normalizeSyncState('queued') }));
      } else {
        setBookingSyncState((prev) => ({ ...prev, [selectedBooking.id]: normalizeSyncState('synced') }));
      }

      const appliedPassengerStatuses = Array.isArray(result?.passengerStatus)
        && result.passengerStatus.length === selectedBooking.passengerNames.length
        ? result.passengerStatus
        : selectedBooking.passengerNames.map((_, index) => (
          result?.status || statusesToPersist[index] || MANIFEST_STATUS.PENDING
        ));
      const appliedStatus = result?.status || result?.localStatus || MANIFEST_STATUS.PENDING;
      setManifestData((current) => ({
        ...current,
        bookings: current.bookings.map((booking) => (
          booking.id === selectedBooking.id
            ? {
                ...booking,
                status: appliedStatus,
                passengerStatus: appliedPassengerStatuses,
                hasPassengerStatuses: true,
                pendingServerConfirmation: Boolean(result?.queued),
              }
            : booking
        )),
      }));
      const cachePatch = cacheScopeEnabled
        ? await driverManifestCache.applyOptimisticUpdate({
          tourId,
          driverId: offlineCacheOwnerId,
          bookingRef: selectedBooking.id,
          passengerStatuses: appliedPassengerStatuses,
        })
        : null;
      if (cacheScopeEnabled && !cachePatch.success) {
        logger.warn('PassengerManifest', 'Manifest update could not be mirrored to the local snapshot', {
          tourId,
          bookingRef: maskIdentifier(selectedBooking.id),
          error: cachePatch.error,
        });
      }

      const syncStateLabel = result?.queued ? 'queued for sync' : 'synced';
      setModalVisible(false);
      setSelectedBooking(null);
      setPartialMode(false);

      if (result?.queued) {
        showStatusFeedback({
          variant: 'warning',
          message: `${selectedBooking.id} is saved on this device and queued for the server. A newer change for this booking will replace this queued one.`,
          ctaLabel: 'Sync now',
          onCtaPress: () => handleSyncNow(),
        });
        return;
      }

      const refreshedManifest = await loadManifest();
      if (!mountedRef.current) return;
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
        const syncSuffix = result?.queued ? ` (${syncStateLabel})` : '';

        showStatusFeedback({
          variant: result?.conflict ? 'warning' : 'success',
          message: result?.conflictMessage || `${parts.join(' - ')}. ${unresolvedSummary}${syncSuffix}`,
          nextBooking,
          unresolvedDelta,
          syncStateLabel,
          autoDismissMs: 4000,
        });
      } else {
        showStatusFeedback({
          variant: result?.conflict ? 'warning' : 'success',
          message: result?.conflictMessage || 'Status saved. The manifest could not refresh, so the confirmed update is shown from this device.',
          autoDismissMs: 5000,
        });
      }
    } catch (error) {
      logger.error('PassengerManifest', 'Manifest update failed', {
        tourId,
        bookingRef: maskIdentifier(selectedBooking?.id),
        error: error?.message || String(error),
      });
      showStatusFeedback({
        variant: 'error',
        message: 'Save failed. Retry now.',
        ctaLabel: 'Retry now',
        onCtaPress: () => submitUpdate(passengerStatuses),
      });
    } finally {
      if (mountedRef.current) {
        setActionLoading(false);
      }
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

    if (!isConnected) {
      showStatusFeedback({
        variant: 'warning',
        message: 'You are offline. Boarding changes stay safely queued on this device and will sync after reconnection.',
        autoDismissMs: 5000,
      });
      if (mountedRef.current) setRefreshing(false);
      return;
    }

    try {
      logger.info('PassengerManifest', 'Manifest sync started', {
        tourId,
        isManualRefresh,
      });
      const replay = await offlineSyncService.replayQueue({
        services: { bookingService, chatService },
        scope: manifestQueueScope || undefined,
      });
      if (!mountedRef.current) return;
      logger.info('PassengerManifest', 'Manifest sync replay completed', {
        tourId,
        isManualRefresh,
        success: Boolean(replay.success),
        syncedCount: replay?.data?.syncedCount ?? replay?.syncedCount ?? null,
        pendingCount: replay?.data?.pendingCount ?? replay?.pendingCount ?? null,
        failedCount: replay?.data?.failedCount ?? replay?.failedCount ?? null,
      });
      if (!replay.success) {
        logger.warn('PassengerManifest', 'Manifest sync replay reported failure', {
          tourId,
          error: replay.error || 'unknown',
        });
        showStatusFeedback({
          variant: 'error',
          message: 'Sync failed. Retry now.',
          ctaLabel: 'Retry now',
          onCtaPress: () => handleSyncNow(),
        });
        await loadManifest();
        return;
      }

      const reconciledOutcome = (replay?.data?.outcomes || []).find((outcome) => (
        outcome.type === 'MANIFEST_UPDATE'
        && normalizeTourId(outcome.tourId) === normalizeTourId(tourId)
        && outcome.reconciled
        && outcome.conflict
      ));
      if (reconciledOutcome) {
        setManifestConflict(reconciledOutcome.conflict);
        showStatusFeedback({
          variant: 'warning',
          message: `Booking ${reconciledOutcome.bookingRef} kept the newer server status. Review the protected update below.`,
        });
      }

      const queued = await offlineSyncService.getQueuedActions({ scope: manifestQueueScope || undefined });
      if (!mountedRef.current) return;
      if (queued.success) {
        const scopedManifestActions = queued.data.filter((action) => (
          action.type === 'MANIFEST_UPDATE'
          && normalizeTourId(action.tourId) === normalizeTourId(tourId)
        ));
        const pendingActions = scopedManifestActions.filter((action) => action.status === 'queued').length;
        const failedActions = scopedManifestActions.filter((action) => action.status === 'failed').length;
        logger.info('PassengerManifest', 'Manifest sync queue scan completed', {
          tourId,
          pendingActions,
          failedActions,
          totalActions: scopedManifestActions.length,
        });

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
    } catch (error) {
      logger.error('PassengerManifest', 'Manifest sync failed unexpectedly', {
        tourId,
        isManualRefresh,
        error: error?.message || String(error),
      });
      showStatusFeedback({
        variant: 'error',
        message: 'Sync failed. Retry now.',
        ctaLabel: 'Retry now',
        onCtaPress: () => handleSyncNow(),
      });
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  };

  const confirmAllNoShow = () => {
    if (!selectedBooking || actionLoading) return;
    const passengerCount = selectedBooking.passengerNames?.length || 0;
    Alert.alert(
      'Mark this booking as no-show?',
      `This will mark all ${passengerCount} passenger${passengerCount === 1 ? '' : 's'} on ${selectedBooking.id} as not present.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark no-show', style: 'destructive', onPress: () => handleSetAll(MANIFEST_STATUS.NO_SHOW) },
      ],
    );
  };

  const handleRetryFailed = async () => {
    logger.info('PassengerManifest', 'Retry failed manifest actions started', { tourId });
    await offlineSyncService.retryFailedActions({
      types: ['MANIFEST_UPDATE'],
      tourId,
      scope: manifestQueueScope || undefined,
    });
    if (!mountedRef.current) return;
    await handleSyncNow();
  };

  // --- Render Functions ---
  const renderHeader = () => (
    <View style={styles.header}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Back to driver console"
        >
          <MaterialCommunityIcons name="arrow-left" size={20} color={COLORS.textLight} />
          <Text style={styles.backText}>Console</Text>
        </TouchableOpacity>
        <View style={styles.topBarTitleWrap}>
          <Text style={styles.headerTitle}>Passenger Manifest</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>Tour {tourId}</Text>
          {manifestSource === 'cache' && <Text style={styles.headerSubtitle}>Saved offline copy - refreshing when available</Text>}
        </View>
        <TouchableOpacity
          onPress={() => handleSyncNow()}
          style={styles.syncBtn}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? 'Syncing passenger manifest' : 'Sync passenger manifest'}
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
        >
          <Text style={styles.syncBtnText}>{refreshing ? 'Syncing...' : 'Sync'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.dashboardContainer}>
        <View style={styles.dashboardItem}>
          <Text style={styles.dashLabel}>EXPECTED</Text>
          <Text style={styles.dashValue}>{totalStats.totalPax}</Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.successTint]}>BOARDED</Text>
          <Text style={[styles.dashValue, { color: COLORS.success }]}>
            {totalStats.checkedIn}
          </Text>
        </View>
        <View style={styles.dashDivider} />
        <View style={styles.dashboardItem}>
          <Text style={[styles.dashLabel, styles.dangerTint]}>NO SHOW</Text>
          <Text style={[styles.dashValue, { color: COLORS.danger }]}>
            {totalStats.noShows}
          </Text>
        </View>
      </View>

      {showHeaderProgressRow ? (
      <View style={styles.progressRow}>
        {HEADER_WIDGETS_VISIBLE.completion && resolutionStats.unresolved > 0 ? (
        <View style={styles.progressShell}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressTitle}>Completion</Text>
            <Text style={styles.progressValue}>{resolutionStats.completionPercent}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${resolutionStats.completionPercent}%` }]} />
          </View>
          <Text style={styles.progressMeta}>
            {resolutionStats.resolved} resolved - {resolutionStats.unresolved} unresolved
          </Text>
        </View>
        ) : null}
        {HEADER_WIDGETS_VISIBLE.syncStatus && activeQueueCount > 0 ? (
        <View style={[
          styles.syncStatusPill,
          failedQueueCount > 0 && styles.syncStatusPill_error,
        ]}>
          <MaterialCommunityIcons
            name={failedQueueCount > 0 ? 'cloud-alert-outline' : 'cloud-check-outline'}
            size={14}
            color={COLORS.primaryDark}
          />
          <View style={styles.syncTextWrap}>
            <Text style={styles.syncStatusText}>{failedQueueCount > 0 ? 'Needs review' : 'Waiting to sync'}</Text>
            <Text style={styles.syncStatusMeta}>{queueDescriptor}</Text>
          </View>
        </View>
        ) : null}
      </View>
      ) : null}
      <ManifestConflictCard
        conflict={manifestConflict}
        onDismiss={() => setManifestConflict(null)}
        onReview={() => {
          const booking = manifestData.bookings.find((item) => item.id === manifestConflict?.bookingRef);
          if (booking) {
            handleOpenBooking(booking);
          } else if (manifestConflict?.bookingRef) {
            setSearchQuery(manifestConflict.bookingRef);
          }
        }}
      />

      <View style={styles.actionSearchRow}>
        {HEADER_WIDGETS_VISIBLE.nextPassenger && nextPriorityBooking ? (
          <TouchableOpacity
            style={styles.nextActionCard}
            onPress={() => handleOpenBooking(nextPriorityBooking)}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel={`Open next unresolved booking ${nextPriorityBooking.id}`}
          >
            <View style={styles.nextActionMeta}>
              <Text style={styles.nextActionEyebrow}>NEXT</Text>
              <Text style={styles.nextActionTitle}>{nextPriorityBooking.id}</Text>
            </View>
            <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.info} />
          </TouchableOpacity>
        ) : null}
        <View style={styles.searchContainer}>
          <MaterialCommunityIcons name="magnify" size={18} color={COLORS.muted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search passenger or booking..."
            placeholderTextColor={THEME.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="characters"
            accessibilityLabel="Search passengers or bookings"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear manifest search"
            >
              <MaterialCommunityIcons name="close-circle" size={18} color={COLORS.muted} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          onPress={() => setFiltersOpen((open) => !open)}
          style={[styles.filterToggle, (filtersOpen || statusFilter !== 'ALL') && styles.filterToggleActive]}
          accessibilityRole="button"
          accessibilityLabel="Toggle manifest filters"
          accessibilityState={{ expanded: filtersOpen, selected: statusFilter !== 'ALL' }}
        >
          <MaterialCommunityIcons
            name="filter-variant"
            size={18}
            color={(filtersOpen || statusFilter !== 'ALL') ? COLORS.textLight : COLORS.primaryDark}
          />
        </TouchableOpacity>
      </View>
      {(filtersOpen || statusFilter !== 'ALL') ? (
      <View style={styles.filtersRow}>
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
                onPress={() => {
                  setStatusFilter(item.key);
                  if (item.key === 'ALL') setFiltersOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Show ${item.label.toLowerCase()} bookings`}
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{item.label}</Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>
      ) : null}
      {(isNarrowedView || resolutionStats.unresolved > 0) ? (
      <View style={styles.searchMetaRow}>
        <Text style={styles.searchMetaText}>{resultsDescriptor}</Text>
        <Text style={styles.searchMetaDivider}>-</Text>
        <Text style={styles.searchMetaText}>{unresolvedDescriptor}</Text>
      </View>
      ) : null}

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
              accessibilityRole="button"
              accessibilityLabel="Open next unresolved booking"
            >
              <Text style={styles.statusBannerBtnText}>Open next</Text>
            </TouchableOpacity>
          )}
          {statusFeedback.ctaLabel && statusFeedback.onCtaPress && (
            <TouchableOpacity
              style={[styles.statusBannerBtn, styles[`statusBannerBtn_${statusFeedback.variant || 'success'}`]]}
              onPress={statusFeedback.onCtaPress}
              accessibilityRole="button"
              accessibilityLabel={statusFeedback.ctaLabel}
            >
              <Text style={styles.statusBannerBtnText}>{statusFeedback.ctaLabel}</Text>
            </TouchableOpacity>
          )}
          {!statusFeedback.autoDismissMs && (
            <TouchableOpacity
              onPress={() => showStatusFeedback(null)}
              style={styles.statusBannerDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss manifest status"
            >
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
        manifestLoadError && manifestData.bookings.length === 0 ? (
          <View style={styles.emptyStateCard} accessibilityRole="alert">
            <MaterialCommunityIcons name="cloud-alert-outline" size={34} color={COLORS.danger} />
            <Text style={styles.emptyStateTitle}>Manifest unavailable</Text>
            <Text style={styles.emptyStateBody}>{manifestLoadError}</Text>
            <TouchableOpacity
              style={styles.emptyStateRetryButton}
              onPress={() => loadManifest()}
              accessibilityRole="button"
              accessibilityLabel="Retry loading the passenger manifest"
            >
              <MaterialCommunityIcons name="refresh" size={18} color={COLORS.textLight} />
              <Text style={styles.emptyStateRetryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : sortedFilteredBookings.length === 0 ? (
          <View style={styles.emptyStateCard}>
            <MaterialCommunityIcons name="clipboard-search-outline" size={34} color={COLORS.primary} />
            <Text style={styles.emptyStateTitle}>{isNarrowedView ? 'No matching bookings' : 'No passengers on this manifest'}</Text>
            <Text style={styles.emptyStateBody}>
              {isNarrowedView
                ? 'Adjust search or filters to find passengers, then update statuses.'
                : 'This tour currently has no passenger bookings to board.'}
            </Text>
          </View>
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
        <KeyboardAvoidingView
          style={styles.modalKeyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent} accessibilityViewIsModal>
            {selectedBooking && (
              <>
                <View style={styles.modalHeader}>
                  <View style={styles.modalHeaderRow}>
                    <View style={styles.modalHeaderText}>
                      <Text style={styles.modalTitle}>{selectedBooking.passengerNames[0]}</Text>
                      <Text style={styles.modalSubtitle}>Ref: {selectedBooking.id} - {selectedBooking.passengerNames.length} Pax</Text>
                    </View>
                    {selectedBookingPhone ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Phone booking ${selectedBooking.id}`}
                        accessibilityHint="Opens the phone app with the booking lead number ready to call."
                        activeOpacity={0.8}
                        onPress={handlePhoneBooking}
                        style={styles.phoneBookingBtn}
                      >
                        <MaterialCommunityIcons name="phone-outline" size={20} color={COLORS.textLight} />
                        <Text style={styles.phoneBookingBtnText}>Phone booking</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                <ScrollView
                  style={styles.modalBody}
                  contentContainerStyle={styles.modalBodyContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                >
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
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as boarded`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.BOARDED, disabled: actionLoading }}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.BOARDED && styles.statusPillTextActive]}>Boarded</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillActiveDanger]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.NO_SHOW)}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as no-show`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.NO_SHOW, disabled: actionLoading }}
                              >
                                <Text style={[styles.statusPillText, status === MANIFEST_STATUS.NO_SHOW && styles.statusPillTextActive]}>No Show</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.statusPill, status === MANIFEST_STATUS.PENDING && styles.statusPillActivePending]}
                                onPress={() => updatePassengerStatus(idx, MANIFEST_STATUS.PENDING)}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Mark ${name} as pending`}
                                accessibilityState={{ selected: status === MANIFEST_STATUS.PENDING, disabled: actionLoading }}
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
                        accessibilityRole="button"
                        accessibilityLabel="Confirm individual passenger statuses"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
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
                        accessibilityLabel={`Mark all passengers here for booking ${selectedBooking.id}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
                      >
                        <MaterialCommunityIcons name="check-all" size={28} color="white" />
                        <Text style={styles.actionBtnText}>All Here</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: COLORS.danger }]}
                        onPress={confirmAllNoShow}
                        disabled={actionLoading}
                        accessibilityLabel={`Mark all passengers no-show for booking ${selectedBooking.id}`}
                        accessibilityRole="button"
                        accessibilityHint="Asks for confirmation before saving"
                        accessibilityState={{ disabled: actionLoading, busy: actionLoading }}
                      >
                        <MaterialCommunityIcons name="close-circle-outline" size={28} color="white" />
                        <Text style={styles.actionBtnText}>No Show</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.modalHintRow}>
                      <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.muted} />
                      <Text style={styles.modalHintText}>
                        Use "Some Here" when only part of the booking has boarded.
                      </Text>
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
                </ScrollView>
              </>
            )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}

const styles = createPassengerManifestScreenStyles({ StyleSheet, COLORS, FONT_WEIGHT, RADIUS, SHADOWS, SPACING });
