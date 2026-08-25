import { recordLoginCompleted } from '../session/loginSessionPhases';

const buildPassengerIdentity = (deps, context) => {
  const {
    IDENTITY_VERSION,
    bookingService,
    normalizePassengerEmail,
    toRealtimeKeySegment,
  } = deps;
  const { authUid, identity } = context;
  const normalizedBookingData = {
    ...identity,
    normalizedPassengerEmail: normalizePassengerEmail(identity.normalizedPassengerEmail),
  };
  const verifiedIdentity = bookingService.resolveVerifiedPassengerIdentity({
    stablePassengerId: normalizedBookingData.stablePassengerId,
    identityVersion: normalizedBookingData.identityVersion,
  });
  const stablePassengerId = verifiedIdentity.stablePassengerId;
  const identityVersion = verifiedIdentity.identityVersion;
  const identityBinding = stablePassengerId ? {
    stablePassengerId,
    stablePassengerKey: toRealtimeKeySegment(stablePassengerId),
    identityVersion: identityVersion || IDENTITY_VERSION,
    bookingRef: normalizedBookingData.id || null,
    normalizedPassengerEmail: normalizedBookingData.normalizedPassengerEmail || null,
    authUid,
  } : null;
  return { identityBinding, identityVersion, normalizedBookingData, stablePassengerId };
};

const joinPassengerTour = async (deps, context, passenger) => {
  const {
    joinTour,
    logger,
    loginDiagnostics,
    maskIdentifier,
    resetLoginTransition,
  } = deps;
  const {
    authCurrentUser,
    authUid,
    diagnosticsContext,
    loginOptions,
    stateUser,
    tour,
    tourDetails,
  } = context;
  if (loginOptions.offlineMode || !tour.id) return;
  if (!authUid) {
    resetLoginTransition();
    const authFailure = new Error('Authenticated tour session unavailable');
    authFailure.userMessage = 'We could not start a secure tour session. Please check your connection and try again.';
    await loginDiagnostics.recordLoginDiagnostic('passenger_join_blocked_missing_auth_uid', {
      tourId: tour.id,
      authCurrentUserUid: authCurrentUser ? authCurrentUser.uid : null,
      stateUserUid: stateUser ? stateUser.uid : null,
    }, diagnosticsContext);
    throw authFailure;
  }

  try {
    await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_started', {
      tourId: tour.id,
      authUid,
      bookingRef: passenger.normalizedBookingData.id || null,
    }, diagnosticsContext);
    const joinResult = await joinTour(tour.id, authUid, undefined, {
      loginDiagnostics: diagnosticsContext,
      tourProjection: tourDetails,
    });
    await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_succeeded', {
      tourId: tour.id,
      authUid,
      currentParticipants: joinResult ? joinResult.currentParticipants : undefined,
      alreadyJoined: Boolean(joinResult && joinResult.alreadyJoined),
    }, diagnosticsContext);
  } catch (error) {
    resetLoginTransition();
    logger.error('Tour', 'Error joining tour', {
      error: error.message,
      code: error.code || null,
      tourId: tour.id,
      authUid: maskIdentifier(authUid),
    });
    await loginDiagnostics.recordLoginDiagnostic('passenger_join_tour_failed', {
      tourId: tour.id,
      authUid,
      bookingRef: passenger.normalizedBookingData.id || null,
      error: loginDiagnostics.summarizeError(error),
    }, diagnosticsContext);
    const joinFailure = new Error('Unable to join tour session');
    joinFailure.userMessage = 'We could not finish joining your tour session. Please check your connection and try again.';
    throw joinFailure;
  }
};

const recordPassengerIdentityFailure = async (deps, context, passenger, error) => {
  const {
    logger,
    loginDiagnostics,
    maskIdentifier,
    resetLoginTransition,
    toRealtimeKeySegment,
  } = deps;
  const { authUid, diagnosticsContext } = context;
  const { normalizedBookingData, stablePassengerId } = passenger;
  if (error.criticalIdentityPersistence) resetLoginTransition();
  const sourceError = error.cause || error;
  const sourceErrorMessage = sourceError.message || error.message || '';
  const sourceErrorCode = sourceError.code || error.code || null;
  const rejected = sourceErrorCode === 'PERMISSION_DENIED'
    || /permission_denied/i.test(sourceErrorMessage)
    || /Permission denied/i.test(sourceErrorMessage);
  const reason = rejected ? 'IDENTITY_BINDING_WRITE_DENIED_OR_INVALID' : 'IDENTITY_BINDING_WRITE_FAILED';
  const stablePassengerKey = stablePassengerId ? toRealtimeKeySegment(stablePassengerId) : null;
  logger.error('Identity', 'identity_binding_persist_failure', {
    error: sourceErrorMessage,
    code: sourceErrorCode,
    critical: Boolean(error.criticalIdentityPersistence),
    reason,
    authUid: maskIdentifier(authUid),
    bookingRef: maskIdentifier(normalizedBookingData.id),
    stablePassengerId: stablePassengerId ? maskIdentifier(stablePassengerId) : null,
    stablePassengerKey: stablePassengerKey ? maskIdentifier(stablePassengerKey) : null,
  });
  await loginDiagnostics.recordLoginDiagnostic('passenger_identity_persist_failed', {
    authUid,
    bookingRef: normalizedBookingData.id,
    normalizedPassengerEmail: normalizedBookingData.normalizedPassengerEmail,
    stablePassengerId,
    stablePassengerKey,
    critical: Boolean(error.criticalIdentityPersistence),
    reason,
    error: loginDiagnostics.summarizeError(sourceError),
  }, diagnosticsContext);
  if (error.criticalIdentityPersistence) throw error;
};

