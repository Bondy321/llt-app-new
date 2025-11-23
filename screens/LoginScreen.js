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
  primaryBlue: '#007DC3',
  secondaryBlue: '#005a8f',
  lightBlue: '#E8F2FF',
  white: '#FFFFFF',
  errorRed: '#FF4444',
  darkText: '#333333',
  lightBlueAccent: '#B8D4FF',
  inputBackground: '#F7FAFC',
  placeholderText: '#A0AEC0',
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
        logger?.info('Login', 'Login successful', {
          bookingRef: bookingReference.trim().toUpperCase(),
          tourCode: result.tour.tourCode,
          duration
        });
        
        await onLoginSuccess(
          bookingReference.trim().toUpperCase(), 
          result.tour, 
          result.booking
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
              <View style={styles.logoContainer}>
                <MaterialCommunityIcons 
                  name="bus-side" 
                  size={80} 
                  color={COLORS.white} 
                />
              </View>
              <Text style={styles.appTitle}>Loch Lomond Travel</Text>
              <Text style={styles.appSubtitle}>Your Highland Adventure Companion</Text>
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
                  placeholder="e.g. T114737"
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
                  name="help-circle-outline" 
                  size={16} 
                  color={COLORS.darkText} 
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
                      color={COLORS.white} 
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
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  logoSection: {
    alignItems: 'center',
    marginTop: height * 0.08,
    marginBottom: 30,
  },
  logoContainer: {
    width: 120,
    height: 120,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  appTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: COLORS.white,
    marginBottom: 8,
  },
  appSubtitle: {
    fontSize: 16,
    color: COLORS.white,
    opacity: 0.9,
  },
  formCard: {
    backgroundColor: COLORS.white,
    borderRadius: 20,
    padding: 30,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 10,
    },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.darkText,
    textAlign: 'center',
    marginBottom: 8,
  },
  instructionText: {
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.7,
    textAlign: 'center',
    marginBottom: 30,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.inputBackground,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.lightBlueAccent,
    marginBottom: 20,
  },
  inputIcon: {
    marginLeft: 15,
  },
  input: {
    flex: 1,
    height: 56,
    paddingHorizontal: 15,
    fontSize: 18,
    color: COLORS.darkText,
    fontWeight: '600',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
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
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primaryBlue,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
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
    alignItems: 'flex-start',
    marginTop: 25,
    paddingTop: 25,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  helpIcon: {
    marginTop: 2,
  },
  helpText: {
    fontSize: 13,
    color: COLORS.darkText,
    opacity: 0.6,
    marginLeft: 8,
    flex: 1,
    lineHeight: 18,
    textAlign: 'center',
  },
  featuresContainer: {
    marginTop: 40,
    marginBottom: 30,
  },
  featuresTitle: {
    fontSize: 14,
    color: COLORS.white,
    opacity: 0.9,
    textAlign: 'center',
    marginBottom: 15,
  },
  featuresList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 20,
    margin: 5,
  },
  featureText: {
    color: COLORS.white,
    fontSize: 14,
    marginLeft: 6,
  },
});