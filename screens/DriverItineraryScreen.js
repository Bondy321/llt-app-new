// screens/DriverItineraryScreen.js
import createDriverItineraryScreenStyles from './styles/DriverItineraryScreen.styles';
import { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { getDriverItinerary } from '../services/bookingServiceRealtime';
import { COLORS as THEME } from '../theme';
import logger from '../services/loggerService';
import offlineSyncService from '../services/offlineSyncService';
import { subscribeToDriverItinerary } from '../services/driverItineraryRealtimeService';
import { removeLegacyDriverItineraryCache } from '../services/legacyDriverItineraryCache';

const COLORS = {
  primaryBlue: THEME.primary,
  complementaryBlue: THEME.primaryLight,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  amber: '#D97706',
  amberLight: '#FEF3C7',
  amberBorder: '#F59E0B',
  danger: THEME.error,
};

export default function DriverItineraryScreen({ onBack, tourId, tourName, offlineCacheOwnerId }) {
  const [driverItinerary, setDriverItinerary] = useState(null);
  const [tourInfo, setTourInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [isOnline, setIsOnline] = useState(true);

  const retryTimeoutRef = useRef(null);
  const mountedRef = useRef(false);
  const activeRequestIdRef = useRef(0);

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const isRequestActive = (requestId) => mountedRef.current && activeRequestIdRef.current === requestId;

  const runIfRequestActive = (requestId, callback) => {
    if (isRequestActive(requestId)) {
      callback();
      return true;
    }

    return false;
  };

  // Real-time listener for driver_itinerary
  useEffect(() => {
    mountedRef.current = true;
    activeRequestIdRef.current += 1;
    logger.trackScreen('DriverItinerary', {
      tourId,
      tourName,
    });
    logger.info('DriverItineraryScreen', 'Driver itinerary effect started', { tourId });
    loadDriverItinerary();

    if (tourId) {
      logger.info('DriverItineraryScreen', 'Realtime driver itinerary listener starting', { tourId });

      const onUpdate = (snapshot) => {
        const data = snapshot.val();
        if (typeof data === 'string' && data.trim().length > 0) {
          setDriverItinerary(data);
          setIsOnline(true);
          setLastSync(new Date());
          cacheDriverItinerary(data);
          logger.info('DriverItineraryScreen', 'Realtime driver itinerary snapshot received', {
            tourId,
            hasContent: true,
            characterCount: data.length,
          });
          return;
        }

        setDriverItinerary(null);
        clearCachedDriverItinerary();
        logger.warn('DriverItineraryScreen', 'Realtime driver itinerary snapshot empty', { tourId });
      };

      const onListenerError = (error) => {
        logger.warn('DriverItineraryScreen', 'Realtime driver itinerary listener failed', {
          tourId,
          error: error?.message || String(error),
        });
        if (mountedRef.current) {
          setIsOnline(false);
          setErrorMessage((current) => current || 'Live itinerary updates are unavailable. Pull to refresh to retry.');
        }
      };

      const unsubscribe = subscribeToDriverItinerary({
        tourId,
        onError: onListenerError,
        onValue: onUpdate,
      });

      return () => {
        mountedRef.current = false;
        clearRetryTimeout();
        logger.debug('DriverItineraryScreen', 'Realtime driver itinerary listener stopping', { tourId });
        unsubscribe();
      };
    }

    return () => {
      mountedRef.current = false;
      clearRetryTimeout();
      logger.debug('DriverItineraryScreen', 'Driver itinerary effect cleaned up without listener', { tourId });
    };
  // Route identity owns this listener; workflow callbacks intentionally capture that scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineCacheOwnerId, tourId, tourName]);

  const cacheDriverItinerary = async (data) => {
    try {
      const syncedAt = new Date().toISOString();
      const [packResult, metaResult] = await Promise.all([
        offlineSyncService.saveTourPack(
          tourId,
          'driver',
          { driverItinerary: data ?? null },
          { ownerId: offlineCacheOwnerId },
        ),
        offlineSyncService.setTourPackMeta(
          tourId,
          'driver',
          { lastSyncedAt: syncedAt, driverItineraryLastSyncedAt: syncedAt },
          { ownerId: offlineCacheOwnerId },
        ),
      ]);
      if (!packResult?.success || !metaResult?.success) {
        throw new Error(packResult?.error || metaResult?.error || 'Driver itinerary cache write failed');
      }
      logger.info('DriverItineraryScreen', 'Cache save completed', {
        tourId,
        characterCount: typeof data === 'string' ? data.length : null,
      });
    } catch (error) {
      logger.warn('DriverItineraryScreen', 'Cache save failed', { error: error?.message || String(error), tourId });
    }
  };

  const clearCachedDriverItinerary = async () => {
    try {
      await offlineSyncService.saveTourPack(
        tourId,
        'driver',
        { driverItinerary: null },
        { ownerId: offlineCacheOwnerId },
      );
      await removeLegacyDriverItineraryCache(tourId);
    } catch (error) {
      logger.warn('DriverItineraryScreen', 'Cache clear failed', { error: error?.message || String(error), tourId });
    }
  };

  const loadCachedDriverItinerary = async () => {
    try {
      const packResult = await offlineSyncService.getTourPack(tourId, 'driver', { ownerId: offlineCacheOwnerId });
      const pack = packResult?.success ? packResult.data : null;
      if (pack && Object.prototype.hasOwnProperty.call(pack, 'driverItinerary')) {
        const cached = pack.driverItinerary;
        const metaResult = await offlineSyncService.getTourPackMeta(tourId, 'driver', { ownerId: offlineCacheOwnerId });
        const driverItineraryLastSyncedAt = metaResult?.success
          ? (metaResult.data?.driverItineraryLastSyncedAt || metaResult.data?.lastSyncedAt)
          : null;
        if (driverItineraryLastSyncedAt) {
          setLastSync(new Date(driverItineraryLastSyncedAt));
        }
        logger.info('DriverItineraryScreen', 'Cache load hit', {
          tourId,
          characterCount: typeof cached === 'string' ? cached.length : null,
          source: 'tour-pack',
        });
        return cached;
      }

      const removedLegacyCache = await removeLegacyDriverItineraryCache(tourId);
      if (removedLegacyCache) {
        logger.info('DriverItineraryScreen', 'Unscoped legacy cache removed without reuse', {
          tourId,
        });
      }
      logger.debug('DriverItineraryScreen', 'Cache load miss', { tourId });
    } catch (error) {
      logger.warn('DriverItineraryScreen', 'Cache load failed', { error: error?.message || String(error), tourId });
    }
    return null;
  };

  const loadDriverItinerary = async ({ showSkeleton = true, retry = 0 } = {}) => {
    const requestId = activeRequestIdRef.current;
    logger.info('DriverItineraryScreen', 'Driver itinerary load started', {
      tourId,
      showSkeleton,
      retry,
      requestId,
    });

    try {
      clearRetryTimeout();

      if (!runIfRequestActive(requestId, () => setErrorMessage(''))) {
        return;
      }

      if (!tourId) {
        logger.warn('DriverItineraryScreen', 'Driver itinerary load skipped without tour id', { requestId });
        runIfRequestActive(requestId, () => {
          setDriverItinerary(null);
          setTourInfo(null);
          setLoading(false);
          setRefreshing(false);
          setErrorMessage('');
        });
        return;
      }

      runIfRequestActive(requestId, () => {
        if (showSkeleton) setLoading(true);
        else setRefreshing(true);
      });

      // Load from cache first
      const cached = await loadCachedDriverItinerary();
      runIfRequestActive(requestId, () => {
        if (cached && showSkeleton) {
          setDriverItinerary(cached);
          setLoading(false);
          logger.info('DriverItineraryScreen', 'Driver itinerary cache used before network load', {
            tourId,
            requestId,
            characterCount: typeof cached === 'string' ? cached.length : null,
          });
        }
      });

      const result = await getDriverItinerary(tourId);
      if (!isRequestActive(requestId)) {
        return;
      }

      if (result) {
        setDriverItinerary(result.driverItinerary);
        setTourInfo(result);
        setIsOnline(true);
        setLastSync(new Date());
        logger.info('DriverItineraryScreen', 'Driver itinerary network load completed', {
          tourId,
          requestId,
          hasDriverItinerary: Boolean(result.driverItinerary),
          characterCount: typeof result.driverItinerary === 'string' ? result.driverItinerary.length : null,
        });

        if (result.driverItinerary) {
          await cacheDriverItinerary(result.driverItinerary);
        } else {
          await clearCachedDriverItinerary();
        }
      } else {
        logger.warn('DriverItineraryScreen', 'Driver itinerary network load returned empty', {
          tourId,
          requestId,
          hadCache: Boolean(cached),
        });
        if (!cached) {
          setDriverItinerary(null);
        }
      }
    } catch (error) {
      logger.error('DriverItineraryScreen', 'Driver itinerary load failed', {
        tourId,
        requestId,
        retry,
        error: error?.message || String(error),
      });

      if (retry < 2) {
        const delay = Math.pow(2, retry) * 1000;
        logger.warn('DriverItineraryScreen', 'Driver itinerary load scheduling retry', {
          tourId,
          requestId,
          nextRetry: retry + 1,
          delay,
        });
        retryTimeoutRef.current = setTimeout(() => {
          if (!isRequestActive(requestId)) {
            return;
          }

          loadDriverItinerary({ showSkeleton: false, retry: retry + 1 });
          retryTimeoutRef.current = null;
        }, delay);

        runIfRequestActive(requestId, () => {
          setErrorMessage(`Connection issue. Retrying (${retry + 1}/2)...`);
        });
      } else {
        const cached = await loadCachedDriverItinerary();
        runIfRequestActive(requestId, () => {
          if (cached) {
            logger.warn('DriverItineraryScreen', 'Driver itinerary using cache fallback', {
              tourId,
              requestId,
              characterCount: typeof cached === 'string' ? cached.length : null,
            });
            setDriverItinerary(cached);
            setIsOnline(false);
            setErrorMessage('Using offline data. Pull to refresh when online.');
          } else {
            logger.error('DriverItineraryScreen', 'Driver itinerary failed with no cache fallback', {
              tourId,
              requestId,
            });
            setErrorMessage('Could not load driver itinerary. Please check your connection.');
          }
        });
      }
    } finally {
      runIfRequestActive(requestId, () => {
        setLoading(false);
        setRefreshing(false);
      });
    }
  };

  // --- LOADING SKELETON ---
  const renderLoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      <View style={styles.skeletonCard}>
        <View style={styles.skeletonHeader} />
        <View style={styles.skeletonLine} />
        <View style={styles.skeletonLine} />
        <View style={styles.skeletonLine} />
        <View style={[styles.skeletonLine, { width: '70%' }]} />
        <View style={styles.skeletonLine} />
        <View style={[styles.skeletonLine, { width: '50%' }]} />
      </View>
    </View>
  );

  // --- EMPTY STATE ---
  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <MaterialCommunityIcons name="file-document-outline" size={80} color="#CBD5E0" />
      <Text style={styles.emptyTitle}>No Driver Itinerary</Text>
      <Text style={styles.emptySubtitle}>
        The driver itinerary for this tour has not been uploaded yet. Check back later.
      </Text>
    </View>
  );

  const displayName = tourName || tourInfo?.tourName || 'Tour';

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[COLORS.amber, '#B45309']} style={styles.headerGradient}>
          <View style={styles.headerContent}>
            <TouchableOpacity
              onPress={onBack}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel="Back to the previous driver screen"
            >
              <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
            </TouchableOpacity>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerLabel}>Driver Itinerary</Text>
              <Text style={styles.headerTitle}>{displayName}</Text>
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
      <LinearGradient colors={[COLORS.amber, '#B45309']} style={styles.headerGradient}>
        <View style={styles.headerContent}>
          <TouchableOpacity
            onPress={onBack}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Back to the previous driver screen"
          >
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerLabel}>Driver Itinerary</Text>
            <Text style={styles.headerTitle}>{displayName}</Text>
            {!isOnline && (
              <View style={styles.offlineBadge}>
                <MaterialCommunityIcons name="cloud-off-outline" size={12} color={COLORS.white} />
                <Text style={styles.offlineText}>Offline</Text>
              </View>
            )}
          </View>
          <View style={styles.headerIconContainer}>
            <MaterialCommunityIcons name="eye" size={22} color={COLORS.white} />
          </View>
        </View>
      </LinearGradient>

      {/* CONTENT */}
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadDriverItinerary({ showSkeleton: false })}
            tintColor={COLORS.amber}
          />
        }
      >
        {errorMessage ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <View style={styles.errorMessageRow}>
              <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.white} />
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => loadDriverItinerary({ showSkeleton: false })}
              disabled={refreshing}
              accessibilityRole="button"
              accessibilityLabel="Retry loading the driver itinerary"
              accessibilityState={{ disabled: refreshing, busy: refreshing }}
            >
              <MaterialCommunityIcons name="refresh" size={18} color={COLORS.amber} />
              <Text style={styles.retryButtonText}>{refreshing ? 'Retrying…' : 'Retry now'}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {lastSync && (
          <Text style={styles.syncText}>
            Last synced: {lastSync.toLocaleTimeString()}
          </Text>
        )}

        {/* Confidential Notice */}
        <View style={styles.confidentialBanner}>
          <MaterialCommunityIcons name="lock" size={18} color={COLORS.amber} />
          <Text style={styles.confidentialText}>
            This itinerary is for driver use only. Do not share with passengers.
          </Text>
        </View>

        {!driverItinerary ? (
          renderEmptyState()
        ) : (
          <View style={styles.itineraryCard}>
            <LinearGradient colors={[COLORS.white, '#FFFBEB']} style={styles.itineraryCardInner}>
              <View style={styles.itineraryHeader}>
                <MaterialCommunityIcons name="file-document-outline" size={22} color={COLORS.amber} />
                <Text style={styles.itineraryHeaderText}>Full Driver Instructions</Text>
              </View>
              <View style={styles.itineraryDivider} />
              <Text style={styles.itineraryText} selectable={true}>
                {driverItinerary}
              </Text>
            </LinearGradient>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = createDriverItineraryScreenStyles({ StyleSheet, COLORS, Platform });
