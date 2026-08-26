import { runPersistDriverIdentityForUser, runPersistPassengerIdentityForUser, runRepairIdentityBindingFromSession, runHydrateIdentityBindingForCurrentUser } from './session/identityBindingRunners';
import { runRefreshAppData, runInitializeApp, runRetryInitialization, runHandleAuthStateChange, runRestoreSession } from './session/sessionBootstrapRunners';
import { runLoadNotificationOnboardingState, runSaveNotificationOnboardingState, runShouldShowNotificationOnboarding, runHandleNotificationOnboardingComplete } from './notifications/notificationOnboardingRunners';
import { runHandleDriverAssignmentChange } from './driver/driverAssignmentRunners';
import { runResolveOfflineLogin, runHandleLoginSuccess } from './session/loginRunners';
import { runClearSessionState, runPurgeLocalSession, runHandleLogout, runHandleAccountDeleted } from './session/logoutRunners';
import AppShellView from './AppShellView';
import useNotificationSessionNavigation from './notifications/useNotificationSessionNavigation';
import useLogoutLifecycle from './session/useLogoutLifecycle';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { auth, authHelpers, realtimeDb } from '../../firebase';
import { joinTour } from '../../services/bookingServiceRealtime';
import logger, { maskIdentifier } from '../../services/loggerService';
import useDiagnostics from '../../hooks/useDiagnostics';
import offlineSyncService from '../../services/offlineSyncService';
import * as bookingService from '../../services/bookingServiceRealtime';
import * as chatService from '../../services/chatService';
import * as photoService from '../../services/photoService';
import { processOfflineQueue as processOfflineSafetyQueue } from '../../services/safetyService';
import offlineLoginResolver from '../../services/offlineLoginResolver';
import driverOperationalLifecycleService from '../../services/driverOperationalLifecycleService';
import appSessionService from '../../services/appSessionService';
import localSessionCleanupService from '../../services/localSessionCleanupService';
import driverTourPackService from '../../services/driverTourPackService';
import useDriverTourPack from '../../hooks/useDriverTourPack';
import useDriverTourPackActions from '../../hooks/useDriverTourPackActions';
import driverTourPackActionService from '../../services/driverTourPackActionService';
import useDriverTourPackFeatureFlag from '../../hooks/useDriverTourPackFeatureFlag';
import {
  PASSENGER_IDENTITY_VERSION,
  getCanonicalIdentity,
  isOpaquePassengerId,
  toRealtimeKeySegment,
} from '../../services/identityService';
import { normalizeTourId, resolveTourId } from '../../services/tourIdentityService';
import { parseTimestampMs } from '../../services/timeUtils';
import {
  installGlobalCrashDiagnostics,
  recordBreadcrumb as recordCrashBreadcrumb,
  setDiagnosticsAuthUid,
  setDiagnosticsContext,
} from '../../services/crashDiagnosticsService';
import loginDiagnostics from '../../services/loginDiagnosticsService';
import { SESSION_KEYS, SessionStorage, storageMode } from './session/sessionStorage';
const { clearNotificationFeedCache } = require('../../services/notificationInboxService');
import useLoginTransition from './navigation/useLoginTransition';
import useAppNavigation from './navigation/useAppNavigation';
const { getLoginTransitionDurationMs } = require('../../screens/loginFlow');
const {
  normalizePassengerIdentityProjection,
  normalizePassengerTourProjection,
} = require('../../services/passengerDataBoundary');
const IDENTITY_VERSION = PASSENGER_IDENTITY_VERSION;
const NOTIFICATION_ONBOARDING_REMINDER_MS = 24 * 60 * 60 * 1000;
const STARTUP_CONNECTION_ERROR_MESSAGE =
  'We could not connect to tour services. Please check your internet connection and restart the app.';

