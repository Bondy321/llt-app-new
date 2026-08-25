import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import createTourHomeScreenStyles from '../../screens/styles/TourHomeScreen.styles';
import { getPickupCountdownState } from '../../services/pickupTimeParser';
import { COLORS } from './tourHomePresentation';
import { RADIUS, SHADOWS, SPACING } from '../../theme';

const styles = createTourHomeScreenStyles({ StyleSheet, COLORS, RADIUS, SHADOWS, SPACING });
const PICKUP_COUNTDOWN_REFRESH_MS = 30 * 1000;

export const AnimatedCard = ({ children, style, delay = 0, onPress, accessibilityLabel, accessibilityHint }) => {
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
  }, [delay, fadeAnim, scaleAnim, slideAnim]);

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
export const SkeletonLoader = ({ width, height, borderRadius = 8, style }) => {
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
  }, [pulseAnim]);

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
export const PickupCountdown = ({ pickupTime, pickupDate }) => {
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
export const QuickActionButton = ({ icon, label, color, onPress, badge, delay = 0, compact = false }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      delay,
      useNativeDriver: true,
    }).start();
  }, [delay, fadeAnim]);

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
export const DriverStatusIndicator = ({ driverName, isLive = false }) => {
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
  }, [isLive, pulseAnim]);

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
export const StatusPulse = ({ color }) => {
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
  }, [pulseAnim]);

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
export const FeatureCard = ({ item, onPress, index, isLarge = false }) => {
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
  }, [fadeAnim, index, slideAnim]);

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
