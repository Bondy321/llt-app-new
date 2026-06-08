// screens/LoginScreen.js
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { validateBookingReference } from '../services/bookingServiceRealtime';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  ActivityIndicator,
  Animated,
  Image,
  Alert,
  Linking,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  COLORS as THEME_COLORS,
  SPACING as THEME_SPACING,
  RADIUS as THEME_RADIUS,
  SHADOWS as THEME_SHADOWS,
  FONT_WEIGHT as THEME_FONT_WEIGHT,
} from '../theme';
import loggerService, { maskIdentifier } from '../services/loggerService';
import { recordBreadcrumb as recordCrashBreadcrumb } from '../services/crashDiagnosticsService';
import {
  FONT_SCALE_LIMITS,
  getResponsiveLayout,
  responsiveFontSize,
  responsiveLineHeight,
} from '../utils/responsiveLayout';

const {
  LOGIN_MODE_HINTS,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  getReferencePlaceholder,
  shouldShowEmailField,
  resolveLoginIdentity,
} = require('./loginFlow');
const loginDiagnostics = require('../services/loginDiagnosticsService');

const COLORS = {
  primaryBlue: THEME_COLORS.primary,
  secondaryBlue: THEME_COLORS.primaryDark,
  lightBlue: THEME_COLORS.primaryMuted,
  white: THEME_COLORS.white,
  errorRed: THEME_COLORS.error,
  errorSoft: THEME_COLORS.errorLight,
  darkText: THEME_COLORS.textPrimary,
  inputBackground: THEME_COLORS.background,
  placeholderText: THEME_COLORS.textMuted,
  border: THEME_COLORS.border,
  subtleText: THEME_COLORS.textSecondary,
  success: THEME_COLORS.success,
  successSoft: THEME_COLORS.successLight,
  warning: THEME_COLORS.warning,
  warningSoft: THEME_COLORS.warningLight,
};

const SPACING = THEME_SPACING || {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

const RADIUS = THEME_RADIUS || {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

const SHADOWS = THEME_SHADOWS || {
  lg: {},
  xl: {},
};

const FONT_WEIGHT = THEME_FONT_WEIGHT || {
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};

const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE?.trim();
const LOGIN_LOGO_ASPECT_RATIO = 355 / 886;

const getNetInfoModule = () => {
  try {
    const netInfoModule = require('@react-native-community/netinfo');
    return netInfoModule.default || netInfoModule;
  } catch (error) {
    return null;
  }
};

const createErrorState = (message, options = {}) => ({
  title: options.title || 'Login issue',
  message,
  reason: options.reason || null,
  showOfflineActions: options.showOfflineActions || false,
  recoverySteps: options.recoverySteps || [],
});

export default function LoginScreen({ onLoginSuccess, logger, isConnected, resolveOfflineLogin }) {
  const { width, height, fontScale } = useWindowDimensions();
  const screenLayout = useMemo(
    () => getResponsiveLayout({ width, height, fontScale }),
    [fontScale, height, width]
  );
  const logoWidth = Math.min(
    Math.max(width - screenLayout.horizontalPadding * 2, 180),
    screenLayout.isLargeText || screenLayout.isCompact ? 230 : 260
  );
  const logoHeight = logoWidth * LOGIN_LOGO_ASPECT_RATIO;
  const responsiveStyles = useMemo(() => {
    const appTitleSize = responsiveFontSize(32, screenLayout, {
      min: 24,
      max: 32,
      compactAdjustment: -2,
      largeTextAdjustment: -5,
      veryLargeTextAdjustment: -7,
    });
    const subtitleSize = responsiveFontSize(14, screenLayout, {
      min: 12,
      max: 14,
      compactAdjustment: -1,
      largeTextAdjustment: -1,
      veryLargeTextAdjustment: -2,
    });
    const welcomeSize = responsiveFontSize(24, screenLayout, {
      min: 20,
      max: 24,
      compactAdjustment: -1,
      largeTextAdjustment: -3,
      veryLargeTextAdjustment: -4,
    });

    return {
      scrollContainer: {
        paddingHorizontal: screenLayout.horizontalPadding,
        paddingTop: screenLayout.isLargeText ? SPACING.xs : SPACING.sm,
      },
      logoSection: {
        marginBottom: screenLayout.isLargeText ? SPACING.sm : SPACING.md,
      },
      formCard: {
        padding: screenLayout.cardPadding,
      },
      appTitle: {
        fontSize: appTitleSize,
        lineHeight: responsiveLineHeight(appTitleSize, 1.16),
      },
      appSubtitle: {
        fontSize: subtitleSize,
        lineHeight: responsiveLineHeight(subtitleSize, 1.22),
      },
      welcomeText: {
        fontSize: welcomeSize,
        lineHeight: responsiveLineHeight(welcomeSize, 1.14),
      },
      welcomeSubtext: {
        fontSize: responsiveFontSize(13, screenLayout, {
          min: 12,
          max: 13,
          compactAdjustment: 0,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -1,
        }),
      },
      hintsRow: screenLayout.isVeryLargeText || screenLayout.isTiny
        ? { flexDirection: 'column' }
        : null,
      hintChip: screenLayout.isLargeText
        ? { padding: SPACING.sm }
        : null,
      input: {
        fontSize: responsiveFontSize(16, screenLayout, {
          min: 14,
          max: 16,
          compactAdjustment: -1,
          largeTextAdjustment: -1,
          veryLargeTextAdjustment: -2,
        }),
      },
      buttonText: {
        fontSize: responsiveFontSize(17, screenLayout, {
          min: 15,
          max: 17,
          compactAdjustment: -1,
          largeTextAdjustment: -2,
          veryLargeTextAdjustment: -2,
        }),
      },
    };
  }, [screenLayout]);
  const [bookingReference, setBookingReference] = useState('');
  const [email, setEmail] = useState('');
  const [errorState, setErrorState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modeHintFocus, setModeHintFocus] = useState(null);
  const [showPrimaryHelp, setShowPrimaryHelp] = useState(false);
  const [showOfflineHelp, setShowOfflineHelp] = useState(false);
  const [showRecoverySteps, setShowRecoverySteps] = useState(false);
  const [fieldTouched, setFieldTouched] = useState({ bookingReference: false, email: false });
  const [activeInput, setActiveInput] = useState(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const activeLogger = logger || loggerService;

  const [logoAnimation] = useState(new Animated.Value(0));
  const [formAnimation] = useState(new Animated.Value(0));
  const [buttonAnimation] = useState(new Animated.Value(1));
  const scrollRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!Keyboard?.addListener) {
      return undefined;
    }

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const clearErrorState = () => setErrorState(null);
  const setSimpleError = (message) => setErrorState(createErrorState(message));

  const normalizedInput = normalizeLoginFields({ bookingReference, email });

  const emailVisible = shouldShowEmailField({
    modeHintFocus,
    normalizedReference: normalizedInput.normalizedReference,
  });

  const isSubmitDisabled = useMemo(
    () => loading || !normalizedInput.normalizedReference,
    [loading, normalizedInput.normalizedReference]
  );

  useEffect(() => {
    Animated.sequence([
      Animated.timing(logoAnimation, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(formAnimation, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();

    activeLogger?.trackScreen('Login');
  }, []);

  const animateButton = () => {
    Animated.sequence([
      Animated.timing(buttonAnimation, { toValue: 0.96, duration: 110, useNativeDriver: true }),
      Animated.timing(buttonAnimation, { toValue: 1, duration: 110, useNativeDriver: true }),
    ]).start();
  };

  const applyValidation = (phase = 'submit', options = {}) => {
    const inputError = getLoginInputError(normalizedInput, {
      phase,
      emailTouched: options.emailTouched ?? fieldTouched.email,
    });

    if (inputError) {
      setSimpleError(inputError);
      return false;
    }

    if (errorState?.reason) {
      clearErrorState();
    }

    return true;
  };

  const handleReferenceChange = (text) => {
    setBookingReference(text);
    const normalized = text.trim().toUpperCase();

    if (normalized.startsWith('D-')) {
      setModeHintFocus('driver');
    } else if (normalized) {
      setModeHintFocus('passenger');
    }

    if (errorState && !errorState.reason) clearErrorState();
  };

  const handleEmailBlur = () => {
    setFieldTouched((current) => ({ ...current, email: true }));
    applyValidation('blur', { emailTouched: true });
  };

  const handleContactSupport = async () => {
    activeLogger?.trackEvent('offline_login_cta_clicked', {
      cta: 'contact_support',
      reason: errorState?.reason,
      isConnected,
      hasPhone: Boolean(SUPPORT_PHONE),
    });

    const openSupportUrl = async (url, method) => {
      try {
        const supported = await Linking.canOpenURL(url);
        if (!supported) return false;
        await Linking.openURL(url);
        return true;
      } catch (error) {
        activeLogger?.warn?.('Login', 'Support contact launch failed', {
          method,
          reason: error?.message || String(error),
        });
        return false;
      }
    };

    if (SUPPORT_PHONE) {
      const telUrl = `tel:${SUPPORT_PHONE}`;
      if (await openSupportUrl(telUrl, 'phone')) return;
    }

    Alert.alert(
      'Support contact unavailable',
      'Support contact details are not configured on this build. Please email support@lochlomondtravel.com for assistance.'
    );
  };

  const handleOfflineCtaPress = async (cta) => {
    activeLogger?.trackEvent('offline_login_cta_clicked', { cta, reason: errorState?.reason, isConnected });

    if (cta === 'retry_now') return handleLogin();
    if (cta === 'verify_online') {
      if (!isConnected) {
        setErrorState(
          createErrorState('No internet connection detected yet. Connect to mobile data or Wi-Fi, then tap "I\'m connected, verify this code".', {
            title: 'Still offline',
            reason: errorState?.reason,
            showOfflineActions: true,
          })
        );
        return;
      }
      return handleLogin();
    }

    if (cta === 'contact_support') return handleContactSupport();
  };

  const handleLogin = async () => {
    const { trimmedReference, normalizedReference, normalizedEmail } = normalizedInput;
    const loginMode = normalizedReference.startsWith('D-') ? 'driver' : 'passenger';
    const loginDiagnosticContext = loginDiagnostics.startLoginAttempt({
      source: 'LoginScreen.handleLogin',
      loginMode,
      isConnected,
      input: {
        bookingReference: trimmedReference,
        normalizedReference,
        email: normalizedEmail,
        referenceLength: trimmedReference.length,
        emailLength: normalizedEmail.length,
      },
      uiState: {
        modeHintFocus,
        emailVisible,
        loading,
        activeInput,
        isKeyboardVisible,
        showPrimaryHelp,
        showOfflineHelp,
      },
    });

    let netInfoState = null;
    try {
      const NetInfo = getNetInfoModule();
      if (typeof NetInfo?.fetch !== 'function') {
        await loginDiagnostics.recordLoginDiagnostic('netinfo_snapshot_unavailable', {
          reason: 'NETINFO_MODULE_UNAVAILABLE',
        }, loginDiagnosticContext);
      } else {
        netInfoState = await NetInfo.fetch();
        await loginDiagnostics.recordLoginDiagnostic('netinfo_snapshot', {
          state: loginDiagnostics.summarizeNetworkState(netInfoState),
        }, loginDiagnosticContext);
      }
    } catch (netInfoError) {
      await loginDiagnostics.recordLoginDiagnostic('netinfo_snapshot_failed', {
        error: loginDiagnostics.summarizeError(netInfoError),
      }, loginDiagnosticContext);
    }

    setFieldTouched({ bookingReference: true, email: true });
    if (!applyValidation('submit')) {
      await loginDiagnostics.recordLoginDiagnostic('client_validation_blocked_submit', {
        loginMode,
        input: {
          bookingReference: trimmedReference,
          normalizedReference,
          email: normalizedEmail,
        },
      }, loginDiagnosticContext);
      return;
    }

    activeLogger?.info('Login', 'Login attempt started', { hasBookingRef: !!bookingReference, isConnected });
    await loginDiagnostics.recordLoginDiagnostic('login_attempt_started_online_state', {
      loginMode,
      isConnected,
      netInfoState: loginDiagnostics.summarizeNetworkState(netInfoState),
      submitDisabledAtPress: isSubmitDisabled,
    }, loginDiagnosticContext);
    recordCrashBreadcrumb('Login', 'submit_started', {
      loginMode,
      isConnected,
      hasEmail: Boolean(normalizedEmail),
      referenceLength: trimmedReference.length,
    }, { remote: true, reason: 'Login:submit_started' });

    if (!isConnected) {
      await loginDiagnostics.recordLoginDiagnostic('offline_login_resolution_started', {
        loginMode,
        input: {
          bookingReference: trimmedReference,
          email: normalizedEmail,
        },
      }, loginDiagnosticContext);
      const offlineCheck = await resolveOfflineLogin?.(trimmedReference, normalizedEmail);
      if (offlineCheck?.success) {
        await loginDiagnostics.recordLoginDiagnostic('offline_login_resolution_succeeded', {
          loginMode: offlineCheck.type || loginMode,
          hasTour: Boolean(offlineCheck.tour),
          identityId: offlineCheck.identity?.id || null,
          tourId: offlineCheck.tour?.id || null,
        }, loginDiagnosticContext);
        recordCrashBreadcrumb('Login', 'offline_login_resolved', {
          loginMode: offlineCheck.type || loginMode,
          hasTour: Boolean(offlineCheck.tour),
        }, { remote: true, reason: 'Login:offline_login_resolved' });
        await onLoginSuccess(normalizedReference, offlineCheck.tour, offlineCheck.identity, offlineCheck.type, {
          offlineMode: true,
          loginDiagnostics: loginDiagnosticContext,
          loginDiagnosticId: loginDiagnosticContext.attemptId,
        });
        return;
      }
      await loginDiagnostics.recordLoginDiagnostic('offline_login_resolution_blocked', {
        loginMode,
        reason: offlineCheck?.reason || null,
        error: offlineCheck?.error || null,
        hasCachedSession: Boolean(offlineCheck?.hasCachedSession),
      }, loginDiagnosticContext);
      recordCrashBreadcrumb('Login', 'offline_login_blocked', {
        loginMode,
        reason: offlineCheck?.reason || null,
        hasCachedSession: Boolean(offlineCheck?.hasCachedSession),
      }, { remote: true, reason: 'Login:offline_login_blocked' });
      setShowRecoverySteps(false);
      setErrorState(createOfflineErrorState(offlineCheck, createErrorState));
      return;
    }

    animateButton();
    setLoading(true);
    clearErrorState();

    try {
      await loginDiagnostics.recordLoginDiagnostic('online_validation_call_started', {
        loginMode,
        input: {
          bookingReference: trimmedReference,
          email: normalizedEmail,
        },
      }, loginDiagnosticContext);
      const result = await validateBookingReference(trimmedReference, normalizedEmail, {
        loginDiagnostics: loginDiagnosticContext,
      });
      await loginDiagnostics.recordLoginDiagnostic('online_validation_call_returned', {
        loginMode,
        valid: Boolean(result?.valid),
        type: result?.type || null,
        error: result?.error || null,
        hasTour: Boolean(result?.tour),
        tourId: result?.tour?.id || null,
        assignmentStatus: result?.assignmentStatus || null,
        identityId: result?.booking?.id || result?.driver?.id || null,
      }, loginDiagnosticContext);
      if (result.valid) {
        recordCrashBreadcrumb('Login', 'validation_succeeded', {
          loginMode: result.type || loginMode,
          hasTour: Boolean(result.tour),
          assignmentStatus: result.assignmentStatus || null,
        }, { remote: true, reason: 'Login:validation_succeeded' });
        const loginData = resolveLoginIdentity(result);
        await loginDiagnostics.recordLoginDiagnostic('login_success_handoff_started', {
          loginMode: result.type || loginMode,
          tourId: result.tour?.id || null,
          identityId: loginData?.id || null,
        }, loginDiagnosticContext);
        await onLoginSuccess(normalizedReference, result.tour, loginData, result.type, {
          loginDiagnostics: loginDiagnosticContext,
          loginDiagnosticId: loginDiagnosticContext.attemptId,
        });
        await loginDiagnostics.recordLoginDiagnostic('login_success_handoff_completed', {
          loginMode: result.type || loginMode,
          tourId: result.tour?.id || null,
          identityId: loginData?.id || null,
        }, loginDiagnosticContext);
      } else {
        recordCrashBreadcrumb('Login', 'validation_failed', {
          loginMode,
          error: result.error || null,
        }, { remote: true, reason: 'Login:validation_failed' });
        await loginDiagnostics.recordLoginDiagnostic('online_validation_rejected_user_visible', {
          loginMode,
          error: result.error || null,
        }, loginDiagnosticContext);
        setSimpleError(result.error || 'Invalid booking reference. Please try again.');
      }
    } catch (error) {
      activeLogger?.error('Login', 'Login error', { error: error.message, bookingRef: maskIdentifier(trimmedReference) });
      await loginDiagnostics.recordLoginDiagnostic('login_flow_threw', {
        loginMode,
        error: loginDiagnostics.summarizeError(error),
        userMessage: error?.userMessage || null,
      }, loginDiagnosticContext);
      recordCrashBreadcrumb('Login', 'login_error', {
        loginMode,
        error: error.message,
        code: error?.code || null,
      }, { remote: true, reason: 'Login:login_error' });
      const userMessage = typeof error?.userMessage === 'string' && error.userMessage.trim()
        ? error.userMessage.trim()
        : 'Unable to verify booking. Please check your connection.';
      setSimpleError(userMessage);
    } finally {
      await loginDiagnostics.recordLoginDiagnostic('login_attempt_finished_client_finally', {
        loginMode,
        mounted: mountedRef.current,
      }, loginDiagnosticContext);
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  };

  const networkStateTone = isConnected
    ? {
        label: 'Online verification available',
        icon: 'check-decagram',
        container: styles.networkPillOnline,
        iconColor: COLORS.success,
        textColor: COLORS.success,
      }
    : {
        label: 'Offline mode active',
        icon: 'wifi-strength-off-outline',
        container: styles.networkPillOffline,
        iconColor: COLORS.warning,
        textColor: COLORS.warning,
      };

  return (
    <LinearGradient colors={[COLORS.primaryBlue, COLORS.secondaryBlue]} style={styles.gradient}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardAvoidingContainer}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={[
              styles.scrollContainer,
              responsiveStyles.scrollContainer,
              isKeyboardVisible && styles.scrollContainerKeyboardVisible,
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
            bounces={!isKeyboardVisible}
            overScrollMode="never"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.container}>
              <Animated.View style={[styles.logoSection, responsiveStyles.logoSection, { opacity: logoAnimation }]}>
                <Image
                  source={require('../assets/images/app-logo-llt-cropped.png')}
                  style={[styles.logoImage, { width: logoWidth, height: logoHeight }]}
                  resizeMode="contain"
                />
                <Text
                  style={[styles.appTitle, responsiveStyles.appTitle]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.display}
                >
                  Loch Lomond Travel
                </Text>
                <Text
                  style={[styles.appSubtitle, responsiveStyles.appSubtitle]}
                  numberOfLines={2}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                >
                  The UK's Fastest Growing Coach Tour Operator
                </Text>
              </Animated.View>

            <Animated.View style={[styles.formCard, responsiveStyles.formCard, { opacity: formAnimation }]}>
              <Text
                style={[styles.welcomeText, responsiveStyles.welcomeText]}
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.heading}
              >
                Welcome aboard
              </Text>
              <Text
                style={[styles.welcomeSubtext, responsiveStyles.welcomeSubtext]}
                maxFontSizeMultiplier={FONT_SCALE_LIMITS.body}
              >
                Sign in securely to access your live itinerary, pickup updates, and tour support.
              </Text>

              <View style={[styles.networkPillBase, networkStateTone.container]}>
                <MaterialCommunityIcons name={networkStateTone.icon} size={16} color={networkStateTone.iconColor} />
                <Text
                  style={[styles.networkPillText, { color: networkStateTone.textColor }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                >
                  {networkStateTone.label}
                </Text>
              </View>

              <View style={[styles.hintsRow, responsiveStyles.hintsRow]}>
                {Object.entries(LOGIN_MODE_HINTS).map(([key, hint]) => {
                  const selected = modeHintFocus === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.hintChip, responsiveStyles.hintChip, selected && styles.hintChipSelected]}
                      onPress={() => setModeHintFocus(key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Select ${hint.label} login hint`}
                    >
                      <View style={styles.hintTitleRow}>
                        <MaterialCommunityIcons
                          name={key === 'driver' ? 'steering' : 'account-group'}
                          size={14}
                          color={selected ? COLORS.primaryBlue : COLORS.subtleText}
                        />
                        <Text
                          style={[styles.hintChipLabel, selected && styles.hintChipLabelSelected]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                        >
                          {hint.label}
                        </Text>
                      </View>
                      <Text
                        style={[styles.hintChipText, selected && styles.hintChipTextSelected]}
                        maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                      >
                        {hint.hint}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={[styles.inputContainer, activeInput === 'reference' && styles.inputContainerFocused]}>
                <MaterialCommunityIcons name="ticket-confirmation-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, responsiveStyles.input]}
                  value={bookingReference}
                  onChangeText={handleReferenceChange}
                  onFocus={() => {
                    setActiveInput('reference');
                    scrollRef.current?.scrollTo({ y: height * 0.24, animated: true });
                  }}
                  onBlur={() => {
                    setActiveInput(null);
                    setFieldTouched((current) => ({ ...current, bookingReference: true }));
                  }}
                  placeholder={getReferencePlaceholder(modeHintFocus)}
                  placeholderTextColor={COLORS.placeholderText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={20}
                  returnKeyType="go"
                  onSubmitEditing={handleLogin}
                  editable={!loading}
                  accessibilityLabel="Booking reference or driver code"
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.form}
                />
              </View>

              {emailVisible ? (
                <View style={[styles.inputContainer, activeInput === 'email' && styles.inputContainerFocused]}>
                  <MaterialCommunityIcons name="email-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, responsiveStyles.input]}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (errorState && !errorState.reason) clearErrorState();
                    }}
                    onFocus={() => {
                      setActiveInput('email');
                      scrollRef.current?.scrollTo({ y: height * 0.32, animated: true });
                    }}
                    onBlur={() => {
                      setActiveInput(null);
                      handleEmailBlur();
                    }}
                    placeholder="Booking email"
                    placeholderTextColor={COLORS.placeholderText}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
                    editable={!loading}
                    accessibilityLabel="Booking email address"
                    maxFontSizeMultiplier={FONT_SCALE_LIMITS.form}
                  />
                </View>
              ) : null}

              {errorState ? (
                <View style={styles.errorContainer}>
                  <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.errorRed} />
                  <View style={styles.errorBody}>
                    <Text style={styles.errorTitle}>{errorState.title}</Text>
                    <Text style={styles.errorText}>{errorState.message}</Text>
                    {errorState.recoverySteps?.length ? (
                      <TouchableOpacity style={styles.disclosureButtonCompact} onPress={() => setShowRecoverySteps((current) => !current)}>
                        <Text style={styles.disclosureErrorText}>How to recover</Text>
                        <MaterialCommunityIcons name={showRecoverySteps ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.errorRed} />
                      </TouchableOpacity>
                    ) : null}
                    {showRecoverySteps
                      ? errorState.recoverySteps.map((step) => (
                          <Text key={step} style={styles.recoveryStepText}>
                            • {step}
                          </Text>
                        ))
                      : null}
                    {errorState.showOfflineActions ? (
                      <View style={styles.errorActionsContainer}>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('retry_now')} disabled={loading}>
                          <Text style={styles.errorActionText}>Retry now</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('verify_online')} disabled={loading}>
                          <Text style={styles.errorActionText}>I’m connected, verify this code</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : null}

              <Animated.View style={{ transform: [{ scale: buttonAnimation }] }}>
                <TouchableOpacity
                  style={[styles.button, isSubmitDisabled && styles.buttonDisabled]}
                  onPress={handleLogin}
                  activeOpacity={0.9}
                  disabled={isSubmitDisabled}
                >
                  <LinearGradient colors={[COLORS.primaryBlue, COLORS.secondaryBlue]} style={styles.buttonGradient}>
                    {loading ? (
                      <View style={styles.loadingRow}>
                        <ActivityIndicator size="small" color={COLORS.white} />
                        <Text
                          style={[styles.buttonText, responsiveStyles.buttonText]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                        >
                          Verifying...
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.buttonContent}>
                        <Text
                          style={[styles.buttonText, responsiveStyles.buttonText]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                        >
                          Access My Tour
                        </Text>
                        <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.white} />
                      </View>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>

              <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowPrimaryHelp((current) => !current)}>
                <Text style={styles.disclosureText}>Sign-in help</Text>
                <MaterialCommunityIcons name={showPrimaryHelp ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.primaryBlue} />
              </TouchableOpacity>

              {showPrimaryHelp ? (
                <View style={styles.helpPanel}>
                  <Text style={styles.helpText}>Passengers sign in with booking reference + booking email. Drivers sign in with a D- code.</Text>
                  <Text style={styles.helpText}>Offline sign-in only works for identities previously verified on this device.</Text>
                </View>
              ) : null}

              <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowOfflineHelp((current) => !current)}>
                <Text style={styles.disclosureText}>Why can’t I log in offline?</Text>
                <MaterialCommunityIcons name={showOfflineHelp ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              {showOfflineHelp ? (
                <View style={styles.helpPanel}>
                  <Text style={styles.helpText}>First-time codes still need one online verification.</Text>
                  <Text style={styles.helpText}>Returning users can continue offline only when code and cached identity match exactly.</Text>
                </View>
              ) : null}
            </Animated.View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  keyboardAvoidingContainer: { flex: 1 },
  scrollContainer: { flexGrow: 1, justifyContent: 'flex-start', paddingTop: SPACING.xs, paddingHorizontal: SPACING.xl, paddingBottom: SPACING.xxl },
  scrollContainerKeyboardVisible: { justifyContent: 'flex-start', paddingBottom: SPACING.lg },
  container: { flexGrow: 1 },
  logoSection: {
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  logoImage: { marginBottom: 2 },
  appTitle: {
    width: '100%',
    fontSize: 32,
    fontWeight: FONT_WEIGHT.extrabold,
    color: COLORS.white,
    letterSpacing: 0.3,
    lineHeight: 38,
    textAlign: 'center',
  },
  appSubtitle: {
    width: '100%',
    marginTop: 2,
    fontSize: 14,
    color: COLORS.lightBlue,
    fontWeight: FONT_WEIGHT.medium,
    textAlign: 'center',
  },
  formCard: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    padding: SPACING.xxl,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.xl,
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: FONT_WEIGHT.extrabold,
    color: COLORS.darkText,
    textAlign: 'center',
  },
  welcomeSubtext: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.subtleText,
  },
  networkPillBase: {
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  networkPillOnline: {
    backgroundColor: COLORS.successSoft,
    borderColor: COLORS.success,
  },
  networkPillOffline: {
    backgroundColor: COLORS.warningSoft,
    borderColor: COLORS.warning,
  },
  networkPillText: {
    fontSize: 12,
    fontWeight: FONT_WEIGHT.semibold,
  },
  hintsRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md },
  hintChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    backgroundColor: COLORS.inputBackground,
  },
  hintChipSelected: {
    borderColor: COLORS.primaryBlue,
    backgroundColor: COLORS.lightBlue,
  },
  hintTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  hintChipLabel: { fontSize: 12, fontWeight: FONT_WEIGHT.bold, color: COLORS.subtleText },
  hintChipLabelSelected: { color: COLORS.primaryBlue },
  hintChipText: {
    fontSize: 11,
    marginTop: SPACING.xs,
    color: COLORS.subtleText,
    lineHeight: 14,
  },
  hintChipTextSelected: { color: COLORS.darkText },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.inputBackground,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.md,
    minHeight: 54,
  },
  inputContainerFocused: {
    borderColor: COLORS.primaryBlue,
    backgroundColor: COLORS.lightBlue,
  },
  inputIcon: { marginLeft: SPACING.md },
  input: {
    flex: 1,
    height: 52,
    paddingHorizontal: SPACING.md,
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: FONT_WEIGHT.semibold,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
    backgroundColor: COLORS.errorSoft,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.errorRed,
    padding: SPACING.sm,
  },
  errorBody: { flex: 1 },
  errorTitle: { color: COLORS.errorRed, fontSize: 14, fontWeight: FONT_WEIGHT.bold },
  errorText: {
    color: COLORS.errorRed,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  recoveryStepText: { color: COLORS.errorRed, fontSize: 12, lineHeight: 16, marginTop: 4 },
  errorActionsContainer: { marginTop: SPACING.sm, gap: SPACING.sm },
  errorActionButton: {
    borderWidth: 1,
    borderColor: COLORS.errorRed,
    borderRadius: RADIUS.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    backgroundColor: COLORS.white,
  },
  errorActionText: { color: COLORS.errorRed, fontSize: 13, fontWeight: FONT_WEIGHT.semibold },
  button: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    ...SHADOWS.lg,
  },
  buttonGradient: {
    minHeight: 54,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  buttonDisabled: { opacity: 0.72 },
  buttonText: { color: COLORS.white, fontSize: 17, fontWeight: FONT_WEIGHT.bold },
  disclosureButton: {
    marginTop: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disclosureButtonCompact: {
    marginTop: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disclosureText: { color: COLORS.primaryBlue, fontSize: 13, fontWeight: FONT_WEIGHT.semibold },
  disclosureErrorText: { color: COLORS.errorRed, fontSize: 13, fontWeight: FONT_WEIGHT.semibold },
  helpPanel: {
    marginTop: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.sm,
    padding: SPACING.sm,
    backgroundColor: COLORS.inputBackground,
  },
  helpText: {
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.subtleText,
    marginBottom: 4,
  },
});
