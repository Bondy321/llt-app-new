import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SPACING } from '../theme';

export default function DriverHomeScreen({ driverData, onLogout, onNavigate }) {
  const activeTourId = driverData?.assignedTourId || driverData?.currentTourId || null;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Driver Console (Web Preview)</Text>
        <Text style={styles.description}>
          The full driver map and live location controls are available on iOS/Android. This web fallback keeps navigation available for QA and update bundling.
        </Text>

        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Driver</Text>
          <Text style={styles.metaValue}>{driverData?.name || driverData?.id || 'Unknown driver'}</Text>
        </View>

        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Active Tour</Text>
          <Text style={styles.metaValue}>{activeTourId || 'Not assigned'}</Text>
        </View>

        {activeTourId ? (
          <TouchableOpacity style={styles.primaryButton} onPress={() => onNavigate('PassengerManifest', { tourId: activeTourId })}>
            <Text style={styles.primaryButtonText}>Open Passenger Manifest</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity style={styles.secondaryButton} onPress={onLogout}>
          <Text style={styles.secondaryButtonText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 22,
    fontWeight: '700',
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  metaBlock: {
    paddingVertical: SPACING.sm,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  metaLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: SPACING.xs,
  },
  metaValue: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  primaryButton: {
    marginTop: SPACING.sm,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  primaryButtonText: {
    color: COLORS.textInverse,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  secondaryButtonText: {
    color: COLORS.textPrimary,
    fontWeight: '600',
  },
});
