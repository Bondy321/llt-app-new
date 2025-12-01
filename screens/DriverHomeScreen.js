import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  ScrollView,
  ActivityIndicator
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { realtimeDb } from '../firebase'; // Import your DB instance

const COLORS = {
  primary: '#2C3E50',
  accent: '#E67E22',
  white: '#FFFFFF',
  bg: '#F5F6FA',
  success: '#27AE60',
  danger: '#C0392B',
  info: '#3498DB',
  location: '#2980B9' // Blue for location
};

export default function DriverHomeScreen({ driverData, onLogout, onNavigate }) {
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const activeTourId = driverData?.assignedTourId || '';

  // Function to capture and save location
  const handleUpdateLocation = async () => {
    if (!activeTourId) {
      Alert.alert("No Tour", "You must have an assigned tour to share location.");
      return;
    }

    setUpdatingLocation(true);

    try {
      // 1. Request Permission
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Allow location access to share your pickup point.');
        setUpdatingLocation(false);
        return;
      }

      // 2. Get Coordinates
      let location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High
      });

      const { latitude, longitude } = location.coords;
      const timestamp = new Date().toISOString();

      // 3. Write to Firebase
      // We write to a specific 'driverLocation' node under the tour
      await realtimeDb.ref(`tours/${activeTourId}/driverLocation`).set({
        latitude,
        longitude,
        timestamp,
        updatedBy: driverData.name
      });

      setLastUpdate(new Date());
      Alert.alert("Location Updated", "Passengers can now see your current position on the map.");

    } catch (error) {
      console.error(error);
      Alert.alert("Error", "Could not update location. Please try again.");
    } finally {
      setUpdatingLocation(false);
    }
  };

  const handleOpenChat = () => {
    if (!activeTourId) {
      Alert.alert("No Tour", "You need an active tour to access the chat.");
      return;
    }
    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true,
      driverName: driverData?.name || 'Driver'
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Driver Console</Text>
          <Text style={styles.driverName}>{driverData?.name || 'Unknown Driver'}</Text>
        </View>
        <TouchableOpacity onPress={onLogout} style={styles.logoutBtn}>
          <MaterialCommunityIcons name="logout" size={24} color={COLORS.white} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* ACTION GRID */}
        <View style={styles.grid}>
            {/* Update Location Button */}
            <TouchableOpacity 
              style={[styles.bigButton, { backgroundColor: COLORS.location }]}
              onPress={handleUpdateLocation}
              activeOpacity={0.8}
              disabled={updatingLocation}
            >
              {updatingLocation ? (
                <ActivityIndicator color={COLORS.white} size="large" />
              ) : (
                <MaterialCommunityIcons 
                    name="map-marker-radius" 
                    size={40} 
                    color={COLORS.white} 
                    style={{marginBottom: 8}}
                />
              )}
              <Text style={styles.bigButtonText}>
                {updatingLocation ? "UPDATING..." : "SET PICKUP POINT"}
              </Text>
              {lastUpdate && (
                <Text style={styles.lastUpdateText}>
                  Last: {lastUpdate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </Text>
              )}
            </TouchableOpacity>

            {/* Open Chat */}
            <TouchableOpacity 
              style={[styles.bigButton, { backgroundColor: COLORS.info }]}
              onPress={handleOpenChat}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons 
                  name="chat-processing" 
                  size={40} 
                  color={COLORS.white} 
                  style={{marginBottom: 8}}
              />
              <Text style={styles.bigButtonText}>GROUP CHAT</Text>
            </TouchableOpacity>
        </View>

        {/* Edit Itinerary Button (Full Width) */}
        <TouchableOpacity 
            style={[styles.wideButton, { backgroundColor: '#8E44AD' }]}
            onPress={() => onNavigate('Itinerary', { 
                tourId: activeTourId, 
                isDriver: true 
            })}
            activeOpacity={0.8}
        >
            <MaterialCommunityIcons 
                name="calendar-edit" 
                size={28} 
                color={COLORS.white} 
                style={{marginRight: 10}}
            />
            <Text style={styles.wideButtonText}>EDIT ITINERARY</Text>
        </TouchableOpacity>

        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>Active Tour ID:</Text>
          <Text style={styles.infoValue}>{activeTourId || 'None Assigned'}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    backgroundColor: COLORS.primary,
    padding: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  greeting: { color: '#BDC3C7', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  driverName: { color: COLORS.white, fontSize: 20, fontWeight: 'bold' },
  logoutBtn: { padding: 8 },
  content: { padding: 20 },
  
  grid: { flexDirection: 'row', gap: 15, marginBottom: 15 },
  bigButton: {
    flex: 1,
    paddingVertical: 25,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    aspectRatio: 0.9,
  },
  bigButtonText: { color: COLORS.white, fontSize: 14, fontWeight: '800', letterSpacing: 0.5, textAlign: 'center', marginTop: 5 },
  lastUpdateText: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 4 },

  wideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    paddingVertical: 18,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    marginBottom: 20,
  },
  wideButtonText: { fontSize: 16, fontWeight: '800', color: COLORS.white, letterSpacing: 0.5 },
  
  infoBox: { marginTop: 10, alignItems: 'center' },
  infoLabel: { color: '#95A5A6', fontSize: 14 },
  infoValue: { color: COLORS.primary, fontSize: 16, fontWeight: '600', marginTop: 4 },
});
