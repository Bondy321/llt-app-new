import { classifySessionTransition, sameSessionIdentity } from '../../../services/appSessionTransition';
import { driverAssignmentDestination } from '../session/driverLoginOwnership';

const assertRetired = (results = []) => {
  if (results.some(result => result.status === 'rejected' || result.value?.success === false)) {
    throw new Error('Previous tour work could not be fully retired. Please reconnect and retry.');
  }
};
const retryFailedRetirement = async (ref, coordinator, assertActive) => {
  const results = await coordinator?.retirement;
  assertActive();
  try { assertRetired(results); }
  catch (error) {
    if (coordinator !== ref.current || !coordinator.retryRetirement) throw error;
    if (!coordinator.retirementRetry) {
      const retry = Promise.resolve().then(() => { assertActive(); return coordinator.retryRetirement(); });
      coordinator.retirementRetry = retry;
      coordinator.retirement = retry;
    }
    const retry = coordinator.retirementRetry;
    try { const retried = await retry; assertActive(); assertRetired(retried); }
    finally { if (coordinator.retirementRetry === retry) coordinator.retirementRetry = null; }
  }
};

const drainDriverAssignmentRetirement = async (ref, assertActive, pendingLoginWork) => {
  const loginWork = pendingLoginWork?.();
  await Promise.resolve(loginWork).catch(() => {});
  assertActive();
  const coordinator = ref.current;
  if (!coordinator) return;
  // Retirement can finish before an accepted projection batch. Drain that batch
  // too, including a successor task appended while awaiting the previous tail.
  // Bounded contention stays retryable instead of hanging logout indefinitely.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assertActive();
    await retryFailedRetirement(ref, coordinator, assertActive);
    const retirement = coordinator.retirement;
    const tail = coordinator.tail;
    await tail.catch(() => {});
    assertActive();
    if (coordinator !== ref.current) throw new Error('Assignment cleanup authority changed');
    if (tail === coordinator.tail && retirement === coordinator.retirement) {
      const retired = await retirement;
      assertActive();
      assertRetired(retired);
      return;
    }
  }
  throw new Error('Assignment cleanup is still in progress');
};

export const settleDriverAssignmentRetirement = async (ref, {
  timeoutMs = 15_000, scheduleTimer = setTimeout, cancelTimer = clearTimeout, pendingLoginWork,
} = {}) => {
  let timer;
  let active = true;
  const pending = () => new Error('Assignment cleanup is still in progress');
  const assertActive = () => { if (!active) throw pending(); };
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60_000) : 15_000;
  const deadline = new Promise((_resolve, reject) => {
    timer = scheduleTimer(() => { active = false; reject(pending()); }, limitMs);
  });
  try { await Promise.race([drainDriverAssignmentRetirement(ref, assertActive, pendingLoginWork), deadline]); }
  finally { active = false; cancelTimer(timer); }
};

export const projectDriverAssignment = (booking, tourId, tour = null, departure = null) => ({
  ...booking, assignedTourId: tourId, currentTourId: tourId, driverAssignedTourId: tourId,
  assignedTourCode: tour?.tourCode || null, currentTourCode: tour?.tourCode || null,
  assignedDepartureKey: departure?.departureKey || null,
});

export const loadAssignedTour = async (deps, assignedTourId) => {
  if (assignedTourId === null) return { departure: null, tour: null };
  const normalized = deps.normalizeTourId(assignedTourId);
  if (!normalized || normalized !== assignedTourId) throw new Error('A valid assigned tour is required.');
  const snapshot = await deps.realtimeDb.ref(`tours/${normalized}`).once('value');
  if (!snapshot.exists()) throw new Error('The assigned tour could not be loaded securely.');
  const tour = { ...(snapshot.val() || {}), id: normalized };
  const departure = deps.driverTourPackService.resolveExactDepartureKey({ tourId: normalized, startDate: tour.startDate });
  if (!departure.ok) throw new Error('The assigned tour is missing a valid departure date. Dispatch must correct it before offline use.');
  return { departure, tour };
};