const persistPassengerIdentity = async (deps, context, passenger) => {
  const {
    logger,
    loginDiagnostics,
    maskIdentifier,
    persistPassengerIdentityForUser,
    realtimeDb,
  } = deps;
  const { authUid, diagnosticsContext } = context;
  const { identityVersion, normalizedBookingData, stablePassengerId } = passenger;
  if (!authUid || !normalizedBookingData.id || !realtimeDb) return;
  try {
    if (!stablePassengerId || !normalizedBookingData.normalizedPassengerEmail) {
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
    }, diagnosticsContext);
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
    }, diagnosticsContext);
    logger.info('Identity', 'identity_binding_persist_success', {
      authUid: maskIdentifier(authUid),
      bookingRef: maskIdentifier(normalizedBookingData.id),
      stablePassengerId: stablePassengerId ? maskIdentifier(stablePassengerId) : null,
      stablePassengerKey: persisted.stablePassengerKey ? maskIdentifier(persisted.stablePassengerKey) : null,
    });
  } catch (error) {
    await recordPassengerIdentityFailure(deps, context, passenger, error);
  }
};

const savePassengerOfflinePack = async (deps, context, passenger) => {
  const { loginDiagnostics, offlineSyncService } = deps;
  const { diagnosticsContext, tour, tourDetails } = context;
  const { normalizedBookingData } = passenger;
  if (!tour.id) return;
  await loginDiagnostics.recordLoginDiagnostic('passenger_offline_pack_save_started', {
    tourId: tour.id,
    bookingRef: normalizedBookingData.id || null,
  }, diagnosticsContext);
  await offlineSyncService.saveTourPack(tour.id, 'passenger', {
    tour: tourDetails,
    booking: normalizedBookingData,
    safety: { emergencyPhone: tour.driverPhone || null },
  }, { ownerId: normalizedBookingData.id });
  await offlineSyncService.setTourPackMeta(
    tour.id,
    'passenger',
    { lastSyncedAt: new Date().toISOString() },
    { ownerId: normalizedBookingData.id },
  );
  await loginDiagnostics.recordLoginDiagnostic('passenger_offline_pack_save_succeeded', {
    tourId: tour.id,
    bookingRef: normalizedBookingData.id || null,
  }, diagnosticsContext);
};

const savePassengerSession = async (deps, context, destination, passenger) => {
  const { identityBinding } = deps;
  const { loginDiagnostics, saveSession } = deps;
  const { diagnosticsContext, tour, tourDetails } = context;
  const { normalizedBookingData } = passenger;
  const activeIdentityBinding = passenger.identityBinding || identityBinding;
  await loginDiagnostics.recordLoginDiagnostic('passenger_session_save_started', {
    postLoginScreen: destination.postLoginScreen,
    tourId: tour.id || null,
    bookingRef: normalizedBookingData.id || null,
    hasIdentityBinding: Boolean(activeIdentityBinding),
  }, diagnosticsContext);
  await saveSession({
    tourData: tourDetails || null,
    bookingData: normalizedBookingData,
    currentScreen: destination.postLoginScreen,
    identityBinding: activeIdentityBinding,
  });
  await loginDiagnostics.recordLoginDiagnostic('passenger_session_save_succeeded', {
    postLoginScreen: destination.postLoginScreen,
    tourId: tour.id || null,
    bookingRef: normalizedBookingData.id || null,
    hasIdentityBinding: Boolean(activeIdentityBinding),
  }, diagnosticsContext);
};

const establishPassengerState = (deps, context, destination, passenger) => {
  const {
    logger,
    maskIdentifier,
    routeHistoryRef,
    setBookingData,
    setCurrentScreen,
    setIdentityBinding,
    setTourCode,
    setTourData,
  } = deps;
  const { reference, tour, tourDetails } = context;
  if (passenger.identityBinding) setIdentityBinding(passenger.identityBinding);
  logger.info('Navigation', 'Passenger Login', { bookingRef: maskIdentifier(reference) });
  setTourCode(tour.tourCode || '');
  setTourData(tourDetails || null);
  setBookingData(passenger.normalizedBookingData);
  routeHistoryRef.current.reset();
  setCurrentScreen(destination.postLoginScreen);
};

export const runPassengerLogin = async (deps, context, destination) => {
  const { setScreenParams } = deps;
  const passenger = buildPassengerIdentity(deps, context);
  await joinPassengerTour(deps, context, passenger);
  if (passenger.identityBinding) deps.setIdentityBinding(passenger.identityBinding);
  await persistPassengerIdentity(deps, context, passenger);
  establishPassengerState(deps, context, destination, passenger);
  await savePassengerOfflinePack(deps, context, passenger);
  await savePassengerSession(deps, context, destination, passenger);
  if (destination.shouldOnboardNotifications) {
    setScreenParams({ isOnboarding: true, audience: 'passenger', returnTo: 'TourHome' });
  }
  await recordLoginCompleted(deps, context, destination, passenger.normalizedBookingData.id || context.identity.id);
};
