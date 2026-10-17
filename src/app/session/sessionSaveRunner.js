// Identity/authentication seed storage remains separate from the current display
// envelope. Navigation must never write captured trip projections back to disk.
export const runSaveSessionProjection = async ({ SESSION_KEYS, SessionStorage, logger,
  tourData, bookingData, currentScreen, identityBinding, passengerTripActive,
  appSession, appSessionService, appSessionRef }, overrides = {}) => {
  try {
    const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const sessionEntries = [[SESSION_KEYS.LAST_SCREEN, has('currentScreen') ? overrides.currentScreen : currentScreen]];
    if (!passengerTripActive || has('bookingData')) {
      sessionEntries.unshift(
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(has('tourData') ? overrides.tourData : tourData)],
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(has('bookingData') ? overrides.bookingData : bookingData)],
      );
    }
    const binding = has('identityBinding') ? overrides.identityBinding : identityBinding;
    if (binding) sessionEntries.push([SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(binding)]);
    if (appSession?.principalType === 'driver') {
      const projectedTour = has('tourData') ? overrides.tourData : tourData;
      const projectedBooking = has('bookingData') ? overrides.bookingData : bookingData;
      if ((projectedTour?.id || projectedBooking?.assignedTourId || null) !== appSession.tourId) return;
      await appSessionService.persistProjection({ expectedSession: appSession, entries: sessionEntries,
        isCurrent: () => appSessionRef.current === appSession });
    } else await SessionStorage.multiSet(sessionEntries);
  } catch (error) {
    logger.error('Session', 'Failed to save session', { error: error.message });
  }
};