const resolveCandidate = (deps, event) => {
  const context = deps.getCurrentContext();
  const expected = deps.appSessionRef.current;
  if (!context.active || !expected || expected.principalType !== 'driver' || !context.userUid) return null;
  const authUid = context.userUid;
  if (event.authUid && event.authUid !== authUid) return null;
  const complete = session => {
    const latestContext = deps.getCurrentContext();
    const latest = deps.appSessionRef.current;
    if (latestContext.userUid !== authUid || !latestContext.active || !sameSessionIdentity(expected, latest)) return null;
    if (event.assignedTourId !== undefined && event.assignedTourId !== session.tourId) return null;
    return { context: latestContext, latest, session, authUid };
  };
  if (event.session) return complete(event.session);
  return deps.appSessionService.verifyCurrent({ authUid, expectedSession: expected, allowDriverAssignment: true })
    .then(current => current.valid ? complete(current.session) : null);
};

const projectionMatches = (context, session) => context.bookingData?.id === session.driverId
  && context.bookingData?.assignedTourId === session.tourId
  && (session.tourId === null || context.currentDriverLifecycleScope?.tourId === session.tourId);

const pendingLoginScope = (login, session) => (
  login?.phase === 'projecting' && login.projectionTask && login.tour?.id
    && sameSessionIdentity(login.verifiedAppSession, session)
    ? { authUid: login.authUid, driverId: session.driverId, tourId: login.tour.id,
      startDate: login.tour.startDate, departureKey: null }
    : null
);

const enqueueReconciliation = (coordinator, token, operation) => {
  const task = coordinator.tail.catch(() => {}).then(async () => {
    try { return await operation(); }
    finally { if (coordinator.token === token) coordinator.pendingRevision = null; }
  });
  coordinator.tail = task;
  return task;
};

const reconcileRevisionOnly = async (deps, transition) => {
  const { session, previousSession, isCurrent, context, coordinator } = transition;
  const committed = await deps.appSessionService.persistSessionTransition({
    expectedSession: previousSession, session, projectionEntries: [], isCurrent,
  });
  if (!committed || !isCurrent()) return { ignored: true };
  coordinator.completed = session;
  return { session, tour: context.tourData || null };
};

const reconcileAcceptedAssignment = async (deps, transition) => {
  const { session, previousSession, booking, retirement, isCurrent, coordinator } = transition;
  assertRetired(await retirement);
  if (!isCurrent()) return { ignored: true };
  const { departure, tour } = await loadAssignedTour(deps, session.tourId);
  if (!isCurrent()) return { ignored: true };
  const updatedBooking = projectDriverAssignment(booking, session.tourId, tour, departure);
  const destination = driverAssignmentDestination(deps, session);
  const committed = await deps.appSessionService.persistSessionTransition({
    expectedSession: previousSession, session, isCurrent,
    projectionEntries: [
      [deps.SESSION_KEYS.BOOKING_DATA, JSON.stringify(updatedBooking)],
      [deps.SESSION_KEYS.TOUR_DATA, JSON.stringify(tour)],
      [deps.SESSION_KEYS.LAST_SCREEN, destination.screen],
    ],
  });
  if (!committed || !isCurrent()) return { ignored: true };
  deps.previousDriverOperationalScopeRef.current = tour ? { authUid: transition.authUid, driverId: session.driverId,
    departureKey: departure.departureKey, tourId: session.tourId, startDate: tour.startDate } : null;
  deps.driverLifecyclePurgeRef.current = null;
  deps.setBookingData(updatedBooking);
  deps.setTourData(tour);
  deps.setTourCode(tour?.tourCode || '');
  const latestDestination = driverAssignmentDestination(deps, session);
  deps.setScreenParams(latestDestination.params);
  deps.routeHistoryRef.current.reset();
  deps.setCurrentScreen(latestDestination.screen);
  coordinator.completed = session;
  coordinator.previousScope = null;
  return { tour, departureKey: departure?.departureKey || null, session };
};

