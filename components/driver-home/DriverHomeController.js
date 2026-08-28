import DriverHomeView from './DriverHomeView';
import createDriverLocationCaptureActions from '../../services/driver-home/createDriverLocationCaptureActions';
import createDriverLocationSharingActions from '../../services/driver-home/createDriverLocationSharingActions';
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Platform,
  Animated,
  AppState,
} from 'react-native';
import * as Haptics from '../../services/hapticsService';
import { readDriverLocation, subscribeToDriverLocation } from '../../services/driverLocationRealtimeRepository';
import { assignDriverToTour } from '../../services/bookingServiceRealtime';
import offlineSyncService from '../../services/offlineSyncService';
import { createPersistenceProvider } from '../../services/persistenceProvider';
import logger, { maskIdentifier } from '../../services/loggerService';
import { getMinutesAgo } from '../../services/timeUtils';
import { normalizeTourId, resolveTourId } from '../../services/tourIdentityService';


import {
  getDriverLocationPresentation,
  getDriverLocationStatusMeta,
} from '../../utils/driverLocation';
import { COLORS as THEME } from '../../theme';

const COLORS = {
  primary: THEME.primary,
  midnight: THEME.textPrimary,
  slate: '#1F2937',
  white: THEME.white,
  bg: THEME.background,
  success: THEME.success,
  danger: THEME.error,
  info: THEME.primaryLight,
  location: '#0EA5E9',
  purple: '#7C3AED',
  border: THEME.border,
  text: THEME.textPrimary,
  muted: THEME.textSecondary,
  warning: '#F59E0B',
};

