import createMapScreenStyles from './styles/MapScreen.styles';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  Animated,
  Linking,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, Polyline, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Haptics from '../services/hapticsService';
import { LinearGradient } from 'expo-linear-gradient';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';
import { getMinutesAgo, parseTimestampMs } from '../services/timeUtils';
import logger from '../services/loggerService';
const { buildDirectionsUrls } = require('../utils/directions');
const { resolvePrimaryPickup } = require('../utils/pickupPresentation');
import { getDriverLocationPresentation, getDriverLocationSnapshotKey } from '../utils/driverLocation';

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  coralAccent: THEME.accent,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  mapHeaderColor: THEME.primary,
  errorRed: THEME.error,
  border: THEME.border,
  softBlue: THEME.primaryMuted,
  success: THEME.success || '#10B981',
  warning: '#F59E0B',
  surface: THEME.surface || '#FFFFFF',
};

// Map styles for a cleaner look
const mapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f5f5' }] },
  { featureType: 'administrative.land_parcel', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dadada' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'transit.station', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
];

const DRIVER_LOCATION_INITIAL_TIMEOUT_MS = 10000;

const summarizeCoords = (coords) => {
  if (!coords) return { present: false };
  const latitude = Number(coords.latitude ?? coords.lat);
  const longitude = Number(coords.longitude ?? coords.lng);
  return {
    present: Number.isFinite(latitude) && Number.isFinite(longitude),
    latitudeApprox: Number.isFinite(latitude) ? Number(latitude.toFixed(3)) : null,
    longitudeApprox: Number.isFinite(longitude) ? Number(longitude.toFixed(3)) : null,
    hasAccuracy: Number.isFinite(Number(coords.accuracy)),
    accuracy: Number.isFinite(Number(coords.accuracy)) ? Math.round(Number(coords.accuracy)) : null,
  };
};

const normalizeMapCoords = (coords) => {
  if (!coords) return null;
  const latitude = Number(coords.latitude ?? coords.lat);
  const longitude = Number(coords.longitude ?? coords.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    ...coords,
    latitude,
    longitude,
  };
};

export default function MapScreen({ onBack, tourId, tourData, bookingData }) {
  const MIN_REFRESH_SPINNER_MS = 120;
  const [driverLocation, setDriverLocation] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [userLocationNotice, setUserLocationNotice] = useState('');
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  const [mapType, setMapType] = useState('standard');
  const primaryPickup = useMemo(() => resolvePrimaryPickup(bookingData), [bookingData]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDetailCard, setShowDetailCard] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [subscriptionRetryKey, setSubscriptionRetryKey] = useState(0);

  const mapRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(100)).current;
  const markerScaleAnim = useRef(new Animated.Value(0)).current;
  const refreshRotation = useRef(new Animated.Value(0)).current;
  const isMountedRef = useRef(true);
  const realtimeConnectedRef = useRef(false);
  const hasDriverSnapshotRef = useRef(false);
  const lastDriverSnapshotKeyRef = useRef('');
  const driverLocationPresentation = useMemo(
    () => getDriverLocationPresentation(driverLocation, freshnessNow),
    [driverLocation, freshnessNow]
  );
  const driverLocationPoint = useMemo(
    () => driverLocationPresentation.available ? normalizeMapCoords(driverLocation) : null,
    [driverLocation, driverLocationPresentation.available]
  );
  const userLocationPoint = useMemo(() => normalizeMapCoords(userLocation), [userLocation]);

  useEffect(() => {
    const freshnessTimer = setInterval(() => setFreshnessNow(Date.now()), 30 * 1000);
    return () => clearInterval(freshnessTimer);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadUserLocation = useCallback(async ({ requestPermission = false } = {}) => {
    const permission = requestPermission
      ? await Location.requestForegroundPermissionsAsync()
      : await Location.getForegroundPermissionsAsync();

    if (permission?.status !== 'granted') {
      if (isMountedRef.current) {
        setUserLocation(null);
        setUserLocationNotice('Your location is off. The driver\'s shared point is still available.');
      }
      return { success: false, reason: 'permission-denied' };
    }

    try {
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (isMountedRef.current) {
        setUserLocation(location.coords);
        setUserLocationNotice('');
      }
      return { success: true, location };
    } catch (error) {
      if (isMountedRef.current) {
        setUserLocationNotice('Your position could not be refreshed. The driver\'s shared point is still available.');
      }
      logger.warn('MapScreen', 'Optional user location lookup failed', {
        tourId,
        error: error?.message || String(error),
      });
      return { success: false, reason: 'location-unavailable' };
    }
  }, [tourId]);

  useEffect(() => {
    logger.trackScreen('Map', {
      tourId,
      hasTourData: Boolean(tourData),
      hasDriverPhone: Boolean(tourData?.driverPhone),
    });
  }, [tourData, tourData?.driverPhone, tourId]);

  // Pulse animation for live indicator
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.3,
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

  // Entry animations
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 50,
        friction: 8,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // Marker scale animation when location updates
  useEffect(() => {
    if (driverLocationPoint) {
      Animated.sequence([
        Animated.timing(markerScaleAnim, {
          toValue: 1.2,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(markerScaleAnim, {
          toValue: 1,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [driverLocationPoint, markerScaleAnim]);

  // 1. Get User's Own Location
  useEffect(() => {
    let cancelled = false;

    (async () => {
      logger.info('MapScreen', 'Optional user location probe started', { tourId });
      const result = await loadUserLocation({ requestPermission: false });
      if (cancelled) return;
      logger.info('MapScreen', 'Optional user location probe completed', {
        tourId,
        success: result.success,
        reason: result.reason || null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [loadUserLocation, tourId]);

  // 2. Subscribe to Driver Location from Firebase
  useEffect(() => {
    if (!tourId) {
      logger.warn('MapScreen', 'Driver location subscription skipped without tour id');
      setLoading(false);
      return;
    }

    setConnectionStatus(realtimeConnectedRef.current ? 'connecting' : 'offline');
    setErrorMsg(null);
    hasDriverSnapshotRef.current = false;
    lastDriverSnapshotKeyRef.current = '';
    const locationRef = realtimeDb.ref(`tours/${tourId}/driverLocation`);
    const initialSnapshotTimeout = setTimeout(() => {
      if (!isMountedRef.current || hasDriverSnapshotRef.current) return;
      setConnectionStatus('error');
      setErrorMsg('The bus location is taking longer than expected. Retry now or use your booked pickup directions.');
      setLoading(false);
      logger.warn('MapScreen', 'Driver location initial snapshot timed out', { tourId });
    }, DRIVER_LOCATION_INITIAL_TIMEOUT_MS);
    logger.info('MapScreen', 'Driver location subscription started', { tourId });

    const unsubscribe = locationRef.on('value', (snapshot) => {
      clearTimeout(initialSnapshotTimeout);
      if (snapshot.exists()) {
        const data = snapshot.val();
        const snapshotKey = getDriverLocationSnapshotKey(data);
        const isMeaningfulUpdate = hasDriverSnapshotRef.current
          && snapshotKey
          && snapshotKey !== lastDriverSnapshotKeyRef.current;
        setDriverLocation(data);
        setErrorMsg(null);
        setConnectionStatus(realtimeConnectedRef.current ? 'connected' : 'offline');
        logger.info('MapScreen', 'Driver location snapshot received', {
          tourId,
          coords: summarizeCoords(data),
          hasTimestamp: Boolean(data?.timestamp || data?.lastUpdated),
          freshness: getDriverLocationPresentation(data).freshness,
          source: data?.source || null,
        });

        // Haptic feedback on location update
        if (isMeaningfulUpdate && Platform.OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        hasDriverSnapshotRef.current = true;
        lastDriverSnapshotKeyRef.current = snapshotKey;
      } else {
        setDriverLocation(null);
        setConnectionStatus(realtimeConnectedRef.current ? 'waiting' : 'offline');
        hasDriverSnapshotRef.current = true;
        lastDriverSnapshotKeyRef.current = '';
        logger.info('MapScreen', 'Driver location snapshot empty', { tourId });
      }
      setLoading(false);
    }, (error) => {
      clearTimeout(initialSnapshotTimeout);
      logger.error('MapScreen', 'Driver location subscription failed', {
        tourId,
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setConnectionStatus('error');
      setErrorMsg('The driver location service is unavailable right now. Please try again shortly.');
      setLoading(false);
    });

    return () => {
      clearTimeout(initialSnapshotTimeout);
      logger.debug('MapScreen', 'Driver location subscription stopped', { tourId });
      locationRef.off('value', unsubscribe);
    };
  }, [subscriptionRetryKey, tourId]);

  const calculateDistanceKm = (pointA, pointB) => {
    const toRad = (value) => (value * Math.PI) / 180;
    const earthRadiusKm = 6371;

    const dLat = toRad(pointB.latitude - pointA.latitude);
    const dLon = toRad(pointB.longitude - pointA.longitude);

    const lat1 = toRad(pointA.latitude);
    const lat2 = toRad(pointB.latitude);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  };

  const formatRelativeTime = (isoString) => {
    const diffMinutes = getMinutesAgo(isoString);
    if (!Number.isFinite(diffMinutes)) return '';
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes === 1) return '1 min ago';
    if (diffMinutes < 60) return `${diffMinutes} mins ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  };

  const formatTime = (isoString) => {
    const parsedMs = parseTimestampMs(isoString);
    if (!Number.isFinite(parsedMs)) return '';
    const date = new Date(parsedMs);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const estimateEtaMinutes = (distanceKm) => {
    if (!distanceKm) return null;
    const averageSpeedKmh = 35; // Highland roads are slower; keep ETA conservative
    const minutes = Math.round((distanceKm / averageSpeedKmh) * 60);
    return Math.max(minutes, 2); // Never show zero-minute arrivals
  };

  const driverLocationTimestamp = driverLocation
    ? (driverLocation.timestamp || driverLocation.lastUpdated)
    : null;
  const driverHasLocation = driverLocationPresentation.available;
  const formattedDriverTime = driverLocationTimestamp ? formatTime(driverLocationTimestamp) : '';
  const relativeUpdateTime = driverLocationTimestamp ? formatRelativeTime(driverLocationTimestamp) : '';
  const locationFreshness = driverLocationPresentation.freshness;
  const isStale = locationFreshness === 'stale';
  const hasLowAccuracy = locationFreshness === 'low_accuracy';
  const hasExpiredLiveLocation = locationFreshness === 'expired';
  const distanceKm = driverLocationPresentation.actionable && driverLocationPoint && userLocationPoint
    ? calculateDistanceKm(driverLocationPoint, userLocationPoint)
    : null;
  const etaMinutes = distanceKm ? estimateEtaMinutes(distanceKm) : null;

  // Auto-fit map to show both locations
  useEffect(() => {
    if (!mapRef.current || (!driverLocationPoint && !userLocationPoint)) {
      return undefined;
    }

    const coordinates = [];
    if (driverLocationPoint) {
      coordinates.push({ latitude: driverLocationPoint.latitude, longitude: driverLocationPoint.longitude });
    }
    if (userLocationPoint) {
      coordinates.push({ latitude: userLocationPoint.latitude, longitude: userLocationPoint.longitude });
    }

    if (coordinates.length === 0) {
      return undefined;
    }

    logger.debug('MapScreen', 'Auto-fitting map coordinates', {
      tourId,
      coordinateCount: coordinates.length,
      hasDriverLocation: Boolean(driverLocationPoint),
      hasUserLocation: Boolean(userLocationPoint),
    });
    const fitTimer = setTimeout(() => {
      mapRef.current?.fitToCoordinates(coordinates, {
        edgePadding: { top: 120, right: 60, bottom: 320, left: 60 },
        animated: true,
      });
    }, 120);

    return () => clearTimeout(fitTimer);
  }, [driverLocationPoint, tourId, userLocationPoint]);

  // Determine initial region
  const getInitialRegion = () => {
    if (driverLocationPoint) {
      return {
        latitude: driverLocationPoint.latitude,
        longitude: driverLocationPoint.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      };
    }
    // Default fallback (e.g. Glasgow) if no driver location yet
    return {
      latitude: 55.8642,
      longitude: -4.2518,
      latitudeDelta: 0.0922,
      longitudeDelta: 0.0421,
    };
  };

  const handleRecenter = useCallback(() => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    logger.info('MapScreen', 'Recenter requested', {
      tourId,
      hasMapRef: Boolean(mapRef.current),
      hasDriverLocation: Boolean(driverLocationPoint),
      hasUserLocation: Boolean(userLocationPoint),
    });

    if (!mapRef.current) return;

    if (driverLocationPoint && userLocationPoint) {
      mapRef.current.fitToCoordinates([
        { latitude: driverLocationPoint.latitude, longitude: driverLocationPoint.longitude },
        { latitude: userLocationPoint.latitude, longitude: userLocationPoint.longitude },
      ], {
        edgePadding: { top: 120, right: 60, bottom: 320, left: 60 },
        animated: true,
      });
      return;
    }

    const region = getInitialRegion();
    mapRef.current.animateToRegion(region, 750);
  }, [driverLocationPoint, userLocationPoint, tourId]);

  const handleRefresh = useCallback(async () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setIsRefreshing(true);
    const refreshStartedAt = Date.now();
    logger.info('MapScreen', 'Manual location refresh started', { tourId });

    // Rotation animation
    const rotationLoop = Animated.loop(
      Animated.timing(refreshRotation, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      })
    );
    rotationLoop.start();

    try {
      const result = await loadUserLocation({ requestPermission: true });
      if (!result.success) return;
      const location = result.location;
      logger.info('MapScreen', 'Manual location refresh completed', {
        tourId,
        durationMs: Date.now() - refreshStartedAt,
        coords: summarizeCoords(location.coords),
      });
    } catch (err) {
      logger.error('MapScreen', 'Manual location refresh failed', {
        tourId,
        durationMs: Date.now() - refreshStartedAt,
        error: err?.message || String(err),
      });
    } finally {
      const elapsed = Date.now() - refreshStartedAt;
      if (elapsed < MIN_REFRESH_SPINNER_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REFRESH_SPINNER_MS - elapsed));
      }

      rotationLoop.stop();
      setIsRefreshing(false);
      refreshRotation.stopAnimation(() => {
        refreshRotation.setValue(0);
      });
    }
  }, [loadUserLocation, refreshRotation, tourId]);

  const handleToggleMapType = useCallback(() => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setMapType(prev => {
      const next = prev === 'standard' ? 'satellite' : 'standard';
      logger.debug('MapScreen', 'Map type toggled', { tourId, previous: prev, next });
      return next;
    });
  }, [tourId]);

  const openDirections = useCallback(async (destination, source) => {
    const urls = buildDirectionsUrls(destination, Platform.OS);
    if (!urls) return false;
    let targetUrl = urls.webUrl;
    try {
      const supported = urls.nativeUrl ? await Linking.canOpenURL(urls.nativeUrl) : false;
      targetUrl = supported ? urls.nativeUrl : urls.webUrl;
    } catch (error) {
      logger.warn('MapScreen', 'Directions URL support check failed; falling back to web', {
        tourId,
        source,
        platform: Platform.OS,
        error: error?.message || String(error),
      });
    }
    try {
      await Linking.openURL(targetUrl);
      return true;
    } catch (error) {
      logger.warn('MapScreen', 'Directions launch failed', {
        tourId,
        source,
        platform: Platform.OS,
        usedWebFallback: targetUrl === urls.webUrl,
        error: error?.message || String(error),
      });
      Alert.alert('Directions unavailable', 'Could not open maps on this device. Please try again in a moment.');
      return false;
    }
  }, [tourId]);

  useEffect(() => {
    const connectedRef = realtimeDb.ref('.info/connected');
    const onConnection = (snapshot) => {
      const connected = snapshot.val() === true;
      realtimeConnectedRef.current = connected;
      if (!connected) {
        setConnectionStatus('offline');
      } else if (!errorMsg) {
        setConnectionStatus(driverLocation ? 'connected' : 'waiting');
      }
    };
    connectedRef.on('value', onConnection);
    return () => connectedRef.off('value', onConnection);
  }, [Boolean(driverLocation), Boolean(errorMsg)]);

  const handleGetDirections = useCallback(async () => {
    logger.info('MapScreen', 'Directions requested', {
      tourId,
      hasDriverLocation: Boolean(driverLocationPoint),
      freshness: locationFreshness,
    });
    if (!driverLocationPoint || !driverLocationPresentation.actionable) {
      Alert.alert('Location too old', 'Wait for the driver to publish a fresh live update before starting directions.');
      return;
    }

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const { latitude, longitude } = driverLocationPoint;
    await openDirections(`${latitude},${longitude}`, 'driver_location');
  }, [driverLocationPoint, driverLocationPresentation.actionable, locationFreshness, openDirections, tourId]);

  const handlePickupDirections = useCallback(async () => {
    if (!primaryPickup.destination) return;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    logger.info('MapScreen', 'Booked pickup directions requested', {
      tourId,
      hasPickupAddress: Boolean(primaryPickup.address),
      hasPickupLocation: Boolean(primaryPickup.location),
    });
    await openDirections(primaryPickup.destination, 'booked_pickup');
  }, [openDirections, primaryPickup, tourId]);

  const handleCallDriver = useCallback(async () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const phone = typeof tourData?.driverPhone === 'string'
      ? tourData.driverPhone.replace(/[^+\d]/g, '')
      : '';

    if (phone.length < 7) {
      logger.warn('MapScreen', 'Call driver blocked without phone number', { tourId });
      Alert.alert('Contact Unavailable', 'Driver contact information is not available. Please contact your tour operator.');
      return;
    }

    logger.info('MapScreen', 'Call driver launched', {
      tourId,
      hasPhoneNumber: Boolean(phone),
      phoneLength: phone.length,
    });
    try {
      await Linking.openURL(`tel:${phone}`);
    } catch (error) {
      logger.warn('MapScreen', 'Call driver launch failed', {
        tourId,
        error: error?.message || String(error),
      });
      Alert.alert('Could not open phone app', 'Please try again, or contact your tour operator if you need help.');
    }
  }, [tourData, tourId]);

  const getFreshnessConfig = (freshness) => {
    switch (freshness) {
      case 'live':
        return { color: COLORS.success, label: 'LIVE NOW', icon: 'broadcast' };
      case 'recent':
        return { color: COLORS.primaryBlue, label: 'LIVE (RECENT)', icon: 'clock-check-outline' };
      case 'stale':
        return { color: COLORS.warning, label: 'STALE', icon: 'clock-alert-outline' };
      case 'pickup':
        return { color: COLORS.primaryBlue, label: 'PICKUP POINT', icon: 'map-marker-check-outline' };
      case 'low_accuracy':
        return { color: COLORS.warning, label: 'LOW ACCURACY', icon: 'crosshairs-question' };
      default:
        return { color: COLORS.secondaryText, label: 'UNKNOWN', icon: 'help-circle-outline' };
    }
  };

  const freshnessConfig = getFreshnessConfig(locationFreshness);

  const spin = refreshRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <LinearGradient
        colors={[`${COLORS.primaryBlue}15`, COLORS.appBackground]}
        style={styles.loadingGradient}
      >
        <View style={styles.loadingContent}>
          <View style={styles.loadingIconContainer}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <View style={styles.loadingIconOuter}>
                <MaterialCommunityIcons name="bus-marker" size={40} color={COLORS.primaryBlue} />
              </View>
            </Animated.View>
          </View>
          <Text style={styles.loadingTitle}>Finding Your Bus</Text>
          <Text style={styles.loadingSubtitle}>Connecting to driver location...</Text>
          <View style={styles.loadingDots}>
            <ActivityIndicator size="small" color={COLORS.primaryBlue} />
          </View>
        </View>
      </LinearGradient>
    </View>
  );

  const renderConnectionIndicator = () => {
    let config;
    switch (connectionStatus) {
      case 'connected':
        config = { color: COLORS.success, icon: 'wifi', label: 'Connected' };
        break;
      case 'waiting':
        config = { color: COLORS.warning, icon: 'wifi-off', label: 'Waiting for driver' };
        break;
      case 'error':
        config = { color: COLORS.errorRed, icon: 'wifi-alert', label: 'Connection error' };
        break;
      case 'offline':
        config = { color: COLORS.warning, icon: 'wifi-off', label: 'Reconnecting...' };
        break;
      default:
        config = { color: COLORS.secondaryText, icon: 'wifi-sync', label: 'Connecting...' };
    }

    return (
      <View style={[styles.connectionBadge, { backgroundColor: `${config.color}15` }]}>
        <MaterialCommunityIcons name={config.icon} size={14} color={config.color} />
        <Text style={[styles.connectionText, { color: config.color }]}>{config.label}</Text>
      </View>
    );
  };

  const renderDriverMarker = () => {
    if (!driverLocationPoint) return null;

    return (
      <>
        {/* Pulse ring */}
        <Circle
          center={{
            latitude: driverLocationPoint.latitude,
            longitude: driverLocationPoint.longitude,
          }}
          radius={100}
          fillColor={`${COLORS.primaryBlue}15`}
          strokeColor={`${COLORS.primaryBlue}30`}
          strokeWidth={1}
        />

        <Marker
          coordinate={{
            latitude: driverLocationPoint.latitude,
            longitude: driverLocationPoint.longitude,
          }}
          title={driverLocationPresentation.mode === 'live' ? 'Live Bus Location' : 'Bus Pickup Point'}
          description={`Updated ${relativeUpdateTime}`}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <Animated.View style={[styles.customMarkerContainer, { transform: [{ scale: markerScaleAnim }] }]}>
            <View style={[styles.customMarkerOuter, locationFreshness === 'live' && styles.markerLive]}>
              <View style={styles.customMarkerInner}>
                <MaterialCommunityIcons name="bus" size={22} color={COLORS.white} />
              </View>
            </View>
            <View style={styles.markerShadow} />
          </Animated.View>
        </Marker>
      </>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (Platform.OS === 'ios') {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            onBack();
          }}
          style={styles.headerButton}
          activeOpacity={0.7}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={COLORS.white} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Find My Bus</Text>
          {renderConnectionIndicator()}
        </View>

        <TouchableOpacity
          style={styles.headerButton}
          onPress={handleToggleMapType}
          activeOpacity={0.7}
          accessibilityLabel="Toggle map type"
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name={mapType === 'standard' ? 'satellite-variant' : 'map'}
            size={22}
            color={COLORS.white}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.container}>
        {loading ? (
          renderLoadingState()
        ) : (
          <Animated.View style={[styles.mapContainer, { opacity: fadeAnim }]}>
            <MapView
              style={styles.map}
              provider={Platform.OS === 'ios' ? PROVIDER_DEFAULT : PROVIDER_GOOGLE}
              initialRegion={getInitialRegion()}
              showsUserLocation={Boolean(userLocationPoint)}
              showsMyLocationButton={false}
              showsCompass={false}
              mapType={mapType}
              customMapStyle={Platform.OS === 'android' && mapType === 'standard' ? mapStyle : undefined}
              ref={mapRef}
              accessibilityLabel="Map showing bus location"
            >
              {renderDriverMarker()}

              {/* Draw line between user and driver */}
              {driverLocationPoint && userLocationPoint && (
                <Polyline
                  coordinates={[
                    { latitude: userLocationPoint.latitude, longitude: userLocationPoint.longitude },
                    { latitude: driverLocationPoint.latitude, longitude: driverLocationPoint.longitude },
                  ]}
                  strokeColor={`${COLORS.primaryBlue}80`}
                  strokeWidth={3}
                  lineDashPattern={[10, 5]}
                />
              )}
            </MapView>

            {/* Floating Action Buttons */}
            <View style={styles.fabContainer}>
              <TouchableOpacity
                style={styles.fab}
                onPress={handleRefresh}
                activeOpacity={0.85}
                disabled={isRefreshing}
                accessibilityLabel="Show or refresh my location"
                accessibilityRole="button"
              >
                <Animated.View style={{ transform: [{ rotate: isRefreshing ? spin : '0deg' }] }}>
                  <MaterialCommunityIcons
                    name="refresh"
                    size={22}
                    color={isRefreshing ? COLORS.secondaryText : COLORS.primaryBlue}
                  />
                </Animated.View>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.fab}
                onPress={handleRecenter}
                activeOpacity={0.85}
                accessibilityLabel="Center map"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="crosshairs-gps" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>

            {/* Info Card */}
            <Animated.View
              style={[
                styles.infoCardContainer,
                { transform: [{ translateY: slideAnim }] }
              ]}
            >
              <View style={styles.infoCard}>
                {errorMsg ? (
                  <View style={styles.errorContent}>
                    <View style={styles.errorIconContainer}>
                      <MaterialCommunityIcons name="alert-circle" size={32} color={COLORS.errorRed} />
                    </View>
                    <View style={styles.errorTextContainer}>
                      <Text style={styles.errorTitle}>Location Error</Text>
                      <Text style={styles.errorMessage}>{errorMsg}</Text>
                      <TouchableOpacity
                        style={styles.contactButton}
                        onPress={() => setSubscriptionRetryKey((value) => value + 1)}
                        accessibilityLabel="Retry driver location connection"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="refresh" size={18} color={COLORS.primaryBlue} />
                        <Text style={styles.contactButtonText}>Retry</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : driverHasLocation ? (
                  <>
                    {/* Status Header */}
                    <View style={styles.cardHeader}>
                      <View style={styles.statusIndicator}>
                        <Animated.View
                          style={[
                            styles.statusDot,
                            { backgroundColor: freshnessConfig.color },
                            locationFreshness === 'live' && { transform: [{ scale: pulseAnim }] }
                          ]}
                        />
                        <Text style={[styles.statusLabel, { color: freshnessConfig.color }]}>
                          {freshnessConfig.label}
                        </Text>
                      </View>
                      <Text style={styles.updateTime}>{relativeUpdateTime}</Text>
                    </View>

                    {/* Driver Info */}
                    <View style={styles.driverInfo}>
                      <View style={styles.driverAvatar}>
                        <MaterialCommunityIcons name="bus" size={28} color={COLORS.white} />
                      </View>
                      <View style={styles.driverDetails}>
                        <Text style={styles.driverTitle}>
                          {driverLocationPresentation.mode === 'live' ? 'Live Bus Location' : 'Bus Pickup Point'}
                        </Text>
                        <Text style={styles.driverSubtitle}>
                          {driverLocationPresentation.mode === 'pickup'
                            ? 'Fixed pickup point shared by the driver'
                            : driverLocation.updatedBy
                              ? `Live update from ${driverLocation.updatedBy}`
                              : 'Live location shared by driver'}
                        </Text>
                        {tourData?.driverName && (
                          <Text style={styles.driverName}>
                            Driver: {tourData.driverName}
                          </Text>
                        )}
                      </View>
                    </View>

                    {/* Metrics */}
                    {(distanceKm !== null || etaMinutes !== null) && (
                      <View style={styles.metricsContainer}>
                        {distanceKm !== null && (
                          <View style={styles.metricCard}>
                            <MaterialCommunityIcons name="map-marker-distance" size={24} color={COLORS.primaryBlue} />
                            <View style={styles.metricTextContainer}>
                              <Text style={styles.metricValue}>
                                {distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(1)}km`}
                              </Text>
                              <Text style={styles.metricLabel}>Distance</Text>
                            </View>
                          </View>
                        )}
                        {etaMinutes !== null && (
                          <View style={[styles.metricCard, styles.metricCardAccent]}>
                            <MaterialCommunityIcons name="clock-fast" size={24} color={COLORS.white} />
                            <View style={styles.metricTextContainer}>
                              <Text style={[styles.metricValue, { color: COLORS.white }]}>
                                {etaMinutes < 60 ? `${etaMinutes} min` : `${Math.floor(etaMinutes/60)}h ${etaMinutes%60}m`}
                              </Text>
                              <Text style={[styles.metricLabel, { color: 'rgba(255,255,255,0.8)' }]}>Est. Travel</Text>
                            </View>
                          </View>
                        )}
                      </View>
                    )}

                    {/* Stale Warning */}
                    {isStale && (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="alert" size={20} color={COLORS.warning} />
                        <Text style={styles.staleText}>
                          This location is getting stale. The driver may still be moving — refresh shortly or contact them for a live update.
                        </Text>
                      </View>
                    )}

                    {hasLowAccuracy && (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="crosshairs-question" size={20} color={COLORS.warning} />
                        <Text style={styles.staleText}>
                          The driver's GPS accuracy is too low for safe directions. Wait for a clearer update or contact the driver.
                        </Text>
                      </View>
                    )}

                    {userLocationNotice ? (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="crosshairs-question" size={20} color={COLORS.secondaryText} />
                        <Text style={styles.staleText}>{userLocationNotice}</Text>
                      </View>
                    ) : null}

                    {/* Action Buttons */}
                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={[styles.primaryButton, !driverLocationPresentation.actionable && { opacity: 0.5 }]}
                        onPress={handleGetDirections}
                        disabled={!driverLocationPresentation.actionable}
                        activeOpacity={0.85}
                        accessibilityLabel="Get directions to pickup point"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="navigation-variant" size={20} color={COLORS.white} />
                        <Text style={styles.primaryButtonText}>Get Directions</Text>
                      </TouchableOpacity>

                      {primaryPickup.destination ? (
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={handlePickupDirections}
                          activeOpacity={0.85}
                          accessibilityLabel="Directions to your booked pickup"
                          accessibilityHint={`${primaryPickup.location || primaryPickup.address}${primaryPickup.formattedDate ? ` on ${primaryPickup.formattedDate}` : ''}`}
                          accessibilityRole="button"
                        >
                          <MaterialCommunityIcons name="map-marker-path" size={20} color={COLORS.primaryBlue} />
                        </TouchableOpacity>
                      ) : null}

                      <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={handleCallDriver}
                        activeOpacity={0.85}
                        accessibilityLabel="Call driver"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="phone" size={20} color={COLORS.primaryBlue} />
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <View style={styles.waitingContent}>
                    <View style={styles.waitingIconContainer}>
                      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <MaterialCommunityIcons name="bus-clock" size={36} color={COLORS.secondaryText} />
                      </Animated.View>
                    </View>
                    <View style={styles.waitingTextContainer}>
                      <Text style={styles.waitingTitle}>
                        {hasExpiredLiveLocation ? 'Live Location Expired' : 'Awaiting Location'}
                      </Text>
                      <Text style={styles.waitingMessage}>
                        {hasExpiredLiveLocation
                          ? 'The last live update is too old to navigate to safely. This screen will update automatically when the driver shares again.'
                          : 'No pickup point is live yet. As soon as the driver shares one, this map will update automatically.'}
                      </Text>
                    </View>
                    {primaryPickup.destination ? (
                      <TouchableOpacity
                        style={styles.pickupDirectionsButton}
                        onPress={handlePickupDirections}
                        activeOpacity={0.85}
                        accessibilityLabel="Directions to your booked pickup"
                        accessibilityHint={`${primaryPickup.location || primaryPickup.address}${primaryPickup.formattedDate ? ` on ${primaryPickup.formattedDate}` : ''}`}
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="map-marker-path" size={18} color={COLORS.white} />
                        <Text style={styles.pickupDirectionsButtonText}>Directions to your pickup</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={styles.contactButton}
                      onPress={handleCallDriver}
                      activeOpacity={0.85}
                      accessibilityLabel="Contact driver by phone"
                      accessibilityRole="button"
                    >
                      <MaterialCommunityIcons name="phone" size={18} color={COLORS.primaryBlue} />
                      <Text style={styles.contactButtonText}>Contact Driver</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </Animated.View>
          </Animated.View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = createMapScreenStyles({ StyleSheet, COLORS, Platform });
