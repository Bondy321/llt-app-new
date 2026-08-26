import { endNotificationDeviceSession } from '../../../services/notifications/notificationDeviceApiService';

export const runClearSessionState = async ({ SESSION_KEYS, SessionStorage, logger, routeHistoryRef, setBookingData, setCurrentScreen, setIdentityBinding, setScreenParams, setTourCode, setTourData }, {
  includeNotificationOnboarding = false
} = {}) => {
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
      routeHistoryRef.current.reset();
      setCurrentScreen('Login');
    }
  };

export const runPurgeLocalSession = async ({ appSession, auth, bookingData, clearSessionState, currentDriverLifecycleScope, driverLifecyclePurgeRef, localSessionCleanupService, previousDriverOperationalScopeRef, setAppSession, setDriverSessionGeneration, tourData, user }, {
  capturedSession = appSession
} = {}) => {
    const result = await localSessionCleanupService.cleanup({
      authUid: user?.uid || auth?.currentUser?.uid || null,
      appSession: capturedSession,
      bookingData,
      tourData,
      driverOperationalScope: currentDriverLifecycleScope,
    });
    previousDriverOperationalScopeRef.current = null;
    driverLifecyclePurgeRef.current = null;
    setDriverSessionGeneration((value) => value + 1);
    setAppSession(null);
    await clearSessionState();
    return result;
  };

export const runHandleLogout = async ({ appSession, appSessionService, auth, bookingData, currentDriverLifecycleScope, logger, logoutContextRef, notificationDeviceEnd = endNotificationDeviceSession, purgeLocalSession, setAppSession, setLogoutStatus, tourData, user }) => {
    const authUid = user?.uid || auth?.currentUser?.uid || null;
    const capturedSession = appSession;
    // Server policy keeps marketing only where explicit consent remains, while
    // immediately removing operational eligibility for this app session.
    if (authUid) {
      notificationDeviceEnd().catch((error) => logger.warn('NotificationService', 'Notification logout reconciliation deferred', {
        error: error?.message || String(error),
      }));
    }
    logoutContextRef.current = {
      authUid,
      appSession: capturedSession,
      bookingData,
      tourData,
      driverOperationalScope: currentDriverLifecycleScope,
    };
    if (!authUid || !capturedSession) {
      const cleanup = await purgeLocalSession({ capturedSession });
      if (cleanup.success) await appSessionService.completeEnd();
      return;
    }
    setLogoutStatus({ state: 'requesting', error: null, diagnostic: capturedSession.sessionId.slice(-6) });
    const serverResult = await appSessionService.endSession({ authUid, session: capturedSession });
    if (serverResult.reason === 'SESSION_CHANGED') {
      try {
        const current = await appSessionService.verifyCurrent({ authUid, expectedSession: capturedSession });
        if (current.reason === 'SESSION_CHANGED' && current.session) {
          await appSessionService.persistSession(current.session);
          await appSessionService.clearPendingEnd();
          setAppSession(current.session);
          setLogoutStatus({ state: 'idle', error: null, diagnostic: null });
          return;
        }
      } catch (error) {
        logger.warn('Auth', 'Could not resolve changed session after logout response', { error: error?.message || String(error) });
      }
    }

    const cleanup = await purgeLocalSession({ capturedSession });
    if (!cleanup.success) {
      setLogoutStatus({
        state: 'failed',
        error: 'Some private data could not be removed from this device. Try again before continuing.',
        diagnostic: capturedSession.sessionId.slice(-6),
      });
      return;
    }
    if (serverResult.success) {
      await appSessionService.completeEnd();
      logoutContextRef.current = null;
      setLogoutStatus({ state: 'complete', error: null, diagnostic: null });
      return;
    }
    setLogoutStatus({
      state: 'pending_network',
      error: serverResult.reason === 'NETWORK_ERROR'
        ? 'We could not reach the server. Logout will finish automatically when you reconnect.'
        : 'The server could not confirm logout yet. Try again when connected.',
      diagnostic: capturedSession.sessionId.slice(-6),
    });
  };

export const runHandleAccountDeleted = async ({ auth, clearNotificationFeedCache, clearSessionState, currentDriverLifecycleScope, driverLifecyclePurgeRef, driverOperationalLifecycleService, logger, maskIdentifier, offlineSyncService, previousDriverOperationalScopeRef, setAppSession, setDriverSessionGeneration, setUser }, summary = {}) => {
    try {
      logger.info('Auth', 'Account deletion completed from UI', {
        deletedAuthUid: maskIdentifier(summary.deletedAuthUid),
        replacementAuthUid: maskIdentifier(summary.replacementAuthUid),
        warningCount: Array.isArray(summary.warnings) ? summary.warnings.length : 0,
      });
      const operationalPurge = currentDriverLifecycleScope
        ? driverOperationalLifecycleService.purge(currentDriverLifecycleScope)
        : offlineSyncService.setActiveSessionScope(null);
      const deletedAuthUid = summary.deletedAuthUid || null;
      const [operationalResult, notificationCacheResult] = await Promise.allSettled([
        operationalPurge,
        deletedAuthUid ? clearNotificationFeedCache({ userId: deletedAuthUid }) : Promise.resolve(0),
      ]);
      if (operationalResult.status === 'rejected') {
        logger.warn('Auth', 'Offline operational data could not be cleared after account deletion', {
          error: operationalResult.reason?.message || String(operationalResult.reason),
        });
      }
      if (notificationCacheResult.status === 'rejected') {
        logger.warn('Auth', 'Saved notification updates could not be cleared after account deletion', {
          error: notificationCacheResult.reason?.message || String(notificationCacheResult.reason),
        });
      }
      previousDriverOperationalScopeRef.current = null;
      driverLifecyclePurgeRef.current = null;
      setDriverSessionGeneration((value) => value + 1);
      setAppSession(null);
      await clearSessionState({ includeNotificationOnboarding: true });
      setUser(auth?.currentUser || null);
    } catch (error) {
      logger.error('Auth', 'Account deletion post-cleanup error', { error: error.message });
    }
  };
