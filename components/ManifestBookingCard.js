import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS as THEME, STATUS_COLORS as THEME_STATUS } from '../theme';

const STATUS_COLORS = {
  PENDING: THEME_STATUS.pending.main,
  BOARDED: THEME_STATUS.boarded.main,
  NO_SHOW: THEME_STATUS.noShow.main,
  PARTIAL: THEME_STATUS.partial.main
};

const STATUS_ICONS = {
  PENDING: 'checkbox-blank-circle-outline',
  BOARDED: 'check-circle',
  NO_SHOW: 'close-circle',
  PARTIAL: 'minus-circle'
};

export default function ManifestBookingCard({ booking, onPress, isSearchResult, syncState = 'synced' }) {
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
        <View style={styles.badgeStack}>
          <View style={[styles.badge, { backgroundColor: `${color}1A`, borderColor: `${color}60` }]}>
            <Text style={[styles.badgeText, { color }]}>{status.replace('_', ' ')}</Text>
          </View>
          <Text style={styles.syncText}>{syncState}</Text>
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
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderLeftWidth: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  refContainer: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  refText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#475569',
  },
  badgeStack: { alignItems: 'flex-end' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    borderWidth: 1,
  },
  syncText: { fontSize: 10, color: '#64748B', marginTop: 2, textTransform: 'uppercase' },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  mainContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leadName: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F172A',
  },
  subNames: {
    fontSize: 13,
    color: '#475569',
    marginTop: 2,
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  locationText: {
    fontSize: 12,
    color: '#475569',
    marginLeft: 4,
    maxWidth: 200,
  },
  paxCounter: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    padding: 10,
    borderRadius: 12,
    minWidth: 40,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  paxCountText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  }
});
