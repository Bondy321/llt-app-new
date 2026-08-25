const loadAssignedTour = async (deps, assignedTourId) => {
  const { driverTourPackService, normalizeTourId, realtimeDb } = deps;
  const normalizedAssignedTourId = normalizeTourId(assignedTourId);
  if (!normalizedAssignedTourId || !realtimeDb) throw new Error('A valid assigned tour is required.');
  const snapshot = await realtimeDb.ref(`tours/${normalizedAssignedTourId}`).once('value');
  if (!snapshot.exists()) throw new Error('The assigned tour could not be loaded securely.');
  const tour = { id: normalizedAssignedTourId, ...(snapshot.val() || {}) };
  const departure = driverTourPackService.resolveExactDepartureKey({
    tourId: normalizedAssignedTourId,
    startDate: tour.startDate,
  });
  if (!departure.ok) {
    throw new Error('The assigned tour is missing a valid departure date. Dispatch must correct it before offline use.');
  }
  return { departure, normalizedAssignedTourId, tour };
};

const purgePreviousAssignment = async (deps, nextScope) => {
  const { currentDriverLifecycleScope, driverOperationalLifecycleService, logger } = deps;
  if (!currentDriverLifecycleScope) return;
  const previous = driverOperationalLifecycleService.normalizeScope(currentDriverLifecycleScope);
  const next = driverOperationalLifecycleService.normalizeScope(nextScope);
  const changedDeparture = previous.ok
    && next.ok
    && (previous.driverId !== next.driverId || previous.departureKey !== next.departureKey);
  if (!changedDeparture) return;
  const purgeResult = await driverOperationalLifecycleService.purge(currentDriverLifecycleScope);
  if (!purgeResult.success) {
    const failures = purgeResult.failures || [];
    logger.warn('DriverTourPack', 'Previous assignment data was only partially purged', {
      failedOperations: failures.map((failure) => failure.name),
    });
  }
};

const persistAssignment = async (deps, updatedBookingData, nextTourData) => {
  const { SESSION_KEYS, SessionStorage, logger } = deps;
  try {
    await SessionStorage.multiSet([
      [SESSION_KEYS.BOOKING_DATA, JSON.stringify(updatedBookingData)],
      [SESSION_KEYS.TOUR_DATA, JSON.stringify(nextTourData)],
    ]);
  } catch (error) {
    logger.error('Session', 'Failed to persist driver assignment', {
      error: error.message,
      assignedTourId: nextTourData.id,
    });
  }
};

export const runHandleDriverAssignmentChange = async (deps, {
  assignedTourId
}) => {
    const {
      auth,
      bookingData,
      driverLifecyclePurgeRef,
      previousDriverOperationalScopeRef,
      setBookingData,
      setDriverSessionGeneration,
      setTourCode,
      setTourData,
      user,
    } = deps;
    const { departure: nextDeparture, normalizedAssignedTourId, tour: nextTourData } = await loadAssignedTour(deps, assignedTourId);
    const currentBooking = bookingData || {};
    const updatedBookingData = {
      ...currentBooking,
      assignedTourId: normalizedAssignedTourId,
      assignedTourCode: nextTourData.tourCode || currentBooking.assignedTourCode || null,
      assignedDepartureKey: nextDeparture.departureKey,
    };
    const authUser = user || (auth && auth.currentUser);
    const nextScope = {
      authUid: authUser ? authUser.uid : null,
      driverId: updatedBookingData.id,
      departureKey: nextDeparture.departureKey,
      tourId: normalizedAssignedTourId,
      startDate: nextTourData.startDate,
    };
    await purgePreviousAssignment(deps, nextScope);
    previousDriverOperationalScopeRef.current = nextScope;
    driverLifecyclePurgeRef.current = null;
    setBookingData(updatedBookingData);
    setTourData(nextTourData);
    setTourCode(nextTourData.tourCode || '');
    setDriverSessionGeneration((value) => value + 1);

    await persistAssignment(deps, updatedBookingData, nextTourData);

    return {
      tour: nextTourData,
      departureKey: nextDeparture.departureKey,
    };
  };
