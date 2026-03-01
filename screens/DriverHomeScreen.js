import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Switch,
  Alert,
  ScrollView,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { realtimeDb } from '../firebase';
import { assignDriverToTour } from '../services/bookingServiceRealtime';
import offlineSyncService from '../services/offlineSyncService';
import { createPersistenceProvider } from '../services/persistenceProvider';
import logger from '../services/loggerService';
import { getMinutesAgo } from '../services/timeUtils';
import { COLORS as THEME, SYNC_COLORS } from '../theme';

const { width } = Dimensions.get('window');

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
const minimalMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
];

const LOCATION_STALE_THRESHOLD_MINUTES = 12;
const AUTO_SHARE_INTERVAL_MS = 3 * 60 * 1000;

export default function DriverHomeScreen({ driverData, onLogout, onNavigate, onDriverAssignmentChange, unifiedSyncStatus = null }) {
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
  const [autoShareStatus, setAutoShareStatus] = useState('Auto-share is off');
  const [autoShareLastRunAt, setAutoShareLastRunAt] = useState(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerType, setBannerType] = useState('info');
  const [bannerMessage, setBannerMessage] = useState('');
  const [bannerActionLabel, setBannerActionLabel] = useState(null);
  const [bannerActionHandler, setBannerActionHandler] = useState(null);

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

  // Derive active tour from props (updates when driverData changes)
  const activeTourId = driverData?.assignedTourId || '';

  const sanitizeTourId = useCallback((tourCode) => (tourCode ? tourCode.replace(/\s+/g, '_') : null), []);
  const autoSharePreferenceKey = `AUTO_SHARE_${driverData?.id || 'unknown'}`;

  const getLastUpdateAgeMinutes = useCallback((timestamp) => {
    const minutesAgo = getMinutesAgo(timestamp);
    return Number.isFinite(minutesAgo) ? minutesAgo : Number.POSITIVE_INFINITY;
  }, []);

  const isLocationStale = Boolean(lastLocationUpdate?.timestamp)
    && getLastUpdateAgeMinutes(lastLocationUpdate.timestamp) >= LOCATION_STALE_THRESHOLD_MINUTES;

  const showBanner = useCallback(({ type = 'info', message, actionLabel, actionHandler, autoHideMs = 4000 }) => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }

    setBannerType(type);
    setBannerMessage(message);
    setBannerActionLabel(actionLabel || null);
    setBannerActionHandler(actionHandler || null);
    setBannerVisible(true);

    if (type === 'warning') {
      logger.warn('DriverHomeScreen', 'Showing warning banner', { message, hasAction: Boolean(actionLabel) });
    }
    if (type === 'error') {
      logger.error('DriverHomeScreen', 'Showing error banner', { message, hasAction: Boolean(actionLabel) });
    }

    if (autoHideMs > 0) {
      bannerTimerRef.current = setTimeout(() => {
        setBannerVisible(false);
        setBannerActionLabel(null);
        setBannerActionHandler(null);
      }, autoHideMs);
    }
  }, []);

  const dismissBanner = useCallback(() => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setBannerVisible(false);
    setBannerActionLabel(null);
    setBannerActionHandler(null);
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
        const stored = await persistenceRef.current.getItemAsync(autoSharePreferenceKey);
        if (cancelled) return;
        const enabled = stored === 'true';
        setAutoShareEnabled(enabled);
        setAutoShareStatus(enabled ? 'Waiting for next background location share' : 'Auto-share is off');
      } catch (error) {
        if (!cancelled) {
          setAutoShareEnabled(false);
          setAutoShareStatus('Auto-share is off');
        }
      }
    };

    loadAutoSharePreference();

    return () => {
      cancelled = true;
    };
  }, [autoSharePreferenceKey]);

  useEffect(() => {
    if (!activeTourId) return;
    offlineSyncService.getTourPackMeta(activeTourId, 'driver').then((res) => {
      if (res.success) setCacheStatusLabel(offlineSyncService.getStalenessLabel(res.data?.lastSyncedAt).label);
    });
  }, [activeTourId]);

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
  }, []);

  // Entry animation
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  // Fetch existing location data on mount
  useEffect(() => {
    if (!activeTourId) return;

    const locationRef = realtimeDb.ref(`tours/${activeTourId}/driverLocation`);
    locationRef.once('value').then((snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        setLastLocationUpdate(data);
      }
    });
  }, [activeTourId]);

  // Reverse geocode to get address
  const getAddressFromCoords = async (latitude, longitude) => {
    try {
      setAddressLoading(true);
      const result = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });

      if (result && result.length > 0) {
        const addr = result[0];
        const parts = [];
        if (addr.name && addr.name !== addr.street) parts.push(addr.name);
        if (addr.street) parts.push(addr.street);
        if (addr.city) parts.push(addr.city);
        if (addr.region) parts.push(addr.region);

        setAddressText(parts.join(', ') || 'Address unavailable');
      } else {
        setAddressText('Address unavailable');
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      setAddressText('Could not determine address');
    } finally {
      setAddressLoading(false);
    }
  };

  const captureCurrentLocationWithPermission = async (accuracy = Location.Accuracy.High) => {
    const existingPermission = await Location.getForegroundPermissionsAsync();
    let permissionStatus = existingPermission?.status;

    if (permissionStatus !== 'granted') {
      const requestedPermission = await Location.requestForegroundPermissionsAsync();
      permissionStatus = requestedPermission?.status;
    }

    if (permissionStatus !== 'granted') {
      return { success: false, error: 'permission-denied' };
    }

    const location = await Location.getCurrentPositionAsync({ accuracy });
    return { success: true, location };
  };

  const uploadLocationUpdate = async ({ latitude, longitude, accuracy, timestamp, address }, source = 'manual') => {
    await realtimeDb.ref(`tours/${activeTourId}/driverLocation`).set({
      latitude,
      longitude,
      timestamp,
      updatedBy: driverData.name,
      address: address || 'Address unavailable',
      accuracy,
      source,
    });

    setLastLocationUpdate({
      latitude,
      longitude,
      timestamp,
      updatedBy: driverData.name,
      address: address || 'Address unavailable',
      accuracy,
      source,
    });
  };

  // Function to capture location and show preview
  const handleCaptureLocation = async () => {
    if (!activeTourId) {
      showBanner({
        type: 'warning',
        message: 'Join a tour to share your pickup location.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setUpdatingLocation(true);

    try {
      // 1. Request Permission
      const captureResult = await captureCurrentLocationWithPermission(Location.Accuracy.High);
      if (!captureResult.success) {
        Alert.alert('Permission Denied', 'Allow location access to share your pickup point.');
        setUpdatingLocation(false);
        return;
      }

      // 2. Get Coordinates with high accuracy
      const location = captureResult.location;

      const { latitude, longitude, accuracy } = location.coords;

      setPreviewLocation({
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
      });
      setLocationAccuracy(accuracy);

      // 3. Get address
      await getAddressFromCoords(latitude, longitude);

      // 4. Show preview modal
      setPreviewModalVisible(true);

    } catch (error) {
      console.error(error);
      showBanner({
        type: 'error',
        message: 'Couldn’t get your location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleCaptureLocation,
      });
    } finally {
      setUpdatingLocation(false);
    }
  };

  // Function to confirm and save location to Firebase
  const handleConfirmLocation = async () => {
    if (!previewLocation) return;

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }

    setConfirmingLocation(true);

    try {
      const { latitude, longitude, timestamp } = previewLocation;

      await uploadLocationUpdate({ latitude, longitude, timestamp, address: addressText, accuracy: locationAccuracy }, 'manual');

      // Success animation
      Animated.sequence([
        Animated.timing(successAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(1500),
        Animated.timing(successAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      setPreviewModalVisible(false);
      showBanner({
        type: 'success',
        message: 'Location shared. Passengers can now see your pickup point.',
      });

    } catch (error) {
      console.error(error);
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      showBanner({
        type: 'error',
        message: 'Couldn’t share location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleConfirmLocation,
      });
    } finally {
      setConfirmingLocation(false);
    }
  };

  const handleToggleAutoShare = async (enabled) => {
    if (enabled && !activeTourId) {
      showBanner({
        type: 'warning',
        message: 'Join a tour before enabling auto-share.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }

    setAutoShareEnabled(enabled);
    setAutoShareStatus(enabled ? 'Waiting for next background location share' : 'Auto-share is off');

    await persistenceRef.current.setItemAsync(autoSharePreferenceKey, enabled ? 'true' : 'false');
  };

  useEffect(() => {
    if (!autoShareEnabled) return undefined;
    if (!activeTourId) {
      setAutoShareStatus('Paused: join a tour to resume auto-share');
      return undefined;
    }

    let cancelled = false;
    let intervalId;

    const runAutoShare = async () => {
      if (cancelled || updatingLocation || confirmingLocation) return;

      try {
        setAutoShareStatus('Auto-share running (battery-aware mode)');
        const captureResult = await captureCurrentLocationWithPermission(Location.Accuracy.Balanced);

        if (!captureResult.success) {
          setAutoShareStatus('Paused: location permission required');
          return;
        }

        const location = captureResult.location;
        const timestamp = new Date().toISOString();
        const { latitude, longitude, accuracy } = location.coords;

        await uploadLocationUpdate({
          latitude,
          longitude,
          accuracy,
          timestamp,
          address: lastLocationUpdate?.address,
        }, 'auto');

        if (!cancelled) {
          setAutoShareLastRunAt(timestamp);
          setLocationAccuracy(accuracy);
          setAutoShareStatus('Live: periodic updates every 3 minutes');
        }
      } catch (error) {
        if (!cancelled) {
          setAutoShareStatus('Paused: network issue, will retry automatically');
        }
      }
    };

    runAutoShare();
    intervalId = setInterval(runAutoShare, AUTO_SHARE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [
    autoShareEnabled,
    activeTourId,
    updatingLocation,
    confirmingLocation,
    lastLocationUpdate?.address,
  ]);

  // Refetch location in preview modal
  const handleRefetchLocation = async () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setUpdatingLocation(true);

    try {
      let location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const { latitude, longitude, accuracy } = location.coords;

      setPreviewLocation({
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
      });
      setLocationAccuracy(accuracy);

      await getAddressFromCoords(latitude, longitude);

    } catch (error) {
      console.error(error);
      showBanner({
        type: 'error',
        message: 'Couldn’t refresh location. Retry.',
        actionLabel: 'Retry',
        actionHandler: handleRefetchLocation,
      });
    } finally {
      setUpdatingLocation(false);
    }
  };

  const handleOpenChat = () => {
    if (!activeTourId) {
      showBanner({
        type: 'warning',
        message: 'Join a tour to open group chat.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true,
      driverName: driverData?.name || 'Driver'
    });
  };

  const handleOpenDriverChat = () => {
    if (!activeTourId) {
      showBanner({
        type: 'warning',
        message: 'Join a tour to open driver chat.',
        actionLabel: 'Join Tour',
        actionHandler: () => setJoinModalVisible(true),
      });
      return;
    }
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
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
      showBanner({ type: 'warning', message: 'Enter a valid tour code to continue.' });
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setJoining(true);
    try {
      const driverId = driverData.id;

      const result = await assignDriverToTour(driverId, inputTourCode);
      const sanitizedTourId = result?.tourId || sanitizeTourId(inputTourCode.trim());

      if (onDriverAssignmentChange && sanitizedTourId) {
        await onDriverAssignmentChange({ assignedTourId: sanitizedTourId });
      }

      if (sanitizedTourId) {
        const [locationSnapshot, metaResult] = await Promise.all([
          realtimeDb.ref(`tours/${sanitizedTourId}/driverLocation`).once('value'),
          offlineSyncService.getTourPackMeta(sanitizedTourId, 'driver'),
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

      showBanner({ type: 'success', message: `Assigned to tour ${inputTourCode}.` });
      setJoinModalVisible(false);
      setInputTourCode('');

    } catch (error) {
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      showBanner({
        type: 'error',
        message: `Couldn’t join tour. Check the code and retry. ${error.message}`,
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
  const bannerConfigByType = {
    info: { icon: 'information-outline', bg: THEME.primaryMuted, accent: THEME.primary, text: THEME.textPrimary },
    success: { icon: 'check-circle-outline', bg: THEME.successLight, accent: THEME.success, text: THEME.textPrimary },
    warning: { icon: 'alert-outline', bg: THEME.warningLight, accent: THEME.warning, text: THEME.textPrimary },
    error: { icon: 'alert-circle-outline', bg: THEME.errorLight, accent: THEME.error, text: THEME.textPrimary },
  };
  const currentBannerConfig = bannerConfigByType[bannerType] || bannerConfigByType.info;

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={[`${COLORS.primary}0D`, COLORS.bg]}
        style={{ flex: 1 }}
      >
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <View style={styles.headerCard}>
            <View style={styles.headerLeft}>
              <View style={styles.avatar}>
                <MaterialCommunityIcons name="steering" size={24} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.greeting}>Driver Console</Text>
                <Text style={styles.driverName} numberOfLines={1}>{driverData?.name || 'Unknown Driver'}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => {
                if (Platform.OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                onLogout();
              }}
              style={styles.iconButton}
              accessibilityLabel="Logout"
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="logout" size={22} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {bannerVisible && (
              <View style={[styles.inlineBanner, { backgroundColor: currentBannerConfig.bg, borderColor: `${currentBannerConfig.accent}66` }]}>
                <MaterialCommunityIcons name={currentBannerConfig.icon} size={20} color={currentBannerConfig.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.inlineBannerText, { color: currentBannerConfig.text }]}>{bannerMessage}</Text>
                  {bannerActionLabel && bannerActionHandler && (
                    <TouchableOpacity
                      style={[styles.inlineBannerAction, { borderColor: `${currentBannerConfig.accent}55` }]}
                      onPress={bannerActionHandler}
                      accessibilityRole="button"
                      accessibilityLabel={bannerActionLabel}
                    >
                      <Text style={[styles.inlineBannerActionText, { color: currentBannerConfig.accent }]}>{bannerActionLabel}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <TouchableOpacity onPress={dismissBanner} style={styles.inlineBannerDismiss} accessibilityRole="button" accessibilityLabel="Dismiss status message">
                  <MaterialCommunityIcons name="close" size={18} color={currentBannerConfig.accent} />
                </TouchableOpacity>
              </View>
            )}

            {/* Tour Assignment Card */}
            <View style={styles.assignCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Active tour</Text>
                <Text style={styles.cardValue}>{activeTourId || 'No tour assigned'}</Text>
                {unifiedSyncStatus?.label && (
                  <View style={[styles.syncStatePill, styles[`syncSeverity_${unifiedSyncStatus?.severity || 'info'}`]]}>
                    <MaterialCommunityIcons name={unifiedSyncStatus?.icon || 'sync'} size={14} color={THEME.white} />
                    <Text style={styles.syncStatePillText}>{unifiedSyncStatus.label}</Text>
                  </View>
                )}
                <Text style={styles.cardHint}>Stay assigned to keep chat and manifests in sync.</Text>
                <Text style={styles.cardHint}>{unifiedSyncStatus?.description || cacheStatusLabel}</Text>
                {unifiedSyncStatus?.showLastSync && (
                  <Text style={styles.cardHint}>Last successful sync {unifiedSyncStatus?.lastSyncRelative || 'Never'}</Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  setJoinModalVisible(true);
                }}
                accessibilityLabel="Change tour assignment"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="swap-horizontal" size={18} color={COLORS.white} />
                <Text style={styles.pillButtonText}>Change</Text>
              </TouchableOpacity>
            </View>

            {/* Last Location Update Card */}
            {lastLocationUpdate && (
              <View style={styles.lastUpdateCard}>
                <View style={styles.lastUpdateHeader}>
                  <View style={styles.lastUpdateIcon}>
                    <MaterialCommunityIcons name="map-marker-check" size={20} color={COLORS.success} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lastUpdateTitle}>Last Shared Location</Text>
                    <Text style={styles.lastUpdateTime}>{formatTimeAgo(lastLocationUpdate.timestamp)}</Text>
                  </View>
                  <Animated.View style={[styles.liveBadge, { transform: [{ scale: pulseAnim }] }]}>
                    <View style={styles.liveIndicator} />
                    <Text style={styles.liveText}>Active</Text>
                  </Animated.View>
                </View>
                {lastLocationUpdate.address && (
                  <Text style={styles.lastUpdateAddress} numberOfLines={2}>
                    {lastLocationUpdate.address}
                  </Text>
                )}
              </View>
            )}

            {isLocationStale && (
              <View style={styles.staleNudgeCard}>
                <View style={styles.staleNudgeIconWrap}>
                  <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.staleNudgeTitle}>Passengers are seeing an old location — update now.</Text>
                  <Text style={styles.staleNudgeSubtitle}>Last shared {formatTimeAgo(lastLocationUpdate?.timestamp)}. Tap “Set pickup” to refresh immediately.</Text>
                </View>
              </View>
            )}

            <View style={styles.autoShareCard}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={styles.autoShareTitle}>Auto-share location</Text>
                <Text style={styles.autoShareSubtitle}>When enabled, this screen shares every 3 minutes while active and tour-assigned.</Text>
              </View>
              <Switch
                value={autoShareEnabled}
                onValueChange={handleToggleAutoShare}
                trackColor={{ false: `${COLORS.muted}50`, true: `${COLORS.primary}80` }}
                thumbColor={autoShareEnabled ? COLORS.white : '#F4F4F5'}
                accessibilityLabel="Toggle automatic location sharing"
              />
            </View>
            <Text style={styles.autoShareStatus}>{autoShareStatus}</Text>
            {autoShareLastRunAt && (
              <Text style={styles.autoShareLastRun}>Last auto-share: {formatTimeAgo(autoShareLastRunAt)}</Text>
            )}

            {/* Primary Action Grid */}
            <View style={styles.grid}>
              <TouchableOpacity
                style={[styles.bigButton, styles.primaryTile]}
                onPress={handleCaptureLocation}
                disabled={updatingLocation}
                activeOpacity={0.9}
                accessibilityLabel="Set pickup location"
                accessibilityRole="button"
              >
                <View style={styles.tileIconCircle}>
                  {updatingLocation ? (
                    <ActivityIndicator color={COLORS.white}/>
                  ) : (
                    <MaterialCommunityIcons name="map-marker-radius" size={30} color={COLORS.white} />
                  )}
                </View>
                <Text style={styles.bigButtonTitle}>Set pickup</Text>
                <Text style={styles.bigButtonSubtitle}>Drop a pin for passengers</Text>
                {lastLocationUpdate && (
                  <View style={styles.tileBadge}>
                    <MaterialCommunityIcons name="check-circle" size={14} color={COLORS.success} />
                    <Text style={styles.tileBadgeText}>Location active</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.bigButton, styles.chatTile]}
                onPress={handleOpenChat}
                activeOpacity={0.9}
                accessibilityLabel="Open group chat"
                accessibilityRole="button"
              >
                <View style={[styles.tileIconCircle, { backgroundColor: '#EEF2FF' }]}>
                  <MaterialCommunityIcons name="chat-processing" size={30} color={COLORS.info} />
                </View>
                <Text style={[styles.bigButtonTitle, { color: COLORS.text }]}>Group chat</Text>
                <Text style={[styles.bigButtonSubtitle, { color: COLORS.muted }]}>Message passengers</Text>
              </TouchableOpacity>
            </View>

            {/* Secondary Actions */}
            <View style={styles.stackButtons}>
              <TouchableOpacity
                style={[styles.wideButton, styles.outlineButton]}
                onPress={handleOpenDriverChat}
                activeOpacity={0.9}
                accessibilityLabel="Open driver chat"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="radio-handheld" size={22} color={COLORS.primary} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.wideTitle}>Driver chat</Text>
                  <Text style={styles.wideSubtitle}>For assigned drivers only</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.dangerButton]}
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  onNavigate('SafetySupport', { from: 'DriverHome', mode: 'driver' });
                }}
                activeOpacity={0.9}
                accessibilityLabel="Safety and support"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="shield-check" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Safety & support</Text>
                  <Text style={[styles.wideSubtitle, { color: '#F8FAFC' }]}>Escalate issues fast</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.infoButton]}
                onPress={() => {
                  if (!activeTourId) {
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to view the passenger manifest.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  onNavigate('PassengerManifest', { tourId: activeTourId });
                }}
                activeOpacity={0.9}
                accessibilityLabel="View passenger manifest"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="clipboard-list-outline" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Passenger manifest</Text>
                  <Text style={[styles.wideSubtitle, { color: '#E0F2FE' }]}>Check-in, no-shows, stats</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.purpleButton]}
                onPress={() => {
                  if (!activeTourId) {
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to open the client itinerary.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  onNavigate('Itinerary', { tourId: activeTourId, isDriver: true });
                }}
                activeOpacity={0.9}
                accessibilityLabel="Edit client itinerary"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="calendar-edit" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Client itinerary</Text>
                  <Text style={[styles.wideSubtitle, { color: '#EDE9FE' }]}>View & edit what passengers see</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.amberButton]}
                onPress={() => {
                  if (!activeTourId) {
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to open the driver itinerary.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  onNavigate('DriverItinerary', { tourId: activeTourId, isDriver: true });
                }}
                activeOpacity={0.9}
                accessibilityLabel="View driver itinerary"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="file-eye" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Driver itinerary</Text>
                  <Text style={[styles.wideSubtitle, { color: '#FEF3C7' }]}>Full unredacted instructions</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>
            </View>
          </ScrollView>
        </Animated.View>
      </LinearGradient>

      {/* Location Preview Modal */}
      <Modal
        visible={previewModalVisible}
        transparent={false}
        animationType="slide"
        onRequestClose={() => setPreviewModalVisible(false)}
      >
        <SafeAreaView style={styles.previewModalContainer}>
          <View style={styles.previewHeader}>
            <TouchableOpacity
              onPress={() => {
                if (Platform.OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                setPreviewModalVisible(false);
              }}
              style={styles.previewCloseButton}
              accessibilityLabel="Close preview"
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="close" size={24} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.previewTitle}>Confirm Pickup Location</Text>
            <View style={styles.previewCloseButton} />
          </View>

          {/* Map Preview */}
          {previewLocation && (
            <View style={styles.mapPreviewContainer}>
              <MapView
                style={styles.mapPreview}
                provider={Platform.OS === 'ios' ? PROVIDER_DEFAULT : PROVIDER_GOOGLE}
                customMapStyle={Platform.OS === 'android' ? minimalMapStyle : undefined}
                region={{
                  latitude: previewLocation.latitude,
                  longitude: previewLocation.longitude,
                  latitudeDelta: 0.005,
                  longitudeDelta: 0.005,
                }}
                scrollEnabled={false}
                zoomEnabled={false}
                pitchEnabled={false}
                rotateEnabled={false}
              >
                <Circle
                  center={{
                    latitude: previewLocation.latitude,
                    longitude: previewLocation.longitude,
                  }}
                  radius={locationAccuracy || 20}
                  fillColor={`${COLORS.primary}20`}
                  strokeColor={`${COLORS.primary}60`}
                  strokeWidth={2}
                />
                <Marker
                  coordinate={{
                    latitude: previewLocation.latitude,
                    longitude: previewLocation.longitude,
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <View style={styles.previewMarker}>
                    <MaterialCommunityIcons name="bus" size={24} color={COLORS.white} />
                  </View>
                </Marker>
              </MapView>

              {/* Accuracy Badge */}
              <View style={[styles.accuracyBadge, { backgroundColor: `${accuracyConfig.color}15` }]}>
                <MaterialCommunityIcons name={accuracyConfig.icon} size={16} color={accuracyConfig.color} />
                <Text style={[styles.accuracyText, { color: accuracyConfig.color }]}>
                  {accuracyConfig.label} accuracy ({Math.round(locationAccuracy || 0)}m)
                </Text>
              </View>
            </View>
          )}

          {/* Location Details */}
          <View style={styles.previewDetails}>
            <View style={styles.previewDetailRow}>
              <View style={styles.previewDetailIcon}>
                <MaterialCommunityIcons name="map-marker" size={24} color={COLORS.primary} />
              </View>
              <View style={styles.previewDetailText}>
                <Text style={styles.previewDetailLabel}>Address</Text>
                {addressLoading ? (
                  <ActivityIndicator size="small" color={COLORS.primary} style={{ marginTop: 4 }} />
                ) : (
                  <Text style={styles.previewDetailValue}>{addressText || 'Loading...'}</Text>
                )}
              </View>
            </View>

            <View style={styles.previewDetailRow}>
              <View style={styles.previewDetailIcon}>
                <MaterialCommunityIcons name="crosshairs-gps" size={24} color={COLORS.primary} />
              </View>
              <View style={styles.previewDetailText}>
                <Text style={styles.previewDetailLabel}>Coordinates</Text>
                <Text style={styles.previewDetailValue}>
                  {previewLocation ? `${previewLocation.latitude.toFixed(6)}, ${previewLocation.longitude.toFixed(6)}` : 'N/A'}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.refetchButton}
              onPress={handleRefetchLocation}
              disabled={updatingLocation}
              accessibilityLabel="Refresh location"
              accessibilityRole="button"
            >
              {updatingLocation ? (
                <ActivityIndicator size="small" color={COLORS.primary} />
              ) : (
                <>
                  <MaterialCommunityIcons name="refresh" size={18} color={COLORS.primary} />
                  <Text style={styles.refetchText}>Refresh Location</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Action Buttons */}
          <View style={styles.previewActions}>
            <TouchableOpacity
              style={styles.cancelPreviewButton}
              onPress={() => {
                if (Platform.OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                setPreviewModalVisible(false);
              }}
              accessibilityLabel="Cancel"
              accessibilityRole="button"
            >
              <Text style={styles.cancelPreviewText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.confirmPreviewButton}
              onPress={handleConfirmLocation}
              disabled={confirmingLocation || addressLoading}
              accessibilityLabel="Share location with passengers"
              accessibilityRole="button"
            >
              {confirmingLocation ? (
                <ActivityIndicator color={COLORS.white} />
              ) : (
                <>
                  <MaterialCommunityIcons name="send" size={20} color={COLORS.white} />
                  <Text style={styles.confirmPreviewText}>Share with Passengers</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* JOIN TOUR MODAL */}
      <Modal
        visible={joinModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setJoinModalVisible(false)}
      >
        <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Join Tour / Route</Text>
                <TouchableOpacity
                  onPress={() => setJoinModalVisible(false)}
                  accessibilityLabel="Close modal"
                  accessibilityRole="button"
                >
                    <MaterialCommunityIcons name="close" size={24} color="#BDC3C7" />
                </TouchableOpacity>
            </View>

            <Text style={styles.modalDesc}>
                Enter the Tour Code found on your paperwork (e.g. 5112D 8).
                This will link you to the passenger manifest.
            </Text>

            <TextInput
                style={styles.input}
                placeholder="Tour Code (e.g. 5112D 8)"
                value={inputTourCode}
                onChangeText={setInputTourCode}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Tour code input"
            />

            <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: COLORS.success }]}
                onPress={handleJoinTour}
                disabled={joining}
                accessibilityLabel="Confirm tour assignment"
                accessibilityRole="button"
            >
                {joining ? (
                    <ActivityIndicator color="white" />
                ) : (
                    <Text style={styles.modalBtnText}>CONFIRM ASSIGNMENT</Text>
                )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Success Overlay */}
      <Animated.View
        style={[
          styles.successOverlay,
          {
            opacity: successAnim,
            pointerEvents: 'none',
          }
        ]}
      >
        <View style={styles.successContent}>
          <MaterialCommunityIcons name="check-circle" size={60} color={COLORS.success} />
          <Text style={styles.successText}>Location Shared!</Text>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  headerCard: {
    backgroundColor: COLORS.white,
    marginHorizontal: 20,
    marginTop: 16,
    padding: 16,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 4,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: `${COLORS.primary}1A`,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  greeting: { color: COLORS.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  driverName: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  iconButton: {
    backgroundColor: `${COLORS.primary}14`,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  content: { padding: 20, paddingBottom: 28 },
  inlineBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  inlineBannerText: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  inlineBannerAction: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  inlineBannerActionText: {
    fontSize: 13,
    fontWeight: '700',
  },
  inlineBannerDismiss: {
    padding: 2,
  },

  // Tour Assignment Card
  assignCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardLabel: { color: COLORS.muted, fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase', fontWeight: '700' },
  cardValue: { color: COLORS.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  cardHint: { color: COLORS.muted, fontSize: 13, marginTop: 6 },
  pillButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillButtonText: { color: COLORS.white, fontWeight: '700' },

  // Last Update Card
  lastUpdateCard: {
    backgroundColor: `${COLORS.success}08`,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: `${COLORS.success}30`,
  },
  lastUpdateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lastUpdateIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: `${COLORS.success}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  lastUpdateTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  lastUpdateTime: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 2,
  },
  lastUpdateAddress: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 10,
    lineHeight: 18,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.success}15`,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    gap: 5,
  },
  liveIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.success,
  },
  liveText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.success,
    textTransform: 'uppercase',
  },


  staleNudgeCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: `${COLORS.warning}12`,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: `${COLORS.warning}4D`,
  },
  staleNudgeIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: `${COLORS.warning}22`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  staleNudgeTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 4,
  },
  staleNudgeSubtitle: {
    fontSize: 12,
    color: COLORS.muted,
    lineHeight: 17,
  },
  autoShareCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
    marginBottom: 6,
  },
  autoShareTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 3,
  },
  autoShareSubtitle: {
    fontSize: 12,
    color: COLORS.muted,
    lineHeight: 16,
  },
  autoShareStatus: {
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: '600',
    marginBottom: 2,
  },
  autoShareLastRun: {
    fontSize: 12,
    color: COLORS.muted,
    marginBottom: 14,
  },
  // Grid and Buttons
  grid: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  bigButton: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  primaryTile: {
    backgroundColor: COLORS.primary,
    borderColor: `${COLORS.primary}80`,
  },
  chatTile: {
    backgroundColor: COLORS.white,
  },
  tileIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: `${COLORS.white}33`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  bigButtonTitle: { fontSize: 16, fontWeight: '800', color: COLORS.white },
  bigButtonSubtitle: { fontSize: 13, color: '#E2E8F0', marginTop: 2 },
  tileBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 4,
  },
  tileBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.success,
  },

  stackButtons: { gap: 12 },
  wideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  outlineButton: {
    backgroundColor: `${COLORS.primary}0A`,
    borderColor: `${COLORS.primary}4D`,
  },
  dangerButton: {
    backgroundColor: COLORS.danger,
    borderColor: `${COLORS.danger}80`,
  },
  infoButton: {
    backgroundColor: COLORS.info,
    borderColor: `${COLORS.info}80`,
  },
  purpleButton: {
    backgroundColor: COLORS.purple,
    borderColor: `${COLORS.purple}80`,
  },
  amberButton: {
    backgroundColor: '#D97706',
    borderColor: '#B4570980',
  },
  wideTitle: { fontSize: 16, fontWeight: '800', color: COLORS.text },
  wideSubtitle: { fontSize: 13, color: COLORS.muted },

  // Preview Modal
  previewModalContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.white,
  },
  previewCloseButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  mapPreviewContainer: {
    height: 280,
    position: 'relative',
  },
  mapPreview: {
    flex: 1,
  },
  previewMarker: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: COLORS.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  accuracyBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    gap: 5,
  },
  accuracyText: {
    fontSize: 12,
    fontWeight: '600',
  },
  previewDetails: {
    flex: 1,
    padding: 20,
  },
  previewDetailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  previewDetailIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: `${COLORS.primary}12`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  previewDetailText: {
    flex: 1,
  },
  previewDetailLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewDetailValue: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 4,
    lineHeight: 22,
  },
  refetchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: `${COLORS.primary}12`,
    borderRadius: 12,
    gap: 8,
    alignSelf: 'center',
    marginTop: 10,
  },
  refetchText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
    padding: 20,
    paddingTop: 0,
  },
  cancelPreviewButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: `${COLORS.muted}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelPreviewText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.muted,
  },
  confirmPreviewButton: {
    flex: 2,
    flexDirection: 'row',
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  confirmPreviewText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.white,
  },

  // Join Tour Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 20,
    elevation: 5,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12, alignItems: 'center' },
  modalTitle: { fontSize: 20, fontWeight: '800', color: COLORS.text },
  modalDesc: { color: COLORS.muted, marginBottom: 16, lineHeight: 20 },
  input: {
    backgroundColor: '#F8FAFC',
    padding: 14,
    borderRadius: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 18
  },
  modalBtn: {
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: COLORS.success,
  },
  modalBtnText: { color: COLORS.white, fontWeight: '800', fontSize: 15 },

  // Success Overlay
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  successContent: {
    alignItems: 'center',
  },
  successText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.success,
    marginTop: 16,
  },
});
