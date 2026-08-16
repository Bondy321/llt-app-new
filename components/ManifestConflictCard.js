import React, { memo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS, RADIUS, SHADOWS, SPACING } from '../theme';

const statusLabel = (status) => String(status || 'PENDING').replaceAll('_', ' ').toLowerCase();

const ManifestConflictCard = ({ conflict, onReview, onDismiss }) => {
  if (!conflict) return null;
  const updatedAt = conflict.serverLastUpdated
    ? new Date(conflict.serverLastUpdated).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : 'time unavailable';

  return (
    <View style={styles.card} accessibilityRole="alert">
      <View style={styles.iconWrap}>
        <MaterialCommunityIcons name="shield-check-outline" size={22} color={COLORS.warningDark || '#92400E'} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>NEWER SERVER UPDATE PROTECTED</Text>
        <Text style={styles.title}>Booking {conflict.bookingRef}</Text>
        <Text style={styles.body}>
          The server kept <Text style={styles.strong}>{statusLabel(conflict.serverStatus)}</Text> from {updatedAt}. Your attempted <Text style={styles.strong}>{statusLabel(conflict.attemptedStatus)}</Text> update was not applied.
        </Text>
        <TouchableOpacity onPress={onReview} style={styles.reviewButton} accessibilityRole="button">
          <Text style={styles.reviewText}>Review booking</Text>
          <MaterialCommunityIcons name="arrow-right" size={16} color={COLORS.white} />
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={onDismiss} style={styles.dismiss} accessibilityRole="button" accessibilityLabel="Dismiss conflict notice">
        <MaterialCommunityIcons name="close" size={18} color={COLORS.textSecondary} />
      </TouchableOpacity>
    </View>
  );
};

export default memo(ManifestConflictCard);

const styles = StyleSheet.create({
  card: {
    marginTop: SPACING.sm,
    padding: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: '#F59E0B',
    backgroundColor: COLORS.warningLight,
    flexDirection: 'row',
    gap: SPACING.sm,
    ...SHADOWS.sm,
  },
  iconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FEF3C7' },
  copy: { flex: 1 },
  eyebrow: { color: '#92400E', fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  title: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '800', marginTop: 3 },
  body: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },
  strong: { color: COLORS.textPrimary, fontWeight: '800' },
  reviewButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.md, marginTop: SPACING.sm },
  reviewText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  dismiss: { padding: 3, alignSelf: 'flex-start' },
});
