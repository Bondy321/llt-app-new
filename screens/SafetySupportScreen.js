// screens/SafetySupportScreen.js - Premium Safety & Emergency Support
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
  Dimensions,
  Platform,
  KeyboardAvoidingView,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
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
  getOfflineQueueCount,
} from '../services/safetyService';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SOS_COUNTDOWN_SECONDS = 5;

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
const SOSButton = ({ onActivate, isActive, countdown, onCancel }) => {
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
    <View style={styles.sosContainer}>
      {isActive && (
        <Animated.View
          style={[
            styles.sosGlow,
            {
              opacity: glowAnim,
              transform: [{ scale: pulseAnim }],
            },
          ]}
        />
      )}
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <TouchableOpacity
          style={[styles.sosButton, isActive && styles.sosButtonActive]}
          onLongPress={onActivate}
          onPress={isActive ? onCancel : undefined}
          delayLongPress={500}
          activeOpacity={0.9}
          accessibilityLabel={isActive ? 'Cancel SOS' : 'Hold for SOS Emergency'}
          accessibilityRole="button"
        >
          <LinearGradient
            colors={isActive ? [COLORS.sosRedDark, COLORS.sosRed] : [COLORS.sosRed, '#EF4444']}
            style={styles.sosGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            {isActive ? (
              <View style={styles.sosContent}>
                <Text style={styles.sosCountdown}>{countdown}</Text>
                <Text style={styles.sosCancelText}>Tap to cancel</Text>
              </View>
            ) : (
              <View style={styles.sosContent}>
                <MaterialCommunityIcons name="alarm-light" size={36} color={COLORS.white} />
                <Text style={styles.sosText}>SOS</Text>
                <Text style={styles.sosHint}>Hold for emergency</Text>
              </View>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
      {!isActive && (
        <Text style={styles.sosDisclaimer}>
          Hold the button for emergency assistance. Your location will be shared.
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
              ? 'Your location is being shared with operations'
              : 'Enable to share your real-time location'}
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

  const formatDate = (timestamp) => {
    const date = new Date(timestamp);
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
        <Text style={styles.historyDate}>{formatDate(event.timestamp)}</Text>
      </View>
      <View style={[styles.historyBadge, { backgroundColor: `${severityMeta.color || COLORS.textMuted}20` }]}>
        <Text style={[styles.historyBadgeText, { color: severityMeta.color || COLORS.textMuted }]}>
          {severityMeta.label || 'Unknown'}
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

  // Live location state
  const [liveLocationSharing, setLiveLocationSharing] = useState(false);
  const [liveLocationUpdating, setLiveLocationUpdating] = useState(false);
  const [currentCoords, setCurrentCoords] = useState(null);
  const [locationAccuracy, setLocationAccuracy] = useState(null);
  const locationWatchRef = useRef(null);

  // Contacts state
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');

  // Report modal state
  const [showReportModal, setShowReportModal] = useState(false);

  // History state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [safetyHistory, setSafetyHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Tips expanded state
  const [tipsExpanded, setTipsExpanded] = useState(false);

  // Offline queue state
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);

  // Animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;

  // Derived values
  const isDriver = mode === 'driver';
  const driverPhone = tourData?.driverPhone;
  const supportPhone = tourData?.operationsPhone || tourData?.supportPhone;
  const userName = bookingData?.passengerNames?.[0] || (isDriver ? tourData?.driverName : 'Passenger');

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

  // Load trusted contacts
  useEffect(() => {
    loadTrustedContacts();
    checkOfflineQueue();
  }, []);

  // Process offline queue when connected
  useEffect(() => {
    if (isConnected && offlineQueueCount > 0) {
      processOfflineQueue(userId).then(({ processed }) => {
        if (processed > 0) {
          Alert.alert(
            'Reports Synced',
            `${processed} pending safety report(s) have been submitted.`
          );
          setOfflineQueueCount(0);
        }
      });
    }
  }, [isConnected]);

  const loadTrustedContacts = async () => {
    const contacts = await getTrustedContacts();
    setTrustedContacts(contacts);
  };

  const checkOfflineQueue = async () => {
    const count = await getOfflineQueueCount();
    setOfflineQueueCount(count);
  };

  const openDialer = (phone) => {
    if (!phone) {
      Alert.alert('Contact unavailable', 'No phone number is configured for this tour.');
      return;
    }
    const sanitized = phone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${sanitized}`);
  };

  const sendSMS = (phone, message) => {
    const encoded = encodeURIComponent(message);
    Linking.openURL(`sms:${phone}?body=${encoded}`);
  };

  // ==================== SOS HANDLERS ====================
  const startSOS = async () => {
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    Vibration.vibrate([0, 200, 100, 200]);

    setSosActive(true);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);

    // Get location immediately
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        setCurrentCoords(location.coords);
        setLocationAccuracy(location.coords.accuracy);
      }
    } catch (error) {
      console.warn('Could not get location for SOS');
    }

    // Start countdown
    sosTimerRef.current = setInterval(() => {
      setSosCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(sosTimerRef.current);
          executeSOS();
          return 0;
        }
        // Vibrate each second
        Vibration.vibrate(100);
        return prev - 1;
      });
    }, 1000);
  };

  const cancelSOS = () => {
    if (sosTimerRef.current) {
      clearInterval(sosTimerRef.current);
    }
    setSosActive(false);
    setSosCountdown(SOS_COUNTDOWN_SECONDS);
    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const executeSOS = async () => {
    setSosActive(false);

    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
    Vibration.vibrate([0, 500, 200, 500]);

    try {
      // Log the SOS event
      await logSafetyEvent({
        userId,
        bookingId: bookingData?.id,
        tourId: tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
        role: mode,
        category: SAFETY_CATEGORIES.SOS,
        severity: SEVERITY_LEVELS.CRITICAL,
        message: 'SOS Emergency Alert activated',
        coords: currentCoords,
        isSOS: true,
      });

      // Show success and options
      Alert.alert(
        'SOS Alert Sent',
        'Emergency services and tour operations have been notified of your location.',
        [
          {
            text: 'Call 112 Now',
            style: 'destructive',
            onPress: () => openDialer('112'),
          },
          {
            text: 'Call Operations',
            onPress: () => openDialer(supportPhone || driverPhone),
          },
          { text: 'OK', style: 'cancel' },
        ]
      );

      // Send SMS to trusted contacts
      if (trustedContacts.length > 0 && currentCoords) {
        const smsMessage = generateEmergencySMS(currentCoords, tourData, userName);
        Alert.alert(
          'Notify Emergency Contacts?',
          'Would you like to send your location to your trusted contacts?',
          [
            { text: 'No', style: 'cancel' },
            {
              text: 'Yes',
              onPress: () => {
                trustedContacts.forEach((contact) => {
                  sendSMS(contact.phone, smsMessage);
                });
              },
            },
          ]
        );
      }
    } catch (error) {
      Alert.alert(
        'SOS Alert',
        'Could not send alert to operations, but you can still call emergency services directly.',
        [
          {
            text: 'Call 112',
            style: 'destructive',
            onPress: () => openDialer('112'),
          },
          { text: 'OK', style: 'cancel' },
        ]
      );
    }
  };

  // ==================== LIVE LOCATION HANDLERS ====================
  const toggleLiveLocation = async (enabled) => {
    setLiveLocationUpdating(true);

    if (enabled) {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Denied', 'Location permission is required for live sharing.');
          setLiveLocationUpdating(false);
          return;
        }

        // Get initial position
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
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
            setCurrentCoords(location.coords);
            setLocationAccuracy(location.coords.accuracy);
            updateLiveLocationSharing(
              tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
              userId,
              true,
              location.coords
            );
          }
        );

        // Initial update
        await updateLiveLocationSharing(
          tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
          userId,
          true,
          location.coords
        );

        setLiveLocationSharing(true);

        if (Platform.OS === 'ios') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (error) {
        Alert.alert('Error', 'Could not start location sharing. Please try again.');
      }
    } else {
      // Stop watching
      if (locationWatchRef.current) {
        locationWatchRef.current.remove();
        locationWatchRef.current = null;
      }

      await updateLiveLocationSharing(
        tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
        userId,
        false
      );

      setLiveLocationSharing(false);
    }

    setLiveLocationUpdating(false);
  };

  // Cleanup location watch on unmount
  useEffect(() => {
    return () => {
      if (locationWatchRef.current) {
        locationWatchRef.current.remove();
      }
    };
  }, []);

  // ==================== REPORT HANDLERS ====================
  const handleSelectCategory = (category) => {
    setSelectedCategory(category);
    setShowReportModal(true);
  };

  const handleSubmitReport = async () => {
    if (!selectedCategory) return;

    setSubmitting(true);

    try {
      let coords = null;

      if (includeLocation) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          coords = location.coords;
        }
      }

      const meta = CATEGORY_META[selectedCategory];

      await logSafetyEvent({
        userId,
        bookingId: bookingData?.id,
        tourId: tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_'),
        role: mode,
        category: selectedCategory,
        severity: selectedSeverity,
        message: meta?.description || 'Safety report',
        customMessage: customMessage.trim() || null,
        coords,
      });

      if (Platform.OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        'Report Submitted',
        'Thank you for letting us know. Operations have been notified and will respond shortly.',
        [{ text: 'OK', onPress: () => setShowReportModal(false) }]
      );

      // Reset form
      setSelectedCategory(null);
      setSelectedSeverity(SEVERITY_LEVELS.MEDIUM);
      setCustomMessage('');
    } catch (error) {
      if (!isConnected) {
        Alert.alert(
          'Report Queued',
          'You appear to be offline. Your report has been saved and will be submitted when you reconnect.',
          [{ text: 'OK', onPress: () => setShowReportModal(false) }]
        );
        checkOfflineQueue();
      } else {
        Alert.alert(
          'Error',
          'Could not submit report. Please try again or call operations directly.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== CONTACT HANDLERS ====================
  const handleAddContact = async () => {
    if (!newContactName.trim() || !newContactPhone.trim()) {
      Alert.alert('Required', 'Please enter both name and phone number.');
      return;
    }

    await addTrustedContact({
      name: newContactName.trim(),
      phone: newContactPhone.trim(),
    });

    await loadTrustedContacts();
    setShowAddContactModal(false);
    setNewContactName('');
    setNewContactPhone('');

    if (Platform.OS === 'ios') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleRemoveContact = async (contactId) => {
    Alert.alert(
      'Remove Contact',
      'Are you sure you want to remove this emergency contact?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeTrustedContact(contactId);
            await loadTrustedContacts();
          },
        },
      ]
    );
  };

  // ==================== HISTORY HANDLERS ====================
  const loadHistory = async () => {
    setLoadingHistory(true);
    const history = await getSafetyHistory(userId);
    setSafetyHistory(history);
    setLoadingHistory(false);
    setShowHistoryModal(true);
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
                You're offline. Reports will be queued.
              </Text>
            </View>
          )}

          {/* Pending Queue Banner */}
          {offlineQueueCount > 0 && isConnected && (
            <View style={styles.queueBanner}>
              <MaterialCommunityIcons name="cloud-upload" size={18} color={COLORS.white} />
              <Text style={styles.queueBannerText}>
                {offlineQueueCount} pending report(s) syncing...
              </Text>
            </View>
          )}

          {/* SOS Emergency Button */}
          <SOSButton
            onActivate={startSOS}
            isActive={sosActive}
            countdown={sosCountdown}
            onCancel={cancelSOS}
          />

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
                sublabel="112"
                onPress={() => openDialer('112')}
                color={COLORS.error}
              />
              <ContactButton
                icon="headset"
                label="Operations"
                sublabel={supportPhone ? 'Call now' : 'Not available'}
                onPress={() => openDialer(supportPhone || driverPhone)}
                color={COLORS.primary}
              />
              {!isDriver && (
                <ContactButton
                  icon="steering"
                  label="Driver"
                  sublabel={driverPhone ? 'Call now' : 'Not available'}
                  onPress={() => openDialer(driverPhone)}
                  color={COLORS.accent}
                />
              )}
            </View>
          </View>

          {/* Live Location Sharing */}
          <LiveLocationCard
            isSharing={liveLocationSharing}
            onToggle={toggleLiveLocation}
            lastUpdate={currentCoords ? new Date().toISOString() : null}
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
                accessibilityLabel="Add contact"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="account-plus" size={18} color={COLORS.white} />
                <Text style={styles.submitButtonText}>Add Contact</Text>
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
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  gradient: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  historyButton: {
    padding: 8,
    backgroundColor: `${COLORS.primary}12`,
    borderRadius: 10,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },

  // Offline/Queue Banners
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.error,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 16,
    gap: 8,
  },
  offlineBannerText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 16,
    gap: 8,
  },
  queueBannerText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },

  // SOS Button
  sosContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  sosGlow: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: COLORS.sosRed,
  },
  sosButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    ...SHADOWS.xl,
  },
  sosButtonActive: {
    ...SHADOWS.lg,
  },
  sosGradient: {
    flex: 1,
    borderRadius: 70,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sosContent: {
    alignItems: 'center',
  },
  sosText: {
    color: COLORS.white,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 2,
    marginTop: 4,
  },
  sosHint: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  sosCountdown: {
    color: COLORS.white,
    fontSize: 48,
    fontWeight: '900',
  },
  sosCancelText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  sosDisclaimer: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 20,
  },

  // Cards
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    ...SHADOWS.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  cardHeaderText: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.text,
  },
  cardSubtitle: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // Contact Buttons
  contactsGrid: {
    gap: 10,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    gap: 12,
  },
  contactIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contactTextContainer: {
    flex: 1,
  },
  contactLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  contactSublabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },

  // Live Location Card
  liveLocationCard: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    ...SHADOWS.md,
  },
  liveLocationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveLocationIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  liveLocationTextContainer: {
    flex: 1,
  },
  liveLocationTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  liveLocationSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  liveLocationStatus: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 16,
  },
  liveLocationStatusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },

  // Location Toggle
  locationToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    gap: 8,
  },
  locationToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },

  // Issue Presets
  issuePresets: {
    gap: 8,
  },
  issuePreset: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  issuePresetSelected: {
    borderColor: COLORS.success,
    backgroundColor: `${COLORS.success}08`,
  },
  issueIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  issueTextContainer: {
    flex: 1,
  },
  issueTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  issueDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // Trusted Contacts
  addContactButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContacts: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  emptyContactsText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 20,
  },
  trustedContactsList: {
    gap: 8,
  },
  trustedContactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: COLORS.background,
    borderRadius: 10,
  },
  trustedContactIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${COLORS.primary}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  trustedContactInfo: {
    flex: 1,
  },
  trustedContactName: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  trustedContactPhone: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  trustedContactAction: {
    padding: 8,
    marginLeft: 4,
  },

  // Safety Tips
  tipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tipsContent: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 12,
  },
  safetyTip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  safetyTipIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  safetyTipContent: {
    flex: 1,
  },
  safetyTipTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  safetyTipDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 18,
  },

  // Severity Selector
  severityContainer: {
    marginBottom: 16,
  },
  severityLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 10,
  },
  severityOptions: {
    flexDirection: 'row',
    gap: 8,
  },
  severityOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    gap: 4,
  },
  severityText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },

  // Tour Info
  tourInfoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  tourInfoText: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '500',
  },

  bottomSpacer: {
    height: 20,
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    maxHeight: '90%',
  },
  historyModalContent: {
    minHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  modalBody: {
    padding: 20,
  },
  modalDescription: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 20,
    lineHeight: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
    marginTop: 8,
  },
  textInput: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: COLORS.text,
    minHeight: 100,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  textInputSingle: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  modalActions: {
    flexDirection: 'row',
    padding: 20,
    paddingTop: 0,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  submitButton: {
    flex: 2,
    flexDirection: 'row',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.white,
  },

  // History
  historyScroll: {
    padding: 20,
  },
  historyLoading: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  historyLoadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  historyEmpty: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  historyEmptyText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 12,
  },
  historyEmptySubtext: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    marginBottom: 10,
  },
  historyIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  historyContent: {
    flex: 1,
  },
  historyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  historyDate: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  historyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  historyBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
