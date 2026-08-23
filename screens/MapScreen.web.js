import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, SPACING, RADIUS } from '../theme';
import { getDriverLocationPresentation } from '../utils/driverLocation';
const { buildDirectionsUrls } = require('../utils/directions');
const { resolvePrimaryPickup } = require('../utils/pickupPresentation');

export default function MapScreen({ onBack, tourData, bookingData }) {
  const driverLocation = tourData?.driverLocation;
  const presentation = getDriverLocationPresentation(driverLocation);
  const latitude = presentation.coordinates?.latitude;
  const longitude = presentation.coordinates?.longitude;
  const mapsUrl = presentation.actionable
    ? `https://www.google.com/maps?q=${latitude},${longitude}`
    : null;
  const primaryPickup = resolvePrimaryPickup(bookingData);
  const pickupMapsUrl = buildDirectionsUrls(primaryPickup.destination, 'web')?.webUrl || null;

  const handleOpenInMaps = async () => {
    if (!mapsUrl) return;
    try {
      await Linking.openURL(mapsUrl);
    } catch {
      Alert.alert('Maps unavailable', 'Could not open Google Maps from this browser.');
    }
  };

  const handleOpenPickupInMaps = async () => {
    if (!pickupMapsUrl) return;
    try {
      await Linking.openURL(pickupMapsUrl);
    } catch {
      Alert.alert('Maps unavailable', 'Could not open your pickup in Google Maps from this browser.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Find my bus</Text>
        <Text style={styles.description}>
          For the clearest live view, use the iOS app. From this page you can still open the latest safe bus location or your booked pickup.
        </Text>

        {presentation.available ? (
          <>
            <Text style={styles.locationStatus}>
              {presentation.mode === 'pickup' ? 'The driver has shared a pickup point.' : 'A current bus location is available.'}
            </Text>
            {presentation.actionable ? (
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleOpenInMaps}
                accessibilityRole="button"
                accessibilityLabel="Open the latest bus location in Google Maps"
              >
                <Text style={styles.primaryButtonText}>Open bus location in Google Maps</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.description}>
                {presentation.freshness === 'low_accuracy'
                  ? 'The driver GPS accuracy is too low for safe directions. Wait for a clearer update.'
                  : 'This live update is too old to navigate to safely. Wait for the driver to share again.'}
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.description}>
            {presentation.freshness === 'expired'
              ? 'The previous live location has expired. Wait for a fresh driver update.'
              : 'No driver pickup point or live location has been published yet.'}
          </Text>
        )}

        {pickupMapsUrl ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleOpenPickupInMaps}
            accessibilityRole="button"
            accessibilityLabel="Directions to your booked pickup"
          >
            <Text style={styles.primaryButtonText}>Directions to your pickup</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to the tour screen"
        >
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
  locationStatus: {
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
