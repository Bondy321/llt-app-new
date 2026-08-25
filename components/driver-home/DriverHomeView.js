import DriverLocationPreviewModal from './DriverLocationPreviewModal';
import createDriverHomeScreenStyles from '../../screens/styles/DriverHomeScreen.styles';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Switch,
  ScrollView,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from '../../services/hapticsService';
import logger, { maskIdentifier } from '../../services/loggerService';




import { COLORS as THEME } from '../../theme';

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

const styles = createDriverHomeScreenStyles({ StyleSheet, COLORS });


export default function DriverHomeView(props) {
  const { accuracyConfig, activeTourId, addressLoading, addressText, autoShareEnabled, autoShareLastRunAt, autoShareSaving, autoShareStatus, cacheStatusLabel, confirmingLocation, driverData, driverTourPackFeature, driverTourPackState, fadeAnim, formatTimeAgo, handleCaptureLocation, handleConfirmLocation, handleJoinTour, handleOpenChat, handleOpenDriverChat, handleRefetchLocation, handleToggleAutoShare, inputTourCode, isLocationStale, joinModalVisible, joining, lastLocationPresentation, lastLocationStatus, lastLocationStatusColor, lastLocationUpdate, locationAccuracy, onLogout, onNavigate, previewLocation, previewModalVisible, previewRequestIdRef, pulseAnim, setAddressLoading, setInputTourCode, setJoinModalVisible, setPreviewModalVisible, setUpdatingLocation, showBanner, successAnim, updatingLocation } = props;
return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={[`${COLORS.primary}0D`, COLORS.bg]}
        style={{ flex: 1 }}
      >
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <View style={styles.headerCard}>
            <View style={styles.headerLeft}>
              <View style={styles.avatar}>
                <MaterialCommunityIcons name="steering" size={24} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.greeting}>Driver Console</Text>
                <Text style={styles.driverName} numberOfLines={1}>{driverData?.name || 'Unknown Driver'}</Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                onPress={() => {
                  logger.info('DriverHomeScreen', 'Account privacy navigation requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onNavigate('AccountPrivacy', { from: 'DriverHome' });
                }}
                style={styles.iconButton}
                accessibilityLabel="Account and privacy"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="account-cog-outline" size={22} color={COLORS.primary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  logger.info('DriverHomeScreen', 'Logout requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onLogout();
                }}
                style={styles.iconButton}
                accessibilityLabel="Logout"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="logout" size={22} color={COLORS.primary} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {/* Tour Assignment Card */}
            <View style={styles.assignCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Active tour</Text>
                <Text style={styles.cardValue}>{activeTourId || 'No tour assigned'}</Text>
                <Text style={styles.cardHint}>Stay assigned to keep chat and manifests in sync.</Text>
                <Text style={styles.cardHint}>{cacheStatusLabel}</Text>
              </View>
              <TouchableOpacity
                style={styles.pillButton}
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  logger.info('DriverHomeScreen', 'Join tour modal opened', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  setJoinModalVisible(true);
                }}
                accessibilityLabel="Change tour assignment"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="swap-horizontal" size={18} color={COLORS.white} />
                <Text style={styles.pillButtonText}>Change</Text>
              </TouchableOpacity>
            </View>

            {/* Last Location Update Card */}
            {lastLocationUpdate && (
              <View style={styles.lastUpdateCard}>
                <View style={styles.lastUpdateHeader}>
                  <View style={styles.lastUpdateIcon}>
                    <MaterialCommunityIcons
                      name={lastLocationStatus.needsRefresh ? 'map-marker-alert' : 'map-marker-check'}
                      size={20}
                      color={lastLocationStatusColor}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lastUpdateTitle}>Last Shared Location</Text>
                    <Text style={styles.lastUpdateTime}>{formatTimeAgo(lastLocationUpdate.timestamp)}</Text>
                  </View>
                  <Animated.View style={[
                    styles.liveBadge,
                    { transform: [{ scale: lastLocationStatus.pulse ? pulseAnim : 1 }] },
                  ]}>
                    {lastLocationStatus.pulse && <View style={styles.liveIndicator} />}
                    <Text style={styles.liveText}>{lastLocationStatus.label}</Text>
                  </Animated.View>
                </View>
                {lastLocationUpdate.address && (
                  <Text style={styles.lastUpdateAddress} numberOfLines={2}>
                    {lastLocationUpdate.address}
                  </Text>
                )}
              </View>
            )}

            {isLocationStale && (
              <View style={styles.staleNudgeCard}>
                <View style={styles.staleNudgeIconWrap}>
                  <MaterialCommunityIcons name="alert-circle" size={20} color={COLORS.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.staleNudgeTitle}>
                    {lastLocationPresentation.freshness === 'low_accuracy'
                      ? 'GPS accuracy is too low for safe directions.'
                      : 'Passengers are seeing an old location — update now.'}
                  </Text>
                  <Text style={styles.staleNudgeSubtitle}>
                    Last shared {formatTimeAgo(lastLocationUpdate?.timestamp)}. Tap "Set pickup" to refresh immediately.
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.autoShareCard}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={styles.autoShareTitle}>Auto-share location</Text>
                <Text style={styles.autoShareSubtitle}>When enabled, this screen shares every 3 minutes while active and tour-assigned.</Text>
              </View>
              <Switch
                value={autoShareEnabled}
                onValueChange={handleToggleAutoShare}
                disabled={autoShareSaving}
                trackColor={{ false: `${COLORS.muted}50`, true: `${COLORS.primary}80` }}
                thumbColor={autoShareEnabled ? COLORS.white : '#F4F4F5'}
                accessibilityLabel="Toggle automatic location sharing"
              />
            </View>
            <Text style={styles.autoShareStatus}>{autoShareStatus}</Text>
            {autoShareLastRunAt && (
              <Text style={styles.autoShareLastRun}>Last auto-share: {formatTimeAgo(autoShareLastRunAt)}</Text>
            )}

            {/* Primary Action Grid */}
            <View style={styles.grid}>
              <TouchableOpacity
                style={[styles.bigButton, styles.primaryTile]}
                onPress={handleCaptureLocation}
                disabled={updatingLocation}
                activeOpacity={0.9}
                accessibilityLabel="Set pickup location"
                accessibilityRole="button"
              >
                <View style={styles.tileIconCircle}>
                  {updatingLocation ? (
                    <ActivityIndicator color={COLORS.white}/>
                  ) : (
                    <MaterialCommunityIcons name="map-marker-radius" size={30} color={COLORS.white} />
                  )}
                </View>
                <Text style={styles.bigButtonTitle}>Set pickup</Text>
                <Text style={styles.bigButtonSubtitle}>Drop a pin for passengers</Text>
                {lastLocationUpdate && (
                  <View style={styles.tileBadge}>
                    <MaterialCommunityIcons
                      name={lastLocationStatus.needsRefresh ? 'alert-circle' : 'check-circle'}
                      size={14}
                      color={lastLocationStatusColor}
                    />
                    <Text style={styles.tileBadgeText}>{lastLocationStatus.label}</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.bigButton, styles.chatTile]}
                onPress={handleOpenChat}
                activeOpacity={0.9}
                accessibilityLabel="Open group chat"
                accessibilityRole="button"
              >
                <View style={[styles.tileIconCircle, { backgroundColor: '#EEF2FF' }]}>
                  <MaterialCommunityIcons name="chat-processing" size={30} color={COLORS.info} />
                </View>
                <Text style={[styles.bigButtonTitle, { color: COLORS.text }]}>Group chat</Text>
                <Text style={[styles.bigButtonSubtitle, { color: COLORS.muted }]}>Message passengers</Text>
              </TouchableOpacity>
            </View>

            {/* Secondary Actions */}
            <View style={styles.stackButtons}>
              {driverTourPackFeature?.enabled && Boolean(activeTourId) && (
                <TouchableOpacity
                  style={[styles.wideButton, styles.infoButton]}
                  onPress={() => onNavigate('DriverTourPack', { tourId: activeTourId, from: 'DriverHome', isDriver: true })}
                  activeOpacity={0.9}
                  accessibilityLabel={`Open Driver Command Centre. ${driverTourPackState?.state || 'pack status unavailable'}`}
                  accessibilityRole="button"
                >
                  <MaterialCommunityIcons name="briefcase-account-outline" size={22} color={COLORS.primary} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.wideTitle}>Driver Command Centre</Text>
                    <Text style={styles.wideSubtitle}>{driverTourPackState?.state === 'ready' ? 'Tour pack ready offline' : 'Open operational tour pack'}</Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.primary} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.wideButton, styles.outlineButton]}
                onPress={handleOpenDriverChat}
                activeOpacity={0.9}
                accessibilityLabel="Open driver chat"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="radio-handheld" size={22} color={COLORS.primary} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.wideTitle}>Driver chat</Text>
                  <Text style={styles.wideSubtitle}>For assigned drivers only</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.dangerButton]}
                onPress={() => {
                  logger.info('DriverHomeScreen', 'Safety navigation requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onNavigate('SafetySupport', { from: 'DriverHome', mode: 'driver' });
                }}
                activeOpacity={0.9}
                accessibilityLabel="Safety and support"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="shield-check" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Safety & support</Text>
                  <Text style={[styles.wideSubtitle, { color: '#F8FAFC' }]}>Escalate issues fast</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.infoButton]}
                onPress={() => {
                  if (!activeTourId) {
                    logger.warn('DriverHomeScreen', 'Manifest navigation blocked without tour', {
                      driverId: maskIdentifier(driverData?.id),
                    });
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to view the passenger manifest.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  logger.info('DriverHomeScreen', 'Manifest navigation requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onNavigate('PassengerManifest', { tourId: activeTourId });
                }}
                activeOpacity={0.9}
                accessibilityLabel="View passenger manifest"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="clipboard-list-outline" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Passenger manifest</Text>
                  <Text style={[styles.wideSubtitle, { color: '#E0F2FE' }]}>Check-in, no-shows, stats</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.purpleButton]}
                onPress={() => {
                  if (!activeTourId) {
                    logger.warn('DriverHomeScreen', 'Client itinerary navigation blocked without tour', {
                      driverId: maskIdentifier(driverData?.id),
                    });
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to open the client itinerary.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  logger.info('DriverHomeScreen', 'Client itinerary navigation requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onNavigate('Itinerary', { tourId: activeTourId, isDriver: true });
                }}
                activeOpacity={0.9}
                accessibilityLabel="Edit client itinerary"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="calendar-edit" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Client itinerary</Text>
                  <Text style={[styles.wideSubtitle, { color: '#EDE9FE' }]}>View & edit what passengers see</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.wideButton, styles.amberButton]}
                onPress={() => {
                  if (!activeTourId) {
                    logger.warn('DriverHomeScreen', 'Driver itinerary navigation blocked without tour', {
                      driverId: maskIdentifier(driverData?.id),
                    });
                    showBanner({
                      type: 'warning',
                      message: 'Join a tour to open the driver itinerary.',
                      actionLabel: 'Join Tour',
                      actionHandler: () => setJoinModalVisible(true),
                    });
                    return;
                  }
                  logger.info('DriverHomeScreen', 'Driver itinerary navigation requested', {
                    driverId: maskIdentifier(driverData?.id),
                    activeTourId,
                  });
                  onNavigate('DriverItinerary', { tourId: activeTourId, isDriver: true });
                }}
                activeOpacity={0.9}
                accessibilityLabel="View driver itinerary"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="file-eye" size={22} color={COLORS.white} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.wideTitle, { color: COLORS.white }]}>Driver itinerary</Text>
                  <Text style={[styles.wideSubtitle, { color: '#FEF3C7' }]}>Full unredacted instructions</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.white} />
              </TouchableOpacity>
            </View>
          </ScrollView>
        </Animated.View>
      </LinearGradient>

      {/* Location Preview Modal */}
      <DriverLocationPreviewModal {...{ accuracyConfig, addressLoading, addressText, confirmingLocation, handleConfirmLocation, handleRefetchLocation, locationAccuracy, previewLocation, previewModalVisible, previewRequestIdRef, setAddressLoading, setPreviewModalVisible, setUpdatingLocation, updatingLocation }} />

      {/* JOIN TOUR MODAL */}
      <Modal
        visible={joinModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setJoinModalVisible(false)}
      >
        <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Join Tour / Route</Text>
                <TouchableOpacity
                  onPress={() => setJoinModalVisible(false)}
                  accessibilityLabel="Close modal"
                  accessibilityRole="button"
                >
                    <MaterialCommunityIcons name="close" size={24} color="#BDC3C7" />
                </TouchableOpacity>
            </View>

            <Text style={styles.modalDesc}>
                Enter the Tour Code found on your paperwork (e.g. 5112D 8).
                This will link you to the passenger manifest.
            </Text>

            <TextInput
                style={styles.input}
                placeholder="Tour Code (e.g. 5112D 8)"
                value={inputTourCode}
                onChangeText={setInputTourCode}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Tour code input"
            />

            <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: COLORS.success }]}
                onPress={handleJoinTour}
                disabled={joining}
                accessibilityLabel="Confirm tour assignment"
                accessibilityRole="button"
            >
                {joining ? (
                    <ActivityIndicator color="white" />
                ) : (
                    <Text style={styles.modalBtnText}>CONFIRM ASSIGNMENT</Text>
                )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Success Overlay */}
      <Animated.View
        style={[
          styles.successOverlay,
          {
            opacity: successAnim,
            pointerEvents: 'none',
          }
        ]}
      >
        <View style={styles.successContent}>
          <MaterialCommunityIcons name="check-circle" size={60} color={COLORS.success} />
          <Text style={styles.successText}>Location Shared!</Text>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}
