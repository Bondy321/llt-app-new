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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, Polyline, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Haptics from '../services/hapticsService';
import { LinearGradient } from 'expo-linear-gradient';
import { realtimeDb } from '../firebase';
import { COLORS as THEME } from '../theme';
import { getMinutesAgo, parseTimestampMs } from '../services/timeUtils';
import logger from '../services/loggerService';

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

export default function MapScreen({ onBack, tourId, tourData }) {
  const MIN_REFRESH_SPINNER_MS = 120;
  const [driverLocation, setDriverLocation] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [mapType, setMapType] = useState('standard');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDetailCard, setShowDetailCard] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  const mapRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(100)).current;
  const markerScaleAnim = useRef(new Animated.Value(0)).current;
  const refreshRotation = useRef(new Animated.Value(0)).current;
  const driverLocationPoint = useMemo(() => normalizeMapCoords(driverLocation), [driverLocation]);
  const userLocationPoint = useMemo(() => normalizeMapCoords(userLocation), [userLocation]);

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
      logger.info('MapScreen', 'User location permission requested', { tourId });
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        logger.warn('MapScreen', 'User location permission denied', { tourId, status });
        setErrorMsg('Permission to access location was denied');
        setLoading(false);
        return;
      }

      try {
        logger.debug('MapScreen', 'User location lookup started', { tourId, accuracy: 'balanced' });
        let location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        setUserLocation(location.coords);
        logger.info('MapScreen', 'User location lookup completed', {
          tourId,
          coords: summarizeCoords(location.coords),
        });
      } catch (err) {
        if (cancelled) return;
        logger.error('MapScreen', 'User location lookup failed', {
          tourId,
          error: err?.message || String(err),
        });
        setErrorMsg('Could not get your location');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tourId]);

  // 2. Subscribe to Driver Location from Firebase
  useEffect(() => {
    if (!tourId) {
      logger.warn('MapScreen', 'Driver location subscription skipped without tour id');
      setLoading(false);
      return;
    }

    setConnectionStatus('connecting');
    const locationRef = realtimeDb.ref(`tours/${tourId}/driverLocation`);
    logger.info('MapScreen', 'Driver location subscription started', { tourId });

    const unsubscribe = locationRef.on('value', (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        setDriverLocation(data);
        setConnectionStatus('connected');
        logger.info('MapScreen', 'Driver location snapshot received', {
          tourId,
          coords: summarizeCoords(data),
          hasTimestamp: Boolean(data?.timestamp || data?.lastUpdated),
          freshness: getLocationFreshness(data?.timestamp || data?.lastUpdated),
          source: data?.source || null,
        });

        // Haptic feedback on location update
        if (Platform.OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      } else {
        setConnectionStatus('waiting');
        logger.info('MapScreen', 'Driver location snapshot empty', { tourId });
      }
      setLoading(false);
    }, (error) => {
      logger.error('MapScreen', 'Driver location subscription failed', {
        tourId,
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setConnectionStatus('error');
      setLoading(false);
    });

    return () => {
      logger.debug('MapScreen', 'Driver location subscription stopped', { tourId });
      locationRef.off('value', unsubscribe);
    };
  }, [tourId]);

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

  const getLocationFreshness = (isoString) => {
    const diffMinutes = getMinutesAgo(isoString);
    if (!Number.isFinite(diffMinutes)) return 'unknown';
    if (diffMinutes < 2) return 'live';
    if (diffMinutes < 10) return 'recent';
    if (diffMinutes < 30) return 'stale';
    return 'old';
  };

  const driverLocationTimestamp = driverLocation
    ? (driverLocation.timestamp || driverLocation.lastUpdated)
    : null;
  const driverHasLocation = Boolean(driverLocationPoint);
  const formattedDriverTime = driverLocationTimestamp ? formatTime(driverLocationTimestamp) : '';
  const relativeUpdateTime = driverLocationTimestamp ? formatRelativeTime(driverLocationTimestamp) : '';
  const locationFreshness = driverLocationTimestamp ? getLocationFreshness(driverLocationTimestamp) : 'unknown';
  const isStale = locationFreshness === 'stale' || locationFreshness === 'old';
  const distanceKm = driverLocationPoint && userLocationPoint
    ? calculateDistanceKm(driverLocationPoint, userLocationPoint)
    : null;
  const etaMinutes = distanceKm ? estimateEtaMinutes(distanceKm) : null;

  // Auto-fit map to show both locations
  useEffect(() => {
    if (mapRef.current && (driverLocationPoint || userLocationPoint)) {
      const coordinates = [];
      if (driverLocationPoint) {
        coordinates.push({ latitude: driverLocationPoint.latitude, longitude: driverLocationPoint.longitude });
      }
      if (userLocationPoint) {
        coordinates.push({ latitude: userLocationPoint.latitude, longitude: userLocationPoint.longitude });
      }

      if (coordinates.length > 0) {
        logger.debug('MapScreen', 'Auto-fitting map coordinates', {
          tourId,
          coordinateCount: coordinates.length,
          hasDriverLocation: Boolean(driverLocationPoint),
          hasUserLocation: Boolean(userLocationPoint),
        });
        setTimeout(() => {
          mapRef.current?.fitToCoordinates(coordinates, {
            edgePadding: { top: 120, right: 60, bottom: 320, left: 60 },
            animated: true,
          });
        }, 120);
      }
    }
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
      let location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setUserLocation(location.coords);
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
  }, [refreshRotation, tourId]);

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

  const handleGetDirections = useCallback(async () => {
    logger.info('MapScreen', 'Directions requested', {
      tourId,
      hasDriverLocation: Boolean(driverLocationPoint),
      freshness: locationFreshness,
    });
    if (!driverLocationPoint) return;

    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const { latitude, longitude } = driverLocationPoint;
    const label = 'Bus Pickup Point';
    const url = Platform.select({
      ios: `maps://app?daddr=${latitude},${longitude}&dirflg=d`,
      android: `google.navigation:q=${latitude},${longitude}`,
    });

    const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;

    let targetUrl = webUrl;

    try {
      const supported = await Linking.canOpenURL(url);
      logger.debug('MapScreen', 'Directions URL support checked', {
        tourId,
        supported,
        platform: Platform.OS,
      });
      targetUrl = supported ? url : webUrl;
    } catch (error) {
      logger.warn('MapScreen', 'Directions URL support check failed; falling back to web', {
        tourId,
        platform: Platform.OS,
        error: error?.message || String(error),
      });
    }

    try {
      await Linking.openURL(targetUrl);
    } catch (error) {
      logger.warn('MapScreen', 'Directions launch failed', {
        tourId,
        platform: Platform.OS,
        usedWebFallback: targetUrl === webUrl,
        error: error?.message || String(error),
      });
      Alert.alert('Directions unavailable', 'Could not open maps on this device. Please try again in a moment.');
    }
  }, [driverLocationPoint, locationFreshness, tourId]);

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
      case 'old':
        return { color: COLORS.errorRed, label: 'VERY STALE', icon: 'clock-remove-outline' };
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
          title="Bus Pickup Point"
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
              showsUserLocation={true}
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
                accessibilityLabel="Refresh location"
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
                        <Text style={styles.driverTitle}>Bus Pickup Point</Text>
                        <Text style={styles.driverSubtitle}>
                          {driverLocation.updatedBy ? `Set by ${driverLocation.updatedBy}` : 'Location set by driver'}
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

                    {/* Action Buttons */}
                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={styles.primaryButton}
                        onPress={handleGetDirections}
                        activeOpacity={0.85}
                        accessibilityLabel="Get directions to pickup point"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="navigation-variant" size={20} color={COLORS.white} />
                        <Text style={styles.primaryButtonText}>Get Directions</Text>
                      </TouchableOpacity>

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
                      <Text style={styles.waitingTitle}>Awaiting Location</Text>
                      <Text style={styles.waitingMessage}>
                        No pickup point is live yet. As soon as the driver shares one, this map will switch to live tracking automatically.
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.contactButton}
                      onPress={handleCallDriver}
                      activeOpacity={0.85}
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.primaryBlue,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.primaryBlue,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
    marginBottom: 4,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    gap: 4,
  },
  connectionText: {
    fontSize: 11,
    fontWeight: '600',
  },

  container: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  mapContainer: {
    flex: 1,
  },
  map: {
    width: '100%',
    height: '100%',
  },

  // Loading State
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  loadingGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContent: {
    alignItems: 'center',
    padding: 40,
  },
  loadingIconContainer: {
    marginBottom: 24,
  },
  loadingIconOuter: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: `${COLORS.primaryBlue}15`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 8,
  },
  loadingSubtitle: {
    fontSize: 15,
    color: COLORS.secondaryText,
    marginBottom: 20,
  },
  loadingDots: {
    marginTop: 10,
  },

  // FAB Buttons
  fabContainer: {
    position: 'absolute',
    right: 16,
    top: 16,
    gap: 10,
  },
  fab: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  // Custom Marker
  customMarkerContainer: {
    alignItems: 'center',
  },
  customMarkerOuter: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: COLORS.white,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
  },
  markerLive: {
    borderColor: COLORS.success,
    borderWidth: 3,
  },
  customMarkerInner: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  markerShadow: {
    width: 20,
    height: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.2)',
    marginTop: 2,
  },

  // Info Card
  infoCardContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 20 : 16,
  },
  infoCard: {
    backgroundColor: COLORS.white,
    borderRadius: 20,
    padding: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  // Card Header
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  updateTime: {
    fontSize: 13,
    color: COLORS.secondaryText,
    fontWeight: '500',
  },

  // Driver Info
  driverInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  driverAvatar: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  driverDetails: {
    flex: 1,
  },
  driverTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  driverSubtitle: {
    fontSize: 13,
    color: COLORS.secondaryText,
    marginTop: 2,
  },
  driverName: {
    fontSize: 13,
    color: COLORS.primaryBlue,
    fontWeight: '600',
    marginTop: 4,
  },

  // Metrics
  metricsContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}10`,
    padding: 14,
    borderRadius: 14,
    gap: 10,
  },
  metricCardAccent: {
    backgroundColor: COLORS.coralAccent,
  },
  metricTextContainer: {
    flex: 1,
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  metricLabel: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '500',
    marginTop: 1,
  },

  // Stale Warning
  staleWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: `${COLORS.warning}15`,
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    gap: 10,
  },
  staleText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.warning,
    fontWeight: '600',
    lineHeight: 18,
  },

  // Action Buttons
  actionButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryBlue,
    paddingVertical: 14,
    borderRadius: 14,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },
  secondaryButton: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: `${COLORS.primaryBlue}12`,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
  },

  // Error State
  errorContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
  },
  errorIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: `${COLORS.errorRed}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  errorTextContainer: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.errorRed,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 14,
    color: COLORS.secondaryText,
    lineHeight: 20,
  },

  // Waiting State
  waitingContent: {
    alignItems: 'center',
    padding: 8,
  },
  waitingIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${COLORS.secondaryText}10`,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  waitingTextContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  waitingTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 6,
  },
  waitingMessage: {
    fontSize: 14,
    color: COLORS.secondaryText,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 10,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: `${COLORS.primaryBlue}12`,
    borderRadius: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
  },
  contactButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.primaryBlue,
  },
});
