// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Switch,
  Modal,
  TextInput,
  Animated,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Haptics from '../../services/hapticsService';
import {
  CATEGORY_META,
} from '../../services/safetyService';
import logger from '../../services/loggerService';
import { COLORS as THEME } from '../../theme';

// Colors
const COLORS = {
  primary: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryMuted: THEME.primaryMuted,
  accent: THEME.accent,
  success: THEME.success,
  warning: THEME.warning,
  error: THEME.error,
  white: THEME.white,
  background: THEME.background,
  text: THEME.textPrimary,
  textSecondary: THEME.textSecondary,
  textMuted: THEME.textMuted,
  border: THEME.border,
  sosRed: '#DC2626',
  sosRedLight: '#FEE2E2',
  sosRedDark: '#991B1B',
};
const styles = createSafetySupportScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });



// ==================== SOS BUTTON COMPONENT ====================
import { ContactButton, HistoryItem, IssuePresetButton, LiveLocationCard, SafetyTip, SeveritySelector, SOSButton, TrustedContactItem } from './SafetySupportComponents';

export default function SafetySupportView(props) {
  const { cancelSOS, confirmAccessibleSOS, confirmEmergencyCall, contactSaving, customMessage, emergencyNumber, fadeAnim, handleAddContact, handleRemoveContact, handleRequestDriverCall, handleRetrySafetyQueue, handleSelectCategory, handleSubmitReport, includeLocation, isConnected, isDriver, liveLocationLastUpdate, liveLocationSharing, liveLocationUpdating, loadHistory, loadingHistory, locationAccuracy, mode, newContactName, newContactPhone, offlineQueueCount, offlineQueueSummary, onBack, openDialer, operationsNumber, requestingDriverCall, safetyHistory, selectedCategory, selectedSeverity, setCustomMessage, setIncludeLocation, setNewContactName, setNewContactPhone, setSelectedSeverity, setShowAddContactModal, setShowHistoryModal, setShowReportModal, setTipsExpanded, showAddContactModal, showHistoryModal, showReportModal, slideAnim, sosActive, sosCountdown, sosDeliveryState, startSOS, submitting, syncingOfflineQueue, tipsExpanded, toggleLiveLocation, tourData, tourId, trustedContacts, visibleCategories } = props;
return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient
        colors={[COLORS.sosRedLight, COLORS.background, COLORS.background]}
        locations={[0, 0.15, 1]}
        style={styles.gradient}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => {
              if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              logger.info('SafetySupportScreen', 'Back navigation requested', { tourId, mode });
              onBack();
            }}
            accessibilityLabel="Go back"
            accessibilityRole="button"
          >
            <MaterialCommunityIcons name="chevron-left" size={28} color={COLORS.primary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Safety & Support</Text>
          <TouchableOpacity
            style={styles.historyButton}
            onPress={loadHistory}
            accessibilityLabel="View history"
            accessibilityRole="button"
          >
            <MaterialCommunityIcons name="history" size={22} color={COLORS.primary} />
          </TouchableOpacity>
        </View>

        <Animated.ScrollView
          contentContainerStyle={styles.scrollContent}
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          showsVerticalScrollIndicator={false}
        >
          {/* Offline Banner */}
          {!isConnected && (
            <View style={styles.offlineBanner}>
              <MaterialCommunityIcons name="wifi-off" size={18} color={COLORS.white} />
              <Text style={styles.offlineBannerText}>
                {offlineQueueCount > 0
                  ? `You're offline. ${offlineQueueCount} safety report(s) are saved on this device.`
                  : "You're offline. Reports can be saved on this device for retry."}
              </Text>
            </View>
          )}

          {/* Pending Queue Banner */}
          {offlineQueueCount > 0 && isConnected && (
            <View style={[
              styles.queueBanner,
              offlineQueueSummary.requiresAttention > 0 && styles.queueAttentionBanner,
            ]}>
              <MaterialCommunityIcons
                name={offlineQueueSummary.requiresAttention > 0 ? 'alert-circle' : 'cloud-upload'}
                size={18}
                color={COLORS.white}
              />
              <Text style={styles.queueBannerText}>
                {offlineQueueSummary.requiresAttention > 0
                  ? `${offlineQueueSummary.requiresAttention} saved report(s) need another attempt.`
                  : syncingOfflineQueue
                    ? `Sending ${offlineQueueCount} saved report(s)…`
                    : `${offlineQueueCount} report(s) safely saved for automatic retry.`}
              </Text>
              {offlineQueueSummary.requiresAttention > 0 && (
                <TouchableOpacity
                  style={styles.queueRetryButton}
                  onPress={handleRetrySafetyQueue}
                  disabled={syncingOfflineQueue}
                  accessibilityRole="button"
                  accessibilityLabel="Retry saved safety reports"
                >
                  {syncingOfflineQueue
                    ? <ActivityIndicator size="small" color={COLORS.error} />
                    : <Text style={styles.queueRetryButtonText}>Retry now</Text>}
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* SOS Emergency Button */}
          <SOSButton
            onActivate={startSOS}
            onAccessibleActivate={confirmAccessibleSOS}
            isActive={sosActive}
            countdown={sosCountdown}
            onCancel={cancelSOS}
          />

          {sosDeliveryState.status !== 'idle' && (
            <View
              style={[
                styles.sosDeliveryBanner,
                sosDeliveryState.status === 'failed' && styles.sosDeliveryBannerFailed,
                sosDeliveryState.status === 'submitted' && styles.sosDeliveryBannerSubmitted,
              ]}
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
            >
              {sosDeliveryState.status === 'sending'
                ? <ActivityIndicator size="small" color={COLORS.primary} />
                : (
                  <MaterialCommunityIcons
                    name={sosDeliveryState.status === 'failed'
                      ? 'alert-circle'
                      : sosDeliveryState.status === 'submitted'
                        ? 'check-circle'
                        : 'cloud-clock'}
                    size={20}
                    color={sosDeliveryState.status === 'failed'
                      ? COLORS.error
                      : sosDeliveryState.status === 'submitted'
                        ? COLORS.success
                        : COLORS.warning}
                  />
                )}
              <Text style={styles.sosDeliveryText}>{sosDeliveryState.message}</Text>
            </View>
          )}

          {/* Instant Contacts Card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIconCircle, { backgroundColor: `${COLORS.success}15` }]}>
                <MaterialCommunityIcons name="phone-ring" size={22} color={COLORS.success} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Emergency Contacts</Text>
                <Text style={styles.cardSubtitle}>Get help with one tap</Text>
              </View>
            </View>

            <View style={styles.contactsGrid}>
              <ContactButton
                icon="hospital-box"
                label="Emergency"
                sublabel={emergencyNumber}
                onPress={confirmEmergencyCall}
                color={COLORS.error}
              />
              <ContactButton
                icon="headset"
                label="Operations"
                sublabel={operationsNumber}
                onPress={() => openDialer(operationsNumber)}
                color={COLORS.primary}
              />
              {!isDriver && (
                <ContactButton
                  icon="phone-in-talk"
                  label="Driver"
                  sublabel={requestingDriverCall ? 'Requesting...' : 'Request callback'}
                  onPress={handleRequestDriverCall}
                  color={COLORS.accent}
                />
              )}
            </View>
          </View>

          {/* Live Location Sharing */}
          <LiveLocationCard
            isSharing={liveLocationSharing}
            onToggle={toggleLiveLocation}
            lastUpdate={liveLocationLastUpdate}
            accuracy={locationAccuracy}
            isUpdating={liveLocationUpdating}
          />

          {/* Report Issues Card */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIconCircle, { backgroundColor: `${COLORS.accent}15` }]}>
                <MaterialCommunityIcons name="alert-decagram" size={22} color={COLORS.accent} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Report an Issue</Text>
                <Text style={styles.cardSubtitle}>Select the type of issue you're experiencing</Text>
              </View>
            </View>

            <View style={styles.locationToggle}>
              <MaterialCommunityIcons name="map-marker" size={18} color={COLORS.primary} />
              <Text style={styles.locationToggleText}>Include my location</Text>
              <Switch
                value={includeLocation}
                onValueChange={setIncludeLocation}
                trackColor={{ true: COLORS.primary, false: COLORS.border }}
                thumbColor={COLORS.white}
                accessibilityLabel="Include my location with this safety report"
              />
            </View>

            <View style={styles.issuePresets}>
              {visibleCategories.map((category) => (
                <IssuePresetButton
                  key={category}
                  preset={category}
                  onPress={handleSelectCategory}
                  isLoading={submitting && selectedCategory === category}
                  isSelected={selectedCategory === category}
                />
              ))}
            </View>
          </View>

          {/* Trusted Emergency Contacts */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIconCircle, { backgroundColor: `${COLORS.primary}15` }]}>
                <MaterialCommunityIcons name="account-group" size={22} color={COLORS.primary} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Trusted Contacts</Text>
                <Text style={styles.cardSubtitle}>People who can help in an emergency</Text>
              </View>
              <TouchableOpacity
                style={styles.addContactButton}
                onPress={() => setShowAddContactModal(true)}
                accessibilityLabel="Add contact"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="plus" size={20} color={COLORS.white} />
              </TouchableOpacity>
            </View>

            {trustedContacts.length === 0 ? (
              <View style={styles.emptyContacts}>
                <MaterialCommunityIcons name="account-plus" size={32} color={COLORS.textMuted} />
                <Text style={styles.emptyContactsText}>
                  Add trusted contacts who can be notified in an emergency
                </Text>
              </View>
            ) : (
              <View style={styles.trustedContactsList}>
                {trustedContacts.map((contact) => (
                  <TrustedContactItem
                    key={contact.id}
                    contact={contact}
                    onRemove={handleRemoveContact}
                    onCall={openDialer}
                  />
                ))}
              </View>
            )}
          </View>

          {/* Safety Tips */}
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.tipsHeader}
              onPress={() => setTipsExpanded(!tipsExpanded)}
              activeOpacity={0.8}
              accessibilityLabel={tipsExpanded ? 'Collapse tips' : 'Expand tips'}
              accessibilityRole="button"
            >
              <View style={[styles.cardIconCircle, { backgroundColor: `${COLORS.primary}15` }]}>
                <MaterialCommunityIcons name="lightbulb-on" size={22} color={COLORS.primary} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Safety Tips</Text>
                <Text style={styles.cardSubtitle}>Stay safe during your tour</Text>
              </View>
              <MaterialCommunityIcons
                name={tipsExpanded ? 'chevron-up' : 'chevron-down'}
                size={24}
                color={COLORS.textMuted}
              />
            </TouchableOpacity>

            {tipsExpanded && (
              <View style={styles.tipsContent}>
                <SafetyTip
                  icon="account-group"
                  title="Stay with your group"
                  description="Always remain with your tour group at stops and attractions."
                  color={COLORS.primary}
                />
                <SafetyTip
                  icon="bag-personal"
                  title="Secure your belongings"
                  description="Keep valuables close and be aware of your surroundings."
                  color={COLORS.accent}
                />
                <SafetyTip
                  icon="map-marker-check"
                  title="Know meeting points"
                  description="Confirm pickup locations and times with your driver."
                  color={COLORS.success}
                />
                <SafetyTip
                  icon="phone-check"
                  title="Keep phone charged"
                  description="Ensure your phone has battery for emergencies."
                  color={COLORS.warning}
                />
                {isDriver && (
                  <>
                    <SafetyTip
                      icon="weather-cloudy-alert"
                      title="Monitor conditions"
                      description="Stay aware of weather and road conditions."
                      color="#0284C7"
                    />
                    <SafetyTip
                      icon="clock-alert"
                      title="Report delays early"
                      description="Notify operations of any delays as soon as possible."
                      color={COLORS.error}
                    />
                  </>
                )}
              </View>
            )}
          </View>

          {/* Tour Info */}
          {tourData && (
            <View style={styles.tourInfoCard}>
              <MaterialCommunityIcons name="bus" size={18} color={COLORS.textMuted} />
              <Text style={styles.tourInfoText}>
                Tour: {tourData.name || tourData.tourCode || 'Unknown'}
              </Text>
            </View>
          )}

          <View style={styles.bottomSpacer} />
        </Animated.ScrollView>
      </LinearGradient>

      {/* Report Modal */}
      <Modal
        visible={showReportModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowReportModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {CATEGORY_META[selectedCategory]?.title || 'Report Issue'}
              </Text>
              <TouchableOpacity
                onPress={() => setShowReportModal(false)}
                accessibilityLabel="Close"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <Text style={styles.modalDescription}>
                {CATEGORY_META[selectedCategory]?.description}
              </Text>

              <SeveritySelector
                selected={selectedSeverity}
                onSelect={setSelectedSeverity}
              />

              <Text style={styles.inputLabel}>Additional Details (Optional)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Describe the issue..."
                placeholderTextColor={COLORS.textMuted}
                value={customMessage}
                onChangeText={setCustomMessage}
                multiline
                numberOfLines={3}
                maxLength={1000}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowReportModal(false)}
                accessibilityLabel="Cancel"
                accessibilityRole="button"
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.submitButton}
                onPress={handleSubmitReport}
                disabled={submitting}
                accessibilityLabel="Submit report"
                accessibilityRole="button"
              >
                {submitting ? (
                  <ActivityIndicator color={COLORS.white} />
                ) : (
                  <>
                    <MaterialCommunityIcons name="send" size={18} color={COLORS.white} />
                    <Text style={styles.submitButtonText}>Submit Report</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Contact Modal */}
      <Modal
        visible={showAddContactModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowAddContactModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Emergency Contact</Text>
              <TouchableOpacity
                onPress={() => setShowAddContactModal(false)}
                accessibilityLabel="Close"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <Text style={styles.inputLabel}>Contact Name</Text>
              <TextInput
                style={styles.textInputSingle}
                placeholder="e.g., Mom, Partner, Friend"
                placeholderTextColor={COLORS.textMuted}
                value={newContactName}
                onChangeText={setNewContactName}
                autoCapitalize="words"
                maxLength={80}
              />

              <Text style={styles.inputLabel}>Phone Number</Text>
              <TextInput
                style={styles.textInputSingle}
                placeholder="e.g., +44 7700 900000"
                placeholderTextColor={COLORS.textMuted}
                value={newContactPhone}
                onChangeText={setNewContactPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                maxLength={40}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setShowAddContactModal(false);
                  setNewContactName('');
                  setNewContactPhone('');
                }}
                accessibilityLabel="Cancel"
                accessibilityRole="button"
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.submitButton}
                onPress={handleAddContact}
                disabled={contactSaving}
                accessibilityLabel="Add contact"
                accessibilityRole="button"
              >
                {contactSaving ? (
                  <ActivityIndicator color={COLORS.white} />
                ) : (
                  <>
                    <MaterialCommunityIcons name="account-plus" size={18} color={COLORS.white} />
                    <Text style={styles.submitButtonText}>Add Contact</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* History Modal */}
      <Modal
        visible={showHistoryModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowHistoryModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, styles.historyModalContent]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Report History</Text>
              <TouchableOpacity
                onPress={() => setShowHistoryModal(false)}
                accessibilityLabel="Close"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.historyScroll}>
              {loadingHistory ? (
                <View style={styles.historyLoading}>
                  <ActivityIndicator size="large" color={COLORS.primary} />
                  <Text style={styles.historyLoadingText}>Loading history...</Text>
                </View>
              ) : safetyHistory.length === 0 ? (
                <View style={styles.historyEmpty}>
                  <MaterialCommunityIcons name="history" size={48} color={COLORS.textMuted} />
                  <Text style={styles.historyEmptyText}>No reports yet</Text>
                  <Text style={styles.historyEmptySubtext}>
                    Your safety reports will appear here
                  </Text>
                </View>
              ) : (
                safetyHistory.map((event) => (
                  <HistoryItem key={event.id} event={event} />
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
