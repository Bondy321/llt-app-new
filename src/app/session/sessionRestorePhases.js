const sessionStorageKeys = (SESSION_KEYS) => [
  SESSION_KEYS.TOUR_DATA,
  SESSION_KEYS.BOOKING_DATA,
  SESSION_KEYS.LAST_SCREEN,
  SESSION_KEYS.IDENTITY_BINDING,
];

export const clearStoredSessionProjection = (deps) => (
  deps.SessionStorage.multiRemove(sessionStorageKeys(deps.SESSION_KEYS))
);

export const restoreStoredIdentityBinding = (deps, savedIdentityBinding) => {
  const { IDENTITY_VERSION, isOpaquePassengerId, logger, setIdentityBinding } = deps;
  if (!savedIdentityBinding || !savedIdentityBinding[1]) return;
  try {
    const restoredBinding = JSON.parse(savedIdentityBinding[1]);
    const isCurrentBinding = restoredBinding
      && typeof restoredBinding === 'object'
      && isOpaquePassengerId(restoredBinding.stablePassengerId)
      && restoredBinding.identityVersion === IDENTITY_VERSION;
    if (isCurrentBinding) setIdentityBinding(restoredBinding);
  } catch (parseError) {
    logger.warn('Session', 'Failed to parse identity binding payload', { error: parseError.message });
  }
};

const normalizeStoredProjection = (deps, storedBookingData, storedTourData) => {
  const { normalizePassengerIdentityProjection, normalizePassengerTourProjection } = deps;
  const isDriverBooking = Boolean(
    storedBookingData.isDriver
    || (storedBookingData.id && storedBookingData.id.startsWith('D-')),
  );
  return {
    bookingData: isDriverBooking
      ? storedBookingData
      : normalizePassengerIdentityProjection(storedBookingData, storedBookingData.id),
    isDriverBooking,
    tourData: isDriverBooking
      ? storedTourData
      : normalizePassengerTourProjection(storedTourData, storedTourData ? storedTourData.id : null),
  };
};

const matchesActiveSession = (validAppSession, projection) => {
  const { bookingData, isDriverBooking, tourData } = projection;
  if (!bookingData) return false;
  const matchesRole = isDriverBooking
    ? validAppSession.principalType === 'driver' && validAppSession.driverId === bookingData.id
    : validAppSession.principalType === 'passenger' && validAppSession.principalId === bookingData.stablePassengerId;
  const expectedTourId = (tourData && tourData.id) || bookingData.assignedTourId || null;
  return matchesRole
    && validAppSession.tourId === expectedTourId
    && !(validAppSession.tourId && !tourData);
};

const persistNormalizedPassengerProjection = async (deps, projection) => {
  if (projection.isDriverBooking) return;
  const { SESSION_KEYS, SessionStorage } = deps;
  await SessionStorage.multiSet([
    [SESSION_KEYS.TOUR_DATA, JSON.stringify(projection.tourData)],
    [SESSION_KEYS.BOOKING_DATA, JSON.stringify(projection.bookingData)],
  ]);
};

const applyRestoredProjection = (deps, projection, lastScreen) => {
  const {
    routeHistoryRef,
    setBookingData,
    setCurrentScreen,
    setTourCode,
    setTourData,
  } = deps;
  const { bookingData, tourData } = projection;
  const screen = lastScreen[1] || 'Login';
  const fallbackScreen = bookingData.id && bookingData.id.startsWith('D-') ? 'DriverHome' : 'TourHome';
  const restoredScreen = screen === 'Login' || screen === 'NotificationPreferences' ? fallbackScreen : screen;
  setBookingData(bookingData);
  setTourData(tourData);
  if (tourData) setTourCode(tourData.tourCode);
  routeHistoryRef.current.reset();
  setCurrentScreen(restoredScreen);
};

export const restoreStoredSessionProjection = async (deps, validAppSession, savedEntries) => {
  const { IDENTITY_VERSION, isOpaquePassengerId, logger } = deps;
  const [savedTourData, savedBookingData, lastScreen] = savedEntries;
  if (!savedBookingData[1]) return false;
  const storedBookingData = JSON.parse(savedBookingData[1]);
  const storedTourData = savedTourData[1] ? JSON.parse(savedTourData[1]) : null;
  const isPassenger = !storedBookingData.isDriver
    && !(storedBookingData.id && storedBookingData.id.startsWith('D-'));
  const hasCurrentPassengerIdentity = isOpaquePassengerId(storedBookingData.stablePassengerId)
    && storedBookingData.identityVersion === IDENTITY_VERSION;
  if (isPassenger && !hasCurrentPassengerIdentity) {
    await clearStoredSessionProjection(deps);
    logger.warn('Session', 'Legacy passenger session invalidated; online verification required');
    return false;
  }
  const projection = normalizeStoredProjection(deps, storedBookingData, storedTourData);
  if (!matchesActiveSession(validAppSession, projection)) {
    await clearStoredSessionProjection(deps);
    logger.warn('Session', 'Saved app data does not match the active secure session');
    return false;
  }
  await persistNormalizedPassengerProjection(deps, projection);
  applyRestoredProjection(deps, projection, lastScreen);
  return true;
};

export const readStoredSessionProjection = (deps) => (
  deps.SessionStorage.multiGet(sessionStorageKeys(deps.SESSION_KEYS))
);
