// screens/TourHomeScreen.js
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import TourHomeView from '../components/tour-home/TourHomeView';
import { SkeletonLoader } from '../components/tour-home/TourHomeComponents';
import useTourHomeResponsiveStyles from '../components/tour-home/useTourHomeResponsiveStyles';
import { COLORS, getTimeBasedGreeting, triggerHaptic } from '../components/tour-home/tourHomePresentation';
import { View, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import {
  isTourHomeRealtimeAvailable,
  readTourHomeRealtimeSnapshot,
  subscribeToTourHomeRealtime,
} from '../services/tourHomeRealtimeService';
import offlineSyncService from '../services/offlineSyncService';
import logger, { maskIdentifier } from '../services/loggerService';
import { resolveTourId } from '../services/tourIdentityService';
import { getDriverLocationPresentation } from '../utils/driverLocation';
import { COLORS as THEME } from '../theme';
import { getPickupCountdownState } from '../services/pickupTimeParser';
const { buildTourHomeActionPlan } = require('../utils/tourHomeActionPlanner');
export default function TourHomeScreen({
  tourCode,
  tourData,
  bookingData,
  onNavigate,
  onLogout,
  isConnected = true,
}) {
  const { responsiveStyles, screenLayout } = useTourHomeResponsiveStyles();
  const [manifestStatus, setManifestStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [manifestReady, setManifestReady] = useState(false);
  const [driverReady, setDriverReady] = useState(false);
  const [driverLocationRecord, setDriverLocationRecord] = useState(null);
  const [driverLocationNow, setDriverLocationNow] = useState(() => Date.now());
  const [noShowAcknowledged, setNoShowAcknowledged] = useState(false);
  const scrollViewRef = useRef(null);
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);

  const greeting = useMemo(() => getTimeBasedGreeting(), []);
  const bookingRef = useMemo(() => bookingData?.id, [bookingData?.id]);
  const activeTourId = useMemo(
    () => resolveTourId(tourData?.id, tourCode, tourData?.tourCode),
    [tourData?.id, tourData?.tourCode, tourCode]
  );
  const driverLocationPresentation = useMemo(
    () => getDriverLocationPresentation(driverLocationRecord, driverLocationNow),
    [driverLocationNow, driverLocationRecord]
  );
  const driverLocationActive = driverLocationPresentation.mode === 'live'
    && driverLocationPresentation.actionable;
  const driverLocationAvailable = driverLocationPresentation.available;

  useEffect(() => {
    const freshnessTimer = setInterval(() => setDriverLocationNow(Date.now()), 30 * 1000);
    return () => clearInterval(freshnessTimer);
  }, []);

  // Get primary pickup time for countdown
  const primaryPickupTime = useMemo(() => {
    if (bookingData?.pickupPoints?.length > 0) {
      return bookingData.pickupPoints[0].time;
    }
    return bookingData?.pickupTime || null;
  }, [bookingData]);

  const primaryPickupDate = useMemo(() => {
    if (bookingData?.pickupPoints?.length > 0) {
      const pickupPointDate = bookingData.pickupPoints[0]?.date;
      if (pickupPointDate) return pickupPointDate;
    }

    return bookingData?.pickupDate || tourData?.startDate || null;
  }, [bookingData, tourData?.startDate]);

  useEffect(() => {
    logger.trackScreen('TourHome', {
      tourId: activeTourId || null,
      tourCode,
      bookingRef: maskIdentifier(bookingRef),
      isConnected,
      hasTourData: Boolean(tourData),
      manifestStatus,
      driverLocationActive,
    });
  }, [activeTourId, bookingRef, driverLocationActive, isConnected, manifestStatus, tourCode, tourData]);

  useEffect(() => {
    if (!isTourHomeRealtimeAvailable() || !activeTourId || !bookingRef) {
      logger.warn('TourHome', 'Realtime readiness skipped', {
        hasRealtimeDb: isTourHomeRealtimeAvailable(),
        hasTourId: Boolean(activeTourId),
        hasTourCode: Boolean(tourCode),
        bookingRef: maskIdentifier(bookingRef),
      });
      setManifestReady(true);
      setDriverReady(true);
      return;
    }

    setManifestReady(false);
    setDriverReady(false);
  }, [activeTourId, tourCode, bookingRef]);

  useEffect(() => {
    if (!manifestReady || !driverReady) {
      setIsLoading(true);
      return;
    }

    const timer = setTimeout(() => setIsLoading(false), 120);
    return () => clearTimeout(timer);
  }, [manifestReady, driverReady]);

  useEffect(() => {
    if (!isTourHomeRealtimeAvailable() || !activeTourId || !bookingRef) return undefined;

    const sanitizedTourId = activeTourId;
    logger.info('TourHome', 'Passenger realtime listeners starting', {
      sanitizedTourId,
      bookingRef: maskIdentifier(bookingRef),
    });

    const handleSnapshot = (snapshot) => {
      const value = snapshot.val();
      setManifestStatus(value?.status || null);
      setManifestReady(true);
      logger.info('TourHome', 'Manifest status snapshot received', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        exists: snapshot.exists(),
        status: value?.status || null,
        hasPassengerStatus: Array.isArray(value?.passengerStatus),
      });
    };

    const handleManifestError = (error) => {
      logger.error('TourHome', 'Manifest status listener failed', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setManifestReady(true);
    };

    const handleDriverSnapshot = (snapshot) => {
      const value = snapshot.val();
      if (!value) {
        setDriverLocationRecord(null);
        setDriverReady(true);
        logger.info('TourHome', 'Driver location snapshot empty', { sanitizedTourId });
        return;
      }

      const presentation = getDriverLocationPresentation(value);
      setDriverLocationRecord(value);
      setDriverReady(true);
      logger.info('TourHome', 'Driver location status snapshot received', {
        sanitizedTourId,
        hasTimestamp: Boolean(value.timestamp ?? value.lastUpdated),
        freshness: presentation.freshness,
        actionable: presentation.actionable,
        source: value?.source || null,
      });
    };

    const handleDriverError = (error) => {
      logger.error('TourHome', 'Driver location listener failed', {
        sanitizedTourId,
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setDriverReady(true);
      setDriverLocationRecord(null);
    };

    const unsubscribe = subscribeToTourHomeRealtime({
      bookingRef,
      onDriverError: handleDriverError,
      onDriverValue: handleDriverSnapshot,
      onManifestError: handleManifestError,
      onManifestValue: handleSnapshot,
      tourId: sanitizedTourId,
    });

    return () => {
      logger.debug('TourHome', 'Passenger realtime listeners stopping', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
      });
      unsubscribe();
    };
  }, [activeTourId, bookingRef]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    triggerHaptic('light');

    const sanitizedTourId = activeTourId;
    logger.info('TourHome', 'Manual refresh started', {
      sanitizedTourId,
      bookingRef: maskIdentifier(bookingRef),
      isConnected,
    });
    try {
      const replayResult = await offlineSyncService.replayQueue({
        services: { bookingService, chatService },
      });
      logger.info('TourHome', 'Manual refresh replay completed', {
        sanitizedTourId,
        success: Boolean(replayResult?.success),
        processed: replayResult?.data?.processed ?? null,
        failed: replayResult?.data?.failed ?? null,
      });

      if (sanitizedTourId && bookingRef && isTourHomeRealtimeAvailable()) {
        const { driverSnapshot, manifestSnapshot } = await readTourHomeRealtimeSnapshot({
          bookingRef,
          tourId: sanitizedTourId,
        });
        setManifestStatus(manifestSnapshot.val()?.status || null);
        const driverValue = driverSnapshot.val();
        setDriverLocationRecord(driverValue || null);

        logger.info('TourHome', 'Manual refresh realtime snapshots loaded', {
          sanitizedTourId,
          bookingRef: maskIdentifier(bookingRef),
          manifestStatus: manifestSnapshot.val()?.status || null,
          driverLocationExists: driverSnapshot.exists(),
        });
      }

      logger.info('TourHome', 'Manual refresh completed', {
        sanitizedTourId,
        success: replayResult?.success !== false,
      });
    } catch (error) {
      logger.error('TourHome', 'Manual refresh failed', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        error: error?.message || String(error),
      });
    } finally {
      setRefreshing(false);
    }
  }, [activeTourId, bookingRef, isConnected]);

  const manifestStatusMeta = useMemo(() => {
    switch (manifestStatus) {
      case MANIFEST_STATUS.BOARDED:
        return {
          title: 'You\'re all set!',
          message: 'Welcome aboard! Enjoy your tour experience. Your driver has confirmed your boarding.',
          tone: COLORS.success,
          toneLight: COLORS.successLight,
          badge: 'Boarded',
          icon: 'check-circle',
        };
      case MANIFEST_STATUS.NO_SHOW:
        return {
          title: 'Action Required',
          message:
            'The driver has marked you as not at the pickup location. Please contact them immediately.',
          tone: COLORS.error,
          toneLight: COLORS.errorLight,
          badge: 'Missing',
          icon: 'alert-circle',
        };
      case MANIFEST_STATUS.PARTIAL:
        return {
          title: 'Almost there',
          message:
            'Some passengers in your party are still missing. Please ensure everyone is at the pickup point.',
          tone: COLORS.warning,
          toneLight: COLORS.warningLight,
          badge: 'Partial',
          icon: 'account-group',
        };
      case MANIFEST_STATUS.PENDING:
      default:
        return {
          title: 'Ready for pickup',
          message: 'Head to your pickup location. The driver will mark you as boarded when you arrive.',
          tone: COLORS.primaryBlue,
          toneLight: COLORS.lightBlue,
          badge: 'Pending',
          icon: 'clock-outline',
        };
    }
  }, [manifestStatus]);

  const isNoShow = manifestStatus === MANIFEST_STATUS.NO_SHOW;

  useEffect(() => {
    if (!isNoShow) setNoShowAcknowledged(false);
  }, [isNoShow]);

  const pickupCountdownState = useMemo(() => {
    if (!primaryPickupTime) return null;
    return getPickupCountdownState({
      pickupTime: primaryPickupTime,
      pickupDate: primaryPickupDate,
      now: new Date(),
    });
  }, [primaryPickupDate, primaryPickupTime]);

  const actionPlan = useMemo(
    () =>
      buildTourHomeActionPlan({
        manifestStatus,
        pickupCountdown: pickupCountdownState,
        driverLocationActive,
      }),
    [driverLocationActive, manifestStatus, pickupCountdownState]
  );

  const resolveDriverPhoneNumber = useCallback(() => {
    const rawPhone = typeof tourData?.driverPhone === 'string' ? tourData.driverPhone : '';
    const sanitizedPhone = rawPhone.replace(/[^+\d]/g, '');
    return sanitizedPhone.length >= 7 ? sanitizedPhone : '';
  }, [tourData?.driverPhone]);

  const openDriverContactUrl = async (url, action) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      logger.warn('TourHome', 'Driver contact launch failed', {
        tourId: activeTourId || null,
        action,
        error: error?.message || String(error),
      });
      Alert.alert(
        'Could not open phone app',
        'Please try again, or contact your operator if you need help reaching the driver.'
      );
    }
  };

  const handleCallDriver = () => {
    triggerHaptic('medium');
    const phone = resolveDriverPhoneNumber();
    if (!phone) {
      logger.warn('TourHome', 'Driver call blocked without phone number', {
        tourId: activeTourId || null,
        source: isNoShow ? 'no_show_modal' : 'quick_action',
      });
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }

    logger.info('TourHome', 'Driver call launched', {
      tourId: activeTourId || null,
      source: isNoShow ? 'no_show_modal' : 'quick_action',
      phoneLength: phone.length,
    });
    openDriverContactUrl(`tel:${phone}`, 'call');
  };

  const navigateWithLog = useCallback((screen, params = {}, source = 'unknown') => {
    logger.info('TourHome', 'Navigation requested', {
      targetScreen: screen,
      source,
      tourId: activeTourId || null,
      bookingRef: maskIdentifier(bookingRef),
      params,
    });
    onNavigate(screen, params);
  }, [activeTourId, bookingRef, onNavigate]);

  const menuItems = [
    {
      id: 'Photobook',
      title: 'My Photos',
      subtitle: 'Personal gallery',
      icon: 'image-album',
      color: COLORS.primaryBlue,
    },
    {
      id: 'GroupPhotobook',
      title: 'Group Album',
      subtitle: 'Shared memories',
      icon: 'image-multiple',
      color: THEME.success,
    },
    {
      id: 'Itinerary',
      title: 'Itinerary',
      subtitle: 'Full schedule',
      icon: 'map-legend',
      color: THEME.primaryLight,
    },
    {
      id: 'Chat',
      title: 'Group Chat',
      subtitle: 'Stay connected',
      icon: 'chat-processing-outline',
      color: THEME.success,
    },
    {
      id: 'SafetySupport',
      title: 'Safety & SOS',
      subtitle: 'Emergency help',
      icon: 'shield-alert',
      color: '#DC2626',
    },
  ];

  const orderedQuickActions = useMemo(() => {
    const byId = {
      Map: { icon: 'bus-marker', label: 'Find Bus', color: COLORS.coralAccent, onPress: () => navigateWithLog('Map', {}, 'quick_action') },
      Chat: { icon: 'chat', label: 'Chat', color: THEME.success, onPress: () => navigateWithLog('Chat', {}, 'quick_action'), badge: null },
      Itinerary: {
        icon: 'map-legend',
        label: 'Itinerary',
        color: THEME.primaryLight,
        onPress: () => navigateWithLog('Itinerary', {}, 'quick_action'),
      },
      GroupPhotobook: {
        icon: 'image-multiple',
        label: 'Group Photos',
        color: COLORS.primaryBlue,
        onPress: () => navigateWithLog('GroupPhotobook', {}, 'quick_action'),
      },
    };

    return actionPlan.orderedActionIds
      .map((id) => byId[id])
      .filter(Boolean)
      .slice(0, 4);
  }, [actionPlan.orderedActionIds, navigateWithLog]);

  if (isLoading) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
        <SafeAreaView style={styles.statusBarSafeArea} edges={['top']} />
        <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
          <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
            <View style={[styles.container, responsiveStyles.container]}>
              {/* Skeleton header */}
              <View style={[styles.header, responsiveStyles.header]}>
                <SkeletonLoader width={44} height={44} borderRadius={12} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <SkeletonLoader width={120} height={14} style={{ marginBottom: 8 }} />
                  <SkeletonLoader width={180} height={24} />
                </View>
              </View>
              {/* Skeleton cards */}
              <SkeletonLoader width="100%" height={140} borderRadius={18} style={{ marginBottom: 18 }} />
              <SkeletonLoader width="100%" height={200} borderRadius={20} style={{ marginBottom: 24 }} />
              <SkeletonLoader width="100%" height={100} borderRadius={18} style={{ marginBottom: 20 }} />
            </View>
          </LinearGradient>
        </SafeAreaView>
      </View>
    );
  }

  return <TourHomeView {...{
      actionPlan, bookingData, driverLocationActive, driverLocationAvailable, driverLocationPresentation, greeting,
      handleCallDriver, isHeaderMenuOpen, isNoShow, manifestStatusMeta, menuItems, navigateWithLog, noShowAcknowledged,
      onLogout, onRefresh, orderedQuickActions, primaryPickupDate, primaryPickupTime, refreshing, responsiveStyles,
      screenLayout, scrollViewRef, setIsHeaderMenuOpen, setNoShowAcknowledged, tourCode, tourData,
  }} />;
}