// Minimal map style for preview
export default function DriverHomeController({ driverData, locationSessionScope = null, onLogout, onNavigate, onDriverAssignmentChange, driverTourPackState, driverTourPackFeature }) {
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [lastLocationUpdate, setLastLocationUpdate] = useState(null);
  const [locationAccuracy, setLocationAccuracy] = useState(null);

  // Location Preview Modal State
  const [previewModalVisible, setPreviewModalVisible] = useState(false);
  const [previewLocation, setPreviewLocation] = useState(null);
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressText, setAddressText] = useState('');
  const [confirmingLocation, setConfirmingLocation] = useState(false);
  const [cacheStatusLabel, setCacheStatusLabel] = useState('Not synced yet');
  const [autoShareEnabled, setAutoShareEnabled] = useState(false);
  const [autoShareSaving, setAutoShareSaving] = useState(false);
  const [autoShareStatus, setAutoShareStatus] = useState('Auto-share is off');
  const [autoShareLastRunAt, setAutoShareLastRunAt] = useState(null);
  const [, setBannerContract] = useState(null);
  const [, setBannerOutcomeText] = useState('');
  const [, setBannerRetryHandler] = useState(null);
  const [, setLastSuccessfulSyncAt] = useState(null);
  const [locationFreshnessNow, setLocationFreshnessNow] = useState(() => Date.now());
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');

  // Modal State for Joining Tour
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [inputTourCode, setInputTourCode] = useState('');
  const [joining, setJoining] = useState(false);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const persistenceRef = useRef(createPersistenceProvider({ namespace: 'LLT_DRIVER_HOME' }));
  const bannerTimerRef = useRef(null);
  const autoShareInFlightRef = useRef(null);
  const autoShareToggleInFlightRef = useRef(false);
  const autoShareInitialLocationRef = useRef(null);
  const autoShareGenerationRef = useRef(0);
  const autoShareSessionRef = useRef(null);
  const autoShareEnabledRef = useRef(false);
  const isAppActiveRef = useRef(AppState.currentState === 'active');
  const activeTourIdRef = useRef('');
  const driverIdRef = useRef('');
  const previewRequestIdRef = useRef(0);
  const locationBusyRef = useRef(false);
  const lastLocationAddressRef = useRef('');

  // Derive active tour from canonical assignment fields.
  const activeTourId = resolveTourId(
    driverData?.assignedTourId,
    driverData?.currentTourId,
    driverData?.driverAssignedTourId,
    driverData?.assignedTourCode,
    driverData?.currentTourCode
  ) || '';

  activeTourIdRef.current = activeTourId;
  driverIdRef.current = driverData?.id || '';
  autoShareEnabledRef.current = autoShareEnabled;
  isAppActiveRef.current = isAppActive;

  const sanitizeTourId = useCallback((tourCode) => normalizeTourId(tourCode), []);
  const autoSharePreferenceKey = `AUTO_SHARE_${driverData?.id || 'unknown'}`;

  useEffect(() => {
    logger.trackScreen('DriverHome', {
      driverId: maskIdentifier(driverData?.id),
      activeTourId,
      hasAssignedTour: Boolean(activeTourId),
      autoShareEnabled,
    });
  }, [activeTourId, autoShareEnabled, driverData?.id]);

  const lastLocationPresentation = getDriverLocationPresentation(lastLocationUpdate, locationFreshnessNow);
  const lastLocationStatus = getDriverLocationStatusMeta(lastLocationPresentation);
  const isLocationStale = lastLocationStatus.needsRefresh;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const nextIsActive = nextState === 'active';
      isAppActiveRef.current = nextIsActive;
      setIsAppActive(nextIsActive);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const freshnessTimer = setInterval(() => setLocationFreshnessNow(Date.now()), 30 * 1000);
    return () => clearInterval(freshnessTimer);
  }, []);

  useEffect(() => {
    locationBusyRef.current = updatingLocation || confirmingLocation;
  }, [confirmingLocation, updatingLocation]);

  useEffect(() => {
    lastLocationAddressRef.current = lastLocationUpdate?.address || '';
  }, [lastLocationUpdate?.address]);

  useEffect(() => {
    if (
      previewLocation
      && (previewLocation.tourId !== activeTourId || previewLocation.driverId !== (driverData?.id || ''))
    ) {
      previewRequestIdRef.current += 1;
      setPreviewModalVisible(false);
      setPreviewLocation(null);
      setAddressLoading(false);
      setUpdatingLocation(false);
    }
  }, [activeTourId, driverData?.id, previewLocation]);

  const showBanner = useCallback(({
    contract,
    outcomeText = '',
    autoHideMs = 4000,
    type = 'info',
    message,
    actionHandler,
  }) => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }

    const typeToSeverity = {
      success: 'success',
      warning: 'warning',
      error: 'critical',
      info: 'info',
    };

    const resolvedContract = contract || {
      label: type === 'success' ? 'Up to date' : type === 'warning' ? 'Attention needed' : type === 'error' ? 'Service issue' : 'Sync update',
      description: message || '',
      icon: type === 'success' ? 'check-circle-outline' : type === 'warning' ? 'alert-outline' : type === 'error' ? 'alert-circle-outline' : 'information-outline',
      severity: typeToSeverity[type] || 'info',
      canRetry: Boolean(actionHandler),
      showLastSync: true,
    };

    setBannerContract(resolvedContract);
    setBannerOutcomeText(outcomeText);
    setBannerRetryHandler(resolvedContract.canRetry ? (actionHandler || null) : null);

    if (resolvedContract?.severity === 'warning') {
      logger.warn('DriverHomeScreen', 'Showing warning banner', { message: resolvedContract?.description, hasAction: Boolean(resolvedContract?.canRetry) });
    }
    if (resolvedContract?.severity === 'error' || resolvedContract?.severity === 'critical') {
      logger.error('DriverHomeScreen', 'Showing error banner', { message: resolvedContract?.description, hasAction: Boolean(resolvedContract?.canRetry) });
    }

    if (autoHideMs > 0) {
      bannerTimerRef.current = setTimeout(() => {
        setBannerContract(null);
        setBannerOutcomeText('');
        setBannerRetryHandler(null);
      }, autoHideMs);
    }
  }, []);

  useEffect(() => () => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAutoSharePreference = async () => {
      try {
        logger.debug('DriverHomeScreen', 'Auto-share preference load started', {
          driverId: maskIdentifier(driverData?.id),
        });
        const stored = await persistenceRef.current.getItemAsync(autoSharePreferenceKey);
        if (cancelled) return;
        const enabled = stored === 'true';
        setAutoShareEnabled(enabled);
        setAutoShareStatus(enabled ? 'Waiting for the next in-app location share' : 'Auto-share is off');
        logger.info('DriverHomeScreen', 'Auto-share preference loaded', {
          driverId: maskIdentifier(driverData?.id),
          enabled,
        });
      } catch (error) {
        if (!cancelled) {
          setAutoShareEnabled(false);
          setAutoShareStatus('Auto-share is off');
        }
        logger.warn('DriverHomeScreen', 'Auto-share preference load failed', {
          driverId: maskIdentifier(driverData?.id),
          error: error?.message || String(error),
        });
      }
    };

    loadAutoSharePreference();

    return () => {
      cancelled = true;
    };
  }, [autoSharePreferenceKey, driverData?.id]);

  useEffect(() => {
    if (!activeTourId) return;
    logger.debug('DriverHomeScreen', 'Tour pack metadata load started', { activeTourId });
    offlineSyncService.getTourPackMeta(activeTourId, 'driver', { ownerId: driverData?.id }).then((res) => {
      if (res.success) {
        const label = offlineSyncService.getStalenessLabel(res.data?.lastSyncedAt).label;
        setCacheStatusLabel(label);
        logger.info('DriverHomeScreen', 'Tour pack metadata loaded', {
          activeTourId,
          lastSyncedAt: res.data?.lastSyncedAt || null,
          label,
        });
      } else {
        logger.warn('DriverHomeScreen', 'Tour pack metadata load failed', {
          activeTourId,
          error: res.error || 'unknown',
        });
      }
    });
  }, [activeTourId, driverData?.id]);

  useEffect(() => {
    let mounted = true;
    offlineSyncService.getLastSuccessAt().then((result) => {
      if (mounted && result?.success) {
        setLastSuccessfulSyncAt(result.data);
      }
    });
    return () => {
      mounted = false;
    };
  }, [pulseAnim]);

  // Start pulse animation
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.2,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  // Entry animation
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  // Keep the driver's status reconciled with the authoritative server timestamp.
  useEffect(() => {
    setLastLocationUpdate(null);
    setLocationAccuracy(null);
    lastLocationAddressRef.current = '';
    if (!activeTourId) return undefined;

    logger.debug('DriverHomeScreen', 'Driver location subscription started', { activeTourId });
    const onLocation = (snapshot) => {
      if (activeTourIdRef.current !== activeTourId) return;
      if (snapshot.exists()) {
        const data = snapshot.val();
        setLastLocationUpdate(data);
        setLocationAccuracy(Number.isFinite(Number(data?.accuracy)) ? Number(data.accuracy) : null);
        logger.info('DriverHomeScreen', 'Existing driver location loaded', {
          activeTourId,
          hasTimestamp: Boolean(data?.timestamp || data?.lastUpdated),
          source: data?.source || null,
          accuracy: Number.isFinite(Number(data?.accuracy)) ? Math.round(Number(data.accuracy)) : null,
        });
      } else {
        setLastLocationUpdate(null);
        setLocationAccuracy(null);
        logger.info('DriverHomeScreen', 'Existing driver location empty', { activeTourId });
      }
    };
    const onLocationError = (error) => {
      if (activeTourIdRef.current !== activeTourId) return;
      logger.warn('DriverHomeScreen', 'Existing driver location lookup failed', {
        activeTourId,
        error: error?.message || String(error),
      });
    };
    const unsubscribe = subscribeToDriverLocation({ onError: onLocationError, onValue: onLocation, tourId: activeTourId });

    return () => {
      unsubscribe();
      logger.debug('DriverHomeScreen', 'Driver location subscription stopped', { activeTourId });
    };
  }, [activeTourId, driverData?.id]);

  // Reverse geocode to get address
  const { getAddressFromCoords, captureCurrentLocationWithPermission, uploadLocationUpdate, handleCaptureLocation, handleConfirmLocation } = createDriverLocationCaptureActions({ activeTourId, activeTourIdRef, addressText, driverData, driverIdRef, locationAccuracy, locationSessionScope, previewLocation, previewRequestIdRef, setAddressLoading, setAddressText, setConfirmingLocation, setJoinModalVisible, setLastLocationUpdate, setLocationAccuracy, setPreviewLocation, setPreviewModalVisible, setUpdatingLocation, showBanner, successAnim });

  const { handleToggleAutoShare, handleRefetchLocation } = createDriverLocationSharingActions({ activeTourId, activeTourIdRef, autoShareEnabled, autoShareEnabledRef, autoShareGenerationRef, autoShareInFlightRef, autoShareInitialLocationRef, autoSharePreferenceKey, autoShareSessionRef, autoShareToggleInFlightRef, captureCurrentLocationWithPermission, driverData, driverIdRef, getAddressFromCoords, isAppActive, isAppActiveRef, lastLocationAddressRef, locationBusyRef, locationSessionScope, persistenceRef, previewLocation, previewRequestIdRef, setAddressLoading, setAddressText, setAutoShareEnabled, setAutoShareLastRunAt, setAutoShareSaving, setAutoShareStatus, setJoinModalVisible, setLastLocationUpdate, setLocationAccuracy, setPreviewLocation, setPreviewModalVisible, setUpdatingLocation, showBanner, uploadLocationUpdate });

  const handleOpenChat = () => {
    if (!activeTourId) {
      logger.warn('DriverHomeScreen', 'Group chat navigation blocked without tour', {
        driverId: maskIdentifier(driverData?.id),
      });
      showBanner({
        contract: {
          ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKLOG_PENDING,
          label: 'Join a tour',
          description: 'Join a tour to open group chat.',
          canRetry: false,
          showLastSync: false,
          icon: 'bus',
          severity: 'warning',
        },
      });
      return;
    }
    logger.info('DriverHomeScreen', 'Group chat navigation requested', {
      activeTourId,
      driverId: maskIdentifier(driverData?.id),
    });
    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true,
      driverName: driverData?.name || 'Driver'
    });
  };

  const handleOpenDriverChat = () => {
    if (!activeTourId) {
      logger.warn('DriverHomeScreen', 'Internal driver chat navigation blocked without tour', {
        driverId: maskIdentifier(driverData?.id),
      });
      showBanner({
        contract: {
          ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKLOG_PENDING,
          label: 'Join a tour',
          description: 'Join a tour to open driver chat.',
          canRetry: false,
          showLastSync: false,
          icon: 'bus-clock',
          severity: 'warning',
        },
      });
      return;
    }
    logger.info('DriverHomeScreen', 'Internal driver chat navigation requested', {
      activeTourId,
      driverId: maskIdentifier(driverData?.id),
    });
    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true,
      driverName: driverData?.name || 'Driver',
      internalDriverChat: true,
    });
  };

  // --- Join Tour Logic ---
  const handleJoinTour = async () => {
    if (!inputTourCode.trim()) {
      logger.warn('DriverHomeScreen', 'Join tour blocked without code', {
        driverId: maskIdentifier(driverData?.id),
      });
      showBanner({ contract: { ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKLOG_PENDING, label: 'Tour code required', description: 'Enter a valid tour code to continue.', canRetry: false, showLastSync: false, severity: 'warning', icon: 'form-textbox' } });
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setJoining(true);
    logger.info('DriverHomeScreen', 'Join tour started', {
      driverId: maskIdentifier(driverData?.id),
      tourCode: maskIdentifier(inputTourCode.trim()),
    });
    try {
      const driverId = driverData.id;

      const result = await assignDriverToTour(driverId, inputTourCode);
      const sanitizedTourId = result?.tourId || sanitizeTourId(inputTourCode.trim());
      logger.info('DriverHomeScreen', 'Join tour assignment completed', {
        driverId: maskIdentifier(driverId),
        sanitizedTourId,
        hadResultTourId: Boolean(result?.tourId),
      });

      if (onDriverAssignmentChange && sanitizedTourId) {
        await onDriverAssignmentChange({ assignedTourId: sanitizedTourId });
        logger.info('DriverHomeScreen', 'Driver assignment persisted to session', {
          driverId: maskIdentifier(driverId),
          sanitizedTourId,
        });
      }

      if (sanitizedTourId) {
        const [locationSnapshot, metaResult] = await Promise.all([
          readDriverLocation(sanitizedTourId),
          offlineSyncService.getTourPackMeta(sanitizedTourId, 'driver', { ownerId: driverData?.id }),
        ]);

        if (locationSnapshot.exists()) {
          setLastLocationUpdate(locationSnapshot.val());
        } else {
          setLastLocationUpdate(null);
        }

        if (metaResult.success) {
          setCacheStatusLabel(offlineSyncService.getStalenessLabel(metaResult.data?.lastSyncedAt).label);
        } else {
          setCacheStatusLabel('Not synced yet');
        }
      }

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      showBanner({ contract: offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_HEALTHY, outcomeText: offlineSyncService.formatSyncOutcome({ source: 'manual-refresh' }) });
      setJoinModalVisible(false);
      setInputTourCode('');

    } catch (error) {
      logger.error('DriverHomeScreen', 'Join tour failed', {
        driverId: maskIdentifier(driverData?.id),
        tourCode: maskIdentifier(inputTourCode.trim()),
        error: error?.message || String(error),
      });
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      showBanner({
        contract: { ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED, canRetry: true, description: "Couldn't join tour. Check the code and retry." },
        outcomeText: offlineSyncService.formatSyncOutcome({ source: 'manual-refresh' }),
      });
    } finally {
      setJoining(false);
    }
  };

  const getAccuracyConfig = (accuracy) => {
    if (!accuracy) return { label: 'Unknown', color: COLORS.muted, icon: 'crosshairs-question' };
    if (accuracy <= 10) return { label: 'Excellent', color: COLORS.success, icon: 'crosshairs-gps' };
    if (accuracy <= 30) return { label: 'Good', color: COLORS.primary, icon: 'crosshairs' };
    if (accuracy <= 100) return { label: 'Fair', color: COLORS.warning, icon: 'crosshairs' };
    return { label: 'Poor', color: COLORS.danger, icon: 'crosshairs-off' };
  };

  const formatTimeAgo = (isoString) => {
    const diffMinutes = getMinutesAgo(isoString);
    if (!Number.isFinite(diffMinutes)) return 'Never';
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes === 1) return '1 min ago';
    if (diffMinutes < 60) return `${diffMinutes} mins ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    return 'Over a day ago';
  };

  const accuracyConfig = getAccuracyConfig(locationAccuracy);
  const lastLocationStatusColor = lastLocationStatus.tone === 'success'
    ? COLORS.success
    : lastLocationStatus.tone === 'warning'
      ? COLORS.warning
      : lastLocationStatus.tone === 'muted'
        ? COLORS.muted
        : COLORS.primary;

  return <DriverHomeView {...{ accuracyConfig, activeTourId, addressLoading, addressText, autoShareEnabled, autoShareLastRunAt, autoShareSaving, autoShareStatus, cacheStatusLabel, confirmingLocation, driverData, driverTourPackFeature, driverTourPackState, fadeAnim, formatTimeAgo, handleCaptureLocation, handleConfirmLocation, handleJoinTour, handleOpenChat, handleOpenDriverChat, handleRefetchLocation, handleToggleAutoShare, inputTourCode, isLocationStale, joinModalVisible, joining, lastLocationPresentation, lastLocationStatus, lastLocationStatusColor, lastLocationUpdate, locationAccuracy, onLogout, onNavigate, previewLocation, previewModalVisible, previewRequestIdRef, pulseAnim, setAddressLoading, setInputTourCode, setJoinModalVisible, setPreviewModalVisible, setUpdatingLocation, showBanner, successAnim, updatingLocation }} />;
}
