// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import createSafetySupportScreenStyles from './styles/SafetySupportScreen.styles';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Linking,
  Alert,
  ActivityIndicator,
  Switch,
  Modal,
  TextInput,
  Animated,
  useWindowDimensions,
  Platform,
  KeyboardAvoidingView,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Location from 'expo-location';
import * as Haptics from '../services/hapticsService';
import {
  logSafetyEvent,
  SAFETY_CATEGORIES,
  CATEGORY_META,
  SEVERITY_LEVELS,
  SEVERITY_META,
  updateLiveLocationSharing,
  getTrustedContacts,
  addTrustedContact,
  removeTrustedContact,
  generateEmergencySMS,
  getSafetyHistory,
  processOfflineQueue,
  getOfflineQueueSummary,
  getOfflineQueuedSafetyEvents,
} from '../services/safetyService';
import logger, { maskIdentifier } from '../services/loggerService';
import { resolveTourId } from '../services/tourIdentityService';
import { parseTimestampMs } from '../services/timeUtils';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';

const SOS_COUNTDOWN_SECONDS = 5;
const MIN_DIALABLE_DIGITS = 7;
const EMPTY_QUEUE_SUMMARY = Object.freeze({
  total: 0,
  readyToRetry: 0,
  waiting: 0,
  requiresAttention: 0,
  nextRetryAtMs: null,
});

const SAFETY_STATUS_META = {
  pending: { label: 'Submitted', color: '#2563EB' },
  acknowledged: { label: 'Acknowledged', color: '#0F766E' },
  in_progress: { label: 'In progress', color: '#7C3AED' },
  escalated: { label: 'Escalated', color: '#DC2626' },
  resolved: { label: 'Resolved', color: '#16A34A' },
};

const hasDialableDigits = (phone) => (
  (String(phone || '').match(/\d/g) || []).length >= MIN_DIALABLE_DIGITS
);

const getSafetyEventTimestampMs = (event) => {
  const parsed = parseTimestampMs(event?.timestamp || event?.queuedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

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

// ==================== SOS BUTTON COMPONENT ====================
const SOSButton = ({ onActivate, onAccessibleActivate, isActive, countdown, onCancel }) => {
  const { width: windowWidth } = useWindowDimensions();
  const buttonSize = Math.min(188, Math.max(148, (windowWidth || 360) * 0.45));
  const glowSize = buttonSize + 28;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isActive) {
      // Pulsing animation during countdown
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
        ])
      ).start();

      // Glow animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0.3,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
      glowAnim.setValue(0);
    }
  }, [isActive]);

  return (
    <View style={styles.sosCard}>
      <View style={styles.sosCardHeader}>
        <View style={styles.sosCardIcon}>
          <MaterialCommunityIcons name="shield-alert" size={24} color={COLORS.sosRed} />
        </View>
        <View style={styles.sosCardHeaderText}>
          <Text style={styles.sosEyebrow}>Emergency options</Text>
          <Text style={styles.sosTitle}>Need urgent help?</Text>
        </View>
      </View>

      <View style={[styles.sosButtonStage, { minHeight: glowSize }]}>
        {isActive && (
          <Animated.View
            style={[
              styles.sosGlow,
              {
                width: glowSize,
                height: glowSize,
                borderRadius: glowSize / 2,
                opacity: glowAnim,
                transform: [{ scale: pulseAnim }],
              },
            ]}
          />
        )}
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[
              styles.sosButton,
              {
                width: buttonSize,
                height: buttonSize,
                borderRadius: buttonSize / 2,
              },
              isActive && styles.sosButtonActive,
            ]}
            onLongPress={onActivate}
            onPress={isActive ? onCancel : onAccessibleActivate}
            delayLongPress={500}
            activeOpacity={0.9}
            accessibilityLabel={isActive ? 'Cancel SOS countdown' : 'Hold for SOS emergency options'}
            accessibilityHint={isActive
              ? 'Cancels the emergency-options countdown.'
              : 'Double tap to confirm, or hold, to start the emergency-options countdown. The app does not call 999 automatically.'}
            accessibilityRole="button"
          >
            <LinearGradient
              colors={isActive ? [COLORS.sosRedDark, COLORS.sosRed] : [COLORS.sosRed, '#EF4444']}
              style={[styles.sosGradient, { borderRadius: buttonSize / 2 }]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              {isActive ? (
                <View style={styles.sosContent}>
                  <Text
                    style={styles.sosCountdown}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {countdown}
                  </Text>
                  <Text
                    style={styles.sosCancelText}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    Tap to cancel
                  </Text>
                </View>
              ) : (
                <View style={styles.sosContent}>
                  <MaterialCommunityIcons name="alarm-light" size={36} color={COLORS.white} />
                  <Text
                    style={styles.sosText}
                    numberOfLines={1}
                  >
                    SOS
                  </Text>
                </View>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>
      </View>

      {!isActive ? (
        <View style={styles.sosHelpPanel}>
          <View style={styles.sosHelpIcon}>
            <MaterialCommunityIcons name="gesture-tap-hold" size={18} color={COLORS.sosRed} />
          </View>
          <Text style={styles.sosHelpText}>
            Hold SOS for emergency call options. The app attempts to attach your location, but does not contact 999 automatically.
          </Text>
        </View>
      ) : (
        <Text style={styles.sosActiveText}>
          Emergency options will open when the countdown reaches zero.
        </Text>
      )}
    </View>
  );
};

// ==================== CONTACT BUTTON COMPONENT ====================
const ContactButton = ({ icon, label, sublabel, onPress, color = COLORS.primary, style }) => (
  <TouchableOpacity
    style={[styles.contactButton, style]}
    onPress={() => {
      if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }}
    activeOpacity={0.8}
    accessibilityLabel={label}
    accessibilityRole="button"
  >
    <View style={[styles.contactIconCircle, { backgroundColor: `${color}15` }]}>
      <MaterialCommunityIcons name={icon} size={24} color={color} />
    </View>
    <View style={styles.contactTextContainer}>
      <Text style={styles.contactLabel}>{label}</Text>
      {sublabel && <Text style={styles.contactSublabel}>{sublabel}</Text>}
    </View>
    <MaterialCommunityIcons name="phone" size={20} color={color} />
  </TouchableOpacity>
);

// ==================== ISSUE PRESET BUTTON COMPONENT ====================
const IssuePresetButton = ({ preset, onPress, isLoading, isSelected }) => {
  const meta = CATEGORY_META[preset];
  if (!meta) return null;

  return (
    <TouchableOpacity
      style={[styles.issuePreset, isSelected && styles.issuePresetSelected]}
      onPress={() => {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress(preset);
      }}
      disabled={isLoading}
      activeOpacity={0.8}
      accessibilityLabel={meta.title}
      accessibilityRole="button"
    >
      <View style={[styles.issueIconCircle, { backgroundColor: `${meta.color}15` }]}>
        <MaterialCommunityIcons name={meta.icon} size={22} color={meta.color} />
      </View>
      <View style={styles.issueTextContainer}>
        <Text style={styles.issueTitle}>{meta.title}</Text>
        <Text style={styles.issueDescription}>{meta.description}</Text>
      </View>
      {isLoading ? (
        <ActivityIndicator size="small" color={COLORS.primary} />
      ) : (
        <MaterialCommunityIcons
          name={isSelected ? 'check-circle' : 'chevron-right'}
          size={22}
          color={isSelected ? COLORS.success : COLORS.textMuted}
        />
      )}
    </TouchableOpacity>
  );
};

// ==================== SEVERITY SELECTOR COMPONENT ====================
const SeveritySelector = ({ selected, onSelect }) => (
  <View style={styles.severityContainer}>
    <Text style={styles.severityLabel}>Urgency Level</Text>
    <View style={styles.severityOptions}>
      {Object.entries(SEVERITY_META).map(([key, meta]) => (
        <TouchableOpacity
          key={key}
          style={[
            styles.severityOption,
            selected === key && { backgroundColor: `${meta.color}20`, borderColor: meta.color },
          ]}
          onPress={() => {
            if (Platform.OS === 'ios') Haptics.selectionAsync();
            onSelect(key);
          }}
          activeOpacity={0.7}
          accessibilityLabel={meta.label}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons
            name={meta.icon}
            size={18}
            color={selected === key ? meta.color : COLORS.textMuted}
          />
          <Text
            style={[
              styles.severityText,
              selected === key && { color: meta.color, fontWeight: '700' },
            ]}
          >
            {meta.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

// ==================== LIVE LOCATION CARD COMPONENT ====================
const LiveLocationCard = ({
  isSharing,
  onToggle,
  lastUpdate,
  accuracy,
  isUpdating,
}) => {
  const getAccuracyLabel = () => {
    if (!accuracy) return { text: 'Unknown', color: COLORS.textMuted };
    if (accuracy <= 10) return { text: 'Excellent', color: COLORS.success };
    if (accuracy <= 30) return { text: 'Good', color: COLORS.primary };
    if (accuracy <= 100) return { text: 'Fair', color: COLORS.warning };
    return { text: 'Poor', color: COLORS.error };
  };

  const accuracyInfo = getAccuracyLabel();

  return (
    <View style={styles.liveLocationCard}>
      <View style={styles.liveLocationHeader}>
        <View style={styles.liveLocationIcon}>
          <MaterialCommunityIcons
            name={isSharing ? 'map-marker-radius' : 'map-marker-off'}
            size={24}
            color={isSharing ? COLORS.success : COLORS.textMuted}
          />
        </View>
        <View style={styles.liveLocationTextContainer}>
          <Text style={styles.liveLocationTitle}>Live Location Sharing</Text>
          <Text style={styles.liveLocationSubtitle}>
            {isSharing
              ? 'Shared with operations while this screen is open'
              : 'Share with operations while this screen is open'}
          </Text>
        </View>
        {isUpdating ? (
          <ActivityIndicator size="small" color={COLORS.primary} />
        ) : (
          <Switch
            value={isSharing}
            onValueChange={onToggle}
            trackColor={{ true: COLORS.success, false: COLORS.border }}
            thumbColor={COLORS.white}
            accessibilityLabel="Share live location with operations while this screen is open"
          />
        )}
      </View>

      {isSharing && (
        <View style={styles.liveLocationStatus}>
          <View style={styles.liveLocationStatusItem}>
            <View style={[styles.statusDot, { backgroundColor: COLORS.success }]} />
            <Text style={styles.statusText}>Active</Text>
          </View>
          <View style={styles.liveLocationStatusItem}>
            <MaterialCommunityIcons name="crosshairs-gps" size={14} color={accuracyInfo.color} />
            <Text style={[styles.statusText, { color: accuracyInfo.color }]}>
              {accuracyInfo.text} ({Math.round(accuracy || 0)}m)
            </Text>
          </View>
          {lastUpdate && (
            <View style={styles.liveLocationStatusItem}>
              <MaterialCommunityIcons name="clock-outline" size={14} color={COLORS.textMuted} />
              <Text style={styles.statusText}>Updated just now</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
};

// ==================== TRUSTED CONTACT COMPONENT ====================
const TrustedContactItem = ({ contact, onRemove, onCall }) => (
  <View style={styles.trustedContactItem}>
    <View style={styles.trustedContactIcon}>
      <MaterialCommunityIcons name="account-heart" size={20} color={COLORS.primary} />
    </View>
    <View style={styles.trustedContactInfo}>
      <Text style={styles.trustedContactName}>{contact.name}</Text>
      <Text style={styles.trustedContactPhone}>{contact.phone}</Text>
    </View>
    <TouchableOpacity
      style={styles.trustedContactAction}
      onPress={() => onCall(contact.phone)}
      accessibilityLabel={`Call ${contact.name}`}
    >
      <MaterialCommunityIcons name="phone" size={18} color={COLORS.success} />
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.trustedContactAction}
      onPress={() => onRemove(contact.id)}
      accessibilityLabel={`Remove ${contact.name}`}
    >
      <MaterialCommunityIcons name="close" size={18} color={COLORS.error} />
    </TouchableOpacity>
  </View>
);

// ==================== SAFETY TIP COMPONENT ====================
const SafetyTip = ({ icon, title, description, color = COLORS.primary }) => (
  <View style={styles.safetyTip}>
    <View style={[styles.safetyTipIcon, { backgroundColor: `${color}12` }]}>
      <MaterialCommunityIcons name={icon} size={20} color={color} />
    </View>
    <View style={styles.safetyTipContent}>
      <Text style={styles.safetyTipTitle}>{title}</Text>
      <Text style={styles.safetyTipDescription}>{description}</Text>
    </View>
  </View>
);

// ==================== HISTORY ITEM COMPONENT ====================
const HistoryItem = ({ event }) => {
  const meta = CATEGORY_META[event.category] || {};
  const severityMeta = SEVERITY_META[event.severity] || {};
  const isQueued = Boolean(event.isQueued);
  const statusMeta = isQueued
    ? event.retryDisposition === 'requires_attention'
      ? { label: 'Needs retry', color: COLORS.error }
      : { label: 'Saved', color: COLORS.warning }
    : SAFETY_STATUS_META[event.status] || SAFETY_STATUS_META.pending;

  const formatDate = (timestamp) => {
    const parsedMs = parseTimestampMs(timestamp);
    if (!Number.isFinite(parsedMs)) return 'Unknown time';
    const date = new Date(parsedMs);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <View style={styles.historyItem}>
      <View style={[styles.historyIcon, { backgroundColor: `${meta.color || COLORS.textMuted}15` }]}>
        <MaterialCommunityIcons
          name={meta.icon || 'alert'}
          size={18}
          color={meta.color || COLORS.textMuted}
        />
      </View>
      <View style={styles.historyContent}>
        <Text style={styles.historyTitle}>{meta.title || 'Report'}</Text>
        <Text style={styles.historyDate}>
          {severityMeta.label ? `${severityMeta.label} urgency · ` : ''}{formatDate(event.timestamp || event.queuedAt)}
        </Text>
      </View>
      <View
        style={[
          styles.historyBadge,
          { backgroundColor: `${statusMeta.color}20` },
        ]}
      >
        <Text
          style={[
            styles.historyBadgeText,
            { color: statusMeta.color },
          ]}
        >
          {statusMeta.label}
        </Text>
      </View>
    </View>
  );
};

// ==================== MAIN SCREEN COMPONENT ====================
export default function SafetySupportScreen({
  onBack,
  tourData,
  bookingData,
  userId,
  principalId,
  mode = 'passenger',
  isConnected = true,
}) {
  // Core state
  const [includeLocation, setIncludeLocation] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedSeverity, setSelectedSeverity] = useState(SEVERITY_LEVELS.MEDIUM);
  const [customMessage, setCustomMessage] = useState('');

  // SOS state
  const [sosActive, setSosActive] = useState(false);
  const [sosCountdown, setSosCountdown] = useState(SOS_COUNTDOWN_SECONDS);
  const sosTimerRef = useRef(null);
  const sosCountdownRef = useRef(SOS_COUNTDOWN_SECONDS);
  const sosCoordsRef = useRef(null);
  const [sosDeliveryState, setSosDeliveryState] = useState({ status: 'idle', message: '' });
  const mountedRef = useRef(true);
  const historyRequestSeqRef = useRef(0);

  // Live location state
  const [liveLocationSharing, setLiveLocationSharing] = useState(false);
  const [liveLocationUpdating, setLiveLocationUpdating] = useState(false);
  const [currentCoords, setCurrentCoords] = useState(null);
  const [locationAccuracy, setLocationAccuracy] = useState(null);
  const [liveLocationLastUpdate, setLiveLocationLastUpdate] = useState(null);
  const locationWatchRef = useRef(null);
  const liveLocationSharingRef = useRef(false);
  const activeLiveLocationScopeRef = useRef(null);

  useEffect(() => () => {
    mountedRef.current = false;
    historyRequestSeqRef.current += 1;
    if (sosTimerRef.current) {
      clearInterval(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    if (locationWatchRef.current) {
      locationWatchRef.current.remove();
      locationWatchRef.current = null;
    }
    const activeScope = activeLiveLocationScopeRef.current;
    if (liveLocationSharingRef.current && activeScope?.tourId && activeScope?.userId) {
      updateLiveLocationSharing(activeScope.tourId, activeScope.userId, false).catch(() => {});
      liveLocationSharingRef.current = false;
      activeLiveLocationScopeRef.current = null;
    }
  }, []);

  // Contacts state
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [contactSaving, setContactSaving] = useState(false);

  // Report modal state
  const [showReportModal, setShowReportModal] = useState(false);

  // History state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [safetyHistory, setSafetyHistory] = useState([]);
  const [requestingDriverCall, setRequestingDriverCall] = useState(false);

  // Derived values
  const isDriver = mode === 'driver';
  const emergencyNumber = '999';
  const operationsNumber = '+441414876737';
  const tourId = resolveTourId(tourData?.id, tourData?.tourCode);
  const userName = bookingData?.passengerNames?.[0] || (isDriver ? tourData?.driverName : 'Passenger');
  const safetyQueueScope = useMemo(() => ({
    tourId,
    principalId: principalId || userId,
    role: mode === 'driver' ? 'driver' : 'passenger',
  }), [mode, principalId, tourId, userId]);

  const [loadingHistory, setLoadingHistory] = useState(false);

  // Tips expanded state
  const [tipsExpanded, setTipsExpanded] = useState(false);

  // Offline queue state
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [offlineQueueSummary, setOfflineQueueSummary] = useState(EMPTY_QUEUE_SUMMARY);
  const [syncingOfflineQueue, setSyncingOfflineQueue] = useState(false);

  // Animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;

  useEffect(() => {
    logger.trackScreen('SafetySupport', {
      tourId,
      mode,
      isConnected,
      userId: maskIdentifier(userId),
      hasTourData: Boolean(tourData),
      hasBookingData: Boolean(bookingData),
    });
  }, [bookingData, isConnected, mode, tourData, tourId, userId]);

  // Get visible categories based on mode
  const visibleCategories = useMemo(() => {
    return Object.keys(CATEGORY_META).filter((key) => {
      const meta = CATEGORY_META[key];
      if (key === SAFETY_CATEGORIES.SOS) return false; // SOS is handled separately
      if (meta.driverOnly && !isDriver) return false;
      return true;
    });
  }, [isDriver]);

  // Entry animation
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const safetyPrincipalId = principalId || userId;

  // Load trusted contacts
  useEffect(() => {
    loadTrustedContacts();
  }, [safetyPrincipalId]);

  useEffect(() => {
    checkOfflineQueue();
  }, [safetyQueueScope]);

  // Process offline queue when connected
  useEffect(() => {
    if (isConnected && offlineQueueSummary.readyToRetry > 0 && !syncingOfflineQueue) {
      setSyncingOfflineQueue(true);
      logger.info('SafetySupportScreen', 'Processing offline safety queue after reconnect', {
        userId: maskIdentifier(userId),
        offlineQueueCount: offlineQueueSummary.total,
      });
      processOfflineQueue(safetyQueueScope).then(async ({ processed, failed, requiresAttention }) => {
        if (!mountedRef.current) return;
        logger.info('SafetySupportScreen', 'Offline safety queue processed', {
          userId: maskIdentifier(userId),
          processed,
          failed,
          requiresAttention,
        });
        if (processed > 0) {
          Alert.alert(
            'Reports Synced',
            `${processed} pending safety report(s) have been submitted.`
          );
        }
        await checkOfflineQueue();
      }).catch((error) => {
        logger.error('SafetySupportScreen', 'Offline safety queue processing failed', {
          userId: maskIdentifier(userId),
          error: error?.message || String(error),
        });
      }).finally(() => {
        if (mountedRef.current) setSyncingOfflineQueue(false);
      });
    }
  }, [isConnected, offlineQueueSummary.readyToRetry, offlineQueueSummary.total, safetyQueueScope, syncingOfflineQueue, userId]);

  useEffect(() => {
    if (!isConnected || !offlineQueueSummary.nextRetryAtMs) return undefined;
    const delay = Math.max(0, offlineQueueSummary.nextRetryAtMs - Date.now());
    const timer = setTimeout(() => {
      checkOfflineQueue();
    }, Math.min(delay + 50, 15 * 60 * 1000));
    return () => clearTimeout(timer);
  }, [isConnected, offlineQueueSummary.nextRetryAtMs, safetyQueueScope]);

  const loadTrustedContacts = async () => {
    logger.debug('SafetySupportScreen', 'Trusted contacts load started');
    const contacts = await getTrustedContacts(safetyPrincipalId);
    if (!mountedRef.current) return;
    setTrustedContacts(contacts);
    logger.info('SafetySupportScreen', 'Trusted contacts loaded', { contactCount: contacts.length });
  };

  const checkOfflineQueue = async () => {
    const summary = await getOfflineQueueSummary(safetyQueueScope);
    if (!mountedRef.current) return;
    setOfflineQueueCount(summary.total);
    setOfflineQueueSummary(summary);
    logger.info('SafetySupportScreen', 'Offline safety queue summary loaded', {
      count: summary.total,
      readyToRetry: summary.readyToRetry,
      requiresAttention: summary.requiresAttention,
    });
  };

  const handleRetrySafetyQueue = async () => {
    if (!isConnected || syncingOfflineQueue) return;
    setSyncingOfflineQueue(true);
    try {
      const result = await processOfflineQueue(safetyQueueScope, { manual: true });
      await checkOfflineQueue();
      if (!mountedRef.current) return;
      if (result.processed > 0) {
        Alert.alert('Saved reports sent', `${result.processed} safety report(s) were submitted.`);
      } else if (result.requiresAttention > 0 || result.failed > 0) {
        Alert.alert(
          'Report still needs attention',
          'The saved report could not be accepted. Check that this tour session is current, or call operations if the issue is urgent.',
        );
      }
    } finally {
      if (mountedRef.current) setSyncingOfflineQueue(false);
    }
  };

  const openDialer = async (phone) => {
    if (!phone) {
      logger.warn('SafetySupportScreen', 'Dialer blocked without phone', { mode, tourId });
      Alert.alert('Contact unavailable', 'No phone number is configured for this tour.');
      return;
    }
    const sanitized = phone.replace(/[^+\d]/g, '');
    if (!sanitized || !hasDialableDigits(sanitized)) {
      logger.warn('SafetySupportScreen', 'Dialer blocked with invalid phone', { mode, tourId });
      Alert.alert('Contact unavailable', 'No valid phone number is configured for this tour.');
      return;
    }
    logger.info('SafetySupportScreen', 'Dialer opened', {
      mode,
      tourId,
      phoneLength: sanitized.length,
    });
    try {
      await Linking.openURL(`tel:${sanitized}`);
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Dialer launch failed', {
        mode,
        tourId,
        phoneLength: sanitized.length,
        error: error?.message || String(error),
      });
      Alert.alert('Could not open phone app', `Please dial ${sanitized} manually if this is urgent.`);
    }
  };

  const confirmEmergencyCall = () => {
    logger.warn('SafetySupportScreen', 'Emergency call confirmation opened', {
      mode,
      tourId,
      userId: maskIdentifier(userId),
    });
    Alert.alert(
      'Call emergency services?',
      'Only continue for an extreme emergency requiring immediate police, fire, or ambulance response.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Call ${emergencyNumber}`,
          style: 'destructive',
          onPress: () => openDialer(emergencyNumber),
        },
      ]
    );
  };

  const handleRequestDriverCall = async () => {
    if (requestingDriverCall) return;
    if (!tourId) {
      logger.warn('SafetySupportScreen', 'Driver callback request blocked without tour id', {
        userId: maskIdentifier(userId),
      });
      Alert.alert('Unavailable', 'We could not find your tour right now. Please contact operations.');
      return;
    }

    setRequestingDriverCall(true);
    logger.info('SafetySupportScreen', 'Driver callback request started', {
      tourId,
      userId: maskIdentifier(userId),
      isConnected,
    });
    let result;
    try {
      result = await logSafetyEvent({
        userId,
        principalId: principalId || userId,
        tourId,
        role: 'passenger',
        category: SAFETY_CATEGORIES.CUSTOM,
        severity: SEVERITY_LEVELS.MEDIUM,
        message: 'Driver callback requested',
        customMessage: 'A passenger requested a callback from the assigned driver.',
        online: isConnected,
      });
    } catch (error) {
      result = { success: false, error: error?.code || error?.message || 'unknown' };
    }
    if (!mountedRef.current) return;
    setRequestingDriverCall(false);

    if (result?.success) {
      logger.info('SafetySupportScreen', 'Driver callback request sent', {
        tourId,
        queued: Boolean(result.queued),
      });
      Alert.alert(
        result.queued ? 'Callback request saved' : 'Callback requested',
        result.queued
          ? 'Your request is stored on this device and will be sent to the driver team when you reconnect.'
          : 'Your request was securely received for the assigned driver team. Please keep your phone nearby.'
      );
      return;
    }

    logger.warn('SafetySupportScreen', 'Driver callback request failed', {
      tourId,
      error: result?.error || 'unknown',
    });
    Alert.alert(
      'Could not send request',
      'Please try again, or contact operations directly if this is urgent.'
    );
  };

  const sendSMS = async (phone, message) => {
    const sanitized = typeof phone === 'string' ? phone.replace(/[^+\d]/g, '') : '';
    if (!sanitized || !hasDialableDigits(sanitized)) {
      logger.warn('SafetySupportScreen', 'Emergency SMS blocked with invalid phone', { tourId });
      Alert.alert('Contact unavailable', 'No valid SMS number is available for this contact.');
      return;
    }

    const encoded = encodeURIComponent(message);
    logger.info('SafetySupportScreen', 'Emergency SMS compose opened', {
      tourId,
      phoneLength: sanitized.length,
      messageLength: message?.length || 0,
    });
    try {
      await Linking.openURL(`sms:${sanitized}?body=${encoded}`);
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Emergency SMS launch failed', {
        tourId,
        phoneLength: sanitized.length,
        error: error?.message || String(error),
      });
      Alert.alert('Could not open messages', 'Please try again, or contact this person manually if it is urgent.');
    }
  };

  // ==================== SOS HANDLERS ====================
  const startSOS = async () => {
    if (sosActive) return;
    logger.warn('SafetySupportScreen', 'SOS countdown activated', {
      mode,
      tourId,
      userId: maskIdentifier(userId),
      includeLocation,
    });
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    Vibration.vibrate([0, 200, 100, 200]);

    setSosActive(true);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);
    sosCountdownRef.current = SOS_COUNTDOWN_SECONDS;
    sosCoordsRef.current = currentCoords;

    if (sosTimerRef.current) clearInterval(sosTimerRef.current);
    sosTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      sosCountdownRef.current = Math.max(0, sosCountdownRef.current - 1);
      setSosCountdown(sosCountdownRef.current);
      if (sosCountdownRef.current === 0) {
        clearInterval(sosTimerRef.current);
        sosTimerRef.current = null;
        executeSOS(sosCoordsRef.current);
        return;
      }
      Vibration.vibrate(100);
    }, 1000);

    // Capture location in parallel so emergency call options never wait on GPS.
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (!mountedRef.current) return;
        sosCoordsRef.current = location.coords;
        setCurrentCoords(location.coords);
        setLocationAccuracy(location.coords.accuracy);
        logger.info('SafetySupportScreen', 'SOS location captured', {
          tourId,
          accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
        });
      } else {
        logger.warn('SafetySupportScreen', 'SOS location permission denied', { tourId, status });
      }
    } catch (error) {
      logger.warn('SafetySupportScreen', 'SOS location capture failed', {
        tourId,
        error: error?.message || String(error),
      });
    }
  };

  const confirmAccessibleSOS = () => {
    if (sosActive) {
      cancelSOS();
      return;
    }
    Alert.alert(
      'Start SOS countdown?',
      `Emergency options will open after ${SOS_COUNTDOWN_SECONDS} seconds. The app will not call ${emergencyNumber} automatically.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start countdown', style: 'destructive', onPress: startSOS },
      ],
    );
  };

  const cancelSOS = () => {
    logger.info('SafetySupportScreen', 'SOS countdown cancelled', {
      tourId,
      userId: maskIdentifier(userId),
    });
    if (sosTimerRef.current) {
      clearInterval(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    sosCoordsRef.current = null;
    setSosActive(false);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);
    sosCountdownRef.current = SOS_COUNTDOWN_SECONDS;
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const executeSOS = (capturedCoords = null) => {
    if (!mountedRef.current) return;
    setSosActive(false);
    logger.warn('SafetySupportScreen', 'SOS countdown completed', {
      tourId,
      userId: maskIdentifier(userId),
      hasLocation: Boolean(capturedCoords),
      trustedContactCount: trustedContacts.length,
    });

    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
    Vibration.vibrate([0, 500, 200, 500]);

    const canNotifyPrimaryContact = trustedContacts.length > 0
      && hasDialableDigits(trustedContacts[0]?.phone);
    const primaryContact = canNotifyPrimaryContact ? trustedContacts[0] : null;
    const smsMessage = primaryContact
      ? generateEmergencySMS(capturedCoords, tourData, userName)
      : null;
    const emergencyActions = [
      {
        text: `Call ${emergencyNumber}`,
        style: 'destructive',
        onPress: () => confirmEmergencyCall(),
      },
      {
        text: 'Call Operations',
        onPress: () => openDialer(operationsNumber),
      },
    ];

    if (primaryContact) {
      emergencyActions.push({
        text: `Text ${primaryContact.name}`,
        onPress: () => sendSMS(primaryContact.phone, smsMessage),
      });
    }
    emergencyActions.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert(
      'Emergency options',
      `This app does not notify emergency services for you. If you need urgent help, call ${emergencyNumber} now.`,
      emergencyActions
    );

    // Recording and alert fanout run after options are shown. A slow or failed
    // network must never delay access to the phone dialler.
    setSosDeliveryState({
      status: 'sending',
      message: 'Sending an operations safety alert…',
    });
    logSafetyEvent({
        userId,
        principalId: principalId || userId,
        bookingId: bookingData?.id,
        tourId,
        role: mode,
        category: SAFETY_CATEGORIES.SOS,
        severity: SEVERITY_LEVELS.CRITICAL,
        message: 'SOS quick action opened by user (no emergency dispatch performed)',
        coords: capturedCoords,
        isSOS: true,
        online: isConnected,
      }).then((sosSubmission) => {
      logger.info('SafetySupportScreen', sosSubmission.queued ? 'SOS safety event queued' : 'SOS safety event logged', {
        tourId,
        userId: maskIdentifier(userId),
        hasLocation: Boolean(capturedCoords),
        queued: Boolean(sosSubmission.queued),
      });
      if (mountedRef.current) {
        setSosDeliveryState(sosSubmission.queued
          ? {
              status: 'queued',
              message: 'Operations alert saved on this device. It will send automatically when a connection is available.',
            }
          : {
              status: 'submitted',
              message: 'Operations safety alert sent.',
            });
        checkOfflineQueue();
      }
    }).catch((error) => {
      logger.error('SafetySupportScreen', 'SOS safety event log failed', {
        tourId,
        userId: maskIdentifier(userId),
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        setSosDeliveryState({
          status: 'failed',
          message: 'The operations alert was not saved. Use the call options now if you still need help.',
        });
      }
    });
  };

  // ==================== LIVE LOCATION HANDLERS ====================
  const toggleLiveLocation = async (enabled) => {
    if (liveLocationUpdating) return;
    const targetScope = enabled
      ? { tourId, userId }
      : (activeLiveLocationScopeRef.current || { tourId, userId });
    logger.info('SafetySupportScreen', 'Live location toggle requested', {
      tourId,
      userId: maskIdentifier(userId),
      enabled,
    });
    if (!targetScope.tourId || !targetScope.userId) {
      logger.warn('SafetySupportScreen', 'Live location toggle blocked without identity context', {
        hasTourId: Boolean(tourId),
        hasUserId: Boolean(userId),
      });
      Alert.alert('Location sharing unavailable', 'We could not identify this tour session. Please reconnect or contact operations.');
      return;
    }
    setLiveLocationUpdating(true);

    if (enabled) {
      try {
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }

        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!mountedRef.current) return;
        if (status !== 'granted') {
          logger.warn('SafetySupportScreen', 'Live location permission denied', { tourId, status });
          Alert.alert('Permission Denied', 'Location permission is required for live sharing.');
          setLiveLocationUpdating(false);
          return;
        }

        // Get initial position
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (!mountedRef.current) return;
        setCurrentCoords(location.coords);
        setLocationAccuracy(location.coords.accuracy);

        // Start watching
        locationWatchRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 10000, // Update every 10 seconds
            distanceInterval: 20, // Or when moved 20 meters
          },
          (location) => {
            if (!mountedRef.current) return;
            setCurrentCoords(location.coords);
            setLocationAccuracy(location.coords.accuracy);
            updateLiveLocationSharing(
              tourId,
              userId,
              true,
              location.coords
            ).then((success) => {
              if (!success) {
                logger.warn('SafetySupportScreen', 'Live location watch update was not accepted', {
                  tourId,
                  userId: maskIdentifier(userId),
                });
              } else if (mountedRef.current) {
                setLiveLocationLastUpdate(Date.now());
              }
            }).catch((error) => {
              logger.warn('SafetySupportScreen', 'Live location watch update failed', {
                tourId,
                userId: maskIdentifier(userId),
                error: error?.message || String(error),
              });
            });
            logger.debug('SafetySupportScreen', 'Live location watch update sent', {
              tourId,
              userId: maskIdentifier(userId),
              accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
            });
          }
        );

        // Initial update
        const shareStarted = await updateLiveLocationSharing(
          tourId,
          userId,
          true,
          location.coords
        );
        if (!mountedRef.current) return;
        if (!shareStarted) {
          throw new Error('Live location update was not accepted');
        }

        setLiveLocationSharing(true);
        liveLocationSharingRef.current = true;
        activeLiveLocationScopeRef.current = { tourId, userId };
        setLiveLocationLastUpdate(Date.now());
        logger.info('SafetySupportScreen', 'Live location sharing started', {
          tourId,
          userId: maskIdentifier(userId),
          accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
        });

        if (Platform.OS === 'ios') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (error) {
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }
        if (!mountedRef.current) return;
        logger.error('SafetySupportScreen', 'Live location sharing start failed', {
          tourId,
          userId: maskIdentifier(userId),
          error: error?.message || String(error),
        });
        Alert.alert('Error', 'Could not start location sharing. Please try again.');
      }
    } else {
      try {
        // Stop watching
        if (locationWatchRef.current) {
          locationWatchRef.current.remove();
          locationWatchRef.current = null;
        }

        const shareStopped = await updateLiveLocationSharing(
          targetScope.tourId,
          targetScope.userId,
          false
        );
        if (!mountedRef.current) return;

        if (shareStopped) {
          setLiveLocationSharing(false);
          liveLocationSharingRef.current = false;
          activeLiveLocationScopeRef.current = null;
          setLiveLocationLastUpdate(null);
          logger.info('SafetySupportScreen', 'Live location sharing stopped', {
            tourId: targetScope.tourId,
            userId: maskIdentifier(targetScope.userId),
          });
        } else {
          logger.warn('SafetySupportScreen', 'Live location stop was not accepted by server', {
            tourId: targetScope.tourId,
            userId: maskIdentifier(targetScope.userId),
          });
          Alert.alert(
            'Could not confirm sharing stopped',
            'Automatic disconnect cleanup is still armed. Please try the switch again when connected.',
          );
        }
      } catch (error) {
        logger.warn('SafetySupportScreen', 'Live location sharing stop write failed', {
          tourId: targetScope.tourId,
          userId: maskIdentifier(targetScope.userId),
          error: error?.message || String(error),
        });
        if (mountedRef.current) {
          Alert.alert(
            'Could not confirm sharing stopped',
            'Automatic disconnect cleanup is still armed. Please try the switch again when connected.',
          );
        }
      }
    }

    if (mountedRef.current) {
      setLiveLocationUpdating(false);
    }
  };

  useEffect(() => {
    const activeScope = activeLiveLocationScopeRef.current;
    if (
      !activeScope
      || (activeScope.tourId === tourId && activeScope.userId === userId)
    ) return undefined;

    if (locationWatchRef.current) {
      locationWatchRef.current.remove();
      locationWatchRef.current = null;
    }
    updateLiveLocationSharing(activeScope.tourId, activeScope.userId, false).then((stopped) => {
      if (!mountedRef.current || !stopped) return;
      activeLiveLocationScopeRef.current = null;
      liveLocationSharingRef.current = false;
      setLiveLocationSharing(false);
      setLiveLocationLastUpdate(null);
    }).catch(() => {});
    return undefined;
  }, [tourId, userId]);

  // Cleanup location watch on unmount
  useEffect(() => {
    return () => {
      if (locationWatchRef.current) {
        logger.debug('SafetySupportScreen', 'Live location watcher cleaned up', {
          tourId,
          userId: maskIdentifier(userId),
        });
        locationWatchRef.current.remove();
      }
    };
  }, [tourId, userId]);

  // ==================== REPORT HANDLERS ====================
  const handleSelectCategory = (category) => {
    logger.info('SafetySupportScreen', 'Safety category selected', {
      tourId,
      category,
      mode,
    });
    setSelectedCategory(category);
    setShowReportModal(true);
  };

  const handleSubmitReport = async () => {
    if (!selectedCategory || submitting) return;

    setSubmitting(true);
    logger.info('SafetySupportScreen', 'Safety report submit started', {
      tourId,
      category: selectedCategory,
      severity: selectedSeverity,
      includeLocation,
      isConnected,
      messageLength: customMessage.trim().length,
    });

    try {
      let coords = null;

      if (includeLocation) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (!mountedRef.current) return;
          coords = location.coords;
          logger.info('SafetySupportScreen', 'Safety report location captured', {
            tourId,
            accuracy: Number.isFinite(Number(location?.coords?.accuracy)) ? Math.round(Number(location.coords.accuracy)) : null,
          });
        } else {
          logger.warn('SafetySupportScreen', 'Safety report location permission denied', {
            tourId,
            status,
          });
        }
      }

      const meta = CATEGORY_META[selectedCategory];

      const submission = await logSafetyEvent({
        userId,
        principalId: principalId || userId,
        bookingId: bookingData?.id,
        tourId,
        role: mode,
        category: selectedCategory,
        severity: selectedSeverity,
        message: meta?.description || 'Safety report',
        customMessage: customMessage.trim() || null,
        coords,
        online: isConnected,
      });
      if (!mountedRef.current) return;
      logger.info('SafetySupportScreen', submission.queued ? 'Safety report queued' : 'Safety report submitted', {
        tourId,
        category: selectedCategory,
        severity: selectedSeverity,
        includedLocation: Boolean(coords),
        queued: Boolean(submission.queued),
      });

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        submission.queued ? 'Report Saved for Retry' : 'Report Submitted',
        submission.queued
          ? 'Your report is safely stored on this device and will be submitted when the connection is available.'
          : 'Your report was securely received. Operations and the assigned driver team can now review it.',
        [{
          text: 'OK',
          onPress: () => {
            setShowReportModal(false);
            setSelectedCategory(null);
            setSelectedSeverity(SEVERITY_LEVELS.MEDIUM);
            setCustomMessage('');
          },
        }]
      );
    } catch (error) {
      if (!mountedRef.current) return;
      logger.error('SafetySupportScreen', 'Safety report was not submitted or stored', {
        tourId,
        category: selectedCategory,
        severity: selectedSeverity,
        isConnected,
        code: error?.code || null,
        error: error?.message || String(error),
      });
      if (mountedRef.current) {
        Alert.alert(
          'Report Not Saved',
          'The report could not be submitted or stored on this device. Please try again or call operations directly.'
        );
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  // ==================== CONTACT HANDLERS ====================
  const handleAddContact = async () => {
    if (contactSaving) return;
    if (!newContactName.trim() || !newContactPhone.trim()) {
      logger.warn('SafetySupportScreen', 'Trusted contact add blocked by missing fields', {
        hasName: Boolean(newContactName.trim()),
        hasPhone: Boolean(newContactPhone.trim()),
      });
      Alert.alert('Required', 'Please enter both name and phone number.');
      return;
    }
    if (!hasDialableDigits(newContactPhone)) {
      logger.warn('SafetySupportScreen', 'Trusted contact add blocked by invalid phone', {
        phoneLength: newContactPhone.replace(/[^+\d]/g, '').length,
      });
      Alert.alert('Invalid phone number', 'Please enter a valid phone number including area or country code.');
      return;
    }

    setContactSaving(true);
    logger.info('SafetySupportScreen', 'Trusted contact add started', {
      nameLength: newContactName.trim().length,
      phoneLength: newContactPhone.replace(/[^+\d]/g, '').length,
    });
    try {
      await addTrustedContact(safetyPrincipalId, {
        name: newContactName.trim(),
        phone: newContactPhone.trim(),
      });
      await loadTrustedContacts();
      if (!mountedRef.current) return;
      setShowAddContactModal(false);
      setNewContactName('');
      setNewContactPhone('');
      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      logger.info('SafetySupportScreen', 'Trusted contact add completed');
    } catch (error) {
      if (!mountedRef.current) return;
      logger.warn('SafetySupportScreen', 'Trusted contact add failed', {
        code: error?.code || null,
        error: error?.message || String(error),
      });
      Alert.alert(
        error?.code === 'TRUSTED_CONTACT_LIMIT' ? 'Contact limit reached' : 'Contact not saved',
        error?.code === 'TRUSTED_CONTACT_LIMIT'
          ? error.message
          : 'This contact could not be stored safely on this device. Please try again.',
      );
    } finally {
      if (mountedRef.current) setContactSaving(false);
    }
  };

  const handleRemoveContact = async (contactId) => {
    logger.info('SafetySupportScreen', 'Trusted contact remove confirmation opened', {
      contactId: maskIdentifier(contactId),
    });
    Alert.alert(
      'Remove Contact',
      'Are you sure you want to remove this emergency contact?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeTrustedContact(safetyPrincipalId, contactId);
              await loadTrustedContacts();
              if (!mountedRef.current) return;
              logger.info('SafetySupportScreen', 'Trusted contact removed', {
                contactId: maskIdentifier(contactId),
              });
            } catch (error) {
              if (!mountedRef.current) return;
              logger.warn('SafetySupportScreen', 'Trusted contact removal failed', {
                contactId: maskIdentifier(contactId),
                error: error?.message || String(error),
              });
              Alert.alert('Contact not removed', 'The change could not be stored on this device. Please try again.');
            }
          },
        },
      ]
    );
  };

  // ==================== HISTORY HANDLERS ====================
  const loadHistory = async () => {
    const requestSeq = ++historyRequestSeqRef.current;
    setLoadingHistory(true);
    logger.info('SafetySupportScreen', 'Safety history load started', {
      userId: maskIdentifier(userId),
    });
    try {
      const [history, queuedEvents] = await Promise.all([
        getSafetyHistory(userId),
        getOfflineQueuedSafetyEvents(safetyQueueScope),
      ]);
      if (!mountedRef.current || requestSeq !== historyRequestSeqRef.current) return;

      const mergedHistory = [...queuedEvents, ...history].sort(
        (a, b) => getSafetyEventTimestampMs(b) - getSafetyEventTimestampMs(a)
      );

      setSafetyHistory(mergedHistory);
      setShowHistoryModal(true);
      logger.info('SafetySupportScreen', 'Safety history load completed', {
        userId: maskIdentifier(userId),
        remoteCount: history.length,
        queuedCount: queuedEvents.length,
        mergedCount: mergedHistory.length,
      });
    } catch (error) {
      logger.warn('SafetySupportScreen', 'Safety history load failed', {
        userId: maskIdentifier(userId),
        error: error?.message || String(error),
      });
      if (mountedRef.current && requestSeq === historyRequestSeqRef.current) {
        Alert.alert('History unavailable', 'Could not load safety history right now. Please try again.');
      }
    } finally {
      if (mountedRef.current && requestSeq === historyRequestSeqRef.current) {
        setLoadingHistory(false);
      }
    }
  };

  // ==================== RENDER ====================
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

// ==================== STYLES ====================
const styles = createSafetySupportScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });
