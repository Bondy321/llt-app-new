import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Platform,
  Animated,
  Linking,
  Alert,
} from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from '../../services/hapticsService';
import logger from '../../services/loggerService';
import { getDriverLocationRef, getRealtimeConnectionRef } from '../../services/mapRealtimeService';
import { getDriverLocationPresentation, getDriverLocationSnapshotKey } from '../../utils/driverLocation';
const { buildDirectionsUrls } = require('../../utils/directions');
const { resolvePrimaryPickup } = require('../../utils/pickupPresentation');
const DRIVER_LOCATION_INITIAL_TIMEOUT_MS = 10000;

import MapScreenView from './MapScreenView';
import { calculateDistanceKm, estimateEtaMinutes, formatRelativeTime, normalizeMapCoords, summarizeCoords } from './mapPresentationModel';
export default function MapScreenController({ onBack, tourId, tourData, bookingData }) {
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
  }, [pulseAnim]);

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
  }, [fadeAnim, slideAnim]);

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
    const locationRef = getDriverLocationRef(tourId);
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

  const driverLocationTimestamp = driverLocation
    ? (driverLocation.timestamp || driverLocation.lastUpdated)
    : null;
  const driverHasLocation = driverLocationPresentation.available;
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
  const getInitialRegion = useCallback(() => {
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
  }, [driverLocationPoint]);

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
  }, [driverLocationPoint, getInitialRegion, tourId, userLocationPoint]);

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

  const hasDriverLocationSnapshot = Boolean(driverLocation);
  const hasConnectionError = Boolean(errorMsg);
  useEffect(() => {
    const connectedRef = getRealtimeConnectionRef();
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
  }, [driverLocation, errorMsg, hasConnectionError, hasDriverLocationSnapshot]);

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


  const spin = refreshRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <MapScreenView
      connectionStatus={connectionStatus}
      distanceKm={distanceKm}
      driverHasLocation={driverHasLocation}
      driverLocationPoint={driverLocationPoint}
      driverLocationPresentation={driverLocationPresentation}
      etaMinutes={etaMinutes}
      fadeAnim={fadeAnim}
      freshnessConfig={freshnessConfig}
      getInitialRegion={getInitialRegion}
      handleCallDriver={handleCallDriver}
      handleGetDirections={handleGetDirections}
      handlePickupDirections={handlePickupDirections}
      handleRecenter={handleRecenter}
      handleRefresh={handleRefresh}
      handleToggleMapType={handleToggleMapType}
      hasExpiredLiveLocation={hasExpiredLiveLocation}
      hasLowAccuracy={hasLowAccuracy}
      isStale={isStale}
      loading={loading}
      locationFreshness={locationFreshness}
      mapRef={mapRef}
      mapType={mapType}
      markerScaleAnim={markerScaleAnim}
      onBack={onBack}
      primaryPickup={primaryPickup}
      pulseAnim={pulseAnim}
      isRefreshing={isRefreshing}
      relativeUpdateTime={relativeUpdateTime}
      slideAnim={slideAnim}
      spin={spin}
      tourData={tourData}
      userLocationPoint={userLocationPoint}
      userLocationNotice={userLocationNotice}
      setSubscriptionRetryKey={setSubscriptionRetryKey}
    />
  );
}
