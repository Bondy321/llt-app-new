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
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { realtimeDb } from '../firebase'; // Import your DB instance
import { assignDriverToTour } from '../services/bookingServiceRealtime';

const COLORS = {
  primary: '#0B5ED7',
  midnight: '#0F172A',
  slate: '#1F2937',
  white: '#FFFFFF',
  bg: '#F4F7FB',
  success: '#22C55E',
  danger: '#EF4444',
  info: '#2563EB',
  location: '#0EA5E9',
  purple: '#7C3AED',
  border: '#E2E8F0',
  text: '#111827',
  muted: '#6B7280',
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
      <LinearGradient
        colors={[`${COLORS.primary}0D`, COLORS.bg]}
        style={{ flex: 1 }}
      >
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
          <TouchableOpacity onPress={onLogout} style={styles.iconButton}>
            <MaterialCommunityIcons name="logout" size={22} color={COLORS.primary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.assignCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>Active tour</Text>
              <Text style={styles.cardValue}>{activeTourId || 'No tour assigned'}</Text>
              <Text style={styles.cardHint}>Stay assigned to keep chat and manifests in sync.</Text>
            </View>
            <TouchableOpacity style={styles.pillButton} onPress={() => setJoinModalVisible(true)}>
              <MaterialCommunityIcons name="swap-horizontal" size={18} color={COLORS.white} />
              <Text style={styles.pillButtonText}>Change</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.grid}>
            <TouchableOpacity 
              style={[styles.bigButton, styles.primaryTile]}
              onPress={handleUpdateLocation}
              disabled={updatingLocation}
              activeOpacity={0.9}
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
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.bigButton, styles.chatTile]}
              onPress={handleOpenChat}
              activeOpacity={0.9}
            >
              <View style={[styles.tileIconCircle, { backgroundColor: '#EEF2FF' }]}>
                <MaterialCommunityIcons name="chat-processing" size={30} color={COLORS.info} />
              </View>
              <Text style={[styles.bigButtonTitle, { color: COLORS.text }]}>Group chat</Text>
              <Text style={[styles.bigButtonSubtitle, { color: COLORS.muted }]}>Message passengers</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.stackButtons}>
            <TouchableOpacity
              style={[styles.wideButton, styles.outlineButton]}
              onPress={handleOpenDriverChat}
              activeOpacity={0.9}
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
              onPress={() => onNavigate('SafetySupport', { from: 'DriverHome', mode: 'driver' })}
              activeOpacity={0.9}
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
                if(!activeTourId) { Alert.alert("No Tour", "Please Join a Tour first."); return;}
                onNavigate('PassengerManifest', { tourId: activeTourId });
              }}
              activeOpacity={0.9}
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
              onPress={() => onNavigate('Itinerary', { tourId: activeTourId, isDriver: true })}
              activeOpacity={0.9}
            >
              <MaterialCommunityIcons name="calendar-edit" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.wideTitle, { color: COLORS.white }]}>Edit itinerary</Text>
                <Text style={[styles.wideSubtitle, { color: '#EDE9FE' }]}>Keep passengers up to date</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </LinearGradient>
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
  assignCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
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
  wideTitle: { fontSize: 16, fontWeight: '800', color: COLORS.text },
  wideSubtitle: { fontSize: 13, color: COLORS.muted },
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
  modalBtnText: { color: COLORS.white, fontWeight: '800', fontSize: 15 }
});
