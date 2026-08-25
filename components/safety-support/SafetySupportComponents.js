// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
import { useEffect, useRef } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Switch,
  Animated,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Haptics from '../../services/hapticsService';
import {
  CATEGORY_META,
  SEVERITY_META,
} from '../../services/safetyService';
import { parseTimestampMs } from '../../services/timeUtils';
import { COLORS as THEME } from '../../theme';

const SAFETY_STATUS_META = {
  pending: { label: 'Submitted', color: '#2563EB' },
  acknowledged: { label: 'Acknowledged', color: '#0F766E' },
  in_progress: { label: 'In progress', color: '#7C3AED' },
  escalated: { label: 'Escalated', color: '#DC2626' },
  resolved: { label: 'Resolved', color: '#16A34A' },
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
const styles = createSafetySupportScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });



// ==================== SOS BUTTON COMPONENT ====================
export const SOSButton = ({ onActivate, onAccessibleActivate, isActive, countdown, onCancel }) => {
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
  }, [glowAnim, isActive, pulseAnim]);

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
export const ContactButton = ({ icon, label, sublabel, onPress, color = COLORS.primary, style }) => (
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
export const IssuePresetButton = ({ preset, onPress, isLoading, isSelected }) => {
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
export const SeveritySelector = ({ selected, onSelect }) => (
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
export const LiveLocationCard = ({
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
export const TrustedContactItem = ({ contact, onRemove, onCall }) => (
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
export const SafetyTip = ({ icon, title, description, color = COLORS.primary }) => (
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
export const HistoryItem = ({ event }) => {
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
