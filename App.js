// App.js
import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Import Firebase services
import { auth, authHelpers } from './firebase';
import { joinTour } from './services/bookingServiceRealtime';
import logger from './services/loggerService';
import useDiagnostics from './hooks/useDiagnostics';

// Import Screens
import LoginScreen from './screens/LoginScreen';
import TourHomeScreen from './screens/TourHomeScreen';
import PhotobookScreen from './screens/PhotobookScreen';
import GroupPhotobookScreen from './screens/GroupPhotobookScreen';
import ItineraryScreen from './screens/ItineraryScreen';
import ChatScreen from './screens/ChatScreen';
import MapScreen from './screens/MapScreen';
import NotificationPreferencesScreen from './screens/NotificationPreferencesScreen';
import DriverHomeScreen from './screens/DriverHomeScreen';
import PassengerManifestScreen from './screens/PassengerManifestScreen';
import SafetySupportScreen from './screens/SafetySupportScreen';

const COLORS = {
  primaryBlue: '#007DC3',
  lightBlueAccent: '#AECAEC',
  white: '#FFFFFF',
  darkText: '#1A202C',
  errorRed: '#E53E3E',
  appBackground: '#F0F4F8',
};

const SESSION_KEYS = {
  TOUR_DATA: '@LLT:tourData',
  BOOKING_DATA: '@LLT:bookingData',
  LAST_SCREEN: '@LLT:lastScreen',
};

// --- SESSION STORAGE SETUP (AsyncStorage fallback to mock for tests/web) ---
const createSessionStorage = () => {
  const mockStorage = {
    _data: {},
    multiGet: async (keys) => keys.map((key) => [key, mockStorage._data[key] || null]),
    multiSet: async (entries) => {
      entries.forEach(([key, value]) => {
        mockStorage._data[key] = value;
      });
    },
    multiRemove: async (keys) => {
      keys.forEach((key) => {
        delete mockStorage._data[key];
      });
    },
  };

  try {
    if (AsyncStorage?.multiGet && AsyncStorage?.multiSet && AsyncStorage?.multiRemove) {
      return { storage: AsyncStorage, mode: 'async-storage', enabled: true };
    }
  } catch (error) {
    logger.warn('SessionStorage', 'AsyncStorage unavailable, falling back to mock', { error: error.message });
  }

  return { storage: mockStorage, mode: 'mock', enabled: true };
};

const { storage: SessionStorage, mode: storageMode } = createSessionStorage();

export default function App() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  const [currentScreen, setCurrentScreen] = useState('Login');
  const [tourCode, setTourCode] = useState('');
  const [tourData, setTourData] = useState(null);
  const [bookingData, setBookingData] = useState(null);
  
  // State for passing params between screens manually (since we aren't using React Navigation stack)
  const [screenParams, setScreenParams] = useState({});

  const refreshAppData = async () => {
    logger.info('App', 'Refreshing app data');
  };

  const { isConnected, firebaseConnected, lastFirebaseError, lastProbeDurationMs } = useDiagnostics({
    onForeground: refreshAppData
  });

  useEffect(() => {
    logger.info('App', 'Application starting', {
      environment: __DEV__ ? 'development' : 'production',
      storageMode
    });

    let authUnsubscribe = null;

    const bootstrap = async () => {
      authUnsubscribe = await initializeApp();
    };

    bootstrap().catch((error) => logger.error('App', 'Bootstrap failure', { error: error.message }));

    return () => {
      if (typeof authUnsubscribe === 'function') authUnsubscribe();
    };
  }, []);

  const initializeApp = async () => {
    try {
      await restoreSession();
      const unsubscribe = authHelpers.onAuthStateChanged(handleAuthStateChange);

      const currentUser = await authHelpers.ensureAuthenticated();
      if (currentUser) {
        logger.setUserId(currentUser.uid);
        logger.info('Auth', 'User authenticated', { uid: currentUser.uid });
      }

      setInitializing(false);
      return unsubscribe;
    } catch (error) {
      logger.error('App', 'Initialization error', { error: error.message });
      setAuthError(error.message);
      setInitializing(false);
      return null;
    }
  };

  const handleAuthStateChange = async (currentUser) => {
    setUser(currentUser);
    if (currentUser) logger.setUserId(currentUser.uid);
    if (initializing) setInitializing(false);
  };

  const restoreSession = async () => {
    try {
      const [savedTourData, savedBookingData, lastScreen] = await SessionStorage.multiGet([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN
      ]);
      
      if (savedBookingData[1]) {
        const bookingData = JSON.parse(savedBookingData[1]);
        const tourData = savedTourData[1] ? JSON.parse(savedTourData[1]) : null;
        const screen = lastScreen[1] || 'Login';
        
        setBookingData(bookingData);
        setTourData(tourData);
        if (tourData) setTourCode(tourData.tourCode);
        
        setCurrentScreen(screen === 'Login' ? (bookingData.id && bookingData.id.startsWith('D-') ? 'DriverHome' : 'TourHome') : screen);
      }
    } catch (error) {
      logger.warn('Session', 'Failed to restore session', { error: error.message });
    }
  };

  const saveSession = async () => {
    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(tourData)],
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(bookingData)],
        [SESSION_KEYS.LAST_SCREEN, currentScreen]
      ]);
    } catch (error) {
      logger.error('Session', 'Failed to save session', { error: error.message });
    }
  };

  const handleLoginSuccess = async (reference, tourDetails, bookingOrDriverData, userType = 'passenger') => {
    if (userType === 'driver') {
      logger.info('Auth', 'Driver Logged In', { driverId: bookingOrDriverData.id });
      setBookingData(bookingOrDriverData);
      setCurrentScreen('DriverHome');
    } else {
      logger.info('Navigation', 'Passenger Login', { bookingRef: reference });
      setTourCode(tourDetails.tourCode);
      setTourData(tourDetails);
      setBookingData(bookingOrDriverData);
      
      if (user && tourDetails?.id) {
        try {
          await joinTour(tourDetails.id, user.uid);
        } catch (error) {
          logger.error('Tour', 'Error joining tour', { error: error.message });
        }
      }
      
      setCurrentScreen('TourHome');
    }
    
    await saveSession();
  };

  // Updated navigation to accept params
  const navigateTo = (screen, params = {}) => {
    logger.trackScreen(screen, { from: currentScreen, ...params });
    setScreenParams(params); // Store params for the next screen to use
    setCurrentScreen(screen);
    saveSession();
  };

  const handleLogout = async () => {
    try {
      await SessionStorage.multiRemove([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN
      ]);
      setTourCode('');
      setTourData(null);
      setBookingData(null);
      setScreenParams({});
      setCurrentScreen('Login');
    } catch (error) {
      logger.error('Auth', 'Logout error', { error: error.message });
    }
  };

  if (initializing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        <Text style={styles.loadingText}>Connecting to Tour Services...</Text>
      </View>
    );
  }

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

  const OfflineBanner = () => (
    !isConnected && (
      <View style={styles.offlineBanner}>
        <MaterialCommunityIcons name="wifi-off" size={20} color={COLORS.white} />
        <Text style={styles.offlineText}>No internet connection</Text>
      </View>
    )
  );

  const SyncIssueBanner = () => (
    isConnected && (!firebaseConnected || lastFirebaseError) && (
      <View style={styles.syncBanner}>
        <MaterialCommunityIcons name="database-alert" size={20} color={COLORS.white} />
        <View style={{ marginLeft: 8 }}>
          <Text style={styles.offlineText}>Reconnecting to tour services…</Text>
          {lastProbeDurationMs !== null && (
            <Text style={styles.syncDetail}>Last check: {lastProbeDurationMs}ms</Text>
          )}
          {lastFirebaseError && (
            <Text style={styles.syncDetail}>Last error: {lastFirebaseError}</Text>
          )}
        </View>
      </View>
    )
  );

  const renderScreen = () => {
    const screenProps = { isConnected, logger };

    switch (currentScreen) {
      case 'Login':
        return <LoginScreen {...screenProps} onLoginSuccess={handleLoginSuccess} />;
      case 'DriverHome':
        return (
          <DriverHomeScreen
            driverData={bookingData}
            onLogout={handleLogout}
            onNavigate={navigateTo} // Pass navigation prop
          />
        );
      case 'SafetySupport':
        return (
          <SafetySupportScreen
            onBack={() => navigateTo(screenParams?.from || 'TourHome')}
            tourData={tourData}
            bookingData={bookingData}
            userId={user?.uid}
            mode={screenParams?.mode || 'passenger'}
          />
        );
      case 'PassengerManifest':
        return (
          <PassengerManifestScreen
            // 1. Pass the global 'screenParams' as 'route.params' so the screen can read 'tourId'
            route={{ params: screenParams }}
            
            // 2. Mock the 'navigation' object so the screen's logic works without changing it
            navigation={{
              navigate: navigateTo,
              goBack: () => navigateTo('DriverHome') // Ensure back button returns to Driver Console
            }}
          />
        );
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
        return <PhotobookScreen {...screenProps} onBack={() => navigateTo('TourHome')} userId={user?.uid} tourId={tourData?.id} />;
      case 'GroupPhotobook':
        return <GroupPhotobookScreen {...screenProps} onBack={() => navigateTo('TourHome')} userId={user?.uid} tourId={tourData?.id} />;
case 'Itinerary':
        // CHECK: Is the user a driver?
        const isDriverUser = screenParams.isDriver || (bookingData?.id && bookingData.id.startsWith('D-'));
        // If driver, back goes to DriverHome
        const backDest = isDriverUser ? 'DriverHome' : 'TourHome';
        // Use active tour ID if passed, else fall back to session data
        const itinTourId = screenParams.tourId || tourData?.id;

        return (
          <ItineraryScreen
            {...screenProps}
            onBack={() => navigateTo(backDest)}
            tourId={itinTourId}
            tourName={tourData?.name}
            startDate={tourData?.startDate}
            isDriver={isDriverUser} // NEW PROP
          />
        );
      case 'Chat':
        // Determine back destination based on user type
        const isDriver = screenParams.isDriver || (bookingData?.id && bookingData.id.startsWith('D-'));
        const backScreen = isDriver ? 'DriverHome' : 'TourHome';
        
        // Use params if passed (from DriverHome), otherwise fall back to standard state
        const chatTourId = screenParams.tourId || tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_');
        
        // Construct booking data for chat if we are in driver mode (since driver doesn't have standard bookingData)
        const effectiveBookingData = isDriver 
          ? { isDriver: true, passengerNames: [screenParams.driverName || bookingData?.name || 'Driver'] }
          : bookingData;

        return (
          <ChatScreen
            {...screenProps}
            onBack={() => navigateTo(backScreen)}
            tourId={chatTourId}
            bookingData={effectiveBookingData}
            tourData={tourData || { name: 'Tour Chat' }}
            internalDriverChat={screenParams.internalDriverChat === true}
          />
        );
      case 'Map':
        // Use active tour ID if passed, else fall back to session data
        const mapTourId = screenParams.tourId || tourData?.id || tourData?.tourCode?.replace(/\s+/g, '_');
        return <MapScreen {...screenProps} onBack={() => navigateTo('TourHome')} tourId={mapTourId} />;
      case 'NotificationPreferences':
        return (
          <NotificationPreferencesScreen
            onBack={() => navigateTo('TourHome')}
            userId={user?.uid}
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
      <SyncIssueBanner />
      {renderScreen()}
    </>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.appBackground, padding: 30 },
  loadingText: { marginTop: 15, fontSize: 16, color: COLORS.darkText, opacity: 0.8 },
  errorTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.errorRed, marginTop: 20, marginBottom: 10, textAlign: 'center' },
  errorText: { fontSize: 16, color: COLORS.darkText, textAlign: 'center', marginBottom: 5 },
  errorDetail: { fontSize: 14, color: COLORS.darkText, opacity: 0.6, textAlign: 'center', marginTop: 15 },
  offlineBanner: { backgroundColor: COLORS.errorRed, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000 },
  offlineText: { color: COLORS.white, fontSize: 14, marginLeft: 8, fontWeight: '500' },
  syncBanner: { backgroundColor: COLORS.primaryBlue, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, position: 'absolute', top: 40, left: 0, right: 0, zIndex: 900 },
  syncDetail: { color: COLORS.white, fontSize: 12, opacity: 0.8 },
});