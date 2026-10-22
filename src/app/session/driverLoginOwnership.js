import { classifySessionTransition, sameSessionIdentity } from '../../../services/appSessionTransition';

export const beginDriverLoginAttempt = (deps) => {
  const attempt = {};
  const previous = deps.appSessionRef.current;
  const generation = deps.sessionGenerationRef.current;
  const authUid = deps.auth.currentUser?.uid;
  deps.loginAttemptRef.current = attempt;
  return () => deps.loginAttemptRef.current === attempt
    && deps.auth.currentUser?.uid === authUid
    && deps.appSessionRef.current === previous
    && deps.sessionGenerationRef.current === generation;
};

// The login callback was captured before session activation. Its authority is
// explicit; neither a null render snapshot nor a later revision may bypass it.
export const ownsDriverLogin = (deps, context, { allowRevision = false } = {}) => {
  const current = deps.appSessionRef.current;
  const live = deps.getCurrentContext();
  return deps.loginProjectionRef.current === context && live.active
    && live.userUid === context.authUid
    && (allowRevision ? sameSessionIdentity(context.verifiedAppSession, current)
      : classifySessionTransition(context.verifiedAppSession, current) === 'duplicate');
};

export const prepareDriverLoginProjection = (deps, context, session) => {
  context.verifiedAppSession = session;
  context.phase = 'preparing';
  deps.loginProjectionRef.current = context;
  // Withhold operational scope, while retaining the verified identity needed
  // by driver routing and by a simultaneous authoritative assignment event.
  deps.setBookingData({ ...context.identity, id: session.driverId,
    assignedTourId: null, currentTourId: null, driverAssignedTourId: null,
    assignedDepartureKey: null });
  deps.setTourData(null);
  deps.setTourCode('');
};

export const driverAssignmentDestination = (deps, session) => {
  const login = deps.loginProjectionRef?.current;
  const onboarding = sameSessionIdentity(login?.verifiedAppSession, session)
    && login?.onboardingPending === true;
  return onboarding
    ? { screen: 'NotificationPreferences', params: { isOnboarding: true, audience: 'driver', returnTo: 'DriverHome' } }
    : { screen: 'DriverHome', params: {} };
};

export const finishDriverLoginProjection = async (deps, context, destination) => {
  if (!ownsDriverLogin(deps, context, { allowRevision: true })) return;
  context.destination = destination;
  context.phase = 'complete';
  const expected = deps.appSessionRef.current;
  const route = driverAssignmentDestination(deps, expected);
  // Onboarding is an explicit intent, completed by its own runner. Its lifetime
  // must not depend on whether an assignment's seed has reached disk yet.
  deps.setScreenParams(route.params);
  deps.setCurrentScreen(route.screen);
  // A newer assignment owns its tour seed. Completing onboarding may choose the
  // route, but must never re-save the login callback's old booking/tour snapshot.
  await deps.appSessionService.persistProjection({
    expectedSession: expected,
    entries: [[deps.SESSION_KEYS.LAST_SCREEN, route.screen]],
    isCurrent: () => ownsDriverLogin(deps, context, { allowRevision: true })
      && classifySessionTransition(expected, deps.appSessionRef.current) === 'duplicate'
      && driverAssignmentDestination(deps, expected).screen === route.screen,
  });
};
