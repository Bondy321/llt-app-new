// screens/LoginScreen.js
import React, { useState, useEffect } from 'react';
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
  Linking
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS as THEME_COLORS } from '../theme';
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
  darkText: THEME_COLORS.textPrimary,
  inputBackground: THEME_COLORS.background,
  placeholderText: THEME_COLORS.textMuted,
  border: THEME_COLORS.border,
  subtleText: THEME_COLORS.textSecondary,
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
  const activeLogger = logger || loggerService;

  const clearErrorState = () => setErrorState(null);
  const setSimpleError = (message) => setErrorState(createErrorState(message));

  const normalizedInput = normalizeLoginFields({ bookingReference, email });
  const emailVisible = shouldShowEmailField({
    modeHintFocus,
    normalizedReference: normalizedInput.normalizedReference,
  });

  useEffect(() => {
    Animated.sequence([
      Animated.timing(logoAnimation, { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.timing(formAnimation, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]).start();

    activeLogger?.trackScreen('Login');
  }, []);

  const [logoAnimation] = useState(new Animated.Value(0));
  const [formAnimation] = useState(new Animated.Value(0));
  const [buttonAnimation] = useState(new Animated.Value(1));

  const animateButton = () => {
    Animated.sequence([
      Animated.timing(buttonAnimation, { toValue: 0.95, duration: 100, useNativeDriver: true }),
      Animated.timing(buttonAnimation, { toValue: 1, duration: 100, useNativeDriver: true }),
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

    Alert.alert('Support contact unavailable', 'Support contact details are not configured on this build. Please email support@lochlomondtravel.com for assistance.');
  };

  const handleOfflineCtaPress = async (cta) => {
    activeLogger?.trackEvent('offline_login_cta_clicked', { cta, reason: errorState?.reason, isConnected });

    if (cta === 'retry_now') return handleLogin();
    if (cta === 'verify_online') {
      if (!isConnected) {
        setErrorState(createErrorState('No internet connection detected yet. Connect to mobile data or Wi-Fi, then tap “I’m connected, verify this code”.', {
          title: 'Still offline',
          reason: errorState?.reason,
          showOfflineActions: true,
        }));
        return;
      }
      return handleLogin();
    }

    if (cta === 'contact_support') return handleContactSupport();
  };

  const handleLogin = async () => {
    setFieldTouched({ bookingReference: true, email: true });
    if (!applyValidation('submit')) return;

    const {
      trimmedReference,
      normalizedReference,
      normalizedEmail,
    } = normalizedInput;

    activeLogger?.info('Login', 'Login attempt started', { hasBookingRef: !!bookingReference, isConnected });

    if (!isConnected) {
      const offlineCheck = await resolveOfflineLogin?.(trimmedReference, normalizedEmail);
      if (offlineCheck?.success) {
        await onLoginSuccess(normalizedReference, offlineCheck.tour, offlineCheck.identity, offlineCheck.type, { offlineMode: true });
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

  return (
    <LinearGradient colors={[COLORS.primaryBlue, COLORS.secondaryBlue]} style={styles.gradient}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
            <Animated.View style={[styles.logoSection, { opacity: logoAnimation }]}>
              <Image source={require('../assets/images/app-icon-llt.png')} style={styles.logoImage} resizeMode="contain" />
              <Text style={styles.appTitle}>Loch Lomond Travel</Text>
            </Animated.View>

            <Animated.View style={[styles.formCard, { opacity: formAnimation }]}> 
              <Text style={styles.welcomeText}>Welcome Aboard</Text>

              <View style={styles.hintsRow}>
                {Object.entries(LOGIN_MODE_HINTS).map(([key, hint]) => {
                  const selected = modeHintFocus === key;
                  return (
                    <TouchableOpacity key={key} style={[styles.hintChip, selected && styles.hintChipSelected]} onPress={() => setModeHintFocus(key)}>
                      <Text style={[styles.hintChipLabel, selected && styles.hintChipLabelSelected]}>{hint.label}</Text>
                      <Text style={[styles.hintChipText, selected && styles.hintChipTextSelected]}>{hint.hint}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.inputContainer}>
                <MaterialCommunityIcons name="ticket-confirmation-outline" size={24} color={COLORS.primaryBlue} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={bookingReference}
                  onChangeText={handleReferenceChange}
                  onBlur={() => setFieldTouched((current) => ({ ...current, bookingReference: true }))}
                  placeholder={getReferencePlaceholder(modeHintFocus)}
                  placeholderTextColor={COLORS.placeholderText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={20}
                  returnKeyType="go"
                  onSubmitEditing={handleLogin}
                  editable={!loading}
                />
              </View>

              {emailVisible ? (
                <View style={styles.inputContainer}>
                  <MaterialCommunityIcons name="email-outline" size={24} color={COLORS.primaryBlue} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (errorState && !errorState.reason) clearErrorState();
                    }}
                    onBlur={handleEmailBlur}
                    placeholder="Booking email"
                    placeholderTextColor={COLORS.placeholderText}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
                    editable={!loading}
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
                      <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowRecoverySteps((current) => !current)}>
                        <Text style={styles.disclosureText}>How to recover</Text>
                        <MaterialCommunityIcons name={showRecoverySteps ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.errorRed} />
                      </TouchableOpacity>
                    ) : null}
                    {showRecoverySteps ? errorState.recoverySteps.map((step) => (
                      <Text key={step} style={styles.recoveryStepText}>• {step}</Text>
                    )) : null}
                    {errorState.showOfflineActions ? (
                      <View style={styles.errorActionsContainer}>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('retry_now')} disabled={loading}><Text style={styles.errorActionText}>Retry now</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('verify_online')} disabled={loading}><Text style={styles.errorActionText}>I’m connected, verify this code</Text></TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : null}

              <Animated.View style={{ transform: [{ scale: buttonAnimation }] }}>
                <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleLogin} activeOpacity={0.8} disabled={loading}>
                  {loading ? <ActivityIndicator size="small" color={COLORS.white} /> : <Text style={styles.buttonText}>Access My Tour</Text>}
                </TouchableOpacity>
              </Animated.View>

              <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowPrimaryHelp((current) => !current)}>
                <Text style={styles.disclosureText}>Sign-in help</Text>
                <MaterialCommunityIcons name={showPrimaryHelp ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.primaryBlue} />
              </TouchableOpacity>

              {showPrimaryHelp ? (
                <View style={styles.helpPanel}>
                  <Text style={styles.helpText}>Passengers sign in with booking reference + booking email. Drivers sign in with a D- code. Mode is auto-detected when you submit.</Text>
                  <Text style={styles.helpText}>Offline sign-in only works for identities already verified on this device.</Text>
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
  container: { flex: 1, paddingHorizontal: 20 },
  logoSection: { alignItems: 'center', marginTop: height * 0.08, marginBottom: 20 },
  logoImage: { width: 220, height: 90, marginBottom: 10 },
  appTitle: { fontSize: 32, fontWeight: 'bold', color: COLORS.white },
  formCard: { backgroundColor: COLORS.white, borderRadius: 24, padding: 24, borderWidth: 1, borderColor: COLORS.border },
  welcomeText: { fontSize: 22, fontWeight: 'bold', color: COLORS.darkText, textAlign: 'center', marginBottom: 14 },
  hintsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  hintChip: { flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, padding: 10, backgroundColor: COLORS.inputBackground },
  hintChipSelected: { borderColor: COLORS.primaryBlue },
  hintChipLabel: { fontSize: 12, fontWeight: '700', color: COLORS.subtleText },
  hintChipLabelSelected: { color: COLORS.primaryBlue },
  hintChipText: { fontSize: 11, marginTop: 4, color: COLORS.subtleText },
  hintChipTextSelected: { color: COLORS.darkText },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.inputBackground, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, marginBottom: 12 },
  inputIcon: { marginLeft: 14 },
  input: { flex: 1, height: 52, paddingHorizontal: 14, fontSize: 16, color: COLORS.darkText, fontWeight: '600' },
  errorContainer: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12, gap: 6 },
  errorBody: { flex: 1 },
  errorTitle: { color: COLORS.errorRed, fontSize: 14, fontWeight: '700' },
  errorText: { color: COLORS.errorRed, fontSize: 13, lineHeight: 18, marginTop: 2 },
  recoveryStepText: { color: COLORS.errorRed, fontSize: 12, lineHeight: 16, marginTop: 4 },
  errorActionsContainer: { marginTop: 10, gap: 8 },
  errorActionButton: { borderWidth: 1, borderColor: COLORS.errorRed, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10 },
  errorActionText: { color: COLORS.errorRed, fontSize: 13, fontWeight: '600' },
  button: { backgroundColor: COLORS.primaryBlue, borderRadius: 14, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: COLORS.white, fontSize: 18, fontWeight: 'bold' },
  disclosureButton: { marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  disclosureText: { color: COLORS.primaryBlue, fontSize: 13, fontWeight: '600' },
  helpPanel: { marginTop: 8, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 10, backgroundColor: COLORS.inputBackground },
  helpText: { fontSize: 12, lineHeight: 17, color: COLORS.subtleText, marginBottom: 4 },
});
