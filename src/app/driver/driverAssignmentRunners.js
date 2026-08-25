export const runHandleDriverAssignmentChange = async ({ SESSION_KEYS, SessionStorage, auth, bookingData, currentDriverLifecycleScope, driverLifecyclePurgeRef, driverOperationalLifecycleService, driverTourPackService, logger, normalizeTourId, previousDriverOperationalScopeRef, realtimeDb, setBookingData, setDriverSessionGeneration, setTourCode, setTourData, user }, {
  assignedTourId
}) => {
    const normalizedAssignedTourId = normalizeTourId(assignedTourId);
    if (!normalizedAssignedTourId || !realtimeDb) {
      throw new Error('A valid assigned tour is required.');
    }

    const nextTourSnapshot = await realtimeDb.ref(`tours/${normalizedAssignedTourId}`).once('value');
    if (!nextTourSnapshot.exists()) {
      throw new Error('The assigned tour could not be loaded securely.');
    }
    const nextTourData = {
      id: normalizedAssignedTourId,
      ...(nextTourSnapshot.val() || {}),
    };
    const nextDeparture = driverTourPackService.resolveExactDepartureKey({
      tourId: normalizedAssignedTourId,
      startDate: nextTourData.startDate,
    });
    if (!nextDeparture.ok) {
      throw new Error('The assigned tour is missing a valid departure date. Dispatch must correct it before offline use.');
    }

    const updatedBookingData = {
      ...(bookingData || {}),
      assignedTourId: normalizedAssignedTourId,
      assignedTourCode: nextTourData.tourCode || bookingData?.assignedTourCode || null,
      assignedDepartureKey: nextDeparture.departureKey,
    };

    const previousScope = currentDriverLifecycleScope;
    const previousNormalized = previousScope
      ? driverOperationalLifecycleService.normalizeScope(previousScope)
      : null;
    const nextScope = {
      authUid: user?.uid || auth?.currentUser?.uid || null,
      driverId: updatedBookingData.id,
      departureKey: nextDeparture.departureKey,
      tourId: normalizedAssignedTourId,
      startDate: nextTourData.startDate,
    };
    const nextNormalized = driverOperationalLifecycleService.normalizeScope(nextScope);
    const changedDeparture = previousNormalized?.ok
      && nextNormalized.ok
      && (previousNormalized.driverId !== nextNormalized.driverId
        || previousNormalized.departureKey !== nextNormalized.departureKey);

    if (changedDeparture) {
      const purgeResult = await driverOperationalLifecycleService.purge(previousScope);
      if (!purgeResult.success) {
        logger.warn('DriverTourPack', 'Previous assignment data was only partially purged', {
          failedOperations: purgeResult.failures?.map((failure) => failure.name) || [],
        });
      }
    }

    previousDriverOperationalScopeRef.current = nextScope;
    driverLifecyclePurgeRef.current = null;
    setBookingData(updatedBookingData);
    setTourData(nextTourData);
    setTourCode(nextTourData.tourCode || '');
    setDriverSessionGeneration((value) => value + 1);

    try {
      await SessionStorage.multiSet([
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(updatedBookingData)],
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(nextTourData)],
      ]);
    } catch (error) {
      logger.error('Session', 'Failed to persist driver assignment', { error: error.message, assignedTourId: normalizedAssignedTourId });
    }

    return {
      tour: nextTourData,
      departureKey: nextDeparture.departureKey,
    };
  };
