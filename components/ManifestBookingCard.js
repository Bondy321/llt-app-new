import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  COLORS as THEME,
  STATUS_COLORS as THEME_STATUS,
  SPACING,
  RADIUS,
  SHADOWS,
  FONT_WEIGHT,
} from '../theme';

const STATUS_COLORS = {
  PENDING: THEME_STATUS.pending.main,
  BOARDED: THEME_STATUS.boarded.main,
  NO_SHOW: THEME_STATUS.noShow.main,
  PARTIAL: THEME_STATUS.partial.main
};

const STATUS_LIGHT_COLORS = {
  PENDING: THEME_STATUS.pending.light,
  BOARDED: THEME_STATUS.boarded.light,
  NO_SHOW: THEME_STATUS.noShow.light,
  PARTIAL: THEME_STATUS.partial.light,
};

const STATUS_ICONS = {
  PENDING: 'checkbox-blank-circle-outline',
  BOARDED: 'check-circle',
  NO_SHOW: 'close-circle',
  PARTIAL: 'minus-circle'
};

const SYNC_META = {
  synced: {
    label: 'SYNCED',
    icon: 'cloud-check-variant',
    colors: THEME.sync.success,
  },
  queued: {
    label: 'QUEUED',
    icon: 'clock-outline',
    colors: THEME.sync.warning,
  },
  syncing: {
    label: 'SYNCING',
    icon: 'cloud-sync-outline',
    colors: THEME.sync.info,
  },
  failed: {
    label: 'FAILED',
    icon: 'cloud-alert-outline',
    colors: THEME.sync.critical,
  },
};

const getSyncMeta = (syncState) => SYNC_META[syncState] || SYNC_META.synced;

export default function ManifestBookingCard({ booking, onPress, isSearchResult, syncState = 'synced' }) {
  const status = booking.status || 'PENDING';
  const color = STATUS_COLORS[status];
  const statusIcon = STATUS_ICONS[status] || STATUS_ICONS.PENDING;
  const passengerCount = booking.passengerNames?.length || 0;
  const syncMeta = getSyncMeta(syncState);

  // Format names for display
  const primaryName = booking.passengerNames?.[0] || 'Unknown Passenger';
  const otherNames = booking.passengerNames?.slice(1).join(', ');
  const pickupTimeLabel = booking.pickupTime || 'TBA';
  const pickupLocationLabel = booking.pickupLocation || 'Pickup location unavailable';

  return (
    <TouchableOpacity
      style={[styles.card, { borderLeftColor: color }]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityLabel={`Booking ${booking.id}. ${status.replace('_', ' ')}. ${passengerCount} passengers.`}
      accessibilityHint="Opens boarding controls for this booking."
    >
      <View style={styles.headerRow}>
        <View style={styles.referenceCluster}>
          <View style={styles.refContainer}>
            <MaterialCommunityIcons name="ticket-confirmation-outline" size={13} color={THEME.primaryDark} />
            <Text style={styles.refText}>{booking.id}</Text>
          </View>

          <View style={[styles.badge, { backgroundColor: STATUS_LIGHT_COLORS[status] || `${color}1A`, borderColor: `${color}4D` }]}>
            <MaterialCommunityIcons name={statusIcon} size={13} color={color} />
            <Text style={[styles.badgeText, { color }]}>{status.replace('_', ' ')}</Text>
          </View>
        </View>

        <View
          style={[
            styles.syncBadge,
            { backgroundColor: syncMeta.colors.background, borderColor: syncMeta.colors.border },
          ]}
        >
          <MaterialCommunityIcons name={syncMeta.icon} size={12} color={syncMeta.colors.foregroundMuted} />
          <Text style={[styles.syncText, { color: syncMeta.colors.foreground }]}>{syncMeta.label}</Text>
        </View>
      </View>

      <View style={styles.mainContent}>
        <View style={styles.contentColumn}>
          <Text style={styles.leadName}>{primaryName}</Text>
          {otherNames ? (
            <Text style={styles.subNames} numberOfLines={1}>+ {otherNames}</Text>
          ) : null}

          <View style={styles.metaRow}>
            <View style={styles.metaChip}>
              <MaterialCommunityIcons name="clock-outline" size={13} color={THEME.textSecondary} />
              <Text style={styles.metaChipText}>{pickupTimeLabel}</Text>
            </View>

            {isSearchResult ? (
              <View style={styles.metaChip}>
                <MaterialCommunityIcons name="map-marker-outline" size={13} color={THEME.textSecondary} />
                <Text style={styles.metaChipText} numberOfLines={1}>
                  {pickupLocationLabel}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.paxCounter}>
          <MaterialCommunityIcons name="account-group" size={18} color={THEME.primaryDark} />
          <Text style={styles.paxCountText}>{passengerCount}</Text>
          <Text style={styles.paxLabel}>PAX</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: THEME.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    borderLeftWidth: 5,
    ...SHADOWS.md,
    borderWidth: 1.5,
    borderColor: THEME.border,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  referenceCluster: {
    flexDirection: 'row',
    gap: SPACING.sm,
    flexWrap: 'wrap',
    alignItems: 'center',
    flexShrink: 1,
  },
  refContainer: {
    backgroundColor: THEME.primaryMuted,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs + 1,
    borderRadius: RADIUS.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  refText: {
    fontSize: 12,
    fontWeight: FONT_WEIGHT.bold,
    color: THEME.primaryDark,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  syncBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    alignSelf: 'flex-start',
  },
  syncText: {
    fontSize: 11,
    fontWeight: FONT_WEIGHT.semibold,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: FONT_WEIGHT.extrabold,
    textTransform: 'uppercase',
  },
  mainContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
  },
  contentColumn: {
    flex: 1,
  },
  leadName: {
    fontSize: 17,
    fontWeight: FONT_WEIGHT.extrabold,
    color: THEME.textPrimary,
  },
  subNames: {
    fontSize: 13,
    color: THEME.textSecondary,
    marginTop: SPACING.xs,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.sm,
    gap: SPACING.sm,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    backgroundColor: THEME.background,
    borderWidth: 1,
    borderColor: THEME.border,
    maxWidth: '100%',
  },
  metaChipText: {
    fontSize: 12,
    color: THEME.textSecondary,
    maxWidth: 220,
  },
  paxCounter: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.primaryMuted,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    minWidth: 62,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  paxCountText: {
    fontSize: 16,
    fontWeight: FONT_WEIGHT.extrabold,
    color: THEME.textPrimary,
  },
  paxLabel: {
    fontSize: 10,
    fontWeight: FONT_WEIGHT.semibold,
    color: THEME.textSecondary,
    letterSpacing: 0.6,
  }
});
