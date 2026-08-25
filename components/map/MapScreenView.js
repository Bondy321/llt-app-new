import createMapScreenStyles from '../../screens/styles/MapScreen.styles';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, Polyline, Circle } from 'react-native-maps';
import * as Haptics from '../../services/hapticsService';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS as THEME } from '../../theme';

const COLORS = {
  primaryBlue: THEME.primary, coralAccent: THEME.accent, white: THEME.white,
  darkText: THEME.textPrimary, secondaryText: THEME.textSecondary,
  appBackground: THEME.background, mapHeaderColor: THEME.primary,
  errorRed: THEME.error, border: THEME.border, softBlue: THEME.primaryMuted,
  success: THEME.success || '#10B981', warning: '#F59E0B', surface: THEME.surface || '#FFFFFF',
};
const mapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f5f5' }] },
  { featureType: 'administrative.land_parcel', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dadada' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'transit.station', elementType: 'geometry', stylers: [{ color: '#eeeeee' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c9c9c9' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
];

const styles = createMapScreenStyles({ StyleSheet, COLORS, Platform });

export default function MapScreenView({
  connectionStatus,
  distanceKm,
  driverHasLocation,
  driverLocationPoint,
  driverLocationPresentation,
  etaMinutes,
  fadeAnim,
  freshnessConfig,
  getInitialRegion,
  handleCallDriver,
  handleGetDirections,
  handlePickupDirections,
  handleRecenter,
  handleRefresh,
  handleToggleMapType,
  hasExpiredLiveLocation,
  hasLowAccuracy,
  isStale,
  loading,
  locationFreshness,
  mapRef,
  mapType,
  markerScaleAnim,
  onBack,
  primaryPickup,
  pulseAnim,
  isRefreshing,
  relativeUpdateTime,
  slideAnim,
  spin,
  tourData,
  userLocationPoint,
  userLocationNotice,
  setSubscriptionRetryKey,
}) {
  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <LinearGradient
        colors={[`${COLORS.primaryBlue}15`, COLORS.appBackground]}
        style={styles.loadingGradient}
      >
        <View style={styles.loadingContent}>
          <View style={styles.loadingIconContainer}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <View style={styles.loadingIconOuter}>
                <MaterialCommunityIcons name="bus-marker" size={40} color={COLORS.primaryBlue} />
              </View>
            </Animated.View>
          </View>
          <Text style={styles.loadingTitle}>Finding Your Bus</Text>
          <Text style={styles.loadingSubtitle}>Connecting to driver location...</Text>
          <View style={styles.loadingDots}>
            <ActivityIndicator size="small" color={COLORS.primaryBlue} />
          </View>
        </View>
      </LinearGradient>
    </View>
  );

  const renderConnectionIndicator = () => {
    let config;
    switch (connectionStatus) {
      case 'connected':
        config = { color: COLORS.success, icon: 'wifi', label: 'Connected' };
        break;
      case 'waiting':
        config = { color: COLORS.warning, icon: 'wifi-off', label: 'Waiting for driver' };
        break;
      case 'error':
        config = { color: COLORS.errorRed, icon: 'wifi-alert', label: 'Connection error' };
        break;
      case 'offline':
        config = { color: COLORS.warning, icon: 'wifi-off', label: 'Reconnecting...' };
        break;
      default:
        config = { color: COLORS.secondaryText, icon: 'wifi-sync', label: 'Connecting...' };
    }

    return (
      <View style={[styles.connectionBadge, { backgroundColor: `${config.color}15` }]}>
        <MaterialCommunityIcons name={config.icon} size={14} color={config.color} />
        <Text style={[styles.connectionText, { color: config.color }]}>{config.label}</Text>
      </View>
    );
  };

  const renderDriverMarker = () => {
    if (!driverLocationPoint) return null;

    return (
      <>
        {/* Pulse ring */}
        <Circle
          center={{
            latitude: driverLocationPoint.latitude,
            longitude: driverLocationPoint.longitude,
          }}
          radius={100}
          fillColor={`${COLORS.primaryBlue}15`}
          strokeColor={`${COLORS.primaryBlue}30`}
          strokeWidth={1}
        />

        <Marker
          coordinate={{
            latitude: driverLocationPoint.latitude,
            longitude: driverLocationPoint.longitude,
          }}
          title={driverLocationPresentation.mode === 'live' ? 'Live Bus Location' : 'Bus Pickup Point'}
          description={`Updated ${relativeUpdateTime}`}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <Animated.View style={[styles.customMarkerContainer, { transform: [{ scale: markerScaleAnim }] }]}>
            <View style={[styles.customMarkerOuter, locationFreshness === 'live' && styles.markerLive]}>
              <View style={styles.customMarkerInner}>
                <MaterialCommunityIcons name="bus" size={22} color={COLORS.white} />
              </View>
            </View>
            <View style={styles.markerShadow} />
          </Animated.View>
        </Marker>
      </>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (Platform.OS === 'ios') {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            onBack();
          }}
          style={styles.headerButton}
          activeOpacity={0.7}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={COLORS.white} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Find My Bus</Text>
          {renderConnectionIndicator()}
        </View>

        <TouchableOpacity
          style={styles.headerButton}
          onPress={handleToggleMapType}
          activeOpacity={0.7}
          accessibilityLabel="Toggle map type"
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name={mapType === 'standard' ? 'satellite-variant' : 'map'}
            size={22}
            color={COLORS.white}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.container}>
        {loading ? (
          renderLoadingState()
        ) : (
          <Animated.View style={[styles.mapContainer, { opacity: fadeAnim }]}>
            <MapView
              style={styles.map}
              provider={Platform.OS === 'ios' ? PROVIDER_DEFAULT : PROVIDER_GOOGLE}
              initialRegion={getInitialRegion()}
              showsUserLocation={Boolean(userLocationPoint)}
              showsMyLocationButton={false}
              showsCompass={false}
              mapType={mapType}
              customMapStyle={Platform.OS === 'android' && mapType === 'standard' ? mapStyle : undefined}
              ref={mapRef}
              accessibilityLabel="Map showing bus location"
            >
              {renderDriverMarker()}

              {/* Draw line between user and driver */}
              {driverLocationPoint && userLocationPoint && (
                <Polyline
                  coordinates={[
                    { latitude: userLocationPoint.latitude, longitude: userLocationPoint.longitude },
                    { latitude: driverLocationPoint.latitude, longitude: driverLocationPoint.longitude },
                  ]}
                  strokeColor={`${COLORS.primaryBlue}80`}
                  strokeWidth={3}
                  lineDashPattern={[10, 5]}
                />
              )}
            </MapView>

            {/* Floating Action Buttons */}
            <View style={styles.fabContainer}>
              <TouchableOpacity
                style={styles.fab}
                onPress={handleRefresh}
                activeOpacity={0.85}
                disabled={isRefreshing}
                accessibilityLabel="Show or refresh my location"
                accessibilityRole="button"
              >
                <Animated.View style={{ transform: [{ rotate: isRefreshing ? spin : '0deg' }] }}>
                  <MaterialCommunityIcons
                    name="refresh"
                    size={22}
                    color={isRefreshing ? COLORS.secondaryText : COLORS.primaryBlue}
                  />
                </Animated.View>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.fab}
                onPress={handleRecenter}
                activeOpacity={0.85}
                accessibilityLabel="Center map"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="crosshairs-gps" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>

            {/* Info Card */}
            <Animated.View
              style={[
                styles.infoCardContainer,
                { transform: [{ translateY: slideAnim }] }
              ]}
            >
              <View style={styles.infoCard}>
                {errorMsg ? (
                  <View style={styles.errorContent}>
                    <View style={styles.errorIconContainer}>
                      <MaterialCommunityIcons name="alert-circle" size={32} color={COLORS.errorRed} />
                    </View>
                    <View style={styles.errorTextContainer}>
                      <Text style={styles.errorTitle}>Location Error</Text>
                      <Text style={styles.errorMessage}>{errorMsg}</Text>
                      <TouchableOpacity
                        style={styles.contactButton}
                        onPress={() => setSubscriptionRetryKey((value) => value + 1)}
                        accessibilityLabel="Retry driver location connection"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="refresh" size={18} color={COLORS.primaryBlue} />
                        <Text style={styles.contactButtonText}>Retry</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : driverHasLocation ? (
                  <>
                    {/* Status Header */}
                    <View style={styles.cardHeader}>
                      <View style={styles.statusIndicator}>
                        <Animated.View
                          style={[
                            styles.statusDot,
                            { backgroundColor: freshnessConfig.color },
                            locationFreshness === 'live' && { transform: [{ scale: pulseAnim }] }
                          ]}
                        />
                        <Text style={[styles.statusLabel, { color: freshnessConfig.color }]}>
                          {freshnessConfig.label}
                        </Text>
                      </View>
                      <Text style={styles.updateTime}>{relativeUpdateTime}</Text>
                    </View>

                    {/* Driver Info */}
                    <View style={styles.driverInfo}>
                      <View style={styles.driverAvatar}>
                        <MaterialCommunityIcons name="bus" size={28} color={COLORS.white} />
                      </View>
                      <View style={styles.driverDetails}>
                        <Text style={styles.driverTitle}>
                          {driverLocationPresentation.mode === 'live' ? 'Live Bus Location' : 'Bus Pickup Point'}
                        </Text>
                        <Text style={styles.driverSubtitle}>
                          {driverLocationPresentation.mode === 'pickup'
                            ? 'Fixed pickup point shared by the driver'
                            : driverLocation.updatedBy
                              ? `Live update from ${driverLocation.updatedBy}`
                              : 'Live location shared by driver'}
                        </Text>
                        {tourData?.driverName && (
                          <Text style={styles.driverName}>
                            Driver: {tourData.driverName}
                          </Text>
                        )}
                      </View>
                    </View>

                    {/* Metrics */}
                    {(distanceKm !== null || etaMinutes !== null) && (
                      <View style={styles.metricsContainer}>
                        {distanceKm !== null && (
                          <View style={styles.metricCard}>
                            <MaterialCommunityIcons name="map-marker-distance" size={24} color={COLORS.primaryBlue} />
                            <View style={styles.metricTextContainer}>
                              <Text style={styles.metricValue}>
                                {distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(1)}km`}
                              </Text>
                              <Text style={styles.metricLabel}>Distance</Text>
                            </View>
                          </View>
                        )}
                        {etaMinutes !== null && (
                          <View style={[styles.metricCard, styles.metricCardAccent]}>
                            <MaterialCommunityIcons name="clock-fast" size={24} color={COLORS.white} />
                            <View style={styles.metricTextContainer}>
                              <Text style={[styles.metricValue, { color: COLORS.white }]}>
                                {etaMinutes < 60 ? `${etaMinutes} min` : `${Math.floor(etaMinutes/60)}h ${etaMinutes%60}m`}
                              </Text>
                              <Text style={[styles.metricLabel, { color: 'rgba(255,255,255,0.8)' }]}>Est. Travel</Text>
                            </View>
                          </View>
                        )}
                      </View>
                    )}

                    {/* Stale Warning */}
                    {isStale && (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="alert" size={20} color={COLORS.warning} />
                        <Text style={styles.staleText}>
                          This location is getting stale. The driver may still be moving — refresh shortly or contact them for a live update.
                        </Text>
                      </View>
                    )}

                    {hasLowAccuracy && (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="crosshairs-question" size={20} color={COLORS.warning} />
                        <Text style={styles.staleText}>
                          The driver's GPS accuracy is too low for safe directions. Wait for a clearer update or contact the driver.
                        </Text>
                      </View>
                    )}

                    {userLocationNotice ? (
                      <View style={styles.staleWarning}>
                        <MaterialCommunityIcons name="crosshairs-question" size={20} color={COLORS.secondaryText} />
                        <Text style={styles.staleText}>{userLocationNotice}</Text>
                      </View>
                    ) : null}

                    {/* Action Buttons */}
                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={[styles.primaryButton, !driverLocationPresentation.actionable && { opacity: 0.5 }]}
                        onPress={handleGetDirections}
                        disabled={!driverLocationPresentation.actionable}
                        activeOpacity={0.85}
                        accessibilityLabel="Get directions to pickup point"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="navigation-variant" size={20} color={COLORS.white} />
                        <Text style={styles.primaryButtonText}>Get Directions</Text>
                      </TouchableOpacity>

                      {primaryPickup.destination ? (
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={handlePickupDirections}
                          activeOpacity={0.85}
                          accessibilityLabel="Directions to your booked pickup"
                          accessibilityHint={`${primaryPickup.location || primaryPickup.address}${primaryPickup.formattedDate ? ` on ${primaryPickup.formattedDate}` : ''}`}
                          accessibilityRole="button"
                        >
                          <MaterialCommunityIcons name="map-marker-path" size={20} color={COLORS.primaryBlue} />
                        </TouchableOpacity>
                      ) : null}

                      <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={handleCallDriver}
                        activeOpacity={0.85}
                        accessibilityLabel="Call driver"
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="phone" size={20} color={COLORS.primaryBlue} />
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <View style={styles.waitingContent}>
                    <View style={styles.waitingIconContainer}>
                      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <MaterialCommunityIcons name="bus-clock" size={36} color={COLORS.secondaryText} />
                      </Animated.View>
                    </View>
                    <View style={styles.waitingTextContainer}>
                      <Text style={styles.waitingTitle}>
                        {hasExpiredLiveLocation ? 'Live Location Expired' : 'Awaiting Location'}
                      </Text>
                      <Text style={styles.waitingMessage}>
                        {hasExpiredLiveLocation
                          ? 'The last live update is too old to navigate to safely. This screen will update automatically when the driver shares again.'
                          : 'No pickup point is live yet. As soon as the driver shares one, this map will update automatically.'}
                      </Text>
                    </View>
                    {primaryPickup.destination ? (
                      <TouchableOpacity
                        style={styles.pickupDirectionsButton}
                        onPress={handlePickupDirections}
                        activeOpacity={0.85}
                        accessibilityLabel="Directions to your booked pickup"
                        accessibilityHint={`${primaryPickup.location || primaryPickup.address}${primaryPickup.formattedDate ? ` on ${primaryPickup.formattedDate}` : ''}`}
                        accessibilityRole="button"
                      >
                        <MaterialCommunityIcons name="map-marker-path" size={18} color={COLORS.white} />
                        <Text style={styles.pickupDirectionsButtonText}>Directions to your pickup</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={styles.contactButton}
                      onPress={handleCallDriver}
                      activeOpacity={0.85}
                      accessibilityLabel="Contact driver by phone"
                      accessibilityRole="button"
                    >
                      <MaterialCommunityIcons name="phone" size={18} color={COLORS.primaryBlue} />
                      <Text style={styles.contactButtonText}>Contact Driver</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </Animated.View>
          </Animated.View>
        )}
      </View>
    </SafeAreaView>
  );
}
