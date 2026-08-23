// App.js
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, Text, StyleSheet, Animated, Easing, PanResponder, TouchableOpacity } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Import Firebase services
import { auth, authHelpers, realtimeDb } from './firebase';
import { joinTour } from './services/bookingServiceRealtime';
import logger, { maskIdentifier } from './services/loggerService';
import useDiagnostics from './hooks/useDiagnostics';
import offlineSyncService from './services/offlineSyncService';
import * as bookingService from './services/bookingServiceRealtime';
import * as chatService from './services/chatService';
import offlineLoginResolver from './services/offlineLoginResolver';
import driverOperationalLifecycleService from './services/driverOperationalLifecycleService';
import driverTourPackService from './services/driverTourPackService';
import useDriverTourPack from './hooks/useDriverTourPack';
import useDriverTourPackActions from './hooks/useDriverTourPackActions';
import driverTourPackActionService from './services/driverTourPackActionService';
import useDriverTourPackFeatureFlag from './hooks/useDriverTourPackFeatureFlag';
import { getCanonicalIdentity, resolveAuthScopedUserId, toRealtimeKeySegment } from './services/identityService';
import { normalizeTourId, resolveTourId } from './services/tourIdentityService';
import { parseTimestampMs } from './services/timeUtils';
import {
  installGlobalCrashDiagnostics,
  recordBreadcrumb as recordCrashBreadcrumb,
  setDiagnosticsAuthUid,
  setDiagnosticsContext,
} from './services/crashDiagnosticsService';
import loginDiagnostics from './services/loginDiagnosticsService';
import {
  deactivatePushToken,
  restorePushTokenForSession,
  subscribeToNotificationResponses,
} from './services/notificationService';
import { COLORS as THEME } from './theme';
import AppErrorBoundary from './components/AppErrorBoundary';

// Import Screens
import LoginScreen from './screens/LoginScreen';
import TourHomeScreen from './screens/TourHomeScreen';
import PhotobookScreen from './screens/PhotobookScreen';
import GroupPhotobookScreen from './screens/GroupPhotobookScreen';
import ItineraryScreen from './screens/ItineraryScreen';
import ChatScreen from './screens/ChatScreen';
import MapScreen from './screens/MapScreen';
import NotificationPreferencesScreen from './screens/NotificationPreferencesScreen';
import AccountPrivacyScreen from './screens/AccountPrivacyScreen';
import DriverHomeScreen from './screens/DriverHomeScreen';
import PassengerManifestScreen from './screens/PassengerManifestScreen';
import SafetySupportScreen from './screens/SafetySupportScreen';
import DriverItineraryScreen from './screens/DriverItineraryScreen';
import DriverTourPackScreen from './screens/DriverTourPackScreen';
const { getLoginTransitionDurationMs } = require('./screens/loginFlow');
const { isEligibleEdgeSwipe, shouldCommitEdgeSwipeHome } = require('./services/swipeHomeNavigation');
const { markNotificationRead } = require('./services/notificationInboxService');
const {
  normalizePassengerIdentityProjection,
  normalizePassengerTourProjection,
} = require('./services/passengerDataBoundary');

const IDENTITY_VERSION = 'pax_v1';
const IDENTITY_SESSION_KEYS = {
  IDENTITY_BINDING: '@LLT:identityBinding',
};

const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: '#93C5FD',
  white: THEME.white,
  darkText: THEME.textPrimary,
  errorRed: THEME.error,
  appBackground: THEME.background,
  statusBarBackground: THEME.statusBarBackground,
};

const SESSION_KEYS = {
  TOUR_DATA: '@LLT:tourData',
  BOOKING_DATA: '@LLT:bookingData',
  LAST_SCREEN: '@LLT:lastScreen',
  NOTIFICATION_ONBOARDING: '@LLT:notificationOnboarding',
  IDENTITY_BINDING: IDENTITY_SESSION_KEYS.IDENTITY_BINDING,
};

const NOTIFICATION_ONBOARDING_REMINDER_MS = 24 * 60 * 60 * 1000;
const STARTUP_CONNECTION_ERROR_MESSAGE =
  'We could not connect to tour services. Please check your internet connection and restart the app.';

const { normalizePassengerEmail, resolveOfflineLoginFromCache } = offlineLoginResolver;

// --- SESSION STORAGE SETUP ---
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

  if (process.env.NODE_ENV === 'test') {
    return { storage: mockStorage, mode: 'memory-test', enabled: true };
  }

  const unavailable = async () => {
    const error = new Error('Durable session storage is unavailable');
    error.code = 'SESSION_STORAGE_UNAVAILABLE';
    throw error;
  };
  return {
    storage: {
      multiGet: unavailable,
      multiSet: unavailable,
      multiRemove: unavailable,
    },
    mode: 'unavailable',
    enabled: false,
  };
};

const { storage: SessionStorage, mode: storageMode } = createSessionStorage();

