import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, spacing, radius, shadows, text as textStyles } from '../theme';

const palette = colors;

const STATUS_COLORS = {
  PENDING: palette.muted,
  BOARDED: palette.success,
  NO_SHOW: palette.danger,
  PARTIAL: palette.accent
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
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderLeftWidth: 5,
    borderWidth: 1,
    borderColor: palette.border,
    ...shadows.subtle,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  refContainer: {
    backgroundColor: palette.primaryMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  refText: {
    ...textStyles.caption,
    fontWeight: '800',
    color: palette.graphite,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  badgeText: {
    color: palette.surface,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  mainContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leadName: {
    ...textStyles.title,
    color: palette.ink,
  },
  subNames: {
    fontSize: 13,
    color: palette.steel,
    marginTop: 2,
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  locationText: {
    fontSize: 12,
    color: palette.steel,
    marginLeft: 4,
    maxWidth: 200,
  },
  paxCounter: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cardSoft,
    padding: spacing.sm,
    borderRadius: radius.md,
    minWidth: 44,
  },
  paxCountText: {
    fontSize: 16,
    fontWeight: '800',
    color: palette.ink,
  }
});
