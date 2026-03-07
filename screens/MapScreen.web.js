import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, SPACING, RADIUS } from '../theme';

export default function MapScreen({ onBack, tourData }) {
  const driverLocation = tourData?.driverLocation;
  const hasCoords = Number.isFinite(driverLocation?.lat) && Number.isFinite(driverLocation?.lng);
  const mapsUrl = hasCoords
    ? `https://www.google.com/maps?q=${driverLocation.lat},${driverLocation.lng}`
    : null;

  const handleOpenInMaps = async () => {
    if (!mapsUrl) return;
    await Linking.openURL(mapsUrl);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Live map is available in the mobile app</Text>
        <Text style={styles.description}>
          Web preview currently shows a lightweight fallback. Use iOS/Android builds for full live map tracking.
        </Text>

        {hasCoords ? (
          <>
            <Text style={styles.coords}>
              Driver coordinates: {driverLocation.lat.toFixed(5)}, {driverLocation.lng.toFixed(5)}
            </Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleOpenInMaps}>
              <Text style={styles.primaryButtonText}>Open in Google Maps</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.description}>No live driver location has been published yet.</Text>
        )}

        <TouchableOpacity style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back</Text>
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
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.textSecondary,
  },
  coords: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  primaryButton: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: COLORS.textInverse,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
