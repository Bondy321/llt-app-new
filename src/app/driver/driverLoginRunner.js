import { recordLoginCompleted } from '../session/loginSessionPhases';

const persistDriverIdentity = async (deps, context) => {
  const {
    loginDiagnostics,
    logger,
    maskIdentifier,
    persistDriverIdentityForUser,
    recordCrashBreadcrumb,
  } = deps;
  const { authUid, diagnosticsContext, identity, tour } = context;
  const assignedTourId = tour.id || identity.assignedTourId || null;
  if (!authUid) {
    recordCrashBreadcrumb('Identity', 'driver_identity_persist_skipped_no_auth_user', {
      driverId: maskIdentifier(identity.id),
      assignedTourId,
    }, { remote: true, reason: 'Identity:driver_identity_persist_skipped_no_auth_user' });
    return;
  }

  try {
    await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_started', {
      authUid,
      driverId: identity.id,
      assignedTourId,
    }, diagnosticsContext);
    const persisted = await persistDriverIdentityForUser({
      authUid,
      driverId: identity.id,
      assignedTourId,
    });
    await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_succeeded', {
      authUid,
      driverId: persisted.driverId,
      assignedTourId: persisted.assignedTourId || null,
    }, diagnosticsContext);
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
      driverId: maskIdentifier(identity.id),
      assignedTourId,
      error: error.message,
      code: error.code || null,
    });
    await loginDiagnostics.recordLoginDiagnostic('driver_identity_persist_failed', {
      authUid,
      driverId: identity.id,
      assignedTourId,
      error: loginDiagnostics.summarizeError(error),
    }, diagnosticsContext);
    recordCrashBreadcrumb('Identity', 'driver_identity_persist_failure', {
      hasAuthUid: true,
      driverId: maskIdentifier(identity.id),
      assignedTourId,
      error: error.message,
      code: error.code || null,
    }, { remote: true, reason: 'Identity:driver_identity_persist_failure' });
  }
};

const saveDriverOfflinePack = async (deps, context, driverSessionData) => {
  const { loginDiagnostics, offlineSyncService } = deps;
  const { diagnosticsContext, identity, tour, tourDetails } = context;
  if (!tour.id) return;
  await loginDiagnostics.recordLoginDiagnostic('driver_offline_pack_save_started', {
    tourId: tour.id,
    driverId: identity.id,
  }, diagnosticsContext);
  await offlineSyncService.saveTourPack(tour.id, 'driver', {
    tour: tourDetails,
    driver: driverSessionData,
  }, { ownerId: identity.id });
  await offlineSyncService.setTourPackMeta(
    tour.id,
    'driver',
    { lastSyncedAt: new Date().toISOString() },
    { ownerId: identity.id },
  );
  await loginDiagnostics.recordLoginDiagnostic('driver_offline_pack_save_succeeded', {
    tourId: tour.id,
    driverId: identity.id,
  }, diagnosticsContext);
};

const saveDriverSession = async (deps, context, destination, driverSessionData) => {
  const { loginDiagnostics, saveSession } = deps;
  const { diagnosticsContext, identity, tour, tourDetails } = context;
  const { postLoginScreen } = destination;
  await loginDiagnostics.recordLoginDiagnostic('driver_session_save_started', {
    postLoginScreen,
    tourId: tour.id || null,
    driverId: identity.id || null,
  }, diagnosticsContext);
  await saveSession({
    tourData: tourDetails || null,
    bookingData: driverSessionData,
    currentScreen: postLoginScreen,
  });
  await loginDiagnostics.recordLoginDiagnostic('driver_session_save_succeeded', {
    postLoginScreen,
    tourId: tour.id || null,
    driverId: identity.id || null,
  }, diagnosticsContext);
};

const establishDriverState = (deps, context, destination, driverSessionData) => {
  const {
    driverLifecyclePurgeRef,
    maskIdentifier,
    recordCrashBreadcrumb,
    routeHistoryRef,
    setBookingData,
    setCurrentScreen,
    setTourCode,
    setTourData,
  } = deps;
  const { authUid, identity, tour, tourDetails } = context;
  setTourCode(tour.tourCode || '');
  setTourData(tourDetails || null);
  setBookingData(driverSessionData);
  driverLifecyclePurgeRef.current = null;
  routeHistoryRef.current.reset();
  setCurrentScreen(destination.postLoginScreen);
  recordCrashBreadcrumb('Auth', 'driver_login_session_established', {
    postLoginScreen: destination.postLoginScreen,
    hasAuthUid: Boolean(authUid),
    driverId: maskIdentifier(identity.id),
    tourId: tour.id || null,
  }, { remote: true, reason: 'Auth:driver_login_session_established' });
};

export const runDriverLogin = async (deps, context, destination) => {
  const {
    driverTourPackService,
    logger,
    maskIdentifier,
    resolveTourId,
    setScreenParams,
  } = deps;
  const { identity, tour, tourDetails } = context;
  const assignedTourId = resolveTourId(tour.id, identity.assignedTourId);
  const departureIdentity = assignedTourId && tourDetails
    ? driverTourPackService.resolveExactDepartureKey({ tourId: assignedTourId, startDate: tour.startDate })
    : { ok: false };
  const driverSessionData = {
    ...identity,
    assignedTourId: assignedTourId || null,
    assignedDepartureKey: departureIdentity.ok ? departureIdentity.departureKey : null,
  };

  logger.info('Auth', 'Driver Logged In', { driverId: maskIdentifier(identity.id) });
  await persistDriverIdentity(deps, context);
  establishDriverState(deps, context, destination, driverSessionData);
  await saveDriverOfflinePack(deps, context, driverSessionData);
  await saveDriverSession(deps, context, destination, driverSessionData);
  if (destination.shouldOnboardNotifications) {
    setScreenParams({ isOnboarding: true, audience: 'driver', returnTo: 'DriverHome' });
  }
  await recordLoginCompleted(deps, context, destination, identity.id);
};
