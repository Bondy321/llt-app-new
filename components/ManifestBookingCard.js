import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const STATUS_COLORS = {
  PENDING: '#95A5A6',
  BOARDED: '#27AE60',
  NO_SHOW: '#C0392B',
  PARTIAL: '#E67E22'
};

const STATUS_ICONS = {
  PENDING: 'checkbox-blank-circle-outline',
  BOARDED: 'check-circle',
  NO_SHOW: 'close-circle',
  PARTIAL: 'minus-circle'
};

export default function ManifestBookingCard({ booking, onPress, isSearchResult }) {
  const status = booking.status || 'PENDING';
  const color = STATUS_COLORS[status];
  const passengerCount = booking.passengerNames?.length || 0;
  
  // Format names for display
  const primaryName = booking.passengerNames?.[0] || 'Unknown Passenger';
  const otherNames = booking.passengerNames?.slice(1).join(', ');

  return (
    <TouchableOpacity 
      style={[styles.card, { borderLeftColor: color }]} 
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.headerRow}>
        <View style={styles.refContainer}>
          <Text style={styles.refText}>{booking.id}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: color }]}>
          <Text style={styles.badgeText}>{status.replace('_', ' ')}</Text>
        </View>
      </View>

      <View style={styles.mainContent}>
        <View style={{ flex: 1 }}>
          <Text style={styles.leadName}>{primaryName}</Text>
          {otherNames ? (
            <Text style={styles.subNames} numberOfLines={1}>+ {otherNames}</Text>
          ) : null}
          
          {/* Show Pickup Info only if we are in search mode (context is lost otherwise) */}
          {isSearchResult && (
             <View style={styles.locationContainer}>
               <MaterialCommunityIcons name="map-marker" size={14} color="#7F8C8D" />
               <Text style={styles.locationText} numberOfLines={1}>
                 {booking.pickupLocation}
               </Text>
             </View>
          )}
        </View>

        <View style={styles.paxCounter}>
          <MaterialCommunityIcons name="account-group" size={20} color="#34495E" />
          <Text style={styles.paxCountText}>{passengerCount}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderLeftWidth: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  refContainer: {
    backgroundColor: '#ECF0F1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  refText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#7F8C8D',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  badgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  mainContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leadName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2C3E50',
  },
  subNames: {
    fontSize: 13,
    color: '#7F8C8D',
    marginTop: 2,
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  locationText: {
    fontSize: 12,
    color: '#7F8C8D',
    marginLeft: 4,
    maxWidth: 200,
  },
  paxCounter: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5F6FA',
    padding: 8,
    borderRadius: 8,
    minWidth: 40,
  },
  paxCountText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2C3E50',
  }
});