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
  Image
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS as THEME_COLORS } from '../theme';

const { width, height } = Dimensions.get('window');

const COLORS = {
  primaryBlue: THEME_COLORS.primary,
  secondaryBlue: THEME_COLORS.primaryDark,
  lightBlue: THEME_COLORS.primaryMuted,
  white: THEME_COLORS.white,
  errorRed: THEME_COLORS.error,
  darkText: THEME_COLORS.textPrimary,
  lightBlueAccent: '#93C5FD',
  inputBackground: THEME_COLORS.background,
  placeholderText: THEME_COLORS.textMuted,
  border: THEME_COLORS.border,
  subtleText: THEME_COLORS.textSecondary,
};

const OFFLINE_LOGIN_REASON_COPY = {
  NO_CACHED_SESSION: 'This code is valid online but hasn’t been used on this device yet. Reconnect briefly once to verify, then offline mode will work next time.',
  CODE_MISMATCH: 'This code is valid online but hasn’t been used on this device yet. Reconnect briefly once to verify, then offline mode will work next time.',
  CACHE_EXPIRED: 'Your offline trip cache has expired. Reconnect briefly once to verify, then offline mode will work next time.',
};

export default function LoginScreen({ onLoginSuccess, logger, isConnected, resolveOfflineLogin }) {
  const [bookingReference, setBookingReference] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showOfflineHelp, setShowOfflineHelp] = useState(false);
  
  // Animations
  const [logoAnimation] = useState(new Animated.Value(0));
  const [formAnimation] = useState(new Animated.Value(0));
  const [buttonAnimation] = useState(new Animated.Value(1));

  useEffect(() => {
    // Animate logo and form on mount
    Animated.sequence([
      Animated.timing(logoAnimation, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.timing(formAnimation, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();
    
    logger?.trackScreen('Login');
  }, []);

  const animateButton = () => {
    Animated.sequence([
      Animated.timing(buttonAnimation, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(buttonAnimation, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleLogin = async () => {
    logger?.info('Login', 'Login attempt started', { 
      hasBookingRef: !!bookingReference,
      isConnected 
    });
    
    if (bookingReference.trim() === '') {
      setError('Please enter your Booking Reference.');
      logger?.warn('Login', 'Empty booking reference submitted');
      return;
    }

    if (!isConnected) {
      const offlineCheck = await resolveOfflineLogin?.(bookingReference.trim());
      if (offlineCheck?.success) {
        logger?.info('Login', 'Offline login fallback accepted', {
          ref: bookingReference.trim().toUpperCase(),
          type: offlineCheck.type,
          source: offlineCheck.source,
        });
        await onLoginSuccess(
          bookingReference.trim().toUpperCase(),
          offlineCheck.tour,
          offlineCheck.identity,
          offlineCheck.type,
          { offlineMode: true }
        );
        return;
      }

      logger?.warn('Login', 'Offline login fallback rejected', {
        ref: bookingReference.trim().toUpperCase(),
        reason: offlineCheck?.reason || offlineCheck?.error,
      });
      const reason = offlineCheck?.reason;
      setError(OFFLINE_LOGIN_REASON_COPY[reason] || offlineCheck?.error || 'No cached trip found for this code; reconnect once to verify.');
      return;
    }

    animateButton();
    setLoading(true);
    setError('');

    try {
      const startTime = Date.now();
      const result = await validateBookingReference(bookingReference.trim());
      const duration = Date.now() - startTime;
      
      logger?.trackAPI('/validateBooking', 'POST', result.valid ? 200 : 404, duration);
      
      if (result.valid) {
        // Pass either booking data OR driver data, and the login type
        const loginData = result.type === 'driver' ? result.driver : result.booking;
        
        logger?.info('Login', 'Login successful', {
          ref: bookingReference.trim().toUpperCase(),
          type: result.type,
          duration
        });
        
        await onLoginSuccess(
          bookingReference.trim().toUpperCase(), 
          result.tour, 
          loginData,
          result.type // Pass 'passenger' or 'driver'
        );
      } else {
        logger?.warn('Login', 'Invalid booking reference', {
          bookingRef: bookingReference.trim(),
          error: result.error
        });
        
        setError(result.error || 'Invalid booking reference. Please try again.');
      }
    } catch (error) {
      logger?.error('Login', 'Login error', {
        error: error.message,
        bookingRef: bookingReference.trim()
      });
      
      setError('Unable to verify booking. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient
      colors={[COLORS.primaryBlue, COLORS.secondaryBlue]}
      style={styles.gradient}
    >
      <SafeAreaView style={styles.safeArea}>
        <ScrollView 
          contentContainerStyle={styles.scrollContainer}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <KeyboardAvoidingView 
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
          >
            {/* Logo Section */}
            <Animated.View 
              style={[
                styles.logoSection,
                {
                  opacity: logoAnimation,
                  transform: [{
                    translateY: logoAnimation.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-30, 0],
                    }),
                  }],
                },
              ]}
            >
              <Image
                source={require('../assets/images/app-icon-llt.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
              <Text style={styles.appTitle}>Loch Lomond Travel</Text>
              <Text style={styles.appSubtitle}>Functional comfort with a refined finish</Text>
            </Animated.View>

            {/* Form Section */}
            <Animated.View 
              style={[
                styles.formCard,
                {
                  opacity: formAnimation,
                  transform: [{
                    translateY: formAnimation.interpolate({
                      inputRange: [0, 1],
                      outputRange: [30, 0],
                    }),
                  }],
                },
              ]}
            >
              <Text style={styles.welcomeText}>Welcome Aboard</Text>
              <Text style={styles.instructionText}>
                Enter your booking reference or driver code to access your tour. Returning travellers can continue offline using previously synced trip data.
              </Text>
              
              <View style={styles.inputContainer}>
                <MaterialCommunityIcons 
                  name="ticket-confirmation-outline" 
                  size={24} 
                  color={COLORS.primaryBlue} 
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  value={bookingReference}
                  onChangeText={(text) => {
                    setBookingReference(text);
                    if (error) setError('');
                  }}
                  placeholder="Ref (e.g. T114737 or Driver ID)"
                  placeholderTextColor={COLORS.placeholderText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={20}
                  returnKeyType="go"
                  onSubmitEditing={handleLogin}
                  editable={!loading}
                />
              </View>
              
              {error ? (
                <View style={styles.errorContainer}>
                  <MaterialCommunityIcons 
                    name="alert-circle" 
                    size={16} 
                    color={COLORS.errorRed} 
                  />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
              
              <Animated.View style={{ transform: [{ scale: buttonAnimation }] }}>
                <TouchableOpacity 
                  style={[styles.button, loading && styles.buttonDisabled]} 
                  onPress={handleLogin} 
                  activeOpacity={0.8}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color={COLORS.white} />
                  ) : (
                    <>
                      <Text style={styles.buttonText}>Access My Tour</Text>
                      <MaterialCommunityIcons 
                        name="arrow-right" 
                        size={20} 
                        color={COLORS.white} 
                        style={styles.buttonIcon}
                      />
                    </>
                  )}
                </TouchableOpacity>
              </Animated.View>
              
              <View style={styles.offlineInfoContainer}>
                <MaterialCommunityIcons
                  name="cloud-sync-outline"
                  size={16}
                  color={COLORS.subtleText}
                />
                <Text style={styles.offlineInfoText}>
                  If you're offline, we'll let you in when this code matches your cached trip. First-time codes still require one online check.
                </Text>
              </View>

              <TouchableOpacity
                style={styles.offlineHelpLink}
                onPress={() => setShowOfflineHelp((current) => !current)}
                activeOpacity={0.8}
              >
                <MaterialCommunityIcons
                  name={showOfflineHelp ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={COLORS.primaryBlue}
                />
                <Text style={styles.offlineHelpLinkText}>Why can’t I log in offline?</Text>
              </TouchableOpacity>

              {showOfflineHelp ? (
                <View style={styles.offlineHelpPanel}>
                  <Text style={styles.offlineHelpText}>
                    Offline login only works after this exact code has been verified online on this device.
                  </Text>
                  <Text style={styles.offlineHelpText}>
                    This code is valid online but hasn’t been used on this device yet.
                  </Text>
                  <Text style={styles.offlineHelpText}>
                    Reconnect briefly once to verify, then offline mode will work next time.
                  </Text>
                </View>
              ) : null}

              <View style={styles.helpSection}>
                <MaterialCommunityIcons 
                  name="information-outline" 
                  size={18} 
                  color={COLORS.primaryBlue} 
                  style={styles.helpIcon}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.helpTitle}>Need help?</Text>
                  <Text style={styles.helpText}>
                    Check your confirmation email or contact support@lochlomondtravel.com
                  </Text>
                </View>
              </View>
            </Animated.View>

            {/* Features Preview */}
            <View style={styles.featuresContainer}>
              <Text style={styles.featuresTitle}>Your trip toolkit</Text>
              <View style={styles.featuresList}>
                {[
                  { icon: 'chat-processing', text: 'Group chat & updates' },
                  { icon: 'image-multiple', text: 'Photo sharing' },
                  { icon: 'map-marker-radius', text: 'Pickup guidance' },
                  { icon: 'shield-check', text: 'Safety & support' },
                ].map((feature, index) => (
                  <View key={index} style={styles.featureItem}>
                    <MaterialCommunityIcons 
                      name={feature.icon} 
                      size={20} 
                      color={COLORS.darkText} 
                    />
                    <Text style={styles.featureText}>{feature.text}</Text>
                  </View>
                ))}
              </View>
            </View>
          </KeyboardAvoidingView>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  scrollContainer: {
    flexGrow: 1,
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  logoSection: {
    alignItems: 'center',
    marginTop: height * 0.07,
    marginBottom: 24,
  },
  logoImage: {
    width: 220,
    height: 90,
    marginBottom: 16,
  },
  appTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: COLORS.white,
    marginBottom: 8,
  },
  appSubtitle: {
    fontSize: 15,
    color: COLORS.lightBlue,
    opacity: 0.95,
  },
  formCard: {
    backgroundColor: COLORS.white,
    borderRadius: 24,
    padding: 28,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 10,
    },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.darkText,
    textAlign: 'center',
    marginBottom: 12,
  },
  instructionText: {
    fontSize: 16,
    color: COLORS.subtleText,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.inputBackground,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 18,
  },
  inputIcon: {
    marginLeft: 14,
  },
  input: {
    flex: 1,
    height: 54,
    paddingHorizontal: 14,
    fontSize: 17,
    color: COLORS.darkText,
    fontWeight: '600',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 5,
  },
  errorText: {
    color: COLORS.errorRed,
    fontSize: 14,
    marginLeft: 5,
    flex: 1,
  },
  button: {
    backgroundColor: COLORS.primaryBlue,
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primaryBlue,
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: 'bold',
  },
  buttonIcon: {
    marginLeft: 8,
  },
  offlineInfoContainer: {
    marginTop: 14,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  offlineInfoText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.subtleText,
  },
  offlineHelpLink: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  offlineHelpLinkText: {
    color: COLORS.primaryBlue,
    fontSize: 13,
    fontWeight: '600',
  },
  offlineHelpPanel: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: COLORS.inputBackground,
  },
  offlineHelpText: {
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.subtleText,
    marginBottom: 4,
  },
  helpSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 22,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  helpIcon: {
    marginRight: 10,
  },
  helpTitle: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '700',
    marginBottom: 4,
  },
  helpText: {
    fontSize: 13,
    color: COLORS.subtleText,
    flex: 1,
    lineHeight: 18,
  },
  featuresContainer: {
    marginTop: 34,
    marginBottom: 26,
  },
  featuresTitle: {
    fontSize: 15,
    color: COLORS.white,
    opacity: 0.95,
    textAlign: 'center',
    marginBottom: 12,
    fontWeight: '700',
  },
  featuresList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    margin: 6,
    borderWidth: 1,
    borderColor: COLORS.lightBlueAccent,
    gap: 8,
  },
  featureText: {
    color: COLORS.darkText,
    fontSize: 14,
    fontWeight: '600',
  },
});
