import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  ScrollView
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const COLORS = {
  primary: '#2C3E50', // Darker, professional color for drivers
  accent: '#E67E22', // Orange for actions
  white: '#FFFFFF',
  bg: '#F5F6FA',
  success: '#27AE60',
  danger: '#C0392B',
  info: '#3498DB'
};

export default function DriverHomeScreen({ driverData, onLogout, onNavigate }) {
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const activeTourId = driverData?.assignedTourId || '';

  // Simple toggle to simulate "Going Live"
  const toggleBroadcast = async () => {
    if (!activeTourId) {
      Alert.alert("No Tour Selected", "Please contact operations to assign a Tour ID.");
      return;
    }

    const newState = !isBroadcasting;
    setIsBroadcasting(newState);

    if (newState) {
      // Logic to start expo-location background task would go here
      Alert.alert("Live Tracking Started", "Passengers can now see your location.");
    } else {
      // Logic to stop task
      Alert.alert("Tracking Stopped", "You are off the grid.");
    }
  };

  const handleOpenChat = () => {
    if (!activeTourId) {
      Alert.alert("No Tour", "You need an active tour to access the chat.");
      return;
    }
    // Navigate to ChatScreen with specific driver params
    onNavigate('Chat', {
      tourId: activeTourId,
      isDriver: true, // IMPORTANT FLAG
      driverName: driverData?.name || 'Driver'
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Driver Header */}
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
        {/* Status Card */}
        <View style={[styles.card, isBroadcasting ? styles.cardActive : styles.cardInactive]}>
          <Text style={styles.statusLabel}>STATUS</Text>
          <View style={styles.statusRow}>
            <MaterialCommunityIcons 
              name={isBroadcasting ? "broadcast" : "broadcast-off"} 
              size={32} 
              color={isBroadcasting ? COLORS.success : COLORS.danger} 
            />
            <Text style={styles.statusText}>
              {isBroadcasting ? "LIVE BROADCASTING" : "OFFLINE"}
            </Text>
          </View>
        </View>

        {/* Action Buttons Grid */}
        <View style={styles.grid}>
            {/* Toggle Tracking */}
            <TouchableOpacity 
            style={[styles.bigButton, { backgroundColor: isBroadcasting ? COLORS.danger : COLORS.success }]}
            onPress={toggleBroadcast}
            activeOpacity={0.8}
            >
            <MaterialCommunityIcons 
                name={isBroadcasting ? "stop-circle-outline" : "play-circle-outline"} 
                size={32} 
                color={COLORS.white} 
                style={{marginBottom: 8}}
            />
            <Text style={styles.bigButtonText}>
                {isBroadcasting ? "STOP TRACKING" : "START TOUR"}
            </Text>
            </TouchableOpacity>

            {/* Open Chat */}
            <TouchableOpacity 
            style={[styles.bigButton, { backgroundColor: COLORS.info }]}
            onPress={handleOpenChat}
            activeOpacity={0.8}
            >
            <MaterialCommunityIcons 
                name="chat-processing" 
                size={32} 
                color={COLORS.white} 
                style={{marginBottom: 8}}
            />
            <Text style={styles.bigButtonText}>GROUP CHAT</Text>
            </TouchableOpacity>
        </View>

        {/* Info */}
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
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 24,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    borderLeftWidth: 6,
  },
  cardActive: { borderLeftColor: COLORS.success },
  cardInactive: { borderLeftColor: COLORS.danger },
  statusLabel: { color: '#7F8C8D', fontSize: 12, fontWeight: '700', marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusText: { fontSize: 20, fontWeight: '800', color: '#2C3E50' },
  
  grid: { flexDirection: 'row', gap: 15, marginBottom: 30 },
  bigButton: {
    flex: 1,
    paddingVertical: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
    aspectRatio: 1, // Make them square-ish
  },
  bigButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '900', letterSpacing: 0.5, textAlign: 'center' },
  
  infoBox: { marginTop: 10, alignItems: 'center' },
  infoLabel: { color: '#95A5A6', fontSize: 14 },
  infoValue: { color: COLORS.primary, fontSize: 16, fontWeight: '600', marginTop: 4 },
});