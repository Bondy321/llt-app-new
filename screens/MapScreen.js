import React, { useState, useEffect } from 'react';
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
};

export default function MapScreen({ onBack, tourId }) { // Expect tourId prop
  const [driverLocation, setDriverLocation] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);

  // 1. Get User's Own Location
  useEffect(() => {
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permission to access location was denied');
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

  const formatTime = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
            >
              {driverLocation && (
                <Marker
                  coordinate={{
                    latitude: driverLocation.latitude,
                    longitude: driverLocation.longitude,
                  }}
                  title="Bus Pickup Point"
                  description={`Updated at ${formatTime(driverLocation.timestamp)}`}
                >
                  <View style={styles.customMarker}>
                    <MaterialCommunityIcons name="bus" size={24} color={COLORS.white} />
                  </View>
                </Marker>
              )}
            </MapView>

            {/* Info Card Overlay */}
            <View style={styles.infoCard}>
              {driverLocation ? (
                <View style={styles.infoContent}>
                  <View style={styles.infoIcon}>
                    <MaterialCommunityIcons name="map-marker-check" size={28} color={COLORS.primaryBlue} />
                  </View>
                  <View>
                    <Text style={styles.infoTitle}>Bus Location Set</Text>
                    <Text style={styles.infoSubtitle}>
                      Last update: {formatTime(driverLocation.timestamp)}
                    </Text>
                    <Text style={styles.infoDetail}>
                      Head to the marker on the map for pickup.
                    </Text>
                  </View>
                </View>
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
});
