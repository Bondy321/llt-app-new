export const runRefreshAppData = async ({ bookingService, chatService, driverTourPackActionService, isConnected, logger, offlineSessionScope, offlineSyncService, photoService, processOfflineSafetyQueue }) => {
    logger.info('App', 'Refreshing app data');
    if (!isConnected) return;
    await Promise.allSettled([
      offlineSyncService.replayQueue({
        services: { bookingService, chatService, photoService, driverTourPackActionService },
        scope: offlineSessionScope,
      }),
      offlineSessionScope
        ? processOfflineSafetyQueue(offlineSessionScope)
        : Promise.resolve({ deferred: true, reason: 'scope_required' }),
    ]);
  };

export const runInitializeApp = async ({ SESSION_KEYS, STARTUP_CONNECTION_ERROR_MESSAGE, SessionStorage, appSessionService, authHelpers, authUnsubscribeRef, handleAuthStateChange, hydrateIdentityBindingForCurrentUser, localSessionCleanupService, logger, maskIdentifier, recordCrashBreadcrumb, restoreSession, setAppSession, setAuthError, setDiagnosticsAuthUid, setInitializing, setLogoutStatus, setUser }) => {
    let unsubscribe = null;
    try {
      setAuthError(null);
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
      }

      const pendingEnd = await appSessionService.readPendingEnd();
      if (pendingEnd) {
        const [savedTourEntry, savedBookingEntry] = await SessionStorage.multiGet([
          SESSION_KEYS.TOUR_DATA,
          SESSION_KEYS.BOOKING_DATA,
        ]);
        const cachedForCleanup = await appSessionService.readSession({ allowExpired: true });
        const parseSaved = (entry) => {
          try { return entry?.[1] ? JSON.parse(entry[1]) : null; } catch { return null; }
        };
        await localSessionCleanupService.cleanup({
          authUid: currentUser?.uid || pendingEnd.authUid,
          appSession: cachedForCleanup,
          bookingData: parseSaved(savedBookingEntry),
          tourData: parseSaved(savedTourEntry),
        });
        await restoreSession(null);
        setAppSession(null);
        setLogoutStatus({
          state: 'pending_network',
          error: 'We still need to confirm logout with the server.',
          diagnostic: pendingEnd.sessionId.slice(-6),
        });
      } else {
        const cachedSession = await appSessionService.readSession();
        let activeSession = cachedSession;
        if (cachedSession && currentUser?.uid) {
          try {
            const verification = await appSessionService.verifyCurrent({
              authUid: currentUser.uid,
              expectedSession: cachedSession,
            });
            activeSession = verification.valid ? verification.session : null;
            if (activeSession) await appSessionService.persistSession(activeSession);
          } catch (error) {
            // A still-unexpired cached session is the only bounded offline restore.
            // Reconnect validation and the remote listener remain mandatory.
            activeSession = cachedSession;
            logger.warn('Session', 'Secure session verification deferred while offline', {
              error: error?.message || String(error),
            });
          }
        }
        if (!activeSession) {
          await appSessionService.clearSession();
          await restoreSession(null);
          setAppSession(null);
        } else {
          setAppSession(activeSession);
          await restoreSession(activeSession);
          await hydrateIdentityBindingForCurrentUser(currentUser.uid);
        }
      }

      if (typeof authUnsubscribeRef.current === 'function') authUnsubscribeRef.current();
      unsubscribe = authHelpers.onAuthStateChanged(handleAuthStateChange);
      authUnsubscribeRef.current = unsubscribe;

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

export const runRetryInitialization = async ({ initializeApp, setAuthError, setInitializing }) => {
    setAuthError(null);
    setInitializing(true);
    await initializeApp();
  };

export const runHandleAuthStateChange = async ({ initializing, logger, maskIdentifier, recordCrashBreadcrumb, setDiagnosticsAuthUid, setDiagnosticsContext, setInitializing, setUser }, currentUser) => {
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

export const runRestoreSession = async ({ IDENTITY_VERSION, SESSION_KEYS, SessionStorage, isOpaquePassengerId, logger, normalizePassengerIdentityProjection, normalizePassengerTourProjection, routeHistoryRef, setBookingData, setCurrentScreen, setIdentityBinding, setTourCode, setTourData }, validAppSession) => {
    try {
      if (!validAppSession) {
        await SessionStorage.multiRemove([
          SESSION_KEYS.TOUR_DATA,
          SESSION_KEYS.BOOKING_DATA,
          SESSION_KEYS.LAST_SCREEN,
          SESSION_KEYS.IDENTITY_BINDING,
        ]);
        return false;
      }
      const [savedTourData, savedBookingData, lastScreen, savedIdentityBinding] = await SessionStorage.multiGet([
        SESSION_KEYS.TOUR_DATA,
        SESSION_KEYS.BOOKING_DATA,
        SESSION_KEYS.LAST_SCREEN,
        SESSION_KEYS.IDENTITY_BINDING,
      ]);
      
      if (savedIdentityBinding?.[1]) {
        try {
          const restoredBinding = JSON.parse(savedIdentityBinding[1]);
          if (restoredBinding && typeof restoredBinding === 'object'
            && isOpaquePassengerId(restoredBinding.stablePassengerId)
            && restoredBinding.identityVersion === IDENTITY_VERSION) {
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
        if (!isDriverBooking && (!isOpaquePassengerId(storedBookingData?.stablePassengerId)
          || storedBookingData?.identityVersion !== IDENTITY_VERSION)) {
          await SessionStorage.multiRemove([
            SESSION_KEYS.TOUR_DATA,
            SESSION_KEYS.BOOKING_DATA,
            SESSION_KEYS.LAST_SCREEN,
            SESSION_KEYS.IDENTITY_BINDING,
          ]);
          logger.warn('Session', 'Legacy passenger session invalidated; online verification required');
          return;
        }
        const bookingData = isDriverBooking
          ? storedBookingData
          : normalizePassengerIdentityProjection(storedBookingData, storedBookingData?.id);
        const tourData = isDriverBooking
          ? storedTourData
          : normalizePassengerTourProjection(storedTourData, storedTourData?.id);
        const matchesRole = isDriverBooking
          ? validAppSession.principalType === 'driver'
            && validAppSession.driverId === bookingData?.id
          : validAppSession.principalType === 'passenger'
            && validAppSession.principalId === bookingData?.stablePassengerId;
        const matchesTour = validAppSession.tourId === (tourData?.id || bookingData?.assignedTourId || null);
        if (!bookingData || !matchesRole || !matchesTour || (validAppSession.tourId && !tourData)) {
          await SessionStorage.multiRemove([
            SESSION_KEYS.TOUR_DATA,
            SESSION_KEYS.BOOKING_DATA,
            SESSION_KEYS.LAST_SCREEN,
            SESSION_KEYS.IDENTITY_BINDING,
          ]);
          logger.warn('Session', 'Saved app data does not match the active secure session');
          return false;
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
        routeHistoryRef.current.reset();
        setCurrentScreen(restoredScreen);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn('Session', 'Failed to restore session', { error: error.message });
      return false;
    }
  };
