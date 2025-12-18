import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Platform,
  ActivityIndicator,
  Dimensions
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { realtimeDb } from '../firebase'; // Ensure this import is correct

const { width, height } = Dimensions.get('window');

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  secondaryText: '#4A5568',
  appBackground: '#F0F4F8',
  mapHeaderColor: '#FF7757',
  errorRed: '#E53E3E',
};

export default function MapScreen({ onBack, tourId }) { // Expect tourId prop
  const [driverLocation, setDriverLocation] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const mapRef = useRef(null);

  // 1. Get User's Own Location
  useEffect(() => {
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permission to access location was denied');
        setLoading(false);
        return;
      }

      let location = await Location.getCurrentPositionAsync({});
      setUserLocation(location.coords);
    })();
  }, []);

  // 2. Subscribe to Driver Location from Firebase
  useEffect(() => {
    if (!tourId) return;

    const locationRef = realtimeDb.ref(`tours/${tourId}/driverLocation`);
    
    const unsubscribe = locationRef.on('value', (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        setDriverLocation(data);
      }
      setLoading(false);
    });

    return () => locationRef.off('value', unsubscribe);
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
    if (!isoString) return '';
    const timestamp = new Date(isoString).getTime();
    if (Number.isNaN(timestamp)) return '';

    const diffMinutes = Math.floor((Date.now() - timestamp) / 60000);
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
    if (!isoString) return '';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const estimateEtaMinutes = (distanceKm) => {
    if (!distanceKm) return null;
    const averageSpeedKmh = 35; // Highland roads are slower; keep ETA conservative
    const minutes = Math.round((distanceKm / averageSpeedKmh) * 60);
    return Math.max(minutes, 2); // Never show zero-minute arrivals
  };

  const driverHasLocation = Boolean(driverLocation);
  const formattedDriverTime = driverLocation ? formatTime(driverLocation.timestamp) : '';
  const relativeUpdateTime = driverLocation ? formatRelativeTime(driverLocation.timestamp) : '';
  const isStale = driverLocation
    ? (Date.now() - new Date(driverLocation.timestamp).getTime()) / 60000 > 10
    : false;
  const distanceKm = driverLocation && userLocation
    ? calculateDistanceKm(driverLocation, userLocation)
    : null;
  const etaMinutes = distanceKm ? estimateEtaMinutes(distanceKm) : null;

  useEffect(() => {
    if (mapRef.current && (driverLocation || userLocation)) {
      const coordinates = [];
      if (driverLocation) {
        coordinates.push({ latitude: driverLocation.latitude, longitude: driverLocation.longitude });
      }
      if (userLocation) {
        coordinates.push({ latitude: userLocation.latitude, longitude: userLocation.longitude });
      }

      if (coordinates.length > 0) {
        mapRef.current.fitToCoordinates(coordinates, {
          edgePadding: { top: 80, right: 80, bottom: 200, left: 80 },
          animated: true,
        });
      }
    }
  }, [driverLocation, userLocation]);

  // Determine initial region
  const getInitialRegion = () => {
    if (driverLocation) {
      return {
        latitude: driverLocation.latitude,
        longitude: driverLocation.longitude,
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

  const handleRecenter = () => {
    if (!mapRef.current) return;

    if (driverLocation && userLocation) {
      mapRef.current.fitToCoordinates([
        { latitude: driverLocation.latitude, longitude: driverLocation.longitude },
        { latitude: userLocation.latitude, longitude: userLocation.longitude },
      ], {
        edgePadding: { top: 80, right: 80, bottom: 200, left: 80 },
        animated: true,
      });
      return;
    }

    const region = getInitialRegion();
    mapRef.current.animateToRegion(region, 750);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.mapHeaderColor }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Find My Bus</Text>
        <View style={styles.headerButton} />
      </View>
      
      <View style={styles.container}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={COLORS.primaryBlue} />
            <Text style={{marginTop: 10}}>Locating bus...</Text>
          </View>
        ) : (
          <>
            <MapView
              style={styles.map}
              provider={PROVIDER_GOOGLE}
              initialRegion={getInitialRegion()}
              showsUserLocation={true}
              showsMyLocationButton={true}
              ref={mapRef}
            >
              {driverLocation && (
                <Marker
                  coordinate={{
                    latitude: driverLocation.latitude,
                    longitude: driverLocation.longitude,
                  }}
                  title="Bus Pickup Point"
                  description={`Updated at ${formattedDriverTime || 'Not available'}`}
                >
                  <View style={styles.customMarker}>
                    <MaterialCommunityIcons name="bus" size={24} color={COLORS.white} />
                  </View>
                </Marker>
              )}
            </MapView>

            <TouchableOpacity style={styles.recenterButton} onPress={handleRecenter} activeOpacity={0.85}>
              <MaterialCommunityIcons name="crosshairs-gps" size={24} color={COLORS.white} />
            </TouchableOpacity>

            {/* Info Card Overlay */}
            <View style={styles.infoCard}>
              {errorMsg ? (
                <View style={styles.infoContent}>
                  <MaterialCommunityIcons name="alert-circle" size={28} color={COLORS.errorRed} style={{ marginRight: 10 }} />
                  <Text style={styles.infoDetail}>{errorMsg}</Text>
                </View>
              ) : driverHasLocation ? (
                <>
                  <View style={styles.infoContent}>
                    <View style={styles.infoIcon}>
                      <MaterialCommunityIcons name="map-marker-check" size={28} color={COLORS.primaryBlue} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.infoTitle}>Bus Location Set</Text>
                      <Text style={styles.infoSubtitle}>
                        Last update: {formattedDriverTime || 'Not available'} ({relativeUpdateTime})
                      </Text>
                      <Text style={styles.infoDetail}>
                        Head to the marker on the map for pickup.
                      </Text>
                    </View>
                  </View>

                  {(distanceKm || etaMinutes) && (
                    <View style={styles.metricRow}>
                      {distanceKm && (
                        <View style={styles.metricPill}>
                          <MaterialCommunityIcons name="map-marker-distance" size={20} color={COLORS.primaryBlue} />
                          <Text style={styles.metricText}>{distanceKm.toFixed(1)} km from you</Text>
                        </View>
                      )}
                      {etaMinutes && (
                        <View style={[styles.metricPill, styles.etaPill]}>
                          <MaterialCommunityIcons name="clock-fast" size={20} color={COLORS.white} />
                          <Text style={[styles.metricText, { color: COLORS.white }]}>~{etaMinutes} min drive</Text>
                        </View>
                      )}
                    </View>
                  )}

                  {isStale && (
                    <View style={styles.staleBox}>
                      <MaterialCommunityIcons name="alert" size={22} color={COLORS.errorRed} />
                      <Text style={styles.staleText}>
                        The last update is over 10 minutes old. Please call dispatch to confirm pickup status.
                      </Text>
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.infoContent}>
                  <MaterialCommunityIcons name="bus-clock" size={28} color={COLORS.secondaryText} style={{marginRight: 10}} />
                  <Text style={styles.infoDetail}>
                    Waiting for driver to set a pickup location...
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.appBackground },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === 'ios' ? 12 : 15,
    zIndex: 10,
  },
  headerButton: { padding: 5, minWidth: 40 },
  headerTitle: { fontSize: 20, fontWeight: '600', color: COLORS.white },
  
  container: { flex: 1, position: 'relative' },
  map: { width: width, height: '100%' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  recenterButton: {
    position: 'absolute',
    right: 20,
    top: 80,
    backgroundColor: COLORS.primaryBlue,
    padding: 12,
    borderRadius: 24,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },

  customMarker: {
    backgroundColor: COLORS.primaryBlue,
    padding: 8,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: COLORS.white,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  
  infoCard: {
    position: 'absolute',
    bottom: 30,
    left: 20,
    right: 20,
    backgroundColor: COLORS.white,
    borderRadius: 15,
    padding: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  infoContent: { flexDirection: 'row', alignItems: 'center' },
  infoIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E1F0FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  infoTitle: { fontSize: 16, fontWeight: 'bold', color: COLORS.darkText },
  infoSubtitle: { fontSize: 13, color: COLORS.secondaryText, marginTop: 2, fontWeight: '600' },
  infoDetail: { fontSize: 13, color: COLORS.secondaryText, marginTop: 4, flex: 1 },
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 15,
  },
  metricPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#E1F0FF',
  },
  etaPill: {
    backgroundColor: COLORS.coralAccent,
  },
  metricText: {
    color: COLORS.darkText,
    fontWeight: '600',
  },
  staleBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#FFF5F5',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  staleText: {
    color: COLORS.errorRed,
    flex: 1,
    lineHeight: 18,
    fontWeight: '600',
  },
});
