import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, Text, StyleSheet, AppState } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';

// Import Firebase services
import { auth, authHelpers, updateNetworkState } from './firebase';
import { joinTour } from './services/bookingServiceRealtime';
import logger from './services/loggerService';

// Import Screens
import LoginScreen from './screens/LoginScreen';
import TourHomeScreen from './screens/TourHomeScreen';
import PhotobookScreen from './screens/PhotobookScreen';
import GroupPhotobookScreen from './screens/GroupPhotobookScreen';
import ItineraryScreen from './screens/ItineraryScreen';
import ChatScreen from './screens/ChatScreen';
import MapScreen from './screens/MapScreen';

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  lightBlueAccent: '#AECAEC',
  white: '#FFFFFF',
  darkText: '#1A202C',
  errorRed: '#E53E3E',
  appBackground: '#F0F4F8',
};

// Session management keys
const SESSION_KEYS = {
  TOUR_DATA: '@LLT:tourData',
  BOOKING_DATA: '@LLT:bookingData',
  LAST_SCREEN: '@LLT:lastScreen',
};

const createSessionStorage = () => {
  try {
    const asyncStorageModule = require('@react-native-async-storage/async-storage').default;

    if (!asyncStorageModule) {
      throw new Error('AsyncStorage module is undefined');
    }

    return {
      storage: asyncStorageModule,
      mode: 'asyncStorage',
      enabled: true
    };
  } catch (asyncStorageError) {
    console.warn('AsyncStorage unavailable; attempting SecureStore fallback.', asyncStorageError);

    if (SecureStore?.getItemAsync) {
      const secureStoreAdapter = {
        async multiGet(keys) {
          const entries = await Promise.all(
            keys.map(async (key) => [key, await SecureStore.getItemAsync(key)])
          );

          return entries;
        },
        async multiSet(entries) {
          await Promise.all(entries.map(([key, value]) => SecureStore.setItemAsync(key, value)));
        },
        async multiRemove(keys) {
          await Promise.all(keys.map((key) => SecureStore.deleteItemAsync(key)));
        }
      };

      return {
        storage: secureStoreAdapter,
        mode: 'secureStore',
        enabled: true
      };
    }

    console.warn('SecureStore fallback unavailable; session persistence will be disabled.');

    const mockStorage = {
      async multiGet() {
        return [];
      },
      async multiSet() {},
      async multiRemove() {}
    };

    return {
      storage: mockStorage,
      mode: 'disabled',
      enabled: false
    };
  }
};

const { storage: SessionStorage, mode: storageMode, enabled: isSessionPersistenceEnabled } = createSessionStorage();
let persistenceWarningLogged = false;

const logPersistenceWarning = (action) => {
  if (isSessionPersistenceEnabled || persistenceWarningLogged) {
    return;
  }

  const message = `Skipping session ${action}: persistent storage unavailable (${storageMode}).`;
  console.warn(message);
  logger.warn('Session', message, { storageMode });
  persistenceWarningLogged = true;
};

