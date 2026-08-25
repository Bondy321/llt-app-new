import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import PassengerManifestView from './PassengerManifestView';
import usePassengerManifestPresentation, {
  computeStats,
  getUnresolvedBookingCount,
} from './usePassengerManifestPresentation';
import { Alert, Linking, Keyboard
} from 'react-native';
import { getTourManifest, updateManifestBooking, MANIFEST_STATUS } from '../../services/bookingServiceRealtime';
import offlineSyncService from '../../services/offlineSyncService';
import * as driverManifestCache from '../../services/driverManifestCacheService';
import * as bookingService from '../../services/bookingServiceRealtime';
import * as chatService from '../../services/chatService';
import logger, { maskIdentifier } from '../../services/loggerService';
const { normalizeSyncState } = require('../../utils/manifestSyncState');
const { normalizeTourId } = require('../../services/tourIdentityService');
const {
  toTelephoneUrl,
} = require('../../utils/bookingLeadPhone');

export default function PassengerManifestController({ route, navigation, driverTourPack = null, isConnected = true }) {
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

  const loadManifest = useCallback(async () => {
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
  }, [cacheScopeEnabled, offlineCacheOwnerId, scopeKey, tourId]);

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
  }, [cacheScopeEnabled, loadManifest, offlineCacheOwnerId, scopeKey, tourId]);

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

  const {
    activeQueueCount,
    failedQueueCount,
    isNarrowedView,
    nextPriorityBooking,
    queueDescriptor,
    resolutionStats,
    resultsDescriptor,
    sectionListData,
    selectedBookingPhone,
    showHeaderProgressRow,
    sortedFilteredBookings,
    totalStats,
    unresolvedDescriptor,
  } = usePassengerManifestPresentation({
    driverTourPack,
    manifestData,
    queueStats,
    searchQuery,
    selectedBooking,
    statusFilter,
    tourId,
  });

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

  return (
    <PassengerManifestView {...{
      actionLoading, activeQueueCount, bookingSyncState, confirmAllNoShow, failedQueueCount, filtersOpen,
      handleConfirmPartial, handleOpenBooking, handlePhoneBooking, handleRefresh, handleSetAll, handleSyncNow,
      isNarrowedView, loadManifest, loading, manifestConflict, manifestData, manifestLoadError, manifestSource,
      modalVisible, navigation, nextPriorityBooking, partialMode, partialStatuses, queueDescriptor, refreshing,
      resolutionStats, resultsDescriptor, searchQuery, sectionListData, selectedBooking, selectedBookingPhone,
      setFiltersOpen, setManifestConflict, setModalVisible, setPartialMode, setSearchQuery, setStatusFilter,
      showHeaderProgressRow, showStatusFeedback, sortedFilteredBookings, statusFeedback, statusFilter,
      totalStats, tourId, unresolvedDescriptor, updatePassengerStatus,
    }} />
  );
}