const retirePreviousAssignment = (deps, coordinator, previousScope, transition) => {
  const { booking, session, authUid } = transition;
  deps.sessionGenerationRef.current += 1;
  // Null the derived scope before any await. Old listeners unmount and queued
  // actions remain associated with their original tour; none are relabelled.
  deps.setBookingData(projectDriverAssignment(booking, null));
  deps.setTourData(null);
  deps.setTourCode('');
  const destination = driverAssignmentDestination(deps, session);
  deps.setScreenParams(destination.params);
  deps.routeHistoryRef.current.reset();
  deps.setCurrentScreen(destination.screen);
  deps.setDriverSessionGeneration(value => value + 1);
  coordinator.previousScope = previousScope;
  const token = coordinator.token;
  const assertOwner = () => {
    if (deps.assignmentReconciliationRef.current !== coordinator || coordinator.token !== token
      || deps.getCurrentContext().userUid !== authUid
      || !sameSessionIdentity(session, deps.appSessionRef.current)
      || deps.appSessionRef.current.tourId !== session.tourId) throw new Error('Assignment cleanup authority changed');
  };
  const loginWork = deps.loginProjectionRef?.current?.projectionTask;
  const operations = [() => deps.offlineSyncService.setActiveSessionScope(null),
    () => deps.stopDriverTracking({ reason: 'assignment_changed' }),
    ...(previousScope ? [async () => {
      // A login's already-issued cache write must settle before retiring it.
      await loginWork?.catch(() => {});
      assertOwner();
      return deps.driverOperationalLifecycleService.purge(previousScope);
    }] : [])];
  coordinator.retryRetirement = () => Promise.allSettled(operations.map(operation => {
    try { assertOwner(); return operation(); } catch (error) { return Promise.reject(error); }
  }));
  const retirement = coordinator.retryRetirement();
  coordinator.retirement = retirement;
  return retirement;
};

// HTTP responses and the own-session listener enter the exact same monotonic
// coordinator. Acceptance fences work synchronously; only the newest accepted
// revision may expose a tour after asynchronous retirement/loading/persistence.
export const runHandleDriverAssignmentChange = async (deps, event = {}) => {
  const resolved = resolveCandidate(deps, event);
  const candidate = event.session ? resolved : await resolved;
  if (!candidate) return { ignored: true };
  const { context, latest, session, authUid } = candidate;
  const change = classifySessionTransition(latest, session, { allowDriverAssignment: true });
  if (change === 'invalid' || change === 'stale') return { ignored: true };
  const login = deps.loginProjectionRef?.current;
  if (change === 'duplicate' && ['preparing', 'projecting'].includes(login?.phase)
    && classifySessionTransition(login.verifiedAppSession, session) === 'duplicate') {
    return { session: latest, pendingLoginProjection: true };
  }
  const coordinator = deps.assignmentReconciliationRef.current || { token: 0, tail: Promise.resolve(), completed: null };
  deps.assignmentReconciliationRef.current = coordinator;
  if (change === 'duplicate' && coordinator.pendingRevision === session.sessionRevision) return coordinator.tail;
  if (change === 'duplicate' && projectionMatches(context, session)
    && classifySessionTransition(coordinator.completed, session) === 'duplicate') {
    return { session: latest, tour: context.tourData || null, alreadyReconciled: true };
  }
  const token = ++coordinator.token;
  coordinator.pendingRevision = session.sessionRevision;
  const previousScope = context.currentDriverLifecycleScope || coordinator.previousScope || pendingLoginScope(login, session);
  const transition = { authUid, session, previousSession: latest, context, coordinator,
    booking: { ...(context.bookingData?.id === session.driverId ? context.bookingData : {}), id: session.driverId },
    isCurrent: () => coordinator.token === token && deps.getCurrentContext().active
      && deps.getCurrentContext().userUid === authUid
      && classifySessionTransition(session, deps.appSessionRef.current) === 'duplicate' };
  deps.setAppSession(session);
  if (latest.tourId === session.tourId && projectionMatches(context, session)) {
    // Coordination revisions retain the explicit tracking intent, replay
    // generation and visible route. Only authority and accepted expiry advance.
    return enqueueReconciliation(coordinator, token, () => reconcileRevisionOnly(deps, transition));
  }
  transition.retirement = retirePreviousAssignment(deps, coordinator, previousScope, transition);
  return enqueueReconciliation(coordinator, token, () => reconcileAcceptedAssignment(deps, transition));
};
