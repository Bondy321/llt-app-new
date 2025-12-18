import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  ScrollView,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { realtimeDb } from '../firebase'; // Import your DB instance
import { assignDriverToTour } from '../services/bookingServiceRealtime';

const COLORS = {
  primary: '#2C3E50',
  accent: '#E67E22',
  white: '#FFFFFF',
  bg: '#F5F6FA',
  success: '#27AE60',
  danger: '#C0392B',
  info: '#3498DB',
  location: '#2980B9', // Blue for location
  purple: '#8E44AD'
};

export default function DriverHomeScreen({ driverData, onLogout, onNavigate }) {
  const [updatingLocation, setUpdatingLocation] = useState(false);
  
  // Modal State for Joining Tour
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [inputTourCode, setInputTourCode] = useState('');
  const [joining, setJoining] = useState(false);

  // Derive active tour from props (updates when driverData changes)
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

  const handleOpenDriverChat = () => {
    if (!activeTourId) {
      Alert.alert("No Tour", "You need an active tour to access the driver chat.");
      return;
    }

    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true,
      driverName: driverData?.name || 'Driver',
      internalDriverChat: true,
    });
  };

  // --- NEW: Join Tour Logic ---
  const handleJoinTour = async () => {
    if (!inputTourCode.trim()) {
      Alert.alert("Required", "Please enter a valid Tour Code (e.g., 5112D 8)");
      return;
    }

    setJoining(true);
    try {
      // 1. Call Service
      // NOTE: Ensure driverData.id exists. If using 'driver' login type, it should be in driverData.id
      const driverId = driverData.id; 
      
      await assignDriverToTour(driverId, inputTourCode);
      
      Alert.alert("Success", `You are now assigned to tour: ${inputTourCode}`);
      setJoinModalVisible(false);
      setInputTourCode('');
      
      // Note: The parent App.js usually manages 'bookingData' (driverData). 
      // Ideally, we should reload the driver profile here or trigger an app refresh.
      // For now, the user might need to pull-to-refresh or re-login to see the "Active Tour ID" text update 
      // unless App.js listens to the driver node changes. 
      
    } catch (error) {
      Alert.alert("Error", "Could not join tour. Check the code and try again.\n" + error.message);
    } finally {
      setJoining(false);
    }
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
        
        {/* --- INFO BOX (Top) --- */}
        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>Current Tour Assignment</Text>
          <View style={styles.tourIdRow}>
            <Text style={styles.infoValue}>{activeTourId || 'NO TOUR ASSIGNED'}</Text>
            <TouchableOpacity onPress={() => setJoinModalVisible(true)}>
               <Text style={styles.changeLink}>Change</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* --- ACTION GRID --- */}
        <View style={styles.grid}>
            {/* Update Location */}
            <TouchableOpacity 
              style={[styles.bigButton, { backgroundColor: COLORS.location }]}
              onPress={handleUpdateLocation}
              disabled={updatingLocation}
            >
              {updatingLocation ? <ActivityIndicator color="white"/> : <MaterialCommunityIcons name="map-marker-radius" size={40} color="white" style={{marginBottom: 8}}/>}
              <Text style={styles.bigButtonText}>{updatingLocation ? "UPDATING..." : "SET PICKUP"}</Text>
            </TouchableOpacity>

            {/* Group Chat */}
            <TouchableOpacity
              style={[styles.bigButton, { backgroundColor: COLORS.info }]}
              onPress={handleOpenChat}
            >
              <MaterialCommunityIcons name="chat-processing" size={40} color="white" style={{marginBottom: 8}}/>
              <Text style={styles.bigButtonText}>GROUP CHAT</Text>
            </TouchableOpacity>
        </View>

        {/* --- FULL WIDTH BUTTONS --- */}

        {/* Driver Chat */}
        <TouchableOpacity
            style={[styles.wideButton, { backgroundColor: COLORS.primary }]}
            onPress={handleOpenDriverChat}
        >
            <MaterialCommunityIcons name="radio-handheld" size={28} color="white" style={{marginRight: 10}}/>
            <Text style={styles.wideButtonText}>DRIVER CHAT</Text>
        </TouchableOpacity>
        
        {/* Manifest Button */}
        <TouchableOpacity 
            style={[styles.wideButton, { backgroundColor: '#2980B9' }]}
            onPress={() => {
                if(!activeTourId) { Alert.alert("No Tour", "Please Join a Tour first."); return;}
                onNavigate('PassengerManifest', { tourId: activeTourId });
            }}
        >
            <MaterialCommunityIcons name="clipboard-list-outline" size={28} color="white" style={{marginRight: 10}}/>
            <Text style={styles.wideButtonText}>PASSENGER MANIFEST</Text>
        </TouchableOpacity>

        {/* Itinerary Button */}
        <TouchableOpacity 
            style={[styles.wideButton, { backgroundColor: COLORS.purple }]}
            onPress={() => onNavigate('Itinerary', { tourId: activeTourId, isDriver: true })}
        >
            <MaterialCommunityIcons name="calendar-edit" size={28} color="white" style={{marginRight: 10}}/>
            <Text style={styles.wideButtonText}>EDIT ITINERARY</Text>
        </TouchableOpacity>
      </ScrollView>
      {/* --- JOIN TOUR MODAL --- */}
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
                <TouchableOpacity onPress={() => setJoinModalVisible(false)}>
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
            />

            <TouchableOpacity 
                style={[styles.modalBtn, { backgroundColor: COLORS.success }]}
                onPress={handleJoinTour}
                disabled={joining}
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
    backgroundColor: COLORS.info,
    elevation: 3,
    shadowOpacity: 0.2,
    shadowOffset: {width:0, height:2}
  },
  bigButtonText: { color: COLORS.white, fontSize: 13, fontWeight: '800', marginTop: 5 },

  wideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    borderRadius: 12,
    marginBottom: 15,
    elevation: 2,
    shadowOpacity: 0.1,
    shadowOffset: {width:0, height:2}
  },
  wideButtonText: { fontSize: 16, fontWeight: '800', color: COLORS.white, letterSpacing: 0.5 },
  
  // Info Box Styles
  infoBox: { 
    backgroundColor: 'white', 
    padding: 15, 
    borderRadius: 10, 
    marginBottom: 20,
    borderLeftWidth: 5,
    borderLeftColor: COLORS.primary
  },
  infoLabel: { color: '#95A5A6', fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase' },
  tourIdRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 },
  infoValue: { color: COLORS.primary, fontSize: 18, fontWeight: 'bold' },
  changeLink: { color: COLORS.info, fontWeight: 'bold', fontSize: 14 },

  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 15,
    padding: 20,
    elevation: 5
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: COLORS.primary },
  modalDesc: { color: '#7F8C8D', marginBottom: 20, lineHeight: 20 },
  input: {
    backgroundColor: '#F5F6FA',
    padding: 15,
    borderRadius: 8,
    fontSize: 18,
    borderWidth: 1,
    borderColor: '#DCDCDC',
    marginBottom: 20
  },
  modalBtn: {
    padding: 18,
    borderRadius: 10,
    alignItems: 'center'
  },
  modalBtnText: { color: 'white', fontWeight: 'bold', fontSize: 16 }
});
