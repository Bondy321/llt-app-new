const asRecord = (value) => value || {};

export const prepareLoginContext = async (deps, reference, tourDetails, identityData, userType, options) => {
  const {
    auth,
    loginDiagnostics,
    maskIdentifier,
    recordCrashBreadcrumb,
    user,
  } = deps;
  const tour = asRecord(tourDetails);
  const identity = asRecord(identityData);
  const loginOptions = asRecord(options);
  const authCurrentUser = asRecord(auth).currentUser || null;
  const stateUser = user || null;
  const authUser = stateUser || authCurrentUser;
  const authUid = authUser ? authUser.uid : null;
  const targetScreen = userType === 'driver' ? 'DriverHome' : 'TourHome';
  const diagnosticsContext = loginOptions.loginDiagnostics || (
    loginOptions.loginDiagnosticId ? { attemptId: loginOptions.loginDiagnosticId } : null
  );

  await loginDiagnostics.recordLoginDiagnostic('app_login_success_handler_started', {
    userType,
    targetScreen,
    hasAuthUid: Boolean(authUid),
    authUid,
    authCurrentUserUid: authCurrentUser ? authCurrentUser.uid : null,
    stateUserUid: stateUser ? stateUser.uid : null,
    hasTourDetails: Boolean(tourDetails),
    tourId: tour.id || null,
    tourCode: tour.tourCode || null,
    identityId: identity.id || null,
    alreadyHydrated: Boolean(loginOptions.alreadyHydrated),
    offlineMode: Boolean(loginOptions.offlineMode),
  }, diagnosticsContext);
  recordCrashBreadcrumb('Auth', 'login_success_handler_started', {
    userType,
    targetScreen,
    hasAuthUid: Boolean(authUid),
    hasTourDetails: Boolean(tourDetails),
    tourId: tour.id || null,
    identityId: identity.id ? maskIdentifier(identity.id) : null,
    alreadyHydrated: Boolean(loginOptions.alreadyHydrated),
    offlineMode: Boolean(loginOptions.offlineMode),
  }, { remote: true, reason: 'Auth:login_success_handler_started' });

  return {
    authCurrentUser,
    authUid,
    diagnosticsContext,
    identity,
    loginOptions,
    reference,
    stateUser,
    targetScreen,
    tour,
    tourDetails,
    userType,
  };
};

export const activateVerifiedSession = async (deps, context) => {
  const {
    appSessionService,
    getLoginTransitionDurationMs,
    sessionGenerationRef,
    setAppSession,
    setLogoutStatus,
    startLoginTransition,
  } = deps;
  const { identity, loginOptions, targetScreen, tour, userType } = context;
  const verifiedAppSession = loginOptions.appSession || await appSessionService.readSession();
  const expectedPrincipalId = userType === 'driver'
    ? `driver:${identity.id}`
    : identity.stablePassengerId;
  const expectedTourId = tour.id || identity.assignedTourId || null;
  const sessionMatches = verifiedAppSession
    && verifiedAppSession.principalType === userType
    && verifiedAppSession.principalId === expectedPrincipalId
    && verifiedAppSession.tourId === expectedTourId;
  if (!sessionMatches) {
    const sessionError = new Error('Secure app session unavailable');
    sessionError.userMessage = 'We could not establish a secure app session. Please reconnect and sign in again.';
    throw sessionError;
  }

  await appSessionService.persistSession(verifiedAppSession);
  await appSessionService.clearPendingEnd();
  sessionGenerationRef.current += 1;
  setAppSession(verifiedAppSession);
  setLogoutStatus({ state: 'idle', error: null, diagnostic: null });
  if (!loginOptions.alreadyHydrated) {
    startLoginTransition({
      targetScreen,
      durationMs: getLoginTransitionDurationMs({ alreadyHydrated: loginOptions.alreadyHydrated }),
    });
  }
};

export const resolvePostLoginDestination = async (deps, context) => {
  const { loginDiagnostics, shouldShowNotificationOnboarding } = deps;
  const { authUid, diagnosticsContext, targetScreen, userType } = context;
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
  }, diagnosticsContext);
  return { postLoginScreen, shouldOnboardNotifications };
};

export const recordLoginCompleted = async (deps, context, destination, identityId) => {
  const { loginDiagnostics } = deps;
  const { diagnosticsContext, targetScreen, tour, userType } = context;
  await loginDiagnostics.recordLoginDiagnostic('app_login_success_handler_completed', {
    userType,
    postLoginScreen: destination.postLoginScreen,
    targetScreen,
    tourId: tour.id || null,
    identityId: identityId || null,
    shouldOnboardNotifications: destination.shouldOnboardNotifications,
  }, diagnosticsContext);
};
