// screens/LoginScreen.js
import React, { useState, useEffect, useMemo } from 'react';
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
  Dimensions,
  ActivityIndicator,
  Animated,
  Image,
  Alert,
  Linking,
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

const {
  LOGIN_MODE_HINTS,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  getReferencePlaceholder,
  shouldShowEmailField,
  resolveLoginIdentity,
} = require('./loginFlow');

const { height } = Dimensions.get('window');

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
const SUPPORT_SMS = process.env.EXPO_PUBLIC_SUPPORT_SMS?.trim();

const createErrorState = (message, options = {}) => ({
  title: options.title || 'Login issue',
  message,
  reason: options.reason || null,
  showOfflineActions: options.showOfflineActions || false,
  recoverySteps: options.recoverySteps || [],
});

export default function LoginScreen({ onLoginSuccess, logger, isConnected, resolveOfflineLogin }) {
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
  const activeLogger = logger || loggerService;

  const [logoAnimation] = useState(new Animated.Value(0));
  const [formAnimation] = useState(new Animated.Value(0));
  const [buttonAnimation] = useState(new Animated.Value(1));

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
    const trimmedCode = bookingReference.trim().toUpperCase();
    const supportMessage = `Hi LLT Support, I need help logging in${trimmedCode ? ` with code ${trimmedCode}` : ''}.`;

    activeLogger?.trackEvent('offline_login_cta_clicked', {
      cta: 'contact_support',
      reason: errorState?.reason,
      isConnected,
      hasPhone: Boolean(SUPPORT_PHONE),
      hasSms: Boolean(SUPPORT_SMS),
    });

    if (SUPPORT_SMS) {
      const smsUrl = `sms:${SUPPORT_SMS}?body=${encodeURIComponent(supportMessage)}`;
      if (await Linking.canOpenURL(smsUrl)) return Linking.openURL(smsUrl);
    }

    if (SUPPORT_PHONE) {
      const telUrl = `tel:${SUPPORT_PHONE}`;
      if (await Linking.canOpenURL(telUrl)) return Linking.openURL(telUrl);
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
          createErrorState('No internet connection detected yet. Connect to mobile data or Wi-Fi, then tap “I’m connected, verify this code”.', {
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
    setFieldTouched({ bookingReference: true, email: true });
    if (!applyValidation('submit')) return;

    const { trimmedReference, normalizedReference, normalizedEmail } = normalizedInput;

    activeLogger?.info('Login', 'Login attempt started', { hasBookingRef: !!bookingReference, isConnected });

    if (!isConnected) {
      const offlineCheck = await resolveOfflineLogin?.(trimmedReference, normalizedEmail);
      if (offlineCheck?.success) {
        await onLoginSuccess(normalizedReference, offlineCheck.tour, offlineCheck.identity, offlineCheck.type, {
          offlineMode: true,
        });
        return;
      }
      setShowRecoverySteps(false);
      setErrorState(createOfflineErrorState(offlineCheck, createErrorState));
      return;
    }

    animateButton();
    setLoading(true);
    clearErrorState();

    try {
      const result = await validateBookingReference(trimmedReference, normalizedEmail);
      if (result.valid) {
        const loginData = resolveLoginIdentity(result);
        await onLoginSuccess(normalizedReference, result.tour, loginData, result.type);
      } else {
        setSimpleError(result.error || 'Invalid booking reference. Please try again.');
      }
    } catch (error) {
      activeLogger?.error('Login', 'Login error', { error: error.message, bookingRef: maskIdentifier(trimmedReference) });
      setSimpleError('Unable to verify booking. Please check your connection.');
    } finally {
      setLoading(false);
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
        <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
            <Animated.View style={[styles.logoSection, { opacity: logoAnimation }]}> 
              <Image source={require('../assets/images/app-icon-llt.png')} style={styles.logoImage} resizeMode="contain" />
              <Text style={styles.appTitle}>Loch Lomond Travel</Text>
              <Text style={styles.appSubtitle}>Premium journeys, effortless access.</Text>
            </Animated.View>

            <Animated.View style={[styles.formCard, { opacity: formAnimation }]}> 
              <Text style={styles.welcomeText}>Welcome aboard</Text>
              <Text style={styles.welcomeSubtext}>Sign in securely to access your live itinerary, pickup updates, and tour support.</Text>

              <View style={[styles.networkPillBase, networkStateTone.container]}>
                <MaterialCommunityIcons name={networkStateTone.icon} size={16} color={networkStateTone.iconColor} />
                <Text style={[styles.networkPillText, { color: networkStateTone.textColor }]}>{networkStateTone.label}</Text>
              </View>

              <View style={styles.hintsRow}>
                {Object.entries(LOGIN_MODE_HINTS).map(([key, hint]) => {
                  const selected = modeHintFocus === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.hintChip, selected && styles.hintChipSelected]}
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
                        <Text style={[styles.hintChipLabel, selected && styles.hintChipLabelSelected]}>{hint.label}</Text>
                      </View>
                      <Text style={[styles.hintChipText, selected && styles.hintChipTextSelected]}>{hint.hint}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={[styles.inputContainer, activeInput === 'reference' && styles.inputContainerFocused]}>
                <MaterialCommunityIcons name="ticket-confirmation-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={bookingReference}
                  onChangeText={handleReferenceChange}
                  onFocus={() => setActiveInput('reference')}
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
                />
              </View>

              {emailVisible ? (
                <View style={[styles.inputContainer, activeInput === 'email' && styles.inputContainerFocused]}>
                  <MaterialCommunityIcons name="email-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (errorState && !errorState.reason) clearErrorState();
                    }}
                    onFocus={() => setActiveInput('email')}
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
                        <Text style={styles.buttonText}>Verifying...</Text>
                      </View>
                    ) : (
                      <View style={styles.buttonContent}>
                        <Text style={styles.buttonText}>Access My Tour</Text>
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
          </KeyboardAvoidingView>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  scrollContainer: { flexGrow: 1 },
  container: { flex: 1, paddingHorizontal: SPACING.xl, paddingBottom: SPACING.xxl },
  logoSection: {
    alignItems: 'center',
    marginTop: height * 0.065,
    marginBottom: SPACING.lg,
  },
  logoImage: { width: 240, height: 94, marginBottom: SPACING.xs },
  appTitle: {
    fontSize: 32,
    fontWeight: FONT_WEIGHT.extrabold,
    color: COLORS.white,
    letterSpacing: 0.3,
  },
  appSubtitle: {
    marginTop: SPACING.xs,
    fontSize: 14,
    color: COLORS.lightBlue,
    fontWeight: FONT_WEIGHT.medium,
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
