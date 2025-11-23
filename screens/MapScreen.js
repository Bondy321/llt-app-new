// screens/MapScreen.js
import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Platform
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  secondaryText: '#4A5568',
  appBackground: '#F0F4F8',
  mapPlaceholderBackground: '#D8E2EB',
  mapHeaderColor: '#FF7757',
};

export default function MapScreen({ onBack }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.mapHeaderColor }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Live Driver Location</Text>
        <View style={styles.headerButton} />
      </View>
      
      <View style={styles.container}>
        <View style={styles.mapPlaceholder}>
          <MaterialCommunityIcons name="map-marker" size={60} color={COLORS.primaryBlue} />
          <Text style={styles.placeholderText}>Map View</Text>
          <Text style={styles.placeholderSubtext}>Driver location tracking will appear here</Text>
        </View>
        
        <View style={styles.locationCard}>
          <MaterialCommunityIcons name="bus-marker" size={30} color={COLORS.primaryBlue} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.locationTitle}>Driver Location</Text>
            <Text style={styles.locationDescription}>
              Your driver is currently at Luss Pier, ready for your loch-side exploration!
            </Text>
            <Text style={styles.locationTime}>Last updated: 2 minutes ago</Text>
          </View>
        </View>
        
        <Text style={styles.disclaimerText}>
          Location is updated periodically. For real-time tracking, please enable location services.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === 'ios' ? 12 : 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  headerButton: {
    padding: 5,
    minWidth: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.white,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 25,
    paddingHorizontal: 15,
  },
  mapPlaceholder: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 18,
    backgroundColor: COLORS.mapPlaceholderBackground,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 25,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 6,
  },
  placeholderText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginTop: 15,
  },
  placeholderSubtext: {
    fontSize: 16,
    color: COLORS.secondaryText,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  locationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    padding: 20,
    borderRadius: 15,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
  },
  locationTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: COLORS.primaryBlue,
    marginBottom: 5,
  },
  locationDescription: {
    fontSize: 14,
    color: COLORS.secondaryText,
    lineHeight: 20,
    marginBottom: 5,
  },
  locationTime: {
    fontSize: 12,
    color: COLORS.secondaryText,
    opacity: 0.7,
  },
  disclaimerText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    opacity: 0.7,
    textAlign: 'center',
    marginTop: 20,
    paddingHorizontal: 10,
  },
});