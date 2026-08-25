import {
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { LinearGradient } from 'expo-linear-gradient';
import { FONT_SCALE_LIMITS } from '../../../../utils/responsiveLayout';
import { COLORS } from './loginPresentationTheme';
import styles from './loginScreenStyles';
import { LoginActions, LoginCredentialFields, LoginErrorPanel } from './LoginFormSections';

export default function LoginScreenView({
  activeInput,
  bookingReference,
  buttonAnimation,
  clearErrorState,
  email,
  emailVisible,
  errorState,
  formAnimation,
  handleEmailBlur,
  handleLogin,
  handleOfflineCtaPress,
  handleReferenceChange,
  height,
  isKeyboardVisible,
  isSubmitDisabled,
  loading,
  logoAnimation,
  logoHeight,
  logoWidth,
  modeHintFocus,
  networkStateTone,
  responsiveStyles,
  scrollRef,
  setActiveInput,
  setEmail,
  setFieldTouched,
  setModeHintFocus,
  setShowOfflineHelp,
  setShowPrimaryHelp,
  setShowRecoverySteps,
  showOfflineHelp,
  showPrimaryHelp,
  showRecoverySteps,
}) {
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
                  source={require('../../../../assets/images/app-logo-llt-cropped.png')}
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

              <LoginCredentialFields
                {...{ activeInput, bookingReference, clearErrorState, email, emailVisible, errorState, handleEmailBlur, handleLogin, handleReferenceChange, height, loading, modeHintFocus, responsiveStyles, scrollRef, setActiveInput, setEmail, setFieldTouched, setModeHintFocus }}
              />
              <LoginErrorPanel {...{ errorState, handleOfflineCtaPress, loading, setShowRecoverySteps, showRecoverySteps }} />
              <LoginActions {...{ buttonAnimation, handleLogin, isSubmitDisabled, loading, responsiveStyles, setShowOfflineHelp, setShowPrimaryHelp, showOfflineHelp, showPrimaryHelp }} />
            </Animated.View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}
