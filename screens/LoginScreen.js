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

const { width, height } = Dimensions.get('window');

const COLORS = {
  primaryBlue: '#0B5ED7',
  secondaryBlue: '#0A3E8C',
  lightBlue: '#E6F0FF',
  white: '#FFFFFF',
  errorRed: '#EF4444',
  darkText: '#0F172A',
  lightBlueAccent: '#C7DBFF',
  inputBackground: '#F8FAFC',
  placeholderText: '#94A3B8',
  border: '#E2E8F0',
  subtleText: '#475569',
};

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
                Enter your booking reference or driver code to access your tour.
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
    backgroundColor: COLORS.lightBlue,
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
