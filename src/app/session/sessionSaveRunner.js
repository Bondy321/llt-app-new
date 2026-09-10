// Identity/authentication seed storage remains separate from the current display
// envelope. Navigation must never write captured trip projections back to disk.
export const runSaveSessionProjection = async ({ SESSION_KEYS, SessionStorage, logger,
  tourData, bookingData, currentScreen, identityBinding, passengerTripActive }, overrides = {}) => {
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
    await SessionStorage.multiSet(sessionEntries);
  } catch (error) {
    logger.error('Session', 'Failed to save session', { error: error.message });
  }
};
