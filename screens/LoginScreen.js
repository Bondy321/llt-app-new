// screens/LoginScreen.js
import { useState, useEffect, useMemo, useRef } from 'react';
import { validateBookingReference } from '../services/bookingServiceRealtime';
import { Alert, Animated, Keyboard, Linking } from 'react-native';
import loggerService, { maskIdentifier } from '../services/loggerService';
import { recordBreadcrumb as recordCrashBreadcrumb } from '../services/crashDiagnosticsService';

const {
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  shouldShowEmailField,
  resolveLoginIdentity,
} = require('./loginFlow');
const loginDiagnostics = require('../services/loginDiagnosticsService');

import { COLORS } from '../src/features/auth/presentation/loginPresentationTheme';
import styles from '../src/features/auth/presentation/loginScreenStyles';
import useLoginResponsiveLayout from '../src/features/auth/presentation/useLoginResponsiveLayout';
import LoginScreenView from '../src/features/auth/presentation/LoginScreenView';

const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE?.trim();
const getNetInfoModule = () => {
  try {
    const netInfoModule = require('@react-native-community/netinfo');
    return netInfoModule.default || netInfoModule;
  } catch (_error) {
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

export default function LoginScreen({ onLoginSuccess, logger, isConnected, resolveOfflineLogin, onManageFutureTourAlerts }) {
  const { height, logoHeight, logoWidth, responsiveStyles } = useLoginResponsiveLayout();
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
  }, [activeLogger, formAnimation, logoAnimation]);

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
          appSession: offlineCheck.appSession || null,
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
          appSession: result.session || null,
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
    <LoginScreenView
      activeInput={activeInput}
      bookingReference={bookingReference}
      buttonAnimation={buttonAnimation}
      clearErrorState={clearErrorState}
      email={email}
      emailVisible={emailVisible}
      errorState={errorState}
      formAnimation={formAnimation}
      handleEmailBlur={handleEmailBlur}
      handleLogin={handleLogin}
      handleOfflineCtaPress={handleOfflineCtaPress}
      handleReferenceChange={handleReferenceChange}
      height={height}
      isKeyboardVisible={isKeyboardVisible}
      isSubmitDisabled={isSubmitDisabled}
      loading={loading}
      logoAnimation={logoAnimation}
      logoHeight={logoHeight}
      logoWidth={logoWidth}
      modeHintFocus={modeHintFocus}
      networkStateTone={networkStateTone}
      onManageFutureTourAlerts={onManageFutureTourAlerts}
      responsiveStyles={responsiveStyles}
      scrollRef={scrollRef}
      setActiveInput={setActiveInput}
      setEmail={setEmail}
      setFieldTouched={setFieldTouched}
      setModeHintFocus={setModeHintFocus}
      setShowOfflineHelp={setShowOfflineHelp}
      setShowPrimaryHelp={setShowPrimaryHelp}
      setShowRecoverySteps={setShowRecoverySteps}
      showOfflineHelp={showOfflineHelp}
      showPrimaryHelp={showPrimaryHelp}
      showRecoverySteps={showRecoverySteps}
    />
  );
}
