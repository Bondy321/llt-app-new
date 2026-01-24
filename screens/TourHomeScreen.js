// screens/TourHomeScreen.js
import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Image,
  Modal,
  Linking,
  Alert,
  Animated,
  RefreshControl,
  Dimensions,
  Platform,
  Vibration,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import TodaysAgendaCard from '../components/TodaysAgendaCard';
import { MANIFEST_STATUS } from '../services/bookingServiceRealtime';
import { realtimeDb } from '../firebase';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryDark: THEME.primaryDark,
  lightBlueAccent: '#93C5FD',
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
};

// Haptic feedback helper
const triggerHaptic = (type = 'light') => {
  if (Platform.OS === 'ios') {
    // On iOS, we'd use expo-haptics, but fallback to vibration
    Vibration.vibrate(type === 'heavy' ? 50 : 10);
  } else {
    Vibration.vibrate(type === 'heavy' ? 50 : 25);
  }
};

// Get time-based greeting
const getTimeBasedGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return { text: 'Good morning', icon: 'weather-sunny', color: '#F59E0B' };
  if (hour < 17) return { text: 'Good afternoon', icon: 'weather-partly-cloudy', color: '#3B82F6' };
  if (hour < 21) return { text: 'Good evening', icon: 'weather-sunset', color: '#F97316' };
  return { text: 'Good night', icon: 'weather-night', color: '#6366F1' };
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
const PickupCountdown = ({ pickupTime }) => {
  const [timeLeft, setTimeLeft] = useState(null);

  useEffect(() => {
    if (!pickupTime) return;

    const calculateTimeLeft = () => {
      const now = new Date();
      const [hours, minutes] = pickupTime.split(':').map(Number);
      const pickup = new Date();
      pickup.setHours(hours, minutes, 0, 0);

      // If pickup time has passed, show as past
      if (pickup < now) {
        return { passed: true };
      }

      const diff = pickup - now;
      const hoursLeft = Math.floor(diff / (1000 * 60 * 60));
      const minutesLeft = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secondsLeft = Math.floor((diff % (1000 * 60)) / 1000);

      return { hoursLeft, minutesLeft, secondsLeft, passed: false };
    };

    setTimeLeft(calculateTimeLeft());
    const interval = setInterval(() => {
      setTimeLeft(calculateTimeLeft());
    }, 1000);

    return () => clearInterval(interval);
  }, [pickupTime]);

  if (!timeLeft || timeLeft.passed) return null;

  const isUrgent = timeLeft.hoursLeft === 0 && timeLeft.minutesLeft < 30;
  const isVeryUrgent = timeLeft.hoursLeft === 0 && timeLeft.minutesLeft < 10;

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
        {timeLeft.hoursLeft > 0 && `${timeLeft.hoursLeft}h `}
        {timeLeft.minutesLeft}m {timeLeft.secondsLeft}s until pickup
      </Text>
    </View>
  );
};

// Quick action button component
const QuickActionButton = ({ icon, label, color, onPress, badge, delay = 0 }) => {
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
    <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={styles.quickActionButton}
        onPress={() => {
          triggerHaptic('light');
          onPress();
        }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        accessible={true}
        accessibilityLabel={label}
        accessibilityRole="button"
      >
        <View style={[styles.quickActionIconContainer, { backgroundColor: `${color}15` }]}>
          <MaterialCommunityIcons name={icon} size={22} color={color} />
          {badge && (
            <View style={styles.quickActionBadge}>
              <Text style={styles.quickActionBadgeText}>{badge}</Text>
            </View>
          )}
        </View>
        <Text style={styles.quickActionLabel} numberOfLines={1}>{label}</Text>
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
          triggerHaptic('light');
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

export default function TourHomeScreen({ tourCode, tourData, bookingData, onNavigate, onLogout }) {
  const [manifestStatus, setManifestStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [driverLocationActive, setDriverLocationActive] = useState(false);
  const scrollViewRef = useRef(null);

  const greeting = useMemo(() => getTimeBasedGreeting(), []);
  const bookingRef = useMemo(() => bookingData?.id, [bookingData?.id]);
  const passengerName = useMemo(() => {
    if (bookingData?.passengerNames?.length > 0) {
      return bookingData.passengerNames[0].split(' ')[0]; // First name only
    }
    return null;
  }, [bookingData?.passengerNames]);

  // Get primary pickup time for countdown
  const primaryPickupTime = useMemo(() => {
    if (bookingData?.pickupPoints?.length > 0) {
      return bookingData.pickupPoints[0].time;
    }
    return bookingData?.pickupTime || null;
  }, [bookingData]);

  useEffect(() => {
    // Simulate initial loading
    const timer = setTimeout(() => setIsLoading(false), 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!realtimeDb || !tourCode || !bookingRef) return undefined;

    const sanitizedTourId = tourCode.replace(/\s+/g, '_');
    const manifestRef = realtimeDb.ref(`tour_manifests/${sanitizedTourId}/bookings/${bookingRef}`);

    const handleSnapshot = (snapshot) => {
      const value = snapshot.val();
      setManifestStatus(value?.status || null);
    };

    manifestRef.on('value', handleSnapshot);

    // Also listen for driver location status
    const driverRef = realtimeDb.ref(`driver_locations/${sanitizedTourId}`);
    const handleDriverSnapshot = (snapshot) => {
      const value = snapshot.val();
      setDriverLocationActive(!!value?.lastUpdated);
    };
    driverRef.on('value', handleDriverSnapshot);

    return () => {
      manifestRef.off('value', handleSnapshot);
      driverRef.off('value', handleDriverSnapshot);
    };
  }, [tourCode, bookingRef]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    triggerHaptic('light');
    // Simulate refresh delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    setRefreshing(false);
  }, []);

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

  const handleCallDriver = () => {
    triggerHaptic('medium');
    if (!tourData?.driverPhone) {
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }
    const phone = tourData.driverPhone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${phone}`);
  };

  const handleMessageDriver = () => {
    triggerHaptic('light');
    if (!tourData?.driverPhone) {
      Alert.alert('Driver contact unavailable', 'Please reach out to your operator.');
      return;
    }
    const phone = tourData.driverPhone.replace(/[^+\d]/g, '');
    Linking.openURL(`sms:${phone}`);
  };

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
      color: '#16a085',
    },
    {
      id: 'Itinerary',
      title: 'Itinerary',
      subtitle: 'Full schedule',
      icon: 'map-legend',
      color: '#3498DB',
    },
    {
      id: 'Chat',
      title: 'Group Chat',
      subtitle: 'Stay connected',
      icon: 'chat-processing-outline',
      color: '#2ECC71',
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
    { icon: 'message-text', label: 'Message', color: COLORS.primaryBlue, onPress: handleMessageDriver },
    { icon: 'bus-marker', label: 'Find Bus', color: COLORS.coralAccent, onPress: () => onNavigate('Map') },
    { icon: 'chat', label: 'Chat', color: '#2ECC71', onPress: () => onNavigate('Chat'), badge: null },
  ];

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
          <View style={styles.container}>
            {/* Skeleton header */}
            <View style={styles.header}>
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
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={[`${COLORS.primaryBlue}0D`, COLORS.white]} style={styles.gradient}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.container}
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
          {/* Header with personalized greeting */}
          <AnimatedCard style={styles.header} delay={0}>
            <Image source={require('../assets/images/app-icon-llt.png')} style={styles.logoImage} />
            <View style={styles.headerTextContainer}>
              <View style={styles.greetingRow}>
                <MaterialCommunityIcons name={greeting.icon} size={16} color={greeting.color} />
                <Text style={styles.greetingText}>{`${greeting.text}${passengerName ? `, ${passengerName}` : ''}!`}</Text>
              </View>
              <Text style={styles.tourCodeDisplay}>{tourCode}</Text>
              <Text style={styles.tourName} numberOfLines={1}>{tourData?.name || 'Active Tour'}</Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.headerButton}
                onPress={() => {
                  triggerHaptic('light');
                  onNavigate('NotificationPreferences');
                }}
                accessible={true}
                accessibilityLabel="Notification settings"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="bell-ring-outline" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.headerButton}
                onPress={() => {
                  triggerHaptic('light');
                  onLogout();
                }}
                activeOpacity={0.7}
                accessible={true}
                accessibilityLabel="Log out"
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="logout-variant" size={22} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          </AnimatedCard>

          {/* Pickup countdown timer */}
          {primaryPickupTime && manifestStatus !== MANIFEST_STATUS.BOARDED && (
            <AnimatedCard delay={50}>
              <PickupCountdown pickupTime={primaryPickupTime} />
            </AnimatedCard>
          )}

          {/* Status card with enhanced visuals */}
          <AnimatedCard style={styles.statusCard} delay={100}>
            <LinearGradient
              colors={[manifestStatusMeta.toneLight, COLORS.white]}
              style={styles.statusCardGradient}
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
                <Text style={styles.statusTitle}>{manifestStatusMeta.title}</Text>
                <Text style={styles.statusMessage}>{manifestStatusMeta.message}</Text>
              </View>
            </LinearGradient>
          </AnimatedCard>

          {/* Quick Actions Bar */}
          <AnimatedCard delay={150}>
            <View style={styles.quickActionsContainer}>
              <Text style={styles.quickActionsTitle}>Quick Actions</Text>
              <View style={styles.quickActionsRow}>
                {quickActions.map((action, index) => (
                  <QuickActionButton
                    key={action.label}
                    {...action}
                    delay={200 + index * 50}
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
                  <View>
                    <Text style={styles.boardingPassLabel}>DIGITAL BOARDING PASS</Text>
                    <Text style={styles.boardingPassTour}>{tourData.name || 'Scenic Tour'}</Text>
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
                          <Text style={styles.pickupLocationText} numberOfLines={2}>{pickup.location}</Text>
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
                        <Text style={styles.pickupLocationText} numberOfLines={2}>
                          {bookingData.pickupLocation}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : null}

                {/* Seat Information */}
                {bookingData?.seatNumbers?.length > 0 && (
                  <View style={styles.seatSection}>
                    <View style={styles.seatRow}>
                      {bookingData.seatNumbers.map((seat, index) => (
                        <View key={index} style={styles.seatBox}>
                          <MaterialCommunityIcons name="seat" size={18} color={COLORS.coralAccent} />
                          <Text style={styles.seatNumber}>{seat}</Text>
                        </View>
                      ))}
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
              <TodaysAgendaCard tourData={tourData} onNudge={() => onNavigate('Itinerary')} />
            </AnimatedCard>
          )}

          {/* Find My Bus - Enhanced Feature Card */}
          <AnimatedCard
            style={styles.findBusCard}
            delay={300}
            onPress={() => {
              triggerHaptic('light');
              onNavigate('Map');
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
                      ? 'Driver location is being shared'
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
                onPress={() => onNavigate(menuItems[0].id)}
              />
              <FeatureCard
                item={menuItems[1]}
                index={1}
                onPress={() => onNavigate(menuItems[1].id)}
              />
            </View>
            {/* Second row - 2 cards */}
            <View style={styles.featuresRow}>
              <FeatureCard
                item={menuItems[2]}
                index={2}
                onPress={() => onNavigate(menuItems[2].id)}
              />
              <FeatureCard
                item={menuItems[3]}
                index={3}
                onPress={() => onNavigate(menuItems[3].id)}
              />
            </View>
            {/* Third row - 1 full-width card for Safety */}
            <FeatureCard
              item={menuItems[4]}
              index={4}
              isLarge={true}
              onPress={() => onNavigate('SafetySupport', { from: 'TourHome', mode: 'passenger' })}
            />
          </View>

          {/* Bottom spacing */}
          <View style={{ height: 40 }} />
        </ScrollView>
      </LinearGradient>

      {/* Enhanced No-Show Modal */}
      <Modal visible={isNoShow} transparent animationType="fade" presentationStyle="overFullScreen">
        <View style={styles.modalOverlay}>
          <Animated.View style={styles.modalCard}>
            <LinearGradient
              colors={[COLORS.errorLight, COLORS.white]}
              style={styles.modalGradient}
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
              >
                <MaterialCommunityIcons name="message-text" size={20} color={COLORS.primaryBlue} />
                <Text style={styles.modalSecondaryButtonText}>Send Text Message</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalEmergencyButton}
                onPress={() => onNavigate('SafetySupport', { from: 'TourHome', mode: 'passenger' })}
                activeOpacity={0.8}
              >
                <MaterialCommunityIcons name="shield-alert" size={18} color={COLORS.error} />
                <Text style={styles.modalEmergencyButtonText}>Emergency Assistance</Text>
              </TouchableOpacity>

              <View style={styles.modalLogoutDivider} />

              <TouchableOpacity
                style={styles.modalLogoutButton}
                onPress={onLogout}
                activeOpacity={0.8}
              >
                <MaterialCommunityIcons name="logout-variant" size={18} color={COLORS.subtleText} />
                <Text style={styles.modalLogoutButtonText}>Log Out</Text>
              </TouchableOpacity>
            </LinearGradient>
          </Animated.View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
  },
  gradient: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 28,
  },

  // Header styles
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    backgroundColor: COLORS.white,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    ...SHADOWS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logoImage: {
    width: 48,
    height: 48,
    borderRadius: 14,
  },
  headerTextContainer: {
    flex: 1,
    marginLeft: 14,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  greetingText: {
    fontSize: 14,
    color: COLORS.subtleText,
    fontWeight: '600',
  },
  tourCodeDisplay: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.primaryBlue,
    letterSpacing: 0.5,
  },
  tourName: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '500',
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  headerButton: {
    padding: 10,
    borderRadius: 14,
    backgroundColor: `${COLORS.primaryBlue}10`,
  },

  // Countdown styles
  countdownContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}10`,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    marginBottom: 16,
    gap: 10,
  },
  countdownUrgent: {
    backgroundColor: COLORS.warningLight,
  },
  countdownVeryUrgent: {
    backgroundColor: COLORS.errorLight,
  },
  countdownText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  countdownTextUrgent: {
    color: COLORS.error,
  },

  // Status card styles
  statusCard: {
    marginBottom: 18,
    borderRadius: 20,
    overflow: 'hidden',
    ...SHADOWS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
  },
  statusCardGradient: {
    flexDirection: 'row',
    padding: 18,
    alignItems: 'flex-start',
  },
  statusIconContainer: {
    position: 'relative',
    marginRight: 16,
  },
  statusPulse: {
    position: 'absolute',
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  statusIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusContent: {
    flex: 1,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 10,
  },
  statusBadgeText: {
    fontWeight: '800',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 6,
  },
  statusMessage: {
    fontSize: 14,
    color: COLORS.subtleText,
    lineHeight: 20,
  },

  // Quick actions styles
  quickActionsContainer: {
    marginBottom: 20,
  },
  quickActionsTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.subtleText,
    marginBottom: 12,
    marginLeft: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  quickActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  quickActionButton: {
    alignItems: 'center',
    width: (SCREEN_WIDTH - 36 - 30) / 4,
  },
  quickActionIconContainer: {
    width: 52,
    height: 52,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    position: 'relative',
  },
  quickActionBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: COLORS.error,
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionBadgeText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: '800',
  },
  quickActionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.darkText,
    textAlign: 'center',
  },

  // Boarding pass styles
  boardingPass: {
    marginBottom: 24,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    ...SHADOWS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  boardingPassHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
  },
  boardingPassHeaderContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  boardingPassLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.7)',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  boardingPassTour: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.white,
    maxWidth: '70%',
  },
  boardingPassQR: {
    opacity: 0.9,
  },
  tornEdge: {
    flexDirection: 'row',
    height: 12,
    backgroundColor: COLORS.white,
    marginTop: -12,
  },
  tornEdgeBump: {
    flex: 1,
    height: 12,
    backgroundColor: COLORS.primaryBlue,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    marginHorizontal: 1,
  },
  boardingPassBody: {
    padding: 20,
  },
  boardingPassDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 16,
  },

  // Driver status styles
  driverStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  driverAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  liveDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: COLORS.success,
    borderWidth: 2,
    borderColor: COLORS.white,
  },
  driverInfo: {
    marginLeft: 12,
    flex: 1,
  },
  driverName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 2,
  },
  driverStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.subtleText,
  },
  statusDotLive: {
    backgroundColor: COLORS.success,
  },
  driverStatusText: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '500',
  },

  // Pickup section styles
  pickupSection: {
    marginBottom: 16,
  },
  pickupSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.subtleText,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pickupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}08`,
    padding: 14,
    borderRadius: 14,
    marginBottom: 8,
  },
  pickupTimeBox: {
    backgroundColor: COLORS.coralAccent,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginRight: 12,
  },
  pickupTimeText: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.white,
  },
  pickupLocationInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  pickupLocationText: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '500',
    flex: 1,
    lineHeight: 20,
  },

  // Seat section styles
  seatSection: {
    alignItems: 'center',
    marginBottom: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  seatRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  seatBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.coralAccent}15`,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 8,
  },
  seatNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.coralAccent,
  },
  seatLabel: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Passengers section styles
  passengersSection: {
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  passengersSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.subtleText,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  passengerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  passengerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  passengerAvatarText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700',
  },
  passengerName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.darkText,
  },
  passengerSeat: {
    fontSize: 12,
    color: COLORS.coralAccent,
    fontWeight: '700',
    backgroundColor: `${COLORS.coralAccent}15`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },

  // Boarding pass footer styles
  boardingPassFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopStyle: 'dashed',
    borderTopColor: COLORS.border,
  },
  boardingPassFooterLabel: {
    fontSize: 10,
    color: COLORS.subtleText,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  boardingPassFooterValue: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  boardingPassFooterRight: {
    alignItems: 'flex-end',
  },

  // Find My Bus card styles
  findBusCard: {
    marginBottom: 24,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    ...SHADOWS.lg,
    borderWidth: 1.5,
    borderColor: `${COLORS.coralAccent}30`,
  },
  findBusGradient: {
    padding: 18,
  },
  findBusContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  findBusIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: `${COLORS.coralAccent}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
    position: 'relative',
  },
  findBusLiveBadge: {
    position: 'absolute',
    bottom: -6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.success,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    gap: 4,
  },
  findBusLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.white,
  },
  findBusLiveText: {
    fontSize: 9,
    fontWeight: '800',
    color: COLORS.white,
    letterSpacing: 0.5,
  },
  findBusTextContainer: {
    flex: 1,
  },
  findBusTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 4,
  },
  findBusSubtitle: {
    fontSize: 14,
    color: COLORS.subtleText,
    fontWeight: '500',
    lineHeight: 20,
  },
  findBusArrow: {
    marginLeft: 10,
  },

  // Section title
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 16,
    paddingLeft: 4,
  },

  // Features grid styles
  featuresGrid: {
    gap: 14,
  },
  featuresRow: {
    flexDirection: 'row',
    gap: 14,
  },
  featureCard: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    ...SHADOWS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  featureCardLarge: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    ...SHADOWS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  featureCardInner: {
    flex: 1,
  },
  featureCardGradient: {
    padding: 18,
    minHeight: 130,
    justifyContent: 'space-between',
  },
  featureIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  featureCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 2,
  },
  featureCardTitleLarge: {
    fontSize: 17,
  },
  featureCardSubtitle: {
    fontSize: 12,
    color: COLORS.subtleText,
    fontWeight: '500',
  },
  featureArrow: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 24,
    overflow: 'hidden',
    ...SHADOWS.xl,
  },
  modalGradient: {
    padding: 28,
    alignItems: 'center',
  },
  modalIconContainer: {
    position: 'relative',
    marginBottom: 20,
  },
  modalIconPulse: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: COLORS.error,
    opacity: 0.2,
  },
  modalIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${COLORS.error}15`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.darkText,
    textAlign: 'center',
    marginBottom: 12,
  },
  modalMessage: {
    fontSize: 15,
    color: COLORS.subtleText,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  modalDivider: {
    width: '100%',
    height: 1,
    backgroundColor: COLORS.border,
    marginBottom: 20,
  },
  modalActionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.subtleText,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 16,
  },
  modalPrimaryButton: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 12,
  },
  modalButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 10,
  },
  modalPrimaryButtonText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
  modalSecondaryButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: `${COLORS.primaryBlue}10`,
    marginBottom: 12,
    gap: 10,
  },
  modalSecondaryButtonText: {
    color: COLORS.primaryBlue,
    fontSize: 15,
    fontWeight: '700',
  },
  modalEmergencyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  modalEmergencyButtonText: {
    color: COLORS.error,
    fontSize: 14,
    fontWeight: '700',
  },
  modalLogoutDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 12,
    marginHorizontal: 20,
  },
  modalLogoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  modalLogoutButtonText: {
    color: COLORS.subtleText,
    fontSize: 14,
    fontWeight: '600',
  },
});
