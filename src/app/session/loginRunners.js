export const runResolveOfflineLogin = async ({ SESSION_KEYS, SessionStorage, appSessionService, logger, maskIdentifier, offlineSyncService, resolveOfflineLoginFromCache }, reference, normalizedEmail) => {
    if (await appSessionService.readPendingEnd()) {
      return { success: false, reason: 'LOGOUT_PENDING', error: 'Logout must finish online before this device can reopen a tour.' };
    }
    const cachedAppSession = await appSessionService.readSession();
    if (!cachedAppSession) {
      return { success: false, reason: 'ONLINE_VERIFICATION_REQUIRED', error: 'Connect to the internet to start a secure tour session.' };
    }
    const result = await resolveOfflineLoginFromCache({
      reference,
      normalizedEmail,
      sessionStorage: SessionStorage,
      sessionKeys: SESSION_KEYS,
      offlineSyncService,
      maskIdentifier,
      logger,
    });
    if (!result?.success) return result;
    const identityId = result.type === 'driver' ? result.identity?.id : result.identity?.stablePassengerId;
    const expectedTourId = result.tour?.id || result.identity?.assignedTourId || null;
    if (cachedAppSession.principalType !== result.type
      || cachedAppSession.principalId !== (result.type === 'driver' ? `driver:${identityId}` : identityId)
      || cachedAppSession.tourId !== expectedTourId) {
      return { success: false, reason: 'SESSION_SCOPE_MISMATCH', error: 'Saved tour data no longer matches this secure session. Reconnect to sign in.' };
    }
    return { ...result, appSession: cachedAppSession };
  };

export const runHandleLoginSuccess = async ({ IDENTITY_VERSION, appSessionService, auth, bookingService, driverLifecyclePurgeRef, driverTourPackService, getLoginTransitionDurationMs, identityBinding, joinTour, logger, loginDiagnostics, maskIdentifier, normalizePassengerEmail, offlineSyncService, persistDriverIdentityForUser, persistPassengerIdentityForUser, realtimeDb, recordCrashBreadcrumb, resetLoginTransition, resolveTourId, routeHistoryRef, saveSession, sessionGenerationRef, setAppSession, setBookingData, setCurrentScreen, setIdentityBinding, setLogoutStatus, setScreenParams, setTourCode, setTourData, shouldShowNotificationOnboarding, startLoginTransition, toRealtimeKeySegment, user }, reference, tourDetails, bookingOrDriverData, userType = 'passenger', options = {}) => {
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
    const verifiedAppSession = options?.appSession || await appSessionService.readSession();
    const expectedPrincipalId = userType === 'driver'
      ? `driver:${bookingOrDriverData?.id}`
      : bookingOrDriverData?.stablePassengerId;
    const expectedTourId = tourDetails?.id || bookingOrDriverData?.assignedTourId || null;
    if (!verifiedAppSession
      || verifiedAppSession.principalType !== userType
      || verifiedAppSession.principalId !== expectedPrincipalId
      || verifiedAppSession.tourId !== expectedTourId) {
      const sessionError = new Error('Secure app session unavailable');
      sessionError.userMessage = 'We could not establish a secure app session. Please reconnect and sign in again.';
      throw sessionError;
    }
    await appSessionService.persistSession(verifiedAppSession);
    await appSessionService.clearPendingEnd();
    sessionGenerationRef.current += 1;
    setAppSession(verifiedAppSession);
    setLogoutStatus({ state: 'idle', error: null, diagnostic: null });
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
      routeHistoryRef.current.reset();
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
    const { stablePassengerId, identityVersion } = bookingService.resolveVerifiedPassengerIdentity({
      stablePassengerId: normalizedBookingData?.stablePassengerId,
      identityVersion: normalizedBookingData?.identityVersion,
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
        resetLoginTransition();
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
        resetLoginTransition();
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
          resetLoginTransition();
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

    routeHistoryRef.current.reset();
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
