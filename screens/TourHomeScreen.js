// screens/TourHomeScreen.js
import createTourHomeScreenStyles from './styles/TourHomeScreen.styles';
import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Image,
  Modal,
  Linking,
  Alert,
  Animated,
  RefreshControl,
  Platform,
  Vibration,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from '../services/hapticsService';
import TodaysAgendaCard from '../components/TodaysAgendaCard';
import { MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import { realtimeDb } from '../firebase';
import offlineSyncService from '../services/offlineSyncService';
import logger, { maskIdentifier } from '../services/loggerService';
import { resolveTourId } from '../services/tourIdentityService';
import { getDriverLocationPresentation } from '../utils/driverLocation';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';
import { getPickupCountdownState } from '../services/pickupTimeParser';
import {
  FONT_SCALE_LIMITS,
  getResponsiveLayout,
  responsiveFontSize,
  responsiveLineHeight,
} from '../utils/responsiveLayout';
const { buildTourHomeActionPlan } = require('../utils/tourHomeActionPlanner');
const { formatPickupDate } = require('../utils/pickupPresentation');

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryDark: THEME.primaryDark,
  lightBlueAccent: THEME.sync.info.border,
  lightBlue: THEME.primaryMuted,
  coralAccent: THEME.accent,
  white: THEME.white,
  darkText: THEME.textPrimary,
  cardBackground: THEME.surface,
  appBackground: THEME.background,
  border: THEME.border,
  subtleText: THEME.textSecondary,
  success: THEME.success,
  successLight: THEME.successLight,
  warning: THEME.warning,
  warningLight: THEME.warningLight,
  error: THEME.error,
  errorLight: THEME.errorLight,
  overlay: THEME.overlay,
  statusBarBackground: THEME.statusBarBackground,
};

const PICKUP_COUNTDOWN_REFRESH_MS = 30 * 1000;

// Haptic feedback helper
const triggerHaptic = (type = 'light') => {
  const style = type === 'heavy'
    ? Haptics.ImpactFeedbackStyle.Heavy
    : Haptics.ImpactFeedbackStyle.Light;

  Haptics.impactAsync(style).catch(() => {
    Vibration.vibrate(type === 'heavy' ? 50 : 25);
  });
};

// Get time-based greeting
const getTimeBasedGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return { text: 'Good Morning', icon: 'weather-sunny', color: '#F59E0B' };
  if (hour < 17) return { text: 'Good Afternoon', icon: 'weather-partly-cloudy', color: '#3B82F6' };
  if (hour < 21) return { text: 'Good Evening', icon: 'weather-sunset', color: '#F97316' };
  return { text: 'Good Night', icon: 'weather-night', color: '#6366F1' };
};

// Animated card component
const AnimatedCard = ({ children, style, delay = 0, onPress, accessibilityLabel, accessibilityHint }) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 500,
        delay,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 8,
        tension: 40,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const animatedStyle = {
    opacity: fadeAnim,
    transform: [{ translateY: slideAnim }, { scale: scaleAnim }],
  };

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.9}
        accessible={true}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityRole="button"
      >
        <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
      </TouchableOpacity>
    );
  }

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
};

// Skeleton loading component
const SkeletonLoader = ({ width, height, borderRadius = 8, style }) => {
  const pulseAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: '#E2E8F0',
          opacity: pulseAnim,
        },
        style,
      ]}
    />
  );
};

// Countdown timer component
const PickupCountdown = ({ pickupTime, pickupDate }) => {
  const [timeLeft, setTimeLeft] = useState(null);

  useEffect(() => {
    if (!pickupTime) {
      setTimeLeft({ mode: 'invalid' });
      return;
    }

    const calculateTimeLeft = () => {
      return getPickupCountdownState({
        pickupTime,
        pickupDate,
        now: new Date(),
      });
    };

    setTimeLeft(calculateTimeLeft());
    const interval = setInterval(() => {
      setTimeLeft(calculateTimeLeft());
    }, PICKUP_COUNTDOWN_REFRESH_MS);

    return () => clearInterval(interval);
  }, [pickupDate, pickupTime]);

  if (!timeLeft || timeLeft.mode === 'passed') return null;

  if (timeLeft.mode === 'invalid') {
    return (
      <View style={styles.countdownFallbackContainer}>
        <MaterialCommunityIcons name="clock-alert-outline" size={16} color={COLORS.subtleText} />
        <Text style={styles.countdownFallbackText}>
          Pickup time shown above — countdown unavailable for this format
        </Text>
      </View>
    );
  }

  const isUrgent = timeLeft.hoursLeft === 0 && timeLeft.minutesLeft < 30;
  const isVeryUrgent = timeLeft.hoursLeft === 0 && timeLeft.minutesLeft < 10;

  let countdownLabel = '';
  if (timeLeft.hoursLeft >= 24) {
    countdownLabel = `${timeLeft.daysLeft}d ${timeLeft.remainingHoursLeft}h until pickup`;
  } else if (timeLeft.hoursLeft >= 1) {
    countdownLabel = `${timeLeft.hoursLeft}h until pickup`;
  } else {
    countdownLabel = `${Math.max(timeLeft.totalMinutesLeft, 0)}m until pickup`;
  }

  return (
    <View style={[
      styles.countdownContainer,
      isUrgent && styles.countdownUrgent,
      isVeryUrgent && styles.countdownVeryUrgent,
    ]}>
      <MaterialCommunityIcons
        name="timer-outline"
        size={18}
        color={isVeryUrgent ? COLORS.error : isUrgent ? COLORS.warning : COLORS.primaryBlue}
      />
      <Text style={[
        styles.countdownText,
        isVeryUrgent && styles.countdownTextUrgent,
      ]}>
        {countdownLabel}
      </Text>
    </View>
  );
};

// Quick action button component
const QuickActionButton = ({ icon, label, color, onPress, badge, delay = 0, compact = false }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      delay,
      useNativeDriver: true,
    }).start();
  }, []);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.9,
      friction: 5,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 5,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[
      styles.quickActionWrapper,
      compact && styles.quickActionWrapperCompact,
      { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
    ]}>
      <TouchableOpacity
        style={styles.quickActionButton}
        onPress={() => {
          onPress();
        }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        accessible={true}
        accessibilityLabel={label}
        accessibilityRole="button"
      >
        <View style={[
          styles.quickActionIconContainer,
          compact && styles.quickActionIconContainerCompact,
          { backgroundColor: `${color}15` },
        ]}>
          <MaterialCommunityIcons name={icon} size={compact ? 20 : 22} color={color} />
          {badge && (
            <View style={styles.quickActionBadge}>
              <Text style={styles.quickActionBadgeText}>{badge}</Text>
            </View>
          )}
        </View>
        <Text
          style={[styles.quickActionLabel, compact && styles.quickActionLabelCompact]}
          numberOfLines={1}
          adjustsFontSizeToFit
          maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
        >
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
};

// Driver status component
const DriverStatusIndicator = ({ driverName, isLive = false }) => {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isLive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [isLive]);

  return (
    <View style={styles.driverStatusContainer}>
      <View style={styles.driverAvatar}>
        <MaterialCommunityIcons name="account" size={20} color={COLORS.white} />
        {isLive && (
          <Animated.View style={[styles.liveDot, { transform: [{ scale: pulseAnim }] }]} />
        )}
      </View>
      <View style={styles.driverInfo}>
        <Text style={styles.driverName}>{driverName || 'Driver'}</Text>
        <View style={styles.driverStatusRow}>
          <View style={[styles.statusDot, isLive && styles.statusDotLive]} />
          <Text style={styles.driverStatusText}>
            {isLive ? 'Location sharing active' : 'Awaiting driver'}
          </Text>
        </View>
      </View>
    </View>
  );
};

// Status pulse animation component
const StatusPulse = ({ color }) => {
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <Animated.View
      style={[
        styles.statusPulse,
        {
          backgroundColor: color,
          opacity: pulseAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.4, 0],
          }),
          transform: [
            {
              scale: pulseAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 2.5],
              }),
            },
          ],
        },
      ]}
    />
  );
};

// Feature card component for the grid
const FeatureCard = ({ item, onPress, index, isLarge = false }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        delay: 400 + index * 80,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 8,
        tension: 40,
        delay: 400 + index * 80,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.95,
      friction: 5,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 5,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View
      style={[
        isLarge ? styles.featureCardLarge : styles.featureCard,
        {
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }, { scale: scaleAnim }],
        },
      ]}
    >
      <TouchableOpacity
        style={styles.featureCardInner}
        onPress={() => {
          onPress();
        }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        accessible={true}
        accessibilityLabel={item.title}
        accessibilityHint={`Navigate to ${item.title}`}
        accessibilityRole="button"
      >
        <LinearGradient
          colors={[`${item.color}08`, `${item.color}03`]}
          style={styles.featureCardGradient}
        >
          <View style={[styles.featureIconContainer, { backgroundColor: `${item.color}15` }]}>
            <MaterialCommunityIcons name={item.icon} size={isLarge ? 32 : 28} color={item.color} />
          </View>
          <Text style={[styles.featureCardTitle, isLarge && styles.featureCardTitleLarge]}>
            {item.title}
          </Text>
          {item.subtitle && (
            <Text style={styles.featureCardSubtitle}>{item.subtitle}</Text>
          )}
          <View style={[styles.featureArrow, { backgroundColor: `${item.color}10` }]}>
            <MaterialCommunityIcons name="chevron-right" size={16} color={item.color} />
          </View>
        </LinearGradient>
      </TouchableOpacity>
    </Animated.View>
  );
};

export default function TourHomeScreen({
  tourCode,
  tourData,
  bookingData,
  onNavigate,
  onLogout,
  isConnected = true,
}) {
  const { width, height, fontScale } = useWindowDimensions();
  const screenLayout = useMemo(
    () => getResponsiveLayout({ width, height, fontScale }),
    [fontScale, height, width]
  );
  const responsiveStyles = useMemo(() => {
    const greetingSize = responsiveFontSize(20, screenLayout, {
      min: 16,
      max: 20,
      compactAdjustment: -1,
      largeTextAdjustment: -3,
      veryLargeTextAdjustment: -4,
    });
    const statusTitleSize = responsiveFontSize(18, screenLayout, {
      min: 15,
      max: 18,
      compactAdjustment: -1,
      largeTextAdjustment: -2,
      veryLargeTextAdjustment: -3,
    });
    const titleSize = responsiveFontSize(20, screenLayout, {
      min: 16,
      max: 20,
      compactAdjustment: -1,
      largeTextAdjustment: -2,
      veryLargeTextAdjustment: -3,
    });
    const isTightHeader = screenLayout.isCompact || screenLayout.isLargeText;
    const compactActions = screenLayout.isTiny || screenLayout.isVeryLargeText;

    return {
      compactActions,
      container: {
        paddingHorizontal: screenLayout.horizontalPadding,
        paddingTop: screenLayout.isLargeText ? SPACING.sm : SPACING.md,
      },
      header: {
        paddingHorizontal: isTightHeader ? SPACING.sm : SPACING.md,
        paddingVertical: isTightHeader ? SPACING.sm : SPACING.md,
      },
      headerBrandMark: isTightHeader
        ? { width: 48, height: 48, borderRadius: 16 }
        : null,
      logoImage: isTightHeader
        ? { width: 36, height: 36, borderRadius: 10 }
        : null,
      headerTextContainer: {
        marginLeft: isTightHeader ? SPACING.sm : SPACING.md,
        marginRight: isTightHeader ? SPACING.sm : SPACING.md,
      },
      greetingIconBadge: isTightHeader
        ? { width: 26, height: 26, borderRadius: 13 }
        : null,
      greetingText: {
        fontSize: greetingSize,
        lineHeight: responsiveLineHeight(greetingSize, 1.16),
      },
      headerMenuButton: isTightHeader
        ? { width: 40, height: 40, borderRadius: 14 }
        : null,
      statusCardGradient: screenLayout.isLargeText
        ? { padding: SPACING.md }
        : null,
      statusTitle: {
        fontSize: statusTitleSize,
        lineHeight: responsiveLineHeight(statusTitleSize, 1.16),
      },
      statusMessage: {
        fontSize: responsiveFontSize(14, screenLayout, {
          min: 12,
          max: 14,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      quickActionsContainer: {
        padding: screenLayout.isLargeText ? SPACING.md : SPACING.lg,
      },
      quickActionsRow: compactActions
        ? { flexWrap: 'wrap', rowGap: SPACING.md }
        : null,
      quickActionsTitle: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 11,
          max: 13,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      quickActionsSubtitle: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 12,
          max: 13,
          compactAdjustment: 0,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -1,
        }),
      },
      boardingPassTour: {
        fontSize: titleSize,
        lineHeight: responsiveLineHeight(titleSize, 1.15),
      },
      pickupLocationText: {
        fontSize: responsiveFontSize(14, screenLayout, {
          min: 12,
          max: 14,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
    };
  }, [screenLayout]);
  const [manifestStatus, setManifestStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [manifestReady, setManifestReady] = useState(false);
  const [driverReady, setDriverReady] = useState(false);
  const [driverLocationRecord, setDriverLocationRecord] = useState(null);
  const [driverLocationNow, setDriverLocationNow] = useState(() => Date.now());
  const [noShowAcknowledged, setNoShowAcknowledged] = useState(false);
  const scrollViewRef = useRef(null);
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);

  const greeting = useMemo(() => getTimeBasedGreeting(), []);
  const bookingRef = useMemo(() => bookingData?.id, [bookingData?.id]);
  const activeTourId = useMemo(
    () => resolveTourId(tourData?.id, tourCode, tourData?.tourCode),
    [tourData?.id, tourData?.tourCode, tourCode]
  );
  const driverLocationPresentation = useMemo(
    () => getDriverLocationPresentation(driverLocationRecord, driverLocationNow),
    [driverLocationNow, driverLocationRecord]
  );
  const driverLocationActive = driverLocationPresentation.mode === 'live'
    && driverLocationPresentation.actionable;
  const driverLocationAvailable = driverLocationPresentation.available;

  useEffect(() => {
    const freshnessTimer = setInterval(() => setDriverLocationNow(Date.now()), 30 * 1000);
    return () => clearInterval(freshnessTimer);
  }, []);

  // Get primary pickup time for countdown
  const primaryPickupTime = useMemo(() => {
    if (bookingData?.pickupPoints?.length > 0) {
      return bookingData.pickupPoints[0].time;
    }
    return bookingData?.pickupTime || null;
  }, [bookingData]);

  const primaryPickupDate = useMemo(() => {
    if (bookingData?.pickupPoints?.length > 0) {
      const pickupPointDate = bookingData.pickupPoints[0]?.date;
      if (pickupPointDate) return pickupPointDate;
    }

    return bookingData?.pickupDate || tourData?.startDate || null;
  }, [bookingData, tourData?.startDate]);

  useEffect(() => {
    logger.trackScreen('TourHome', {
      tourId: activeTourId || null,
      tourCode,
      bookingRef: maskIdentifier(bookingRef),
      isConnected,
      hasTourData: Boolean(tourData),
      manifestStatus,
      driverLocationActive,
    });
  }, [activeTourId, bookingRef, driverLocationActive, isConnected, manifestStatus, tourCode, tourData]);

  useEffect(() => {
    if (!realtimeDb || !activeTourId || !bookingRef) {
      logger.warn('TourHome', 'Realtime readiness skipped', {
        hasRealtimeDb: Boolean(realtimeDb),
        hasTourId: Boolean(activeTourId),
        hasTourCode: Boolean(tourCode),
        bookingRef: maskIdentifier(bookingRef),
      });
      setManifestReady(true);
      setDriverReady(true);
      return;
    }

    setManifestReady(false);
    setDriverReady(false);
  }, [activeTourId, tourCode, bookingRef]);

  useEffect(() => {
    if (!manifestReady || !driverReady) {
      setIsLoading(true);
      return;
    }

    const timer = setTimeout(() => setIsLoading(false), 120);
    return () => clearTimeout(timer);
  }, [manifestReady, driverReady]);

  useEffect(() => {
    if (!realtimeDb || !activeTourId || !bookingRef) return undefined;

    const sanitizedTourId = activeTourId;
    const manifestRef = realtimeDb.ref(`tour_manifests/${sanitizedTourId}/bookings/${bookingRef}`);
    logger.info('TourHome', 'Passenger realtime listeners starting', {
      sanitizedTourId,
      bookingRef: maskIdentifier(bookingRef),
    });

    const handleSnapshot = (snapshot) => {
      const value = snapshot.val();
      setManifestStatus(value?.status || null);
      setManifestReady(true);
      logger.info('TourHome', 'Manifest status snapshot received', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        exists: snapshot.exists(),
        status: value?.status || null,
        hasPassengerStatus: Array.isArray(value?.passengerStatus),
      });
    };

    const handleManifestError = (error) => {
      logger.error('TourHome', 'Manifest status listener failed', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setManifestReady(true);
    };

    manifestRef.on('value', handleSnapshot, handleManifestError);

    // Also listen for driver location status
    const driverRef = realtimeDb.ref(`tours/${sanitizedTourId}/driverLocation`);
    const handleDriverSnapshot = (snapshot) => {
      const value = snapshot.val();
      if (!value) {
        setDriverLocationRecord(null);
        setDriverReady(true);
        logger.info('TourHome', 'Driver location snapshot empty', { sanitizedTourId });
        return;
      }

      const presentation = getDriverLocationPresentation(value);
      setDriverLocationRecord(value);
      setDriverReady(true);
      logger.info('TourHome', 'Driver location status snapshot received', {
        sanitizedTourId,
        hasTimestamp: Boolean(value.timestamp ?? value.lastUpdated),
        freshness: presentation.freshness,
        actionable: presentation.actionable,
        source: value?.source || null,
      });
    };

    const handleDriverError = (error) => {
      logger.error('TourHome', 'Driver location listener failed', {
        sanitizedTourId,
        error: error?.message || String(error),
        code: error?.code || null,
      });
      setDriverReady(true);
      setDriverLocationRecord(null);
    };

    driverRef.on('value', handleDriverSnapshot, handleDriverError);

    return () => {
      logger.debug('TourHome', 'Passenger realtime listeners stopping', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
      });
      manifestRef.off('value', handleSnapshot);
      driverRef.off('value', handleDriverSnapshot);
    };
  }, [activeTourId, bookingRef]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    triggerHaptic('light');

    const sanitizedTourId = activeTourId;
    logger.info('TourHome', 'Manual refresh started', {
      sanitizedTourId,
      bookingRef: maskIdentifier(bookingRef),
      isConnected,
    });
    try {
      const replayResult = await offlineSyncService.replayQueue({
        services: { bookingService, chatService },
      });
      logger.info('TourHome', 'Manual refresh replay completed', {
        sanitizedTourId,
        success: Boolean(replayResult?.success),
        processed: replayResult?.data?.processed ?? null,
        failed: replayResult?.data?.failed ?? null,
      });

      if (sanitizedTourId && bookingRef && realtimeDb) {
        const manifestSnapshot = await realtimeDb
          .ref(`tour_manifests/${sanitizedTourId}/bookings/${bookingRef}`)
          .once('value');
        setManifestStatus(manifestSnapshot.val()?.status || null);

        const driverSnapshot = await realtimeDb
          .ref(`tours/${sanitizedTourId}/driverLocation`)
          .once('value');
        const driverValue = driverSnapshot.val();
        setDriverLocationRecord(driverValue || null);

        logger.info('TourHome', 'Manual refresh realtime snapshots loaded', {
          sanitizedTourId,
          bookingRef: maskIdentifier(bookingRef),
          manifestStatus: manifestSnapshot.val()?.status || null,
          driverLocationExists: driverSnapshot.exists(),
        });
      }

      logger.info('TourHome', 'Manual refresh completed', {
        sanitizedTourId,
        success: replayResult?.success !== false,
      });
    } catch (error) {
      logger.error('TourHome', 'Manual refresh failed', {
        sanitizedTourId,
        bookingRef: maskIdentifier(bookingRef),
        error: error?.message || String(error),
      });
    } finally {
      setRefreshing(false);
    }
  }, [activeTourId, bookingRef, isConnected]);

  const manifestStatusMeta = useMemo(() => {
    switch (manifestStatus) {
      case MANIFEST_STATUS.BOARDED:
        return {
          title: 'You\'re all set!',
          message: 'Welcome aboard! Enjoy your tour experience. Your driver has confirmed your boarding.',
          tone: COLORS.success,
          toneLight: COLORS.successLight,
          badge: 'Boarded',
          icon: 'check-circle',
        };
      case MANIFEST_STATUS.NO_SHOW:
        return {
          title: 'Action Required',
          message:
            'The driver has marked you as not at the pickup location. Please contact them immediately.',
          tone: COLORS.error,
          toneLight: COLORS.errorLight,
          badge: 'Missing',
          icon: 'alert-circle',
        };
      case MANIFEST_STATUS.PARTIAL:
        return {
          title: 'Almost there',
          message:
            'Some passengers in your party are still missing. Please ensure everyone is at the pickup point.',
          tone: COLORS.warning,
          toneLight: COLORS.warningLight,
          badge: 'Partial',
          icon: 'account-group',
        };
      case MANIFEST_STATUS.PENDING:
      default:
        return {
          title: 'Ready for pickup',
          message: 'Head to your pickup location. The driver will mark you as boarded when you arrive.',
          tone: COLORS.primaryBlue,
          toneLight: COLORS.lightBlue,
          badge: 'Pending',
          icon: 'clock-outline',
        };
    }
  }, [manifestStatus]);

  const isNoShow = manifestStatus === MANIFEST_STATUS.NO_SHOW;

  useEffect(() => {
    if (!isNoShow) setNoShowAcknowledged(false);
  }, [isNoShow]);

  const pickupCountdownState = useMemo(() => {
    if (!primaryPickupTime) return null;
    return getPickupCountdownState({
      pickupTime: primaryPickupTime,
      pickupDate: primaryPickupDate,
      now: new Date(),
    });
  }, [primaryPickupDate, primaryPickupTime]);

  const actionPlan = useMemo(
    () =>
      buildTourHomeActionPlan({
        manifestStatus,
        pickupCountdown: pickupCountdownState,
        driverLocationActive,
      }),
    [driverLocationActive, manifestStatus, pickupCountdownState]
  );

  const resolveDriverPhoneNumber = useCallback(() => {
    const rawPhone = typeof tourData?.driverPhone === 'string' ? tourData.driverPhone : '';
    const sanitizedPhone = rawPhone.replace(/[^+\d]/g, '');
    return sanitizedPhone.length >= 7 ? sanitizedPhone : '';
  }, [tourData?.driverPhone]);

  const openDriverContactUrl = async (url, action) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      logger.warn('TourHome', 'Driver contact launch failed', {
        tourId: activeTourId || null,
        action,
        error: error?.message || String(error),
      });
      Alert.alert(
        'Could not open phone app',
        'Please try again, or contact your operator if you need help reaching the driver.'
      );
    }
  };

  const handleCallDriver = () => {
    triggerHaptic('medium');
    const phone = resolveDriverPhoneNumber();
    if (!phone) {
      logger.warn('TourHome', 'Driver call blocked without phone number', {
        tourId: activeTourId || null,
        source: isNoShow ? 'no_show_modal' : 'quick_action',
      });
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }

    logger.info('TourHome', 'Driver call launched', {
      tourId: activeTourId || null,
      source: isNoShow ? 'no_show_modal' : 'quick_action',
      phoneLength: phone.length,
    });
    openDriverContactUrl(`tel:${phone}`, 'call');
  };

  const handleMessageDriver = () => {
    triggerHaptic('light');
    const phone = resolveDriverPhoneNumber();
    if (!phone) {
      logger.warn('TourHome', 'Driver message blocked without phone number', {
        tourId: activeTourId || null,
        bookingRef: maskIdentifier(bookingRef),
      });
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }
    logger.info('TourHome', 'Driver message launched', {
      tourId: activeTourId || null,
      phoneLength: phone.length,
    });
    openDriverContactUrl(`sms:${phone}`, 'sms');
  };

  const navigateWithLog = useCallback((screen, params = {}, source = 'unknown') => {
    logger.info('TourHome', 'Navigation requested', {
      targetScreen: screen,
      source,
      tourId: activeTourId || null,
      bookingRef: maskIdentifier(bookingRef),
      params,
    });
    onNavigate(screen, params);
  }, [activeTourId, bookingRef, onNavigate]);

  const menuItems = [
    {
      id: 'Photobook',
      title: 'My Photos',
      subtitle: 'Personal gallery',
      icon: 'image-album',
      color: COLORS.primaryBlue,
    },
    {
      id: 'GroupPhotobook',
      title: 'Group Album',
      subtitle: 'Shared memories',
      icon: 'image-multiple',
      color: THEME.success,
    },
    {
      id: 'Itinerary',
      title: 'Itinerary',
      subtitle: 'Full schedule',
      icon: 'map-legend',
      color: THEME.primaryLight,
    },
    {
      id: 'Chat',
      title: 'Group Chat',
      subtitle: 'Stay connected',
      icon: 'chat-processing-outline',
      color: THEME.success,
    },
    {
      id: 'SafetySupport',
      title: 'Safety & SOS',
      subtitle: 'Emergency help',
      icon: 'shield-alert',
      color: '#DC2626',
    },
  ];

  // Quick actions for easier access
  const quickActions = [
    { icon: 'phone', label: 'Call', color: COLORS.success, onPress: handleCallDriver },
    {
      icon: 'image-multiple',
      label: 'Group Photos',
      color: COLORS.primaryBlue,
      onPress: () => navigateWithLog('GroupPhotobook', {}, 'quick_action'),
    },
    { icon: 'bus-marker', label: 'Find Bus', color: COLORS.coralAccent, onPress: () => navigateWithLog('Map', {}, 'quick_action') },
    { icon: 'chat', label: 'Chat', color: THEME.success, onPress: () => navigateWithLog('Chat', {}, 'quick_action'), badge: null },
  ];

  const orderedQuickActions = useMemo(() => {
    const byId = {
      Map: quickActions.find((action) => action.label === 'Find Bus'),
      Chat: quickActions.find((action) => action.label === 'Chat'),
      Itinerary: {
        icon: 'map-legend',
        label: 'Itinerary',
        color: THEME.primaryLight,
        onPress: () => navigateWithLog('Itinerary', {}, 'quick_action'),
      },
      GroupPhotobook: quickActions.find((action) => action.label === 'Group Photos'),
    };

    return actionPlan.orderedActionIds
      .map((id) => byId[id])
      .filter(Boolean)
      .slice(0, 4);
  }, [actionPlan.orderedActionIds, navigateWithLog, quickActions]);

  if (isLoading) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
        <SafeAreaView style={styles.statusBarSafeArea} edges={['top']} />
        <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
          <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
            <View style={[styles.container, responsiveStyles.container]}>
              {/* Skeleton header */}
              <View style={[styles.header, responsiveStyles.header]}>
                <SkeletonLoader width={44} height={44} borderRadius={12} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <SkeletonLoader width={120} height={14} style={{ marginBottom: 8 }} />
                  <SkeletonLoader width={180} height={24} />
                </View>
              </View>
              {/* Skeleton cards */}
              <SkeletonLoader width="100%" height={140} borderRadius={18} style={{ marginBottom: 18 }} />
              <SkeletonLoader width="100%" height={200} borderRadius={20} style={{ marginBottom: 24 }} />
              <SkeletonLoader width="100%" height={100} borderRadius={18} style={{ marginBottom: 20 }} />
            </View>
          </LinearGradient>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
      <SafeAreaView style={styles.statusBarSafeArea} edges={['top']} />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
        <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
          <ScrollView
            ref={scrollViewRef}
            contentContainerStyle={[styles.container, responsiveStyles.container]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={[COLORS.primaryBlue]}
                tintColor={COLORS.primaryBlue}
                title="Updating..."
                titleColor={COLORS.subtleText}
              />
            }
          >
          {/* Header */}
          <AnimatedCard style={[styles.header, responsiveStyles.header]} delay={0}>
            <View style={[styles.headerBrandMark, responsiveStyles.headerBrandMark]}>
              <Image
                source={require('../assets/images/logo_for_tour_home.png')}
                style={[styles.logoImage, responsiveStyles.logoImage]}
              />
            </View>
            <View style={[styles.headerTextContainer, responsiveStyles.headerTextContainer]}>
              <View style={styles.greetingTitleRow}>
                <View style={[
                  styles.greetingIconBadge,
                  responsiveStyles.greetingIconBadge,
                  { backgroundColor: `${greeting.color}14` },
                ]}>
                  <MaterialCommunityIcons name={greeting.icon} size={17} color={greeting.color} />
                </View>
                <Text
                  style={[styles.greetingText, responsiveStyles.greetingText]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.heading}
                >
                  {`${greeting.text}!`}
                </Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={[
                  styles.headerMenuButton,
                  responsiveStyles.headerMenuButton,
                  isHeaderMenuOpen && styles.headerMenuButtonActive,
                ]}
                onPress={() => {
                  triggerHaptic('light');
                  setIsHeaderMenuOpen((open) => !open);
                }}
                accessible={true}
                accessibilityLabel="Open account menu"
                accessibilityRole="button"
                accessibilityState={{ expanded: isHeaderMenuOpen }}
              >
                <MaterialCommunityIcons
                  name={isHeaderMenuOpen ? 'chevron-up' : 'dots-horizontal'}
                  size={24}
                  color={COLORS.primaryBlue}
                />
              </TouchableOpacity>
              {isHeaderMenuOpen ? (
                <View style={styles.headerMenuDropdown}>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      navigateWithLog('AccountPrivacy', { from: 'TourHome' }, 'header_account');
                    }}
                    accessible={true}
                    accessibilityLabel="Account and privacy"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="account-cog-outline" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Account</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      navigateWithLog('NotificationPreferences', {}, 'header_notifications');
                    }}
                    accessible={true}
                    accessibilityLabel="Notification settings"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="bell-ring-outline" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Notifications</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuOpen(false);
                      triggerHaptic('light');
                      logger.info('TourHome', 'Logout requested from header', {
                        tourId: activeTourId || null,
                        bookingRef: maskIdentifier(bookingRef),
                      });
                      onLogout();
                    }}
                    activeOpacity={0.7}
                    accessible={true}
                    accessibilityLabel="Log out"
                    accessibilityRole="button"
                  >
                    <View style={styles.headerMenuIcon}>
                      <MaterialCommunityIcons name="logout-variant" size={20} color={COLORS.primaryBlue} />
                    </View>
                    <Text style={styles.headerMenuItemText}>Log out</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          </AnimatedCard>

          {/* Pickup countdown timer */}
          {primaryPickupTime && manifestStatus !== MANIFEST_STATUS.BOARDED && (
            <AnimatedCard delay={50}>
              <PickupCountdown pickupTime={primaryPickupTime} pickupDate={primaryPickupDate} />
            </AnimatedCard>
          )}

          {/* Status card with enhanced visuals */}
          <AnimatedCard style={styles.statusCard} delay={100}>
            <LinearGradient
              colors={[manifestStatusMeta.toneLight, COLORS.white]}
              style={[styles.statusCardGradient, responsiveStyles.statusCardGradient]}
            >
              <View style={styles.statusIconContainer}>
                <StatusPulse color={manifestStatusMeta.tone} />
                <View style={[styles.statusIconCircle, { backgroundColor: `${manifestStatusMeta.tone}20` }]}>
                  <MaterialCommunityIcons
                    name={manifestStatusMeta.icon}
                    size={28}
                    color={manifestStatusMeta.tone}
                  />
                </View>
              </View>
              <View style={styles.statusContent}>
                <View style={styles.statusHeader}>
                  <View style={[styles.statusBadge, { backgroundColor: `${manifestStatusMeta.tone}20` }]}>
                    <Text style={[styles.statusBadgeText, { color: manifestStatusMeta.tone }]}>
                      {manifestStatusMeta.badge}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[styles.statusTitle, responsiveStyles.statusTitle]}
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                >
                  {manifestStatusMeta.title}
                </Text>
                <Text
                  style={[styles.statusMessage, responsiveStyles.statusMessage]}
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                >
                  {manifestStatusMeta.message}
                </Text>
              </View>
            </LinearGradient>
          </AnimatedCard>

          {/* Quick Actions Bar */}
          <AnimatedCard delay={150}>
            <View style={[styles.quickActionsContainer, responsiveStyles.quickActionsContainer]}>
              <Text
                style={[styles.quickActionsTitle, responsiveStyles.quickActionsTitle]}
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
              >
                {actionPlan.title}
              </Text>
              <Text
                style={[styles.quickActionsSubtitle, responsiveStyles.quickActionsSubtitle]}
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
              >
                {actionPlan.subtitle}
              </Text>
              <View style={[styles.quickActionsRow, responsiveStyles.quickActionsRow]}>
                {orderedQuickActions.map((action, index) => (
                  <QuickActionButton
                    key={`${action.label}-${index}`}
                    {...action}
                    delay={200 + index * 50}
                    compact={responsiveStyles.compactActions}
                  />
                ))}
              </View>
            </View>
          </AnimatedCard>

          {/* Digital Boarding Pass */}
          {tourData && (
            <AnimatedCard style={styles.boardingPass} delay={200}>
              {/* Ticket header with torn edge effect */}
              <LinearGradient
                colors={[COLORS.primaryBlue, COLORS.primaryDark]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.boardingPassHeader}
              >
                <View style={styles.boardingPassHeaderContent}>
                  <View style={styles.boardingPassHeaderTextContainer}>
                    <Text style={styles.boardingPassLabel}>DIGITAL BOARDING PASS</Text>
                    <Text
                      style={[styles.boardingPassTour, responsiveStyles.boardingPassTour]}
                      numberOfLines={2}
                      adjustsFontSizeToFit
                      maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                    >
                      {tourData.name || 'Scenic Tour'}
                    </Text>
                  </View>
                  <View style={styles.boardingPassQR}>
                    <MaterialCommunityIcons name="qrcode" size={48} color="rgba(255,255,255,0.9)" />
                  </View>
                </View>
              </LinearGradient>

              {/* Torn edge decoration */}
              <View style={styles.tornEdge}>
                {[...Array(20)].map((_, i) => (
                  <View key={i} style={styles.tornEdgeBump} />
                ))}
              </View>

              {/* Ticket body */}
              <View style={styles.boardingPassBody}>
                {/* Driver info */}
                {tourData.driverName && (
                  <DriverStatusIndicator
                    driverName={tourData.driverName}
                    isLive={driverLocationActive}
                  />
                )}

                <View style={styles.boardingPassDivider} />

                {/* Pickup Information */}
                {bookingData?.pickupPoints && bookingData.pickupPoints.length > 0 ? (
                  <View style={styles.pickupSection}>
                    <Text style={styles.pickupSectionTitle}>
                      {bookingData.pickupPoints.length > 1 ? 'Pickup Points' : 'Pickup Location'}
                    </Text>
                    {bookingData.pickupPoints.map((pickup, index) => (
                      <View key={index} style={styles.pickupCard}>
                        <View style={styles.pickupTimeBox}>
                          <Text style={styles.pickupTimeText}>{pickup.time}</Text>
                        </View>
                        <View style={styles.pickupLocationInfo}>
                          <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.coralAccent} />
                          <View style={styles.pickupLocationCopy}>
                            <Text
                              style={[styles.pickupLocationText, responsiveStyles.pickupLocationText]}
                              numberOfLines={2}
                              maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                            >
                              {pickup.location}
                            </Text>
                            {formatPickupDate(pickup.date || bookingData.pickupDate) ? (
                              <Text style={styles.pickupDateText}>
                                {formatPickupDate(pickup.date || bookingData.pickupDate)}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : bookingData?.pickupTime ? (
                  <View style={styles.pickupSection}>
                    <Text style={styles.pickupSectionTitle}>Pickup Location</Text>
                    <View style={styles.pickupCard}>
                      <View style={styles.pickupTimeBox}>
                        <Text style={styles.pickupTimeText}>{bookingData.pickupTime}</Text>
                      </View>
                      <View style={styles.pickupLocationInfo}>
                        <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.coralAccent} />
                        <View style={styles.pickupLocationCopy}>
                          <Text
                            style={[styles.pickupLocationText, responsiveStyles.pickupLocationText]}
                            numberOfLines={2}
                            maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
                          >
                            {bookingData.pickupLocation}
                          </Text>
                          {formatPickupDate(bookingData.pickupDate) ? (
                            <Text style={styles.pickupDateText}>{formatPickupDate(bookingData.pickupDate)}</Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  </View>
                ) : null}

                {/* Seat Information */}
                {bookingData?.seatNumbers?.length > 0 && (
                  <View style={styles.seatSection}>
                    <View style={styles.seatGrid}>
                      {Array.from({ length: Math.ceil(bookingData.seatNumbers.length / 2) }, (_, rowIndex) => {
                        const rowSeats = bookingData.seatNumbers.slice(rowIndex * 2, rowIndex * 2 + 2);

                        return (
                          <View key={`seat-row-${rowIndex}`} style={styles.seatRow}>
                            {rowSeats.map((seat, seatIndex) => (
                              <View key={`seat-${rowIndex}-${seatIndex}-${seat}`} style={styles.seatBox}>
                                <MaterialCommunityIcons name="seat" size={18} color={COLORS.coralAccent} />
                                <Text style={styles.seatNumber}>{seat}</Text>
                              </View>
                            ))}
                          </View>
                        );
                      })}
                    </View>
                    <Text style={styles.seatLabel}>
                      {bookingData.seatNumbers.length > 1 ? 'Assigned Seats' : 'Your Seat'}
                    </Text>
                  </View>
                )}

                {/* Passengers list */}
                {bookingData?.passengerNames?.length > 1 && (
                  <View style={styles.passengersSection}>
                    <Text style={styles.passengersSectionTitle}>Passengers</Text>
                    {bookingData.passengerNames.map((name, index) => (
                      <View key={index} style={styles.passengerRow}>
                        <View style={styles.passengerAvatar}>
                          <Text style={styles.passengerAvatarText}>
                            {name.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <Text style={styles.passengerName}>{name}</Text>
                        {bookingData.seatNumbers?.[index] != null ? (
                          <Text style={styles.passengerSeat}>{`Seat ${bookingData.seatNumbers[index]}`}</Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}

                {/* Footer with booking ref */}
                <View style={styles.boardingPassFooter}>
                  <View>
                    <Text style={styles.boardingPassFooterLabel}>Booking Reference</Text>
                    <Text style={styles.boardingPassFooterValue}>{bookingData?.id}</Text>
                  </View>
                  <View style={styles.boardingPassFooterRight}>
                    <Text style={styles.boardingPassFooterLabel}>Tour Code</Text>
                    <Text style={styles.boardingPassFooterValue}>{tourCode}</Text>
                  </View>
                </View>
              </View>
            </AnimatedCard>
          )}

          {/* Today's Agenda */}
          {tourData && (
            <AnimatedCard delay={250}>
              <TodaysAgendaCard tourData={tourData} onNudge={() => navigateWithLog('Itinerary', {}, 'agenda_nudge')} />
            </AnimatedCard>
          )}

          {/* Find My Bus - Enhanced Feature Card */}
          <AnimatedCard
            style={styles.findBusCard}
            delay={300}
            onPress={() => {
              navigateWithLog('Map', {}, 'find_bus_card');
            }}
            accessibilityLabel="Find My Bus"
            accessibilityHint="View your driver's location on the map"
          >
            <LinearGradient
              colors={[`${COLORS.coralAccent}12`, `${COLORS.coralAccent}05`]}
              style={styles.findBusGradient}
            >
              <View style={styles.findBusContent}>
                <View style={styles.findBusIconContainer}>
                  <MaterialCommunityIcons name="bus-marker" size={36} color={COLORS.coralAccent} />
                  {driverLocationActive && (
                    <View style={styles.findBusLiveBadge}>
                      <View style={styles.findBusLiveDot} />
                      <Text style={styles.findBusLiveText}>LIVE</Text>
                    </View>
                  )}
                </View>
                <View style={styles.findBusTextContainer}>
                  <Text style={styles.findBusTitle}>Find My Bus</Text>
                  <Text style={styles.findBusSubtitle}>
                    {driverLocationActive
                      ? 'Driver live location is being shared'
                      : driverLocationAvailable
                        ? 'Driver pickup point is available'
                        : 'See where your driver is on the map'}
                  </Text>
                </View>
                <View style={styles.findBusArrow}>
                  <MaterialCommunityIcons name="arrow-right-circle" size={32} color={COLORS.coralAccent} />
                </View>
              </View>
            </LinearGradient>
          </AnimatedCard>

          {/* Tour Features Grid - Enhanced Layout */}
          <Text style={styles.sectionTitle}>Tour Features</Text>
          <View style={styles.featuresGrid}>
            {/* First row - 2 cards */}
            <View style={styles.featuresRow}>
              <FeatureCard
                item={menuItems[0]}
                index={0}
                onPress={() => navigateWithLog(menuItems[0].id, {}, 'feature_card')}
              />
              <FeatureCard
                item={menuItems[1]}
                index={1}
                onPress={() => navigateWithLog(menuItems[1].id, {}, 'feature_card')}
              />
            </View>
            {/* Second row - 2 cards */}
            <View style={styles.featuresRow}>
              <FeatureCard
                item={menuItems[2]}
                index={2}
                onPress={() => navigateWithLog(menuItems[2].id, {}, 'feature_card')}
              />
              <FeatureCard
                item={menuItems[3]}
                index={3}
                onPress={() => navigateWithLog(menuItems[3].id, {}, 'feature_card')}
              />
            </View>
            {/* Third row - 1 full-width card for Safety */}
            <FeatureCard
              item={menuItems[4]}
              index={4}
              isLarge={true}
              onPress={() => navigateWithLog('SafetySupport', { from: 'TourHome', mode: 'passenger' }, 'feature_card')}
            />
          </View>

          {/* Bottom spacing */}
          <View style={{ height: 40 }} />
          </ScrollView>
        </LinearGradient>

        {/* Enhanced No-Show Modal */}
        <Modal
          visible={isNoShow && !noShowAcknowledged}
          transparent
          animationType="fade"
          presentationStyle="overFullScreen"
          onRequestClose={() => setNoShowAcknowledged(true)}
        >
          <View style={styles.modalOverlay}>
            <Animated.View
              style={styles.modalCard}
              accessibilityViewIsModal
              accessibilityRole="alert"
              accessibilityLabel="You have been marked as missing from pickup"
            >
              <LinearGradient
                colors={[COLORS.errorLight, COLORS.white]}
                style={styles.modalGradient}
              >
              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={styles.modalScrollContent}
                showsVerticalScrollIndicator
                bounces={false}
              >
              <View style={styles.modalIconContainer}>
                <View style={styles.modalIconPulse} />
                <View style={styles.modalIconCircle}>
                  <MaterialCommunityIcons name="alert-circle" size={40} color={COLORS.error} />
                </View>
              </View>

              <Text style={styles.modalTitle}>You've Been Marked as Missing</Text>
              <Text style={styles.modalMessage}>
                Your driver has marked you as not at the pickup location. Please contact them immediately
                so they can wait for you or help you find the right location.
              </Text>

              <View style={styles.modalDivider} />

              <Text style={styles.modalActionLabel}>What would you like to do?</Text>

              <TouchableOpacity
                style={styles.modalPrimaryButton}
                onPress={handleCallDriver}
                activeOpacity={0.9}
                accessibilityRole="button"
                accessibilityLabel="Call your driver now"
              >
                <LinearGradient
                  colors={[COLORS.coralAccent, '#E55B3C']}
                  style={styles.modalButtonGradient}
                >
                  <MaterialCommunityIcons name="phone" size={22} color={COLORS.white} />
                  <Text style={styles.modalPrimaryButtonText}>Call Driver Now</Text>
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalSecondaryButton}
                onPress={handleMessageDriver}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Send your driver a text message"
              >
                <MaterialCommunityIcons name="message-text" size={20} color={COLORS.primaryBlue} />
                <Text style={styles.modalSecondaryButtonText}>Send Text Message</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalEmergencyButton}
                onPress={() => navigateWithLog('SafetySupport', { from: 'TourHome', mode: 'passenger' }, 'no_show_modal')}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Open emergency assistance"
              >
                <MaterialCommunityIcons name="shield-alert" size={18} color={COLORS.error} />
                <Text style={styles.modalEmergencyButtonText}>Emergency Assistance</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalContinueButton}
                onPress={() => setNoShowAcknowledged(true)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Acknowledge this alert and continue to the tour screen"
              >
                <Text style={styles.modalContinueButtonText}>I understand — continue to tour</Text>
              </TouchableOpacity>

              <View style={styles.modalLogoutDivider} />

              <TouchableOpacity
                style={styles.modalLogoutButton}
                onPress={() => {
                  logger.info('TourHome', 'Logout requested from no-show modal', {
                    tourId: activeTourId || null,
                    bookingRef: maskIdentifier(bookingRef),
                  });
                  onLogout();
                }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Log out"
              >
                <MaterialCommunityIcons name="logout-variant" size={18} color={COLORS.subtleText} />
                <Text style={styles.modalLogoutButtonText}>Log Out</Text>
              </TouchableOpacity>
              </ScrollView>
              </LinearGradient>
            </Animated.View>
          </View>
        </Modal>
      </SafeAreaView>
    </View>
  );
}

const styles = createTourHomeScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });
