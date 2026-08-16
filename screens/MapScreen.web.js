import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, SPACING, RADIUS } from '../theme';
import { getDriverLocationPresentation } from '../utils/driverLocation';

export default function MapScreen({ onBack, tourData }) {
  const driverLocation = tourData?.driverLocation;
  const presentation = getDriverLocationPresentation(driverLocation);
  const latitude = presentation.coordinates?.latitude;
  const longitude = presentation.coordinates?.longitude;
  const mapsUrl = presentation.actionable
    ? `https://www.google.com/maps?q=${latitude},${longitude}`
    : null;

  const handleOpenInMaps = async () => {
    if (!mapsUrl) return;
    try {
      await Linking.openURL(mapsUrl);
    } catch {
      Alert.alert('Maps unavailable', 'Could not open Google Maps from this browser.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Live map is available in the mobile app</Text>
        <Text style={styles.description}>
          Web preview currently shows a lightweight fallback. Use iOS/Android builds for full live map tracking.
        </Text>

        {presentation.available ? (
          <>
            <Text style={styles.coords}>
              {presentation.mode === 'pickup' ? 'Driver pickup point' : 'Driver live location'}: {latitude.toFixed(5)}, {longitude.toFixed(5)}
            </Text>
            {presentation.actionable ? (
              <TouchableOpacity style={styles.primaryButton} onPress={handleOpenInMaps}>
                <Text style={styles.primaryButtonText}>Open in Google Maps</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.description}>This live update is too old to navigate to safely. Wait for the driver to share again.</Text>
            )}
          </>
        ) : (
          <Text style={styles.description}>
            {presentation.freshness === 'expired'
              ? 'The previous live location has expired. Wait for a fresh driver update.'
              : 'No driver pickup point or live location has been published yet.'}
          </Text>
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