export default function App() {
  const [appEpoch, setAppEpoch] = useState(0);

  return (
    <SafeAreaProvider>
      <AppErrorBoundary
        resetKey={appEpoch}
        onReset={() => setAppEpoch((value) => value + 1)}
      >
        <AppContent key={appEpoch} />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  const [currentScreen, setCurrentScreen] = useState('Login');
  const [tourCode, setTourCode] = useState('');
  const [tourData, setTourData] = useState(null);
  const [bookingData, setBookingData] = useState(null);
  const [identityBinding, setIdentityBinding] = useState(null);
  
  // State for passing params between screens manually (since we aren't using React Navigation stack)
  const [screenParams, setScreenParams] = useState({});
  const [isImageViewerVisible, setIsImageViewerVisible] = useState(false);
  const [loginTransition, setLoginTransition] = useState(null);
  const [driverSessionGeneration, setDriverSessionGeneration] = useState(0);
  const loginTransitionTimerRef = useRef(null);
  const loginTransitionAnimationRef = useRef(null);
  const driverIdentityPersistKeyRef = useRef(null);
  const authUnsubscribeRef = useRef(null);
  const loginProgress = useRef(new Animated.Value(0)).current;
  const notificationNavigateRef = useRef(null);
  const previousDriverOperationalScopeRef = useRef(null);
  const driverLifecyclePurgeRef = useRef(null);
  const driverAssignmentChangeRef = useRef(null);
  const assignmentValidationSeqRef = useRef(0);

  const isDriverSession = bookingData?.id && bookingData.id.startsWith('D-');
  const canonicalIdentity = useMemo(
    () => getCanonicalIdentity({ authUser: user, bookingData, identityBinding }),
    [user, bookingData, identityBinding]
  );
  const homeScreen = isDriverSession ? 'DriverHome' : 'TourHome';
  const canSwipeToHome =
    currentScreen !== 'Login' &&
    currentScreen !== 'TourHome' &&
    currentScreen !== 'DriverHome' &&
    currentScreen !== 'Chat' &&
    !isImageViewerVisible;

  const handleViewerVisibilityChange = useCallback((visible) => {
    setIsImageViewerVisible(Boolean(visible));
  }, []);

  const clearLoginTransitionArtifacts = () => {
    if (loginTransitionTimerRef.current) {
      clearTimeout(loginTransitionTimerRef.current);
      loginTransitionTimerRef.current = null;
    }

    if (loginTransitionAnimationRef.current) {
      loginTransitionAnimationRef.current.stop();
      loginTransitionAnimationRef.current = null;
    }
  };

  const startLoginTransition = ({ targetScreen, durationMs }) => {
    clearLoginTransitionArtifacts();
    loginProgress.setValue(0);
    setLoginTransition({
      targetScreen,
      message: 'Tour synced - entering dashboard',
      durationMs,
    });

    loginTransitionAnimationRef.current = Animated.timing(loginProgress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    loginTransitionAnimationRef.current.start();

    loginTransitionTimerRef.current = setTimeout(() => {
      clearLoginTransitionArtifacts();
      setLoginTransition(null);
      loginProgress.setValue(0);
    }, durationMs);
  };
  const diagnosticsTourId = isDriverSession
    ? resolveTourId(bookingData?.assignedTourId, tourData?.id, tourData?.tourCode)
    : resolveTourId(tourData?.id, tourData?.tourCode);
  const diagnosticsRole = bookingData?.id?.startsWith('D-') ? 'driver' : 'passenger';
  const offlineSessionScope = useMemo(() => {
    const principalId = canonicalIdentity?.principalId;
    if (!diagnosticsTourId || !principalId || principalId === 'anonymous') return null;
    return {
      tourId: diagnosticsTourId,
      principalId,
      role: diagnosticsRole,
      authUid: canonicalIdentity?.authUid || null,
      cacheOwnerId: bookingData?.id || principalId,
    };
  }, [bookingData?.id, canonicalIdentity?.authUid, canonicalIdentity?.principalId, diagnosticsRole, diagnosticsTourId]);
  const offlineSessionScopeKey = offlineSessionScope
    ? `${offlineSessionScope.tourId}|${offlineSessionScope.role}|${offlineSessionScope.principalId}|${offlineSessionScope.cacheOwnerId}`
    : 'none';
  const driverOperationalScope = useMemo(() => {
    if (!isDriverSession || !diagnosticsTourId) return null;
    const normalized = driverTourPackService.normalizeScope({
      authUid: user?.uid,
      driverId: bookingData?.id,
      departureKey: bookingData?.assignedDepartureKey,
      tourId: diagnosticsTourId,
      startDate: tourData?.startDate,
    });
    return normalized.ok ? normalized : null;
  }, [
    bookingData?.assignedDepartureKey,
    bookingData?.id,
    diagnosticsTourId,
    isDriverSession,
    tourData?.startDate,
    user?.uid,
  ]);
  const driverTourPackState = useDriverTourPack(driverOperationalScope || {}, {
    enabled: Boolean(driverOperationalScope),
  });
  const driverTourPackFeature = useDriverTourPackFeatureFlag(isDriverSession ? bookingData?.id : null);
  useEffect(() => {
    if (currentScreen !== 'DriverTourPack' || driverTourPackFeature.loading || driverTourPackFeature.enabled) return;
    setCurrentScreen('DriverHome');
    setScreenParams({});
    SessionStorage.setItem(SESSION_KEYS.LAST_SCREEN, 'DriverHome').catch(() => undefined);
  }, [currentScreen, driverTourPackFeature.enabled, driverTourPackFeature.loading]);
  const currentDriverLifecycleScope = useMemo(() => (
    isDriverSession && diagnosticsTourId
      ? {
          authUid: user?.uid || null,
          driverId: bookingData?.id,
          departureKey: bookingData?.assignedDepartureKey || driverOperationalScope?.departureKey || null,
          tourId: diagnosticsTourId,
          startDate: tourData?.startDate || null,
        }
      : null
  ), [
    bookingData?.assignedDepartureKey,
    bookingData?.id,
    diagnosticsTourId,
    driverOperationalScope?.departureKey,
    isDriverSession,
    tourData?.startDate,
    user?.uid,
  ]);
  const currentDriverLifecycleScopeKey = currentDriverLifecycleScope
    ? [
        currentDriverLifecycleScope.authUid || '',
        currentDriverLifecycleScope.driverId || '',
        currentDriverLifecycleScope.departureKey || '',
        currentDriverLifecycleScope.tourId || '',
      ].join('|')
    : 'none';

  const refreshAppData = async () => {
    logger.info('App', 'Refreshing app data');
    if (!isConnected) return;
    await offlineSyncService.replayQueue({
      services: { bookingService, chatService, driverTourPackActionService },
      scope: offlineSessionScope,
    });
  };

  const { isConnected, firebaseConnected } = useDiagnostics({
    onForeground: refreshAppData,
    activeTourId: diagnosticsTourId,
    role: diagnosticsRole,
    offlineCacheOwnerId: bookingData?.id || null,
  });
  const driverTourPackActions = useDriverTourPackActions({ pack: driverTourPackState.pack, driverId: bookingData?.id, authUid: user?.uid, isConnected });
  const insets = useSafeAreaInsets();

  useEffect(() => {
    offlineSyncService.setActiveSessionScope(offlineSessionScope).catch((error) => {
      logger.warn('OfflineSync', 'Could not update active offline session scope', {
        error: error?.message || String(error),
      });
    });
  }, [offlineSessionScopeKey]);

  useEffect(() => {
    const previous = previousDriverOperationalScopeRef.current;
    const previousNormalized = previous
      ? driverOperationalLifecycleService.normalizeScope(previous)
      : null;
    const currentNormalized = currentDriverLifecycleScope
      ? driverOperationalLifecycleService.normalizeScope(currentDriverLifecycleScope)
      : null;
    const previousKey = previousNormalized?.ok
      ? `${previousNormalized.driverId}|${previousNormalized.departureKey || previousNormalized.tourId}`
      : null;
    const currentKey = currentNormalized?.ok
      ? `${currentNormalized.driverId}|${currentNormalized.departureKey || currentNormalized.tourId}`
      : null;

    if (previousKey && currentKey && previousKey !== currentKey) {
      driverOperationalLifecycleService.purge(previous).then((result) => {
        if (!result.success) {
          logger.warn('DriverTourPack', 'Previous driver operational scope was only partially purged', {
            failedOperations: result.failures?.map((failure) => failure.name) || [],
          });
        }
      }).finally(() => {
        // The purge deliberately invalidates the previous replay generation. Restore
        // the newly-derived session scope only after that invalidation has finished.
        if (offlineSessionScope) {
          offlineSyncService.setActiveSessionScope(offlineSessionScope).catch(() => {});
        }
      });
      setDriverSessionGeneration((value) => value + 1);
    }
    previousDriverOperationalScopeRef.current = currentDriverLifecycleScope;
  }, [currentDriverLifecycleScopeKey]);

  useEffect(() => {
    if (!currentDriverLifecycleScope) return;
    if (driverTourPackState.state !== 'expired' && driverTourPackState.state !== 'withdrawn') return;
    const purgeKey = `${currentDriverLifecycleScopeKey}|${driverTourPackState.state}|${driverTourPackState.revision || 0}`;
    if (driverLifecyclePurgeRef.current === purgeKey) return;
    driverLifecyclePurgeRef.current = purgeKey;

    driverOperationalLifecycleService.purge(currentDriverLifecycleScope).then((result) => {
      if (!result.success) {
        logger.warn('DriverTourPack', 'Expired or withdrawn operational data was only partially purged', {
          state: driverTourPackState.state,
          failedOperations: result.failures?.map((failure) => failure.name) || [],
        });
      }
      setDriverSessionGeneration((value) => value + 1);
    });
  }, [
    currentDriverLifecycleScopeKey,
    driverTourPackState.revision,
    driverTourPackState.state,
  ]);

  useEffect(() => {
    installGlobalCrashDiagnostics();
    recordCrashBreadcrumb('App', 'application_starting', {
      currentScreen,
      environment: __DEV__ ? 'development' : 'production',
      storageMode,
    }, { remote: true });
    logger.info('App', 'Application starting', {
      environment: __DEV__ ? 'development' : 'production',
      storageMode
    });

    const bootstrap = async () => {
      await initializeApp();
    };

    bootstrap().catch((error) => logger.error('App', 'Bootstrap failure', { error: error.message }));

    return () => {
      clearLoginTransitionArtifacts();
      offlineSyncService.setActiveSessionScope(null).catch(() => {});
      if (typeof authUnsubscribeRef.current === 'function') authUnsubscribeRef.current();
      authUnsubscribeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const shouldFlushNavigationDiagnostics = Boolean(user?.uid) || currentScreen !== 'Login';
    setDiagnosticsContext('navigation', {
      currentScreen,
      homeScreen,
      hasTourData: Boolean(tourData),
      hasBookingData: Boolean(bookingData),
      hasIdentityBinding: Boolean(identityBinding),
      isDriverSession,
      isImageViewerVisible,
    }, { flush: shouldFlushNavigationDiagnostics });
    recordCrashBreadcrumb('Navigation', 'screen_state_changed', {
      currentScreen,
      homeScreen,
      isImageViewerVisible,
    }, {
      remote: shouldFlushNavigationDiagnostics,
      reason: 'Navigation:screen_state_changed',
    });
  }, [bookingData, currentScreen, homeScreen, identityBinding, isDriverSession, isImageViewerVisible, tourData, user?.uid]);

  const persistPassengerIdentityForUser = async ({
    authUid,
    stablePassengerId,
    identityVersion,
    bookingRef,
    normalizedPassengerEmail,
  }) => {
    if (!authUid || !realtimeDb || !bookingRef || !stablePassengerId) {
      return { profilePersisted: false, bindingPersisted: false };
    }

    const now = Date.now();
    const stablePassengerKey = toRealtimeKeySegment(stablePassengerId);
    const privatePhotoOwnerKey = stablePassengerKey;
    const profileUpdates = {
      [`users/${authUid}/privatePhotoOwnerId`]: stablePassengerId,
      [`users/${authUid}/privatePhotoOwnerKey`]: privatePhotoOwnerKey,
      [`users/${authUid}/privatePhotoOwnerType`]: 'stable_passenger',
      [`users/${authUid}/lastUpdated`]: now,
    };
    const bindingLinkUpdates = {};
    const bindingMetaUpdates = {};

    if (normalizedPassengerEmail) {
      profileUpdates[`users/${authUid}/stablePassengerId`] = stablePassengerId;
      profileUpdates[`users/${authUid}/stablePassengerKey`] = stablePassengerKey;
      profileUpdates[`users/${authUid}/identityVersion`] = identityVersion || IDENTITY_VERSION;
      profileUpdates[`users/${authUid}/bookingRef`] = bookingRef;
      profileUpdates[`users/${authUid}/normalizedPassengerEmail`] = normalizedPassengerEmail;
      bindingLinkUpdates[`identity_bindings/${stablePassengerKey}/${authUid}`] = true;
      bindingMetaUpdates[`identity_bindings_meta/${stablePassengerKey}/bookingRef`] = bookingRef;
      bindingMetaUpdates[`identity_bindings_meta/${stablePassengerKey}/normalizedPassengerEmail`] = normalizedPassengerEmail;
      bindingMetaUpdates[`identity_bindings_meta/${stablePassengerKey}/identityVersion`] = identityVersion || IDENTITY_VERSION;
      bindingMetaUpdates[`identity_bindings_meta/${stablePassengerKey}/lastSeenAt`] = now;
    }

    try {
      await realtimeDb.ref().update(profileUpdates);
    } catch (error) {
      const profileError = new Error('Passenger identity profile persistence failed');
      profileError.userMessage = 'We could not finish securing your tour session. Please check your connection and try again.';
      profileError.criticalIdentityPersistence = true;
      profileError.cause = error;
      throw profileError;
    }

    let bindingPersisted = false;
    let bindingMetaPersisted = false;

    if (Object.keys(bindingLinkUpdates).length > 0) {
      try {
        await realtimeDb.ref().update(bindingLinkUpdates);
        bindingPersisted = true;
      } catch (error) {
        logger.warn('Identity', 'identity_binding_link_persist_failure', {
          authUid: maskIdentifier(authUid),
          stablePassengerKey: stablePassengerKey ? maskIdentifier(stablePassengerKey) : null,
          error: error?.message || String(error),
          code: error?.code || null,
        });
      }
    }
    if (Object.keys(bindingMetaUpdates).length > 0) {
      try {
        await realtimeDb.ref().update(bindingMetaUpdates);
        bindingMetaPersisted = true;
      } catch (error) {
        logger.warn('Identity', 'identity_binding_meta_persist_failure', {
          authUid: maskIdentifier(authUid),
          stablePassengerKey: stablePassengerKey ? maskIdentifier(stablePassengerKey) : null,
          error: error?.message || String(error),
          code: error?.code || null,
        });
      }
    }

    return {
      profilePersisted: true,
      bindingPersisted,
      bindingMetaPersisted,
      stablePassengerKey,
    };
  };

  const persistDriverIdentityForUser = useCallback(async ({
    authUid,
    driverId,
    assignedTourId,
  }) => {
    const normalizedDriverId = typeof driverId === 'string' ? driverId.trim().toUpperCase() : '';
    if (!authUid || !normalizedDriverId || !realtimeDb) {
      return { profilePersisted: false };
    }

    const now = Date.now();
    const updates = {
      [`drivers/${normalizedDriverId}/lastActive`]: new Date(now).toISOString(),
    };

    const normalizedAssignedTourId = normalizeTourId(assignedTourId);

    await realtimeDb.ref().update(updates);
    return {
      profilePersisted: true,
      driverId: normalizedDriverId,
      assignedTourId: normalizedAssignedTourId || null,
    };
  }, []);

  useEffect(() => {
    const driverId = typeof bookingData?.id === 'string' && bookingData.id.trim().toUpperCase().startsWith('D-')
      ? bookingData.id.trim().toUpperCase()
      : null;
    const assignedTourId = resolveTourId(tourData?.id, bookingData?.assignedTourId, tourData?.tourCode);
    const authUid = user?.uid || null;

    if (!authUid || !driverId) return undefined;

    const persistKey = `${authUid}:${driverId}:${assignedTourId || 'unassigned'}`;
    if (driverIdentityPersistKeyRef.current === persistKey) return undefined;

    let cancelled = false;
    driverIdentityPersistKeyRef.current = persistKey;

    persistDriverIdentityForUser({ authUid, driverId, assignedTourId })
      .then((persisted) => {
        if (cancelled) return;
        logger.info('Identity', 'driver_identity_session_persist_success', {
          authUid: maskIdentifier(authUid),
          driverId: maskIdentifier(persisted.driverId),
          assignedTourId: persisted.assignedTourId || null,
        });
        recordCrashBreadcrumb('Identity', 'driver_identity_session_persist_success', {
          hasAuthUid: Boolean(authUid),
          driverId: maskIdentifier(persisted.driverId),
          assignedTourId: persisted.assignedTourId || null,
        }, { remote: true, reason: 'Identity:driver_identity_session_persist_success' });
      })
      .catch((error) => {
        if (cancelled) return;
        driverIdentityPersistKeyRef.current = null;
        logger.error('Identity', 'driver_identity_session_persist_failure', {
          authUid: maskIdentifier(authUid),
          driverId: maskIdentifier(driverId),
          assignedTourId,
          error: error.message,
          code: error?.code || null,
        });
        recordCrashBreadcrumb('Identity', 'driver_identity_session_persist_failure', {
          hasAuthUid: Boolean(authUid),
          driverId: maskIdentifier(driverId),
          assignedTourId,
          error: error.message,
          code: error?.code || null,
        }, { remote: true, reason: 'Identity:driver_identity_session_persist_failure' });
      });

    return () => {
      cancelled = true;
    };
  }, [
    bookingData?.assignedTourId,
    bookingData?.id,
    persistDriverIdentityForUser,
    tourData?.id,
    user?.uid,
  ]);

  const repairIdentityBindingFromSession = async (authUid) => {
    const [savedIdentityBinding, savedBookingData] = await SessionStorage.multiGet([
      SESSION_KEYS.IDENTITY_BINDING,
      SESSION_KEYS.BOOKING_DATA,
    ]);
    const restoredBinding = savedIdentityBinding?.[1] ? JSON.parse(savedIdentityBinding[1]) : null;
    const restoredBooking = savedBookingData?.[1] ? JSON.parse(savedBookingData[1]) : null;
    const stablePassengerId = restoredBinding?.stablePassengerId || restoredBooking?.stablePassengerId || null;
    const normalizedPassengerEmail = restoredBinding?.normalizedPassengerEmail || normalizePassengerEmail(restoredBooking?.normalizedPassengerEmail);
    const bookingRef = restoredBinding?.bookingRef || restoredBooking?.id || null;

    if (!stablePassengerId || !normalizedPassengerEmail || !bookingRef) {
      return null;
    }

    const identityVersion = restoredBinding?.identityVersion || IDENTITY_VERSION;
    const persisted = await persistPassengerIdentityForUser({
      authUid,
      stablePassengerId,
      identityVersion,
      bookingRef,
      normalizedPassengerEmail,
    });
    const repairedBinding = {
      stablePassengerId,
      stablePassengerKey: persisted.stablePassengerKey || toRealtimeKeySegment(stablePassengerId),
      identityVersion,
      bookingRef,
      normalizedPassengerEmail,
      authUid,
    };

    setIdentityBinding(repairedBinding);
    await SessionStorage.multiSet([
      [SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(repairedBinding)],
    ]);
    return repairedBinding;
  };

  const hydrateIdentityBindingForCurrentUser = async (authUid) => {
    if (!authUid || !realtimeDb) return;

    try {
      const snapshot = await realtimeDb.ref(`users/${authUid}`).once('value');
      const userProfile = snapshot.val() || {};
      const stablePassengerId = userProfile?.stablePassengerId;

      if (!stablePassengerId) {
        const repairedBinding = await repairIdentityBindingFromSession(authUid);
        if (repairedBinding?.stablePassengerId) {
          logger.info('Identity', 'identity_binding_repaired_from_session', {
            authUid: maskIdentifier(authUid),
            stablePassengerId: maskIdentifier(repairedBinding.stablePassengerId),
            stablePassengerKey: maskIdentifier(repairedBinding.stablePassengerKey),
          });
          return;
        }
        logger.info('Identity', 'identity_binding_missing', { authUid: maskIdentifier(authUid) });
        return;
      }

      const hydratedBinding = {
        stablePassengerId,
        stablePassengerKey: toRealtimeKeySegment(stablePassengerId),
        identityVersion: userProfile?.identityVersion || IDENTITY_VERSION,
        bookingRef: userProfile?.bookingRef || null,
        normalizedPassengerEmail: userProfile?.normalizedPassengerEmail || null,
        authUid,
      };

      setIdentityBinding(hydratedBinding);
      await SessionStorage.multiSet([
        [SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(hydratedBinding)],
      ]);
      logger.info('Identity', 'identity_binding_hydrated', {
        authUid: maskIdentifier(authUid),
        stablePassengerId: maskIdentifier(stablePassengerId),
      });
    } catch (error) {
      logger.warn('Identity', 'Failed to hydrate identity binding for auth user', {
        error: error.message,
        authUid: maskIdentifier(authUid),
      });
    }
  };

  const initializeApp = async () => {
    let unsubscribe = null;
    try {
      setAuthError(null);
      await restoreSession();
      if (typeof authUnsubscribeRef.current === 'function') authUnsubscribeRef.current();
      unsubscribe = authHelpers.onAuthStateChanged(handleAuthStateChange);
      authUnsubscribeRef.current = unsubscribe;

      const currentUser = await authHelpers.ensureAuthenticated();
      if (currentUser) {
        setUser(currentUser);
        logger.setUserId(currentUser.uid);
        setDiagnosticsAuthUid(currentUser.uid, { flush: true, reason: 'Auth:ensure_authenticated_route_set' });
        recordCrashBreadcrumb('Auth', 'ensure_authenticated', {
          hasAuthUid: true,
          isAnonymous: Boolean(currentUser.isAnonymous),
          authUidMasked: maskIdentifier(currentUser.uid),
        }, { remote: true, reason: 'Auth:ensure_authenticated' });
        logger.info('Auth', 'User authenticated', { uid: maskIdentifier(currentUser.uid) });
        await hydrateIdentityBindingForCurrentUser(currentUser.uid);
      }

      setInitializing(false);
      return unsubscribe;
    } catch (error) {
      if (typeof unsubscribe === 'function') unsubscribe();
      if (authUnsubscribeRef.current === unsubscribe) authUnsubscribeRef.current = null;
      logger.error('App', 'Initialization error', { error: error.message });
      setAuthError(STARTUP_CONNECTION_ERROR_MESSAGE);
      setInitializing(false);
      return null;
    }
  };

  const retryInitialization = async () => {
    setAuthError(null);
    setInitializing(true);
    await initializeApp();
  };

  const handleAuthStateChange = async (currentUser) => {
    setUser(currentUser);
    if (currentUser) {
      logger.setUserId(currentUser.uid);
    } else {
      logger.setUserId(null);
    }
    setDiagnosticsAuthUid(currentUser?.uid || null);
    setDiagnosticsContext('authState', {
      hasCurrentUser: Boolean(currentUser),
      isAnonymous: Boolean(currentUser?.isAnonymous),
      authUidMasked: currentUser?.uid ? maskIdentifier(currentUser.uid) : null,
    }, { flush: true });
    recordCrashBreadcrumb('Auth', 'state_changed', {
      hasCurrentUser: Boolean(currentUser),
      isAnonymous: Boolean(currentUser?.isAnonymous),
      authUidMasked: currentUser?.uid ? maskIdentifier(currentUser.uid) : null,
    }, { remote: true, reason: 'Auth:state_changed' });
    if (initializing) setInitializing(false);
  };

  const restoreSession = async () => {
    try {
      const [savedTourData, savedBookingData, lastScreen, savedIdentityBinding] = await SessionStorage.multiGet([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN,
        SESSION_KEYS.IDENTITY_BINDING,
      ]);
      
      if (savedIdentityBinding?.[1]) {
        try {
          const restoredBinding = JSON.parse(savedIdentityBinding[1]);
          if (restoredBinding && typeof restoredBinding === 'object') {
            setIdentityBinding(restoredBinding);
          }
        } catch (parseError) {
          logger.warn('Session', 'Failed to parse identity binding payload', { error: parseError.message });
        }
      }

      if (savedBookingData[1]) {
        const storedBookingData = JSON.parse(savedBookingData[1]);
        const storedTourData = savedTourData[1] ? JSON.parse(savedTourData[1]) : null;
        const isDriverBooking = Boolean(storedBookingData?.isDriver || storedBookingData?.id?.startsWith('D-'));
        const bookingData = isDriverBooking
          ? storedBookingData
          : normalizePassengerIdentityProjection(storedBookingData, storedBookingData?.id);
        const tourData = isDriverBooking
          ? storedTourData
          : normalizePassengerTourProjection(storedTourData, storedTourData?.id);
        if (!bookingData || !tourData) {
          logger.warn('Session', 'Passenger session requires a secure online refresh');
          return;
        }
        if (!isDriverBooking) {
          await SessionStorage.multiSet([
            [SESSION_KEYS.TOUR_DATA, JSON.stringify(tourData)],
            [SESSION_KEYS.BOOKING_DATA, JSON.stringify(bookingData)],
          ]);
        }
        const screen = lastScreen[1] || 'Login';
        
        setBookingData(bookingData);
        setTourData(tourData);
        if (tourData) setTourCode(tourData.tourCode);
        
        const fallbackScreen = bookingData.id && bookingData.id.startsWith('D-') ? 'DriverHome' : 'TourHome';
        const restoredScreen = screen === 'Login' || screen === 'NotificationPreferences' ? fallbackScreen : screen;
        setCurrentScreen(restoredScreen);
      }
    } catch (error) {
      logger.warn('Session', 'Failed to restore session', { error: error.message });
    }
  };

  const loadNotificationOnboardingState = async () => {
    try {
      const raw = await SessionStorage.multiGet([SESSION_KEYS.NOTIFICATION_ONBOARDING]);
      const serialized = raw?.[0]?.[1];
      if (!serialized) return null;
      const parsed = JSON.parse(serialized);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      logger.warn('NotificationOnboarding', 'Failed to load onboarding state', { error: error.message });
      return null;
    }
  };

  const saveNotificationOnboardingState = async (nextState = {}) => {
    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.NOTIFICATION_ONBOARDING, JSON.stringify(nextState)],
      ]);
    } catch (error) {
      logger.warn('NotificationOnboarding', 'Failed to persist onboarding state', { error: error.message });
    }
  };

  const shouldShowNotificationOnboarding = async ({ userId, audience }) => {
    const savedState = await loadNotificationOnboardingState();
    if (!savedState) return true;

    const sameUser = savedState?.userId && userId && savedState.userId === userId;
    const sameAudience = savedState?.audience === audience;
    const status = savedState?.status;

    if (status === 'completed' && sameUser && sameAudience) {
      return false;
    }

    if (status === 'skipped' && sameUser && sameAudience) {
      const skippedAtMs = parseTimestampMs(savedState?.updatedAt);
      if (Number.isFinite(skippedAtMs)) {
        return (Date.now() - skippedAtMs) >= NOTIFICATION_ONBOARDING_REMINDER_MS;
      }
      return false;
    }

    return true;
  };

  const saveSession = async (overrides = {}) => {
    try {
      const persistedTourData = Object.prototype.hasOwnProperty.call(overrides, 'tourData') ? overrides.tourData : tourData;
      const persistedBookingData = Object.prototype.hasOwnProperty.call(overrides, 'bookingData') ? overrides.bookingData : bookingData;
      const persistedScreen = Object.prototype.hasOwnProperty.call(overrides, 'currentScreen') ? overrides.currentScreen : currentScreen;
      const persistedIdentityBinding = Object.prototype.hasOwnProperty.call(overrides, 'identityBinding')
        ? overrides.identityBinding
        : identityBinding;

      const sessionEntries = [
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(persistedTourData)],
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(persistedBookingData)],
        [SESSION_KEYS.LAST_SCREEN, persistedScreen],
      ];

      if (persistedIdentityBinding) {
        sessionEntries.push([SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(persistedIdentityBinding)]);
      }

      await SessionStorage.multiSet(sessionEntries);
    } catch (error) {
      logger.error('Session', 'Failed to save session', { error: error.message });
    }
  };

  const handleDriverAssignmentChange = async ({ assignedTourId }) => {
    const normalizedAssignedTourId = normalizeTourId(assignedTourId);
    if (!normalizedAssignedTourId || !realtimeDb) {
      throw new Error('A valid assigned tour is required.');
    }

    const nextTourSnapshot = await realtimeDb.ref(`tours/${normalizedAssignedTourId}`).once('value');
    if (!nextTourSnapshot.exists()) {
      throw new Error('The assigned tour could not be loaded securely.');
    }
    const nextTourData = {
      id: normalizedAssignedTourId,
      ...(nextTourSnapshot.val() || {}),
    };
    const nextDeparture = driverTourPackService.resolveExactDepartureKey({
      tourId: normalizedAssignedTourId,
      startDate: nextTourData.startDate,
    });
    if (!nextDeparture.ok) {
      throw new Error('The assigned tour is missing a valid departure date. Dispatch must correct it before offline use.');
    }

    const updatedBookingData = {
      ...(bookingData || {}),
      assignedTourId: normalizedAssignedTourId,
      assignedTourCode: nextTourData.tourCode || bookingData?.assignedTourCode || null,
      assignedDepartureKey: nextDeparture.departureKey,
    };

    const previousScope = currentDriverLifecycleScope;
    const previousNormalized = previousScope
      ? driverOperationalLifecycleService.normalizeScope(previousScope)
      : null;
    const nextScope = {
      authUid: user?.uid || auth?.currentUser?.uid || null,
      driverId: updatedBookingData.id,
      departureKey: nextDeparture.departureKey,
      tourId: normalizedAssignedTourId,
      startDate: nextTourData.startDate,
    };
    const nextNormalized = driverOperationalLifecycleService.normalizeScope(nextScope);
    const changedDeparture = previousNormalized?.ok
      && nextNormalized.ok
      && (previousNormalized.driverId !== nextNormalized.driverId
        || previousNormalized.departureKey !== nextNormalized.departureKey);

    if (changedDeparture) {
      const purgeResult = await driverOperationalLifecycleService.purge(previousScope);
      if (!purgeResult.success) {
        logger.warn('DriverTourPack', 'Previous assignment data was only partially purged', {
          failedOperations: purgeResult.failures?.map((failure) => failure.name) || [],
        });
      }
    }

    previousDriverOperationalScopeRef.current = nextScope;
    driverLifecyclePurgeRef.current = null;
    setBookingData(updatedBookingData);
    setTourData(nextTourData);
    setTourCode(nextTourData.tourCode || '');
    setDriverSessionGeneration((value) => value + 1);

    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(updatedBookingData)],
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(nextTourData)],
      ]);
    } catch (error) {
      logger.error('Session', 'Failed to persist driver assignment', { error: error.message, assignedTourId: normalizedAssignedTourId });
    }

    return {
      tour: nextTourData,
      departureKey: nextDeparture.departureKey,
    };
  };
  driverAssignmentChangeRef.current = handleDriverAssignmentChange;

  useEffect(() => {
    const scope = currentDriverLifecycleScope;
    const currentAuthUid = user?.uid || null;
    if (!scope || !currentAuthUid || !realtimeDb) return undefined;

    const validationSeq = ++assignmentValidationSeqRef.current;
    const assignmentRef = realtimeDb.ref(`tour_manifests/${scope.tourId}/assigned_drivers/${scope.driverId}`);
    let handlingInvalidation = false;

    const handleInvalidAssignment = async (reason) => {
      if (handlingInvalidation || validationSeq !== assignmentValidationSeqRef.current) return;
      handlingInvalidation = true;
      try {
        const profileSnapshot = await realtimeDb.ref(`users/${currentAuthUid}/driverAssignedTourId`).once('value');
        const authoritativeTourId = normalizeTourId(profileSnapshot.val());
        if (authoritativeTourId && authoritativeTourId !== scope.tourId) {
          await driverAssignmentChangeRef.current?.({ assignedTourId: authoritativeTourId });
          return;
        }

        const purgeResult = await driverOperationalLifecycleService.purge(scope);
        if (!purgeResult.success) {
          logger.warn('DriverTourPack', 'Assignment validation failure only partially purged local data', {
            reason,
            failedOperations: purgeResult.failures?.map((failure) => failure.name) || [],
          });
        }
        if (validationSeq !== assignmentValidationSeqRef.current) return;

        const clearedBookingData = {
          ...(bookingData || {}),
          assignedTourId: null,
          assignedTourCode: null,
          assignedDepartureKey: null,
        };
        previousDriverOperationalScopeRef.current = null;
        setBookingData(clearedBookingData);
        setTourData(null);
        setTourCode('');
        setScreenParams({});
        setCurrentScreen('DriverHome');
        setDriverSessionGeneration((value) => value + 1);
        await SessionStorage.multiSet([
          [SESSION_KEYS.BOOKING_DATA, JSON.stringify(clearedBookingData)],
          [SESSION_KEYS.TOUR_DATA, JSON.stringify(null)],
          [SESSION_KEYS.LAST_SCREEN, 'DriverHome'],
        ]);
      } catch (error) {
        logger.warn('DriverTourPack', 'Could not reconcile failed driver assignment validation', {
          reason,
          error: error?.message || String(error),
        });
      } finally {
        handlingInvalidation = false;
      }
    };

    const onValue = (snapshot) => {
      if (snapshot.val() !== true) {
        handleInvalidAssignment('MANIFEST_ASSIGNMENT_MISSING');
      }
    };
    const onCancelled = () => {
      handleInvalidAssignment('MANIFEST_ASSIGNMENT_DENIED');
    };
    assignmentRef.on('value', onValue, onCancelled);

    return () => {
      assignmentValidationSeqRef.current += 1;
      assignmentRef.off('value', onValue);
    };
  }, [currentDriverLifecycleScopeKey, user?.uid]);

  const resolveOfflineLogin = async (reference, normalizedEmail) => resolveOfflineLoginFromCache({
    reference,
    normalizedEmail,
    sessionStorage: SessionStorage,
    sessionKeys: SESSION_KEYS,
    offlineSyncService,
    maskIdentifier,
    logger,
  });

  const handleLoginSuccess = async (reference, tourDetails, bookingOrDriverData, userType = 'passenger', options = {}) => {
    const targetScreen = userType === 'driver' ? 'DriverHome' : 'TourHome';
    const authUser = user || auth?.currentUser || null;
    const authUid = authUser?.uid || null;
    const loginDiagnosticsContext = options?.loginDiagnostics || (
      options?.loginDiagnosticId ? { attemptId: options.loginDiagnosticId } : null
    );
    await loginDiagnostics.recordLoginDiagnostic('app_login_success_handler_started', {
      userType,
      targetScreen,
      hasAuthUid: Boolean(authUid),
      authUid,
      authCurrentUserUid: auth?.currentUser?.uid || null,
      stateUserUid: user?.uid || null,
      hasTourDetails: Boolean(tourDetails),
      tourId: tourDetails?.id || null,
      tourCode: tourDetails?.tourCode || null,
      identityId: bookingOrDriverData?.id || null,
      alreadyHydrated: Boolean(options?.alreadyHydrated),
      offlineMode: Boolean(options?.offlineMode),
    }, loginDiagnosticsContext);
    recordCrashBreadcrumb('Auth', 'login_success_handler_started', {
      userType,
      targetScreen,
      hasAuthUid: Boolean(authUid),
      hasTourDetails: Boolean(tourDetails),
      tourId: tourDetails?.id || null,
      identityId: bookingOrDriverData?.id ? maskIdentifier(bookingOrDriverData.id) : null,
      alreadyHydrated: Boolean(options?.alreadyHydrated),
      offlineMode: Boolean(options?.offlineMode),
    }, { remote: true, reason: 'Auth:login_success_handler_started' });
    const durationMs = getLoginTransitionDurationMs({ alreadyHydrated: options?.alreadyHydrated });
    const showInterstitial = !options?.alreadyHydrated;
    if (showInterstitial) {
      startLoginTransition({ targetScreen, durationMs });
    }

    const onboardingAudience = userType === 'driver' ? 'driver' : 'passenger';
    const shouldOnboardNotifications = await shouldShowNotificationOnboarding({
      userId: authUid,
      audience: onboardingAudience,
    });
    const postLoginScreen = shouldOnboardNotifications ? 'NotificationPreferences' : targetScreen;
    await loginDiagnostics.recordLoginDiagnostic('notification_onboarding_decision_resolved', {
      userType,
      onboardingAudience,
      shouldOnboardNotifications,
      postLoginScreen,
      hasAuthUid: Boolean(authUid),
    }, loginDiagnosticsContext);

    if (userType === 'driver') {
      const assignedTourId = resolveTourId(tourDetails?.id, bookingOrDriverData?.assignedTourId);
      const departureIdentity = assignedTourId && tourDetails
        ? driverTourPackService.resolveExactDepartureKey({
            tourId: assignedTourId,
            startDate: tourDetails.startDate,
          })
        : { ok: false };
      const driverSessionData = {
        ...bookingOrDriverData,
        assignedTourId: assignedTourId || null,
        assignedDepartureKey: departureIdentity.ok ? departureIdentity.departureKey : null,
      };
      logger.info('Auth', 'Driver Logged In', { driverId: maskIdentifier(bookingOrDriverData.id) });
      if (authUid) {
        try {
          await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_started', {
            authUid,
            driverId: bookingOrDriverData?.id,
            assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
          }, loginDiagnosticsContext);
          const persisted = await persistDriverIdentityForUser({
            authUid,
            driverId: bookingOrDriverData?.id,
            assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
          });
          await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_succeeded', {
            authUid,
            driverId: persisted.driverId,
            assignedTourId: persisted.assignedTourId || null,
          }, loginDiagnosticsContext);
          logger.info('Identity', 'driver_identity_persist_success', {
            authUid: maskIdentifier(authUid),
            driverId: maskIdentifier(persisted.driverId),
            assignedTourId: persisted.assignedTourId || null,
          });
          recordCrashBreadcrumb('Identity', 'driver_identity_persist_success', {
            hasAuthUid: true,
            driverId: maskIdentifier(persisted.driverId),
            assignedTourId: persisted.assignedTourId || null,
          }, { remote: true, reason: 'Identity:driver_identity_persist_success' });
        } catch (error) {
          logger.error('Identity', 'driver_identity_persist_failure', {
            authUid: maskIdentifier(authUid),
            driverId: maskIdentifier(bookingOrDriverData?.id),
            assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
            error: error.message,
            code: error?.code || null,
          });
          await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_failed', {
            authUid,
            driverId: bookingOrDriverData?.id,
            assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
            error: loginDiagnostics.summarizeError(error),
          }, loginDiagnosticsContext);
          recordCrashBreadcrumb('Identity', 'driver_identity_persist_failure', {
            hasAuthUid: true,
            driverId: maskIdentifier(bookingOrDriverData?.id),
            assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
            error: error.message,
            code: error?.code || null,
          }, { remote: true, reason: 'Identity:driver_identity_persist_failure' });
        }
      } else {
        recordCrashBreadcrumb('Identity', 'driver_identity_persist_skipped_no_auth_user', {
          driverId: maskIdentifier(bookingOrDriverData?.id),
          assignedTourId: tourDetails?.id || bookingOrDriverData?.assignedTourId || null,
        }, { remote: true, reason: 'Identity:driver_identity_persist_skipped_no_auth_user' });
      }
      setTourCode(tourDetails?.tourCode || '');
      setTourData(tourDetails || null);
      setBookingData(driverSessionData);
      driverLifecyclePurgeRef.current = null;
      setCurrentScreen(postLoginScreen);
      recordCrashBreadcrumb('Auth', 'driver_login_session_established', {
        postLoginScreen,
        hasAuthUid: Boolean(authUid),
        driverId: maskIdentifier(bookingOrDriverData?.id),
        tourId: tourDetails?.id || null,
      }, { remote: true, reason: 'Auth:driver_login_session_established' });
      if (tourDetails?.id) {
        await loginDiagnostics.recordLoginDiagnostic('driver_offline_pack_save_started', {
          tourId: tourDetails.id,
          driverId: bookingOrDriverData?.id,
        }, loginDiagnosticsContext);
        await offlineSyncService.saveTourPack(tourDetails.id, 'driver', {
          tour: tourDetails,
          driver: driverSessionData,
        }, { ownerId: bookingOrDriverData?.id });
        await offlineSyncService.setTourPackMeta(
          tourDetails.id,
          'driver',
          { lastSyncedAt: new Date().toISOString() },
          { ownerId: bookingOrDriverData?.id },
        );
        await loginDiagnostics.recordLoginDiagnostic('driver_offline_pack_save_succeeded', {
          tourId: tourDetails.id,
          driverId: bookingOrDriverData?.id,
        }, loginDiagnosticsContext);
      }
      await loginDiagnostics.recordLoginDiagnostic('driver_session_save_started', {
        postLoginScreen,
        tourId: tourDetails?.id || null,
        driverId: bookingOrDriverData?.id || null,
      }, loginDiagnosticsContext);
      await saveSession({
        tourData: tourDetails || null,
        bookingData: driverSessionData,
        currentScreen: postLoginScreen,
      });
      await loginDiagnostics.recordLoginDiagnostic('driver_session_save_succeeded', {
        postLoginScreen,
        tourId: tourDetails?.id || null,
        driverId: bookingOrDriverData?.id || null,
      }, loginDiagnosticsContext);

      if (shouldOnboardNotifications) {
        setScreenParams({
          isOnboarding: true,
          audience: 'driver',
          returnTo: 'DriverHome',
        });
      }
      await loginDiagnostics.recordLoginDiagnostic('app_login_success_handler_completed', {
        userType,
        postLoginScreen,
        targetScreen,
        tourId: tourDetails?.id || null,
        identityId: bookingOrDriverData?.id || null,
        shouldOnboardNotifications,
      }, loginDiagnosticsContext);
      return;
    }

    const normalizedBookingData = {
      ...bookingOrDriverData,
      normalizedPassengerEmail: normalizePassengerEmail(bookingOrDriverData?.normalizedPassengerEmail),
    };
    const { stablePassengerId, identityVersion } = bookingService.buildPassengerStableIdentity({
      bookingRef: normalizedBookingData?.id,
      normalizedEmail: normalizedBookingData?.normalizedPassengerEmail,
    });
    const nextIdentityBinding = stablePassengerId
      ? {
          stablePassengerId,
          stablePassengerKey: toRealtimeKeySegment(stablePassengerId),
          identityVersion: identityVersion || IDENTITY_VERSION,
          bookingRef: normalizedBookingData?.id || null,
          normalizedPassengerEmail: normalizedBookingData?.normalizedPassengerEmail || null,
          authUid,
        }
      : null;

    if (!options?.offlineMode && tourDetails?.id) {
      if (!authUid) {
        clearLoginTransitionArtifacts();
        setLoginTransition(null);
        loginProgress.setValue(0);
        const authFailure = new Error('Authenticated tour session unavailable');
        authFailure.userMessage = 'We could not start a secure tour session. Please check your connection and try again.';
        await loginDiagnostics.recordLoginDiagnostic('passenger_join_blocked_missing_auth_uid', {
          tourId: tourDetails.id,
          authCurrentUserUid: auth?.currentUser?.uid || null,
          stateUserUid: user?.uid || null,
        }, loginDiagnosticsContext);
        throw authFailure;
      }

      try {
        await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_started', {
          tourId: tourDetails.id,
          authUid,
          bookingRef: normalizedBookingData?.id || null,
        }, loginDiagnosticsContext);
        const joinResult = await joinTour(tourDetails.id, authUid, undefined, {
          loginDiagnostics: loginDiagnosticsContext,
          tourProjection: tourDetails,
        });
        await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_succeeded', {
          tourId: tourDetails.id,
          authUid,
          currentParticipants: joinResult?.currentParticipants,
          alreadyJoined: Boolean(joinResult?.alreadyJoined),
        }, loginDiagnosticsContext);
      } catch (error) {
        clearLoginTransitionArtifacts();
        setLoginTransition(null);
        loginProgress.setValue(0);
        logger.error('Tour', 'Error joining tour', {
          error: error.message,
          code: error?.code || null,
          tourId: tourDetails.id,
          authUid: maskIdentifier(authUid),
        });
        await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_failed', {
          tourId: tourDetails.id,
          authUid,
          bookingRef: normalizedBookingData?.id || null,
          error: loginDiagnostics.summarizeError(error),
        }, loginDiagnosticsContext);
        const joinFailure = new Error('Unable to join tour session');
        joinFailure.userMessage = 'We could not finish joining your tour session. Please check your connection and try again.';
        throw joinFailure;
      }
    }

    if (nextIdentityBinding) {
      setIdentityBinding(nextIdentityBinding);
    }

    logger.info('Navigation', 'Passenger Login', { bookingRef: maskIdentifier(reference) });
    setTourCode(tourDetails?.tourCode || '');
    setTourData(tourDetails || null);
    setBookingData(normalizedBookingData);

    if (authUid && normalizedBookingData?.id && realtimeDb) {
      try {
        if (!stablePassengerId || !normalizedBookingData?.normalizedPassengerEmail) {
          logger.warn('Identity', 'Stable identity unavailable during passenger login', {
            reason: 'STABLE_ID_UNAVAILABLE',
            authUid: maskIdentifier(authUid),
            bookingRef: maskIdentifier(normalizedBookingData.id),
          });
        }

        await loginDiagnostics.recordLoginDiagnostic('passenger_identity_persist_started', {
          authUid,
          bookingRef: normalizedBookingData.id,
          normalizedPassengerEmail: normalizedBookingData.normalizedPassengerEmail,
          stablePassengerId,
          identityVersion,
        }, loginDiagnosticsContext);
        const persisted = await persistPassengerIdentityForUser({
          authUid,
          stablePassengerId,
          identityVersion,
          bookingRef: normalizedBookingData.id,
          normalizedPassengerEmail: normalizedBookingData.normalizedPassengerEmail,
        });
        await loginDiagnostics.recordLoginDiagnostic('passenger_identity_persist_succeeded', {
          authUid,
          bookingRef: normalizedBookingData.id,
          stablePassengerId,
          stablePassengerKey: persisted.stablePassengerKey || null,
        }, loginDiagnosticsContext);
        logger.info('Identity', 'identity_binding_persist_success', {
          authUid: maskIdentifier(authUid),
          bookingRef: maskIdentifier(normalizedBookingData.id),
          stablePassengerId: stablePassengerId ? maskIdentifier(stablePassengerId) : null,
          stablePassengerKey: persisted.stablePassengerKey ? maskIdentifier(persisted.stablePassengerKey) : null,
        });
      } catch (error) {
        if (error?.criticalIdentityPersistence) {
          clearLoginTransitionArtifacts();
          setLoginTransition(null);
          loginProgress.setValue(0);
        }

        const sourceError = error?.cause || error;
        const sourceErrorMessage = sourceError?.message || error?.message || '';
        const sourceErrorCode = sourceError?.code || error?.code || null;
        const isIdentityBindingWriteRejected = sourceErrorCode === 'PERMISSION_DENIED'
          || /permission_denied/i.test(sourceErrorMessage)
          || /Permission denied/i.test(sourceErrorMessage);
        logger.error('Identity', 'identity_binding_persist_failure', {
          error: sourceErrorMessage,
          code: sourceErrorCode,
          critical: Boolean(error?.criticalIdentityPersistence),
          reason: isIdentityBindingWriteRejected ? 'IDENTITY_BINDING_WRITE_DENIED_OR_INVALID' : 'IDENTITY_BINDING_WRITE_FAILED',
          authUid: maskIdentifier(authUid),
          bookingRef: maskIdentifier(normalizedBookingData.id),
          stablePassengerId: stablePassengerId ? maskIdentifier(stablePassengerId) : null,
          stablePassengerKey: stablePassengerId ? maskIdentifier(toRealtimeKeySegment(stablePassengerId)) : null,
        });
        await loginDiagnostics.recordLoginDiagnostic('passenger_identity_persist_failed', {
          authUid,
          bookingRef: normalizedBookingData.id,
          normalizedPassengerEmail: normalizedBookingData.normalizedPassengerEmail,
          stablePassengerId,
          stablePassengerKey: stablePassengerId ? toRealtimeKeySegment(stablePassengerId) : null,
          critical: Boolean(error?.criticalIdentityPersistence),
          reason: isIdentityBindingWriteRejected ? 'IDENTITY_BINDING_WRITE_DENIED_OR_INVALID' : 'IDENTITY_BINDING_WRITE_FAILED',
          error: loginDiagnostics.summarizeError(sourceError),
        }, loginDiagnosticsContext);

        if (error?.criticalIdentityPersistence) {
          throw error;
        }
      }
    }

    setCurrentScreen(postLoginScreen);
    if (tourDetails?.id) {
      await loginDiagnostics.recordLoginDiagnostic('passenger_offline_pack_save_started', {
        tourId: tourDetails.id,
        bookingRef: normalizedBookingData?.id || null,
      }, loginDiagnosticsContext);
      await offlineSyncService.saveTourPack(tourDetails.id, 'passenger', {
        tour: tourDetails,
        booking: normalizedBookingData,
        safety: { emergencyPhone: tourDetails?.driverPhone || null },
      }, { ownerId: normalizedBookingData?.id });
      await offlineSyncService.setTourPackMeta(
        tourDetails.id,
        'passenger',
        { lastSyncedAt: new Date().toISOString() },
        { ownerId: normalizedBookingData?.id },
      );
      await loginDiagnostics.recordLoginDiagnostic('passenger_offline_pack_save_succeeded', {
        tourId: tourDetails.id,
        bookingRef: normalizedBookingData?.id || null,
      }, loginDiagnosticsContext);
    }

    await loginDiagnostics.recordLoginDiagnostic('passenger_session_save_started', {
      postLoginScreen,
      tourId: tourDetails?.id || null,
      bookingRef: normalizedBookingData?.id || null,
      hasIdentityBinding: Boolean(nextIdentityBinding || identityBinding),
    }, loginDiagnosticsContext);
    await saveSession({
      tourData: tourDetails || null,
      bookingData: normalizedBookingData,
      currentScreen: postLoginScreen,
      identityBinding: nextIdentityBinding || identityBinding,
    });
    await loginDiagnostics.recordLoginDiagnostic('passenger_session_save_succeeded', {
      postLoginScreen,
      tourId: tourDetails?.id || null,
      bookingRef: normalizedBookingData?.id || null,
      hasIdentityBinding: Boolean(nextIdentityBinding || identityBinding),
    }, loginDiagnosticsContext);

    if (shouldOnboardNotifications) {
      setScreenParams({
        isOnboarding: true,
        audience: 'passenger',
        returnTo: 'TourHome',
      });
    }

    await loginDiagnostics.recordLoginDiagnostic('app_login_success_handler_completed', {
      userType,
      postLoginScreen,
      targetScreen,
      tourId: tourDetails?.id || null,
      identityId: normalizedBookingData?.id || bookingOrDriverData?.id || null,
      shouldOnboardNotifications,
    }, loginDiagnosticsContext);

  };

  const handleNotificationOnboardingComplete = async ({ status, audience, returnTo }) => {
    const normalizedStatus = status === 'completed' ? 'completed' : 'skipped';
    await saveNotificationOnboardingState({
      status: normalizedStatus,
      audience,
      userId: user?.uid || null,
      updatedAt: new Date().toISOString(),
    });
    navigateTo(returnTo || homeScreen, { from: 'NotificationPreferences', onboardingCompleted: normalizedStatus === 'completed' });
  };

  // Updated navigation to accept params
  const navigateTo = (screen, params = {}) => {
    logger.trackScreen(screen, { from: currentScreen, ...params });
    setScreenParams(params); // Store params for the next screen to use
    setCurrentScreen(screen);
    saveSession({ currentScreen: screen });
  };
  notificationNavigateRef.current = navigateTo;

  useEffect(() => {
    const activeTourId = tourData?.id;
    const authUserId = user?.uid;
    const hasAppSession = Boolean(bookingData?.id);
    if (!authUserId || !hasAppSession) return undefined;

    return subscribeToNotificationResponses({
      getContext: () => ({
        activeTourId,
        isDriver: Boolean(isDriverSession),
      }),
      onNavigate: async ({ screen, params }) => {
        const responseTourId = params?.tourId || activeTourId;
        if (params?.noticeId && responseTourId) {
          try {
            await markNotificationRead({
              tourId: responseTourId,
              userId: authUserId,
              noticeId: params.noticeId,
            });
          } catch (error) {
            logger.warn('Navigation', 'Notification read state could not be persisted', {
              screen,
              error: error?.message || String(error),
            });
          }
        }
        const navigate = notificationNavigateRef.current;
        if (typeof navigate !== 'function') {
          throw new Error('Notification navigation is not ready');
        }
        navigate(screen, params);
      },
    });
  }, [bookingData?.id, isDriverSession, tourData?.id, user?.uid]);

  useEffect(() => {
    if (!user?.uid || !tourData?.id) return;
    restorePushTokenForSession(user.uid).then((result) => {
      if (!result?.success) {
        logger.warn('NotificationService', 'Signed-in push token restore was deferred', {
          error: result?.error || 'unknown',
        });
      }
    });
  }, [tourData?.id, user?.uid]);

  const edgeSwipeResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => {
        if (!canSwipeToHome) return false;
        return isEligibleEdgeSwipe(gestureState);
      },
    onPanResponderRelease: (_, gestureState) => {
        if (!canSwipeToHome) return;
        if (!shouldCommitEdgeSwipeHome(gestureState)) return;

        logger.info('Navigation', 'Edge swipe home navigation triggered', {
          from: currentScreen,
          to: homeScreen,
          dx: gestureState?.dx,
          vx: gestureState?.vx,
        });
        navigateTo(homeScreen, { viaGesture: 'edge-swipe-home' });
      },
    onPanResponderTerminationRequest: () => true,
    });

  const clearSessionState = async ({ includeNotificationOnboarding = false } = {}) => {
    const keysToRemove = [
      SESSION_KEYS.TOUR_DATA,
      SESSION_KEYS.BOOKING_DATA,
      SESSION_KEYS.LAST_SCREEN,
      SESSION_KEYS.IDENTITY_BINDING,
    ];
    if (includeNotificationOnboarding) {
      keysToRemove.push(SESSION_KEYS.NOTIFICATION_ONBOARDING);
    }

    try {
      await SessionStorage.multiRemove(keysToRemove);
    } catch (error) {
      logger.warn('Auth', 'Persisted session cleanup failed; clearing in-memory session', {
        error: error?.message || String(error),
      });
    } finally {
      setTourCode('');
      setTourData(null);
      setBookingData(null);
      setIdentityBinding(null);
      setScreenParams({});
      setCurrentScreen('Login');
    }
  };

  const handleLogout = async () => {
    const authUid = user?.uid || auth?.currentUser?.uid || null;
    const [scopeResult, tokenResult, operationalPurgeResult] = await Promise.allSettled([
      offlineSyncService.setActiveSessionScope(null),
      authUid ? deactivatePushToken(authUid) : Promise.resolve({ success: true }),
      currentDriverLifecycleScope
        ? driverOperationalLifecycleService.purge(currentDriverLifecycleScope)
        : Promise.resolve({ success: true }),
    ]);

    if (scopeResult.status === 'rejected') {
      logger.warn('Auth', 'Offline session scope could not be cleared during logout', {
        error: scopeResult.reason?.message || String(scopeResult.reason),
      });
    }
    if (tokenResult.status === 'rejected' || tokenResult.value?.success === false) {
      logger.warn('Auth', 'Push token could not be deactivated during logout', {
        error: tokenResult.status === 'rejected'
          ? (tokenResult.reason?.message || String(tokenResult.reason))
          : tokenResult.value?.error,
      });
    }
    if (operationalPurgeResult.status === 'rejected' || operationalPurgeResult.value?.success === false) {
      const failures = operationalPurgeResult.status === 'fulfilled'
        ? operationalPurgeResult.value?.failures?.map((failure) => failure.name) || []
        : [];
      logger.warn('Auth', 'Driver operational data could not be completely purged during logout', {
        failedOperations: failures,
        error: operationalPurgeResult.status === 'rejected'
          ? (operationalPurgeResult.reason?.message || String(operationalPurgeResult.reason))
          : operationalPurgeResult.value?.error,
      });
    }

    previousDriverOperationalScopeRef.current = null;
    driverLifecyclePurgeRef.current = null;
    setDriverSessionGeneration((value) => value + 1);
    await clearSessionState();
  };

  const handleAccountDeleted = async (summary = {}) => {
    try {
      logger.info('Auth', 'Account deletion completed from UI', {
        deletedAuthUid: maskIdentifier(summary.deletedAuthUid),
        replacementAuthUid: maskIdentifier(summary.replacementAuthUid),
        warningCount: Array.isArray(summary.warnings) ? summary.warnings.length : 0,
      });
      const operationalPurge = currentDriverLifecycleScope
        ? driverOperationalLifecycleService.purge(currentDriverLifecycleScope)
        : offlineSyncService.setActiveSessionScope(null);
      await operationalPurge.catch((error) => {
        logger.warn('Auth', 'Offline operational data could not be cleared after account deletion', {
          error: error?.message || String(error),
        });
      });
      previousDriverOperationalScopeRef.current = null;
      driverLifecyclePurgeRef.current = null;
      setDriverSessionGeneration((value) => value + 1);
      await clearSessionState({ includeNotificationOnboarding: true });
      setUser(auth?.currentUser || null);
    } catch (error) {
      logger.error('Auth', 'Account deletion post-cleanup error', { error: error.message });
    }
  };

  useEffect(() => {
    if (!isConnected || !firebaseConnected || !offlineSessionScope) return;
    offlineSyncService.replayQueue({
      services: { bookingService, chatService, driverTourPackActionService },
      scope: offlineSessionScope,
    });
  }, [isConnected, firebaseConnected, offlineSessionScopeKey]);

  if (initializing) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['top']}>
        <ActivityIndicator size="large" color={COLORS.primaryBlue} />
        <Text style={styles.loadingText}>Connecting to Tour Services...</Text>
      </SafeAreaView>
    );
  }

  if (authError) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['top']}>
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Connection Error</Text>
        <Text style={styles.errorText}>{authError}</Text>
        <Text style={styles.errorDetail}>Check your internet connection, then try again. Your saved tour remains on this device.</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Retry connecting to tour services"
          style={styles.retryButton}
          onPress={retryInitialization}
        >
          <Text style={styles.retryButtonText}>Try again</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const renderScreen = () => {
    const screenProps = { isConnected, logger };

    switch (currentScreen) {
      case 'Login':
        return <LoginScreen {...screenProps} onLoginSuccess={handleLoginSuccess} resolveOfflineLogin={resolveOfflineLogin} />;
      case 'DriverHome':
        return (
          <DriverHomeScreen
            driverData={bookingData}
            onLogout={handleLogout}
            onNavigate={navigateTo} // Pass navigation prop
            onDriverAssignmentChange={handleDriverAssignmentChange}
            driverTourPackState={driverTourPackState}
            driverTourPackFeature={driverTourPackFeature}
          />
        );
      case 'DriverTourPack':
        if (!driverTourPackFeature.enabled) {
          return (
            <DriverHomeScreen
              driverData={bookingData}
              onLogout={handleLogout}
              onNavigate={navigateTo}
              onDriverAssignmentChange={handleDriverAssignmentChange}
              driverTourPackState={driverTourPackState}
              driverTourPackFeature={driverTourPackFeature}
            />
          );
        }
        return <DriverTourPackScreen packState={driverTourPackState} actionState={driverTourPackActions} isConnected={isConnected} tourData={tourData} driverData={bookingData} onBack={() => navigateTo('DriverHome')} onNavigate={navigateTo} />;
      case 'SafetySupport':
        return (
          <SafetySupportScreen
            onBack={() => navigateTo(screenParams?.from || 'TourHome')}
            tourData={tourData}
            bookingData={bookingData}
            userId={user?.uid}
            principalId={canonicalIdentity?.principalId}
            offlineCacheOwnerId={bookingData?.id}
            mode={screenParams?.mode || 'passenger'}
            isConnected={isConnected}
          />
        );
      case 'PassengerManifest':
        return (
          <PassengerManifestScreen
            driverTourPack={driverTourPackState?.pack || null}
            isConnected={isConnected}
            // 1. Pass the global 'screenParams' as 'route.params' so the screen can read 'tourId'
            route={{
              params: {
                ...screenParams,
                actorPrincipalId: canonicalIdentity?.principalId,
                authUid: canonicalIdentity?.authUid,
                offlineCacheOwnerId: bookingData?.id,
                sessionGeneration: driverSessionGeneration,
              },
            }}
            
            // 2. Mock the 'navigation' object so the screen's logic works without changing it
            navigation={{
              navigate: navigateTo,
              goBack: () => navigateTo(screenParams?.from || 'DriverHome')
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
        return (
          <PhotobookScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            onViewerVisibilityChange={handleViewerVisibilityChange}
            tourId={tourData?.id}
            privatePhotoOwnerId={canonicalIdentity?.principalId}
            stablePassengerId={canonicalIdentity?.stablePassengerId || null}
            canonicalIdentity={canonicalIdentity}
          />
        );
      case 'GroupPhotobook':
        return (
          <GroupPhotobookScreen
            {...screenProps}
            onBack={() => navigateTo('TourHome')}
            onViewerVisibilityChange={handleViewerVisibilityChange}
            userId={canonicalIdentity?.principalId}
            tourId={tourData?.id}
            userName={bookingData?.passengerNames?.[0] || 'Tour Member'}
            canonicalIdentity={canonicalIdentity}
          />
        );
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
            offlineCacheOwnerId={bookingData?.id}
          />
        );
      case 'DriverItinerary':
        return (
          <DriverItineraryScreen
            {...screenProps}
            onBack={() => navigateTo('DriverHome')}
            tourId={screenParams.tourId || tourData?.id}
            tourName={tourData?.name}
            offlineCacheOwnerId={bookingData?.id}
          />
        );
      case 'Chat':
        // Determine back destination based on user type
        const isDriver = screenParams.isDriver || (bookingData?.id && bookingData.id.startsWith('D-'));
        const backScreen = isDriver ? 'DriverHome' : 'TourHome';
        
        // Use params if passed (from DriverHome), otherwise fall back to standard state
        const chatTourId = resolveTourId(screenParams.tourId, tourData?.id, tourData?.tourCode);
        
        // Construct booking data for chat if we are in driver mode (since driver doesn't have standard bookingData)
        const effectiveBookingData = isDriver 
          ? {
              isDriver: true,
              passengerNames: [screenParams.driverName || bookingData?.name || 'Driver'],
            }
          : {
              ...(bookingData || {}),
            };

        return (
          <ChatScreen
            {...screenProps}
            onBack={() => navigateTo(backScreen)}
            tourId={chatTourId}
            bookingData={effectiveBookingData}
            tourData={tourData || { name: 'Tour Chat' }}
            internalDriverChat={screenParams.internalDriverChat === true}
            initialMessageId={screenParams.messageId || null}
            identityBinding={identityBinding}
            canonicalIdentity={canonicalIdentity}
          />
        );
      case 'Map':
        // Use active tour ID if passed, else fall back to session data
        const mapTourId = resolveTourId(screenParams.tourId, tourData?.id, tourData?.tourCode);
        const mapReturnTarget = screenParams?.from || (isDriverSession ? 'DriverHome' : 'TourHome');
        return <MapScreen {...screenProps} onBack={() => navigateTo(mapReturnTarget)} tourId={mapTourId} tourData={tourData} bookingData={bookingData} />;
      case 'NotificationPreferences':
        const notificationReturnTarget = screenParams?.returnTo || (isDriverSession ? 'DriverHome' : 'TourHome');
        const notificationPreferencesUserId = resolveAuthScopedUserId({
          canonicalIdentity,
          authUser: user,
        });
        return (
          <NotificationPreferencesScreen
            onBack={() => navigateTo(notificationReturnTarget, { from: 'NotificationPreferences' })}
            userId={notificationPreferencesUserId}
            isOnboarding={screenParams?.isOnboarding === true}
            audience={screenParams?.audience || (isDriverSession ? 'driver' : 'passenger')}
            returnTo={notificationReturnTarget}
            onComplete={handleNotificationOnboardingComplete}
            tourId={tourData?.id}
            initialMarketingCategoryKey={screenParams?.categoryKey || null}
            onNavigate={navigateTo}
          />
        );
      case 'AccountPrivacy':
        return (
          <AccountPrivacyScreen
            onBack={() => navigateTo(screenParams?.from || homeScreen)}
            onLogout={handleLogout}
            onAccountDeleted={handleAccountDeleted}
            tourData={tourData}
            bookingData={bookingData}
            canonicalIdentity={canonicalIdentity}
            identityBinding={identityBinding}
            isDriverSession={isDriverSession}
            sessionStorage={SessionStorage}
            sessionKeys={SESSION_KEYS}
          />
        );
      default:
        return <LoginScreen {...screenProps} onLoginSuccess={handleLoginSuccess} resolveOfflineLogin={resolveOfflineLogin} />;
    }
  };

  return (
    <>
      <StatusBar style="light" backgroundColor={COLORS.statusBarBackground} />
      <View
        pointerEvents="none"
        style={[
          styles.statusBarScrim,
          { height: insets.top },
        ]}
      />
      {loginTransition ? (
        <View style={[styles.loginTransitionOverlay, { top: insets.top + 8 }]}>
          <Text style={styles.loginTransitionText}>{loginTransition.message}</Text>
          <View style={styles.loginTransitionTrack}>
            <Animated.View
              style={[
                styles.loginTransitionFill,
                {
                  width: loginProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.screenContainer} {...edgeSwipeResponder.panHandlers}>
        {renderScreen()}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.appBackground, padding: 30 },
  loadingText: { marginTop: 15, fontSize: 16, color: COLORS.darkText, opacity: 0.8 },
  errorTitle: { fontSize: 22, fontWeight: 'bold', color: COLORS.errorRed, marginTop: 20, marginBottom: 10, textAlign: 'center' },
  errorIcon: { fontSize: 52 },
  screenContainer: { flex: 1 },
  statusBarScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.statusBarBackground,
    zIndex: 1000,
  },
  errorText: { fontSize: 16, color: COLORS.darkText, textAlign: 'center', marginBottom: 5 },
  errorDetail: { fontSize: 14, color: COLORS.darkText, opacity: 0.6, textAlign: 'center', marginTop: 15 },
  retryButton: {
    minHeight: 48,
    minWidth: 160,
    marginTop: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.primaryBlue,
  },
  retryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  loginTransitionOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 1001,
    backgroundColor: THEME.sync.info.background,
    borderWidth: 1,
    borderColor: THEME.sync.info.border,
    borderRadius: 10,
    padding: 10,
  },
  loginTransitionText: {
    color: THEME.sync.info.foreground,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  loginTransitionTrack: {
    height: 6,
    borderRadius: 99,
    backgroundColor: THEME.sync.info.background,
    borderWidth: 1,
    borderColor: THEME.sync.info.border,
    overflow: 'hidden',
  },
  loginTransitionFill: {
    height: '100%',
    backgroundColor: THEME.sync.info.foreground,
  },
});