export default function App() {
  // Auth State
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  // Navigation State
  const [currentScreen, setCurrentScreen] = useState('Login');
  const [tourCode, setTourCode] = useState('');
  const [tourData, setTourData] = useState(null);
  const [bookingData, setBookingData] = useState(null);

  // App State
  const [appState, setAppState] = useState(AppState.currentState);
  const [isConnected, setIsConnected] = useState(true);

  // Initialize app
  useEffect(() => {
    logger.info('App', 'Application starting', { 
      environment: __DEV__ ? 'development' : 'production' 
    });
    
    initializeApp();
    
    // Set up listeners
    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    const unsubscribeNetInfo = NetInfo.addEventListener(handleNetworkChange);
    
    return () => {
      appStateSubscription.remove();
      unsubscribeNetInfo();
    };
  }, []);

  const initializeApp = async () => {
    try {
      // Restore session if exists
      await restoreSession();
      
      // Set up auth listener
      const unsubscribe = authHelpers.onAuthStateChanged(handleAuthStateChange);
      
      // Try to authenticate
      const currentUser = await authHelpers.ensureAuthenticated();
      if (currentUser) {
        logger.setUserId(currentUser.uid);
        logger.info('Auth', 'User authenticated on app start', { uid: currentUser.uid });
      }
      
      setInitializing(false);
      
      return () => unsubscribe();
    } catch (error) {
      logger.error('App', 'Initialization error', { error: error.message });
      setAuthError(error.message);
      setInitializing(false);
    }
  };

  const handleAuthStateChange = async (currentUser) => {
    logger.info('Auth', 'Auth state changed', { 
      uid: currentUser?.uid || 'null',
      isAnonymous: currentUser?.isAnonymous 
    });
    
    setUser(currentUser);
    
    if (currentUser) {
      logger.setUserId(currentUser.uid);
    }
    
    if (initializing) {
      setInitializing(false);
    }
  };

  const handleAppStateChange = (nextAppState) => {
    logger.info('App', 'App state changed', { 
      from: appState, 
      to: nextAppState 
    });
    
    if (appState.match(/inactive|background/) && nextAppState === 'active') {
      logger.info('App', 'App became active');
      // Refresh data when app comes to foreground
      refreshAppData();
    }
    
    setAppState(nextAppState);
  };

  const handleNetworkChange = (state) => {
    logger.info('Network', 'Network state changed', { 
      isConnected: state.isConnected,
      type: state.type 
    });
    
    setIsConnected(state.isConnected);
    updateNetworkState(state.isConnected);
  };

  const restoreSession = async () => {
    if (!isSessionPersistenceEnabled) {
      logPersistenceWarning('restore');
      return;
    }

    try {
      const [savedTourData, savedBookingData, lastScreen] = await SessionStorage.multiGet([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN
      ]);
      
      if (savedTourData[1]) {
        const tourData = JSON.parse(savedTourData[1]);
        const bookingData = JSON.parse(savedBookingData[1]);
        const screen = lastScreen[1] || 'Login';
        
        setTourData(tourData);
        setBookingData(bookingData);
        setTourCode(tourData.tourCode);
        setCurrentScreen(screen === 'Login' ? 'TourHome' : screen);
        
        logger.info('Session', 'Session restored', { 
          tourCode: tourData.tourCode,
          screen 
        });
      }
    } catch (error) {
      logger.warn('Session', 'Failed to restore session', { error: error.message });
    }
  };

  const saveSession = async () => {
    if (!isSessionPersistenceEnabled) {
      logPersistenceWarning('save');
      return;
    }

    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(tourData)],
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(bookingData)],
        [SESSION_KEYS.LAST_SCREEN, currentScreen]
      ]);
      
      logger.debug('Session', 'Session saved');
    } catch (error) {
      logger.error('Session', 'Failed to save session', { error: error.message });
    }
  };

  const refreshAppData = async () => {
    // Implement data refresh logic here
    logger.info('App', 'Refreshing app data');
  };

  // Navigation handlers
  const handleLoginSuccess = async (bookingReference, tourDetails, bookingDetails) => {
    logger.info('Navigation', 'Login successful', { 
      bookingRef: bookingReference,
      tourCode: tourDetails.tourCode 
    });
    
    setTourCode(tourDetails.tourCode);
    setTourData(tourDetails);
    setBookingData(bookingDetails);
    
    // Join the tour
    if (user && tourDetails?.id) {
      try {
        await joinTour(tourDetails.id, user.uid);
        logger.info('Tour', 'Successfully joined tour', { 
          tourId: tourDetails.id,
          userId: user.uid 
        });
      } catch (error) {
        logger.error('Tour', 'Error joining tour', { 
          error: error.message,
          tourId: tourDetails.id 
        });
      }
    }
    
    setCurrentScreen('TourHome');
    await saveSession();
  };

  const navigateTo = (screen) => {
    logger.trackScreen(screen, { from: currentScreen });
    setCurrentScreen(screen);
    saveSession();
  };

  const handleLogout = async () => {
    logger.info('Auth', 'User logging out');

    if (!isSessionPersistenceEnabled) {
      logPersistenceWarning('logout');
    }

    try {
      // Clear session data
      await SessionStorage.multiRemove([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN
      ]);
      
      // Reset state
      setTourCode('');
      setTourData(null);
      setBookingData(null);
      setCurrentScreen('Login');
      
      logger.info('Auth', 'Logout successful');
    } catch (error) {
      logger.error('Auth', 'Logout error', { error: error.message });
    }
  };

  // Render loading state
  if (initializing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        <Text style={styles.loadingText}>Connecting to Tour Services...</Text>
      </View>
    );
  }

  // Render error state
  if (authError) {
    return (
      <View style={styles.loadingContainer}>
        <MaterialCommunityIcons name="alert-circle-outline" size={60} color={COLORS.errorRed} />
        <Text style={styles.errorTitle}>Connection Error</Text>
        <Text style={styles.errorText}>{authError}</Text>
        <Text style={styles.errorDetail}>Please check your internet connection and restart the app.</Text>
      </View>
    );
  }

  // Render offline banner
  const OfflineBanner = () => (
    !isConnected && (
      <View style={styles.offlineBanner}>
        <MaterialCommunityIcons name="wifi-off" size={20} color={COLORS.white} />
        <Text style={styles.offlineText}>No internet connection</Text>
      </View>
    )
  );

  // Render appropriate screen
  const renderScreen = () => {
    // Common props for all screens
    const screenProps = {
      isConnected,
      logger
    };

    switch (currentScreen) {
      case 'Login':
        return <LoginScreen {...screenProps} onLoginSuccess={handleLoginSuccess} />;
      case 'TourHome':
        return (
          <TourHomeScreen
            {...screenProps}
            tourCode={tourCode}
            tourData={tourData}
            bookingData={bookingData}
            onNavigate={navigateTo}
            onLogout={handleLogout}
          />
        );
      case 'Photobook':
        return (
          <PhotobookScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            userId={user?.uid}
            tourId={tourData?.id}
          />
        );
      case 'GroupPhotobook':
        return (
          <GroupPhotobookScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            userId={user?.uid}
            tourId={tourData?.id}
          />
        );
      case 'Itinerary':
        return (
          <ItineraryScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            tourId={tourData?.id}
            tourName={tourData?.name}
          />
        );
      case 'Chat':
        return (
          <ChatScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            tourId={tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_')}
            bookingData={bookingData}
            tourData={tourData}
          />
        );
      case 'Map':
        return (
          <MapScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
          />
        );
      default:
        return <LoginScreen {...screenProps} onLoginSuccess={handleLoginSuccess} />;
    }
  };

  return (
    <>
      <StatusBar style="light" backgroundColor={COLORS.primaryBlue} />
      <OfflineBanner />
      {renderScreen()}
    </>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.appBackground,
    padding: 30,
  },
  loadingText: {
    marginTop: 15,
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.8,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.errorRed,
    marginTop: 20,
    marginBottom: 10,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 16,
    color: COLORS.darkText,
    textAlign: 'center',
    marginBottom: 5,
  },
  errorDetail: {
    fontSize: 14,
    color: COLORS.darkText,
    opacity: 0.6,
    textAlign: 'center',
    marginTop: 15,
  },
  offlineBanner: {
    backgroundColor: COLORS.errorRed,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
  },
  offlineText: {
    color: COLORS.white,
    fontSize: 14,
    marginLeft: 8,
    fontWeight: '500',
  },
});