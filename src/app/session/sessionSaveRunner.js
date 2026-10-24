import { classifySessionTransition } from '../../../services/appSessionTransition';

// Identity/authentication seed storage remains separate from the current display
// envelope. Navigation must never write captured trip projections back to disk.
export const runSaveSessionProjection = async ({ SESSION_KEYS, logger,
  tourData, bookingData, currentScreen, identityBinding, passengerTripActive,
  appSession, appSessionService, appSessionRef }, overrides = {}) => {
  try {
    const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const expected = overrides.expectedAppSession || appSession;
    const projectedTour = has('tourData') ? overrides.tourData : tourData;
    const projectedBooking = has('bookingData') ? overrides.bookingData : bookingData;
    const sessionEntries = [[SESSION_KEYS.LAST_SCREEN, has('currentScreen') ? overrides.currentScreen : currentScreen]];
    if (!passengerTripActive || has('bookingData')) {
      sessionEntries.unshift(
        [SESSION_KEYS.TOUR_DATA, JSON.stringify(has('tourData') ? overrides.tourData : tourData)],
        [SESSION_KEYS.BOOKING_DATA, JSON.stringify(has('bookingData') ? overrides.bookingData : bookingData)],
      );
    }
    const binding = has('identityBinding') ? overrides.identityBinding : identityBinding;
    if (binding) sessionEntries.push([SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(binding)]);
    if (expected?.principalType === 'driver' || appSessionRef?.current?.principalType === 'driver'
      || projectedBooking?.id?.startsWith('D-')) {
      if (expected?.principalType !== 'driver' || projectedBooking?.id !== expected.driverId
        || (projectedTour?.id || projectedBooking?.assignedTourId || null) !== expected.tourId) return false;
      return await appSessionService.persistProjection({ expectedSession: expected, entries: sessionEntries,
        isCurrent: () => classifySessionTransition(expected, appSessionRef.current) === 'duplicate' });
    }
    if (expected?.principalType !== 'passenger'
      || projectedBooking?.stablePassengerId !== expected.principalId
      || projectedTour?.id !== expected.tourId) return false;
    return await appSessionService.persistProjection({ expectedSession: expected, entries: sessionEntries,
      isCurrent: () => classifySessionTransition(expected, appSessionRef.current) === 'duplicate' });
  } catch (error) {
    logger.error('Session', 'Failed to save session', { error: error.message });
    return false;
  }
};
