import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, Circle } from 'react-native-maps';
import * as Haptics from '../../services/hapticsService';


import {
  DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS,
} from '../../utils/driverLocation';
import { COLORS as THEME } from '../../theme';
import createDriverHomeScreenStyles from '../../screens/styles/DriverHomeScreen.styles';

const COLORS = {
  primary: THEME.primary,
  midnight: THEME.textPrimary,
  slate: '#1F2937',
  white: THEME.white,
  bg: THEME.background,
  success: THEME.success,
  danger: THEME.error,
  info: THEME.primaryLight,
  location: '#0EA5E9',
  purple: '#7C3AED',
  border: THEME.border,
  text: THEME.textPrimary,
  muted: THEME.textSecondary,
  warning: '#F59E0B',
};

// Minimal map style for preview
const minimalMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
];

const styles = createDriverHomeScreenStyles({ StyleSheet, COLORS });




export default function DriverLocationPreviewModal(props) {
  const { accuracyConfig, addressLoading, addressText, confirmingLocation, handleConfirmLocation, handleRefetchLocation, locationAccuracy, previewLocation, previewModalVisible, previewRequestIdRef, setAddressLoading, setPreviewModalVisible, setUpdatingLocation, updatingLocation } = props;
  return (<Modal
        visible={previewModalVisible}
        transparent={false}
        animationType="slide"
        onRequestClose={() => {
          if (confirmingLocation) return;
          previewRequestIdRef.current += 1;
          setAddressLoading(false);
          setUpdatingLocation(false);
          setPreviewModalVisible(false);
        }}
      >
        <SafeAreaView style={styles.previewModalContainer}>
          <View style={styles.previewHeader}>
            <TouchableOpacity
              onPress={() => {
                if (Platform.OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                previewRequestIdRef.current += 1;
                setAddressLoading(false);
                setUpdatingLocation(false);
                setPreviewModalVisible(false);
              }}
              style={styles.previewCloseButton}
              disabled={confirmingLocation}
              accessibilityLabel="Close preview"
              accessibilityRole="button"
            >
              <MaterialCommunityIcons name="close" size={24} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.previewTitle}>Confirm Pickup Location</Text>
            <View style={styles.previewCloseButton} />
          </View>

          {/* Map Preview */}
          {previewLocation && (
            <View style={styles.mapPreviewContainer}>
              <MapView
                style={styles.mapPreview}
                provider={Platform.OS === 'ios' ? PROVIDER_DEFAULT : PROVIDER_GOOGLE}
                customMapStyle={Platform.OS === 'android' ? minimalMapStyle : undefined}
                region={{
                  latitude: previewLocation.latitude,
                  longitude: previewLocation.longitude,
                  latitudeDelta: 0.005,
                  longitudeDelta: 0.005,
                }}
                scrollEnabled={false}
                zoomEnabled={false}
                pitchEnabled={false}
                rotateEnabled={false}
              >
                <Circle
                  center={{
                    latitude: previewLocation.latitude,
                    longitude: previewLocation.longitude,
                  }}
                  radius={locationAccuracy || 20}
                  fillColor={`${COLORS.primary}20`}
                  strokeColor={`${COLORS.primary}60`}
                  strokeWidth={2}
                />
                <Marker
                  coordinate={{
                    latitude: previewLocation.latitude,
                    longitude: previewLocation.longitude,
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <View style={styles.previewMarker}>
                    <MaterialCommunityIcons name="bus" size={24} color={COLORS.white} />
                  </View>
                </Marker>
              </MapView>

              {/* Accuracy Badge */}
              <View style={[styles.accuracyBadge, { backgroundColor: `${accuracyConfig.color}15` }]}>
                <MaterialCommunityIcons name={accuracyConfig.icon} size={16} color={accuracyConfig.color} />
                <Text style={[styles.accuracyText, { color: accuracyConfig.color }]}>
                  {accuracyConfig.label} accuracy ({Math.round(locationAccuracy || 0)}m)
                </Text>
              </View>
            </View>
          )}

          {/* Location Details */}
          <View style={styles.previewDetails}>
            <View style={styles.previewDetailRow}>
              <View style={styles.previewDetailIcon}>
                <MaterialCommunityIcons name="map-marker" size={24} color={COLORS.primary} />
              </View>
              <View style={styles.previewDetailText}>
                <Text style={styles.previewDetailLabel}>Address</Text>
                {addressLoading ? (
                  <ActivityIndicator size="small" color={COLORS.primary} style={{ marginTop: 4 }} />
                ) : (
                  <Text style={styles.previewDetailValue}>{addressText || 'Loading...'}</Text>
                )}
              </View>
            </View>

            <View style={styles.previewDetailRow}>
              <View style={styles.previewDetailIcon}>
                <MaterialCommunityIcons name="crosshairs-gps" size={24} color={COLORS.primary} />
              </View>
              <View style={styles.previewDetailText}>
                <Text style={styles.previewDetailLabel}>Coordinates</Text>
                <Text style={styles.previewDetailValue}>
                  {previewLocation ? `${previewLocation.latitude.toFixed(6)}, ${previewLocation.longitude.toFixed(6)}` : 'N/A'}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.refetchButton}
              onPress={handleRefetchLocation}
              disabled={updatingLocation}
              accessibilityLabel="Refresh location"
              accessibilityRole="button"
            >
              {updatingLocation ? (
                <ActivityIndicator size="small" color={COLORS.primary} />
              ) : (
                <>
                  <MaterialCommunityIcons name="refresh" size={18} color={COLORS.primary} />
                  <Text style={styles.refetchText}>Refresh Location</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Action Buttons */}
          <View style={styles.previewActions}>
            <TouchableOpacity
              style={styles.cancelPreviewButton}
              disabled={confirmingLocation}
              onPress={() => {
                if (Platform.OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                previewRequestIdRef.current += 1;
                setAddressLoading(false);
                setUpdatingLocation(false);
                setPreviewModalVisible(false);
              }}
              accessibilityLabel="Cancel"
              accessibilityRole="button"
            >
              <Text style={styles.cancelPreviewText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.confirmPreviewButton,
                (Number(locationAccuracy) > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS) && { opacity: 0.5 },
              ]}
              onPress={handleConfirmLocation}
              disabled={
                confirmingLocation
                || addressLoading
                || Number(locationAccuracy) > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS
              }
              accessibilityLabel="Share location with passengers"
              accessibilityRole="button"
              accessibilityHint={Number(locationAccuracy) > DRIVER_LOCATION_MAX_ACTIONABLE_ACCURACY_METERS
                ? 'Refresh the location first because the current accuracy is too low'
                : undefined}
            >
              {confirmingLocation ? (
                <ActivityIndicator color={COLORS.white} />
              ) : (
                <>
                  <MaterialCommunityIcons name="send" size={20} color={COLORS.white} />
                  <Text style={styles.confirmPreviewText}>Share with Passengers</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>);
}
