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
import { colors, spacing, radius, shadows, text as textStyles } from '../theme';

const palette = colors;

const COLORS = {
  primary: palette.primary,
  accent: palette.accent,
  white: palette.surface,
  bg: palette.background,
  success: palette.success,
  danger: palette.danger,
  info: palette.primary,
  location: palette.primary,
  purple: '#6B5AED',
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

        {/* Safety & Support */}
        <TouchableOpacity
            style={[styles.wideButton, { backgroundColor: COLORS.danger }]}
            onPress={() => onNavigate('SafetySupport', { from: 'DriverHome', mode: 'driver' })}
        >
            <MaterialCommunityIcons name="shield-check" size={28} color="white" style={{marginRight: 10}}/>
            <Text style={styles.wideButtonText}>SAFETY & SUPPORT</Text>
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
    backgroundColor: COLORS.white,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    borderBottomWidth: 1,
    borderColor: palette.border,
    ...shadows.soft,
  },
  greeting: { ...textStyles.caption, color: palette.steel, letterSpacing: 0.8 },
  driverName: { ...textStyles.heading, fontSize: 22 },
  logoutBtn: { padding: spacing.sm, backgroundColor: palette.primary, borderRadius: radius.sm },
  content: { padding: spacing.lg },

  grid: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  bigButton: {
    flex: 1,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.info,
    ...shadows.soft,
  },
  bigButtonText: { color: COLORS.white, fontSize: 14, fontWeight: '800', marginTop: spacing.xs, letterSpacing: 0.5 },

  wideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    ...shadows.subtle,
  },
  wideButtonText: { fontSize: 16, fontWeight: '800', color: COLORS.white, letterSpacing: 0.3 },
  
  // Info Box Styles
  infoBox: { 
    backgroundColor: COLORS.white, 
    padding: spacing.md, 
    borderRadius: radius.lg, 
    marginBottom: spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.subtle,
  },
  infoLabel: { ...textStyles.caption, color: palette.steel },
  tourIdRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.xs },
  infoValue: { ...textStyles.title, color: palette.ink },
  changeLink: { color: COLORS.info, fontWeight: '700', fontSize: 14 },

  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadows.soft,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md },
  modalTitle: { ...textStyles.title, color: COLORS.primary },
  modalDesc: { color: palette.steel, marginBottom: spacing.md, lineHeight: 20 },
  input: {
    backgroundColor: palette.cardSoft,
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: 18,
    borderWidth: 1,
    borderColor: palette.border,
    marginBottom: spacing.md,
    color: palette.ink,
  },
  modalBtn: {
    padding: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center'
  },
  modalBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 }
});
