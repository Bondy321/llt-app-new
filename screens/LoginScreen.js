// screens/LoginScreen.js
import React, { useState, useEffect } from 'react';
import { validateBookingReference } from '../services/bookingServiceRealtime';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  ActivityIndicator,
  Animated,
  Image
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing, radius, shadows, text as textStyles } from '../theme';

const { width, height } = Dimensions.get('window');

const palette = colors;

export default function LoginScreen({ onLoginSuccess, logger, isConnected }) {
  const [bookingReference, setBookingReference] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
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
    
    if (!isConnected) {
      setError('No internet connection. Please check your network and try again.');
      return;
    }
    
    if (bookingReference.trim() === '') {
      setError('Please enter your Booking Reference.');
      logger?.warn('Login', 'Empty booking reference submitted');
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
      colors={[palette.primary, '#0F3FBF']}
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
              <Text style={styles.appSubtitle}>The UK's Fastest Growing Coach Tour Operator</Text>
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
              <Text style={styles.welcomeText}>Welcome Aboard!</Text>
              <Text style={styles.instructionText}>
                Enter your booking reference to access your tour
              </Text>
              
              <View style={styles.inputContainer}>
                <MaterialCommunityIcons 
                  name="ticket-confirmation-outline" 
                  size={24} 
                  color={palette.primary} 
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
                  placeholderTextColor={palette.muted}
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
                    color={palette.danger} 
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
                    <ActivityIndicator size="small" color={palette.surface} />
                  ) : (
                    <>
                      <Text style={styles.buttonText}>Access My Tour</Text>
                      <MaterialCommunityIcons 
                        name="arrow-right" 
                        size={20} 
                        color={palette.surface} 
                        style={styles.buttonIcon}
                      />
                    </>
                  )}
                </TouchableOpacity>
              </Animated.View>
              
              <View style={styles.helpSection}>
                <MaterialCommunityIcons 
                  name="help-circle-outline" 
                  size={16} 
                  color={palette.steel} 
                  style={styles.helpIcon}
                />
                <Text style={styles.helpText}>
                  Can't find your booking reference?{'\n'}
                  Check your confirmation email or contact{'\n'}
                  support@lochlomondtravel.com
                </Text>
              </View>
            </Animated.View>

            {/* Features Preview */}
            <View style={styles.featuresContainer}>
              <Text style={styles.featuresTitle}>What's included in your tour app:</Text>
              <View style={styles.featuresList}>
                {[
                  { icon: 'image-multiple', text: 'Photo sharing' },
                  { icon: 'chat-processing', text: 'Group chat' },
                  { icon: 'map-legend', text: 'Tour itinerary' },
                  { icon: 'map-marker', text: 'Live tracking' },
                ].map((feature, index) => (
                  <View key={index} style={styles.featureItem}>
                    <MaterialCommunityIcons 
                      name={feature.icon} 
                      size={20} 
                      color={palette.surface} 
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
  },
  scrollContainer: {
    flexGrow: 1,
    paddingBottom: spacing.xl,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  logoSection: {
    alignItems: 'center',
    marginTop: height * 0.06,
    marginBottom: spacing.lg,
  },
  logoImage: {
    width: 200,
    height: 90,
    marginBottom: spacing.sm,
  },
  appTitle: {
    ...textStyles.heading,
    color: palette.surface,
    letterSpacing: 0.3,
  },
  appSubtitle: {
    ...textStyles.body,
    color: palette.surface,
    opacity: 0.9,
  },
  formCard: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: palette.primaryMuted,
    ...shadows.soft,
  },
  welcomeText: {
    ...textStyles.heading,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  instructionText: {
    ...textStyles.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
    color: palette.steel,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.cardSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
    ...shadows.subtle,
  },
  inputIcon: {
    marginLeft: spacing.xs,
    color: palette.primary,
  },
  input: {
    flex: 1,
    height: 52,
    paddingHorizontal: spacing.sm,
    fontSize: 18,
    color: palette.ink,
    fontWeight: '700',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  errorText: {
    color: palette.danger,
    fontSize: 14,
    marginLeft: spacing.xs,
    flex: 1,
  },
  button: {
    backgroundColor: palette.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    ...shadows.soft,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: palette.surface,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  buttonIcon: {
    marginLeft: spacing.xs,
  },
  helpSection: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: palette.border,
  },
  helpIcon: {
    marginTop: 2,
    color: palette.steel,
  },
  helpText: {
    ...textStyles.caption,
    color: palette.steel,
    marginLeft: spacing.xs,
    flex: 1,
    lineHeight: 18,
    textAlign: 'center',
  },
  featuresContainer: {
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  featuresTitle: {
    ...textStyles.body,
    color: palette.surface,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  featuresList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    margin: 6,
  },
  featureText: {
    color: palette.surface,
    fontSize: 14,
    marginLeft: spacing.xs,
  },
});