const { normalizePassengerEmail, resolveOfflineLoginFromCache } = offlineLoginResolver;
export default function AppShell() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [tourCode, setTourCode] = useState('');
  const [tourData, setTourData] = useState(null);
  const [bookingData, setBookingData] = useState(null);
  const [identityBinding, setIdentityBinding] = useState(null);
  const [appSession, setAppSession] = useState(null);
  const [logoutStatus, setLogoutStatus] = useState({ state: 'idle', error: null, diagnostic: null });

  const [driverSessionGeneration, setDriverSessionGeneration] = useState(0);
  const driverIdentityPersistKeyRef = useRef(null);
  const authUnsubscribeRef = useRef(null);
  const {
    clearLoginTransitionArtifacts,
    loginProgress,
    loginTransition,
    resetLoginTransition,
    startLoginTransition,
  } = useLoginTransition();
  const previousDriverOperationalScopeRef = useRef(null);
  const driverLifecyclePurgeRef = useRef(null);
  const driverAssignmentChangeRef = useRef(null);
  const assignmentValidationSeqRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const logoutContextRef = useRef(null);

  const isDriverSession = bookingData?.id && bookingData.id.startsWith('D-');
  const canonicalIdentity = useMemo(
    () => getCanonicalIdentity({ authUser: user, bookingData, identityBinding }),
    [user, bookingData, identityBinding]
  );
  const homeScreen = isDriverSession ? 'DriverHome' : 'TourHome';
  const driverTourPackFeature = useDriverTourPackFeatureFlag(isDriverSession ? bookingData?.id : null);
  const {
    currentScreen,
    edgeSwipeResponder,
    handleViewerVisibilityChange,
    isImageViewerVisible,
    navigateBack,
    navigateTo,
    routeHistoryRef,
    screenParams,
    setCurrentScreen,
    setScreenParams,
  } = useAppNavigation({
    driverTourPackFeature,
    homeScreen,
    persistScreen: (...args) => saveSession(...args),
  });

  const diagnosticsTourId = isDriverSession
    ? resolveTourId(bookingData?.assignedTourId, tourData?.id, tourData?.tourCode)
    : resolveTourId(tourData?.id, tourData?.tourCode);
  const diagnosticsRole = bookingData?.id?.startsWith('D-') ? 'driver' : 'passenger';
  const offlineSessionScope = useMemo(() => {
    const principalId = canonicalIdentity?.principalId;
    if (!appSession || !diagnosticsTourId || !principalId || principalId === 'anonymous'
      || appSession.tourId !== diagnosticsTourId || appSession.principalId !== principalId) return null;
    return {
      tourId: diagnosticsTourId,
      principalId,
      role: diagnosticsRole,
      authUid: canonicalIdentity?.authUid || null,
      cacheOwnerId: bookingData?.id || principalId,
      sessionId: appSession.sessionId,
    };
  }, [appSession, bookingData?.id, canonicalIdentity?.authUid, canonicalIdentity?.principalId, diagnosticsRole, diagnosticsTourId]);
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

  const refreshAppData = (...args) => runRefreshAppData({ bookingService, chatService, driverTourPackActionService, isConnected, logger, offlineSessionScope, offlineSyncService, photoService, processOfflineSafetyQueue }, ...args);

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
  }, [offlineSessionScope]);

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
      }).catch((error) => {
        logger.warn('DriverTourPack', 'Previous driver operational scope purge failed', {
          error: error?.message || String(error),
        });
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
  }, [currentDriverLifecycleScope, currentDriverLifecycleScopeKey, offlineSessionScope]);

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
    }).catch((error) => {
      logger.warn('DriverTourPack', 'Expired operational data purge failed', {
        error: error?.message || String(error),
        state: driverTourPackState.state,
      });
    });
  }, [
    currentDriverLifecycleScope,
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
  // Bootstrap and cleanup intentionally run once; runners capture the initial application boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const persistPassengerIdentityForUser = (...args) => runPersistPassengerIdentityForUser({ IDENTITY_VERSION, isOpaquePassengerId, realtimeDb, toRealtimeKeySegment }, ...args);

  const persistDriverIdentityForUser = useCallback((args) => (
    runPersistDriverIdentityForUser({ normalizeTourId, realtimeDb }, args)
  ), []);

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
    tourData?.tourCode,
    user?.uid,
  ]);

  const repairIdentityBindingFromSession = (...args) => runRepairIdentityBindingFromSession({ IDENTITY_VERSION, SESSION_KEYS, SessionStorage, isOpaquePassengerId, normalizePassengerEmail, persistPassengerIdentityForUser, setIdentityBinding, toRealtimeKeySegment }, ...args);

  const hydrateIdentityBindingForCurrentUser = (...args) => runHydrateIdentityBindingForCurrentUser({ IDENTITY_VERSION, SESSION_KEYS, SessionStorage, isOpaquePassengerId, logger, maskIdentifier, realtimeDb, repairIdentityBindingFromSession, setIdentityBinding, toRealtimeKeySegment }, ...args);

  const initializeApp = (...args) => runInitializeApp({ SESSION_KEYS, STARTUP_CONNECTION_ERROR_MESSAGE, SessionStorage, appSessionService, authHelpers, authUnsubscribeRef, handleAuthStateChange, hydrateIdentityBindingForCurrentUser, localSessionCleanupService, logger, maskIdentifier, recordCrashBreadcrumb, restoreSession, setAppSession, setAuthError, setDiagnosticsAuthUid, setInitializing, setLogoutStatus, setUser }, ...args);

  const retryInitialization = (...args) => runRetryInitialization({ initializeApp, setAuthError, setInitializing }, ...args);

  const handleAuthStateChange = (...args) => runHandleAuthStateChange({ initializing, logger, maskIdentifier, recordCrashBreadcrumb, setDiagnosticsAuthUid, setDiagnosticsContext, setInitializing, setUser }, ...args);

  const restoreSession = (...args) => runRestoreSession({ IDENTITY_VERSION, SESSION_KEYS, SessionStorage, isOpaquePassengerId, logger, normalizePassengerIdentityProjection, normalizePassengerTourProjection, routeHistoryRef, setBookingData, setCurrentScreen, setIdentityBinding, setTourCode, setTourData }, ...args);

  const loadNotificationOnboardingState = (...args) => runLoadNotificationOnboardingState({ SESSION_KEYS, SessionStorage, logger }, ...args);

  const saveNotificationOnboardingState = (...args) => runSaveNotificationOnboardingState({ SESSION_KEYS, SessionStorage, logger }, ...args);

  const shouldShowNotificationOnboarding = (...args) => runShouldShowNotificationOnboarding({ NOTIFICATION_ONBOARDING_REMINDER_MS, loadNotificationOnboardingState, parseTimestampMs }, ...args);

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

  const handleDriverAssignmentChange = (...args) => runHandleDriverAssignmentChange({ SESSION_KEYS, SessionStorage, auth, bookingData, currentDriverLifecycleScope, driverLifecyclePurgeRef, driverOperationalLifecycleService, driverTourPackService, logger, normalizeTourId, previousDriverOperationalScopeRef, realtimeDb, setBookingData, setDriverSessionGeneration, setTourCode, setTourData, user }, ...args);
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
        routeHistoryRef.current.reset();
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
  }, [
    bookingData,
    currentDriverLifecycleScope,
    currentDriverLifecycleScopeKey,
    routeHistoryRef,
    setCurrentScreen,
    setScreenParams,
    user?.uid,
  ]);

  const resolveOfflineLogin = (...args) => runResolveOfflineLogin({ SESSION_KEYS, SessionStorage, appSessionService, logger, maskIdentifier, offlineSyncService, resolveOfflineLoginFromCache }, ...args);

  const handleLoginSuccess = (...args) => runHandleLoginSuccess({ IDENTITY_VERSION, appSessionService, auth, bookingService, driverLifecyclePurgeRef, driverTourPackService, getLoginTransitionDurationMs, identityBinding, joinTour, logger, loginDiagnostics, maskIdentifier, normalizePassengerEmail, offlineSyncService, persistDriverIdentityForUser, persistPassengerIdentityForUser, realtimeDb, recordCrashBreadcrumb, resetLoginTransition, resolveTourId, routeHistoryRef, saveSession, sessionGenerationRef, setAppSession, setBookingData, setCurrentScreen, setIdentityBinding, setLogoutStatus, setScreenParams, setTourCode, setTourData, shouldShowNotificationOnboarding, startLoginTransition, toRealtimeKeySegment, user }, ...args);

  const handleNotificationOnboardingComplete = (...args) => runHandleNotificationOnboardingComplete({ homeScreen, navigateTo, saveNotificationOnboardingState, user }, ...args);

  useNotificationSessionNavigation({ authUid: user?.uid, appSession, bookingId: bookingData?.id, isConnected, isDriver: isDriverSession, navigateTo, tourId: tourData?.id });

  const clearSessionState = (...args) => runClearSessionState({ SESSION_KEYS, SessionStorage, logger, routeHistoryRef, setBookingData, setCurrentScreen, setIdentityBinding, setScreenParams, setTourCode, setTourData }, ...args);

  const purgeLocalSession = (...args) => runPurgeLocalSession({ appSession, auth, bookingData, clearSessionState, currentDriverLifecycleScope, driverLifecyclePurgeRef, localSessionCleanupService, previousDriverOperationalScopeRef, setAppSession, setDriverSessionGeneration, tourData, user }, ...args);

  const handleLogout = (...args) => runHandleLogout({ appSession, appSessionService, auth, bookingData, currentDriverLifecycleScope, logger, logoutContextRef, purgeLocalSession, setAppSession, setLogoutStatus, tourData, user }, ...args);

  const retryPendingLogout = useLogoutLifecycle({
    appSession,
    isConnected,
    logoutContextRef,
    logoutStatus,
    purgeLocalSession,
    sessionGenerationRef,
    setCurrentScreen,
    setLogoutStatus,
    userUid: user?.uid,
  });

  const handleAccountDeleted = (...args) => runHandleAccountDeleted({ auth, clearNotificationFeedCache, clearSessionState, currentDriverLifecycleScope, driverLifecyclePurgeRef, driverOperationalLifecycleService, logger, maskIdentifier, offlineSyncService, previousDriverOperationalScopeRef, setAppSession, setDriverSessionGeneration, setUser }, ...args);

  useEffect(() => {
    if (!isConnected || !firebaseConnected || !offlineSessionScope) return;
    Promise.allSettled([
      offlineSyncService.replayQueue({
        services: { bookingService, chatService, photoService, driverTourPackActionService },
        scope: offlineSessionScope,
      }),
      processOfflineSafetyQueue(offlineSessionScope),
    ]).catch((error) => {
      logger.warn('OfflineSync', 'Foreground replay coordination failed', {
        error: error?.message || String(error),
      });
    });
  }, [isConnected, firebaseConnected, offlineSessionScope, offlineSessionScopeKey]);

  return (
    <AppShellView
      authError={authError}
      edgeSwipeResponder={edgeSwipeResponder}
      initializing={initializing}
      insets={insets}
      isConnected={isConnected}
      loginProgress={loginProgress}
      loginTransition={loginTransition}
      logoutStatus={logoutStatus}
      retryInitialization={retryInitialization}
      retryPendingLogout={retryPendingLogout}
      routerProps={{
        bookingData,
        canonicalIdentity,
        currentScreen,
        driverSessionGeneration,
        driverTourPackActions,
        driverTourPackFeature,
        driverTourPackState,
        handleAccountDeleted,
        handleDriverAssignmentChange,
        handleLoginSuccess,
        handleLogout,
        handleNotificationOnboardingComplete,
        handleViewerVisibilityChange,
        homeScreen,
        identityBinding,
        isConnected,
        isDriverSession,
        navigateBack,
        navigateTo,
        offlineSessionScope,
        resolveOfflineLogin,
        screenParams,
        tourCode,
        tourData,
        user,
      }}
    />
  );
}
