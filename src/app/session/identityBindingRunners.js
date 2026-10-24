export const runPersistPassengerIdentityForUser = async ({ IDENTITY_VERSION, isOpaquePassengerId, realtimeDb, toRealtimeKeySegment }, {
  authUid,
  stablePassengerId,
  identityVersion,
  bookingRef,
  normalizedPassengerEmail: _normalizedPassengerEmail,
}) => {
    if (!authUid || !realtimeDb || !bookingRef || !isOpaquePassengerId(stablePassengerId)
      || identityVersion !== IDENTITY_VERSION) {
      return { profilePersisted: false, bindingPersisted: false };
    }

    const stablePassengerKey = toRealtimeKeySegment(stablePassengerId);
    try {
      const snapshot = await boundedNetworkDecision(() => realtimeDb.ref(`users/${authUid}`).once('value'));
      const profile = snapshot.val() || {};
      const serverIdentityMatches = profile.stablePassengerId === stablePassengerId
        && profile.stablePassengerKey === stablePassengerKey
        && profile.privatePhotoOwnerId === stablePassengerId
        && profile.privatePhotoOwnerKey === stablePassengerKey
        && profile.identityVersion === IDENTITY_VERSION
        && profile.bookingRef === bookingRef;
      if (!serverIdentityMatches) {
        throw new Error('Server-issued passenger identity does not match the authenticated profile');
      }
    } catch (error) {
      const profileError = new Error('Passenger identity profile verification failed');
      profileError.userMessage = 'We could not finish securing your tour session. Please check your connection and try again.';
      profileError.criticalIdentityPersistence = true;
      profileError.cause = error;
      throw profileError;
    }

    return {
      profilePersisted: true,
      bindingPersisted: true,
      bindingMetaPersisted: true,
      stablePassengerKey,
    };
  };

const parseStoredEntry = (entry) => (entry && entry[1] ? JSON.parse(entry[1]) : null);

export const runRepairIdentityBindingFromSession = async ({ IDENTITY_VERSION, SESSION_KEYS, SessionStorage, isOpaquePassengerId, normalizePassengerEmail, persistPassengerIdentityForUser, setIdentityBinding, toRealtimeKeySegment }, authUid) => {
    const [savedIdentityBinding, savedBookingData] = await SessionStorage.multiGet([
      SESSION_KEYS.IDENTITY_BINDING,
      SESSION_KEYS.BOOKING_DATA,
    ]);
    const restoredBinding = parseStoredEntry(savedIdentityBinding) || {};
    const restoredBooking = parseStoredEntry(savedBookingData) || {};
    const stablePassengerId = restoredBinding.stablePassengerId || restoredBooking.stablePassengerId || null;
    const normalizedPassengerEmail = restoredBinding.normalizedPassengerEmail || normalizePassengerEmail(restoredBooking.normalizedPassengerEmail);
    const bookingRef = restoredBinding.bookingRef || restoredBooking.id || null;
    const restoredIdentityVersion = restoredBinding.identityVersion || restoredBooking.identityVersion;

    if (!isOpaquePassengerId(stablePassengerId) || !normalizedPassengerEmail || !bookingRef
      || restoredIdentityVersion !== IDENTITY_VERSION) {
      return null;
    }

    const identityVersion = restoredBinding.identityVersion || IDENTITY_VERSION;
    const persisted = await persistPassengerIdentityForUser({
      authUid,
      stablePassengerId,
      identityVersion,
      bookingRef,
      normalizedPassengerEmail,
    });
    const repairedBinding = {
      stablePassengerId,
      stablePassengerKey: persisted.stablePassengerKey || toRealtimeKeySegment(stablePassengerId),
      identityVersion,
      bookingRef,
      normalizedPassengerEmail,
      authUid,
    };

    setIdentityBinding(repairedBinding);
    await SessionStorage.multiSet([
      [SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(repairedBinding)],
    ]);
    return repairedBinding;
  };

export const runHydrateIdentityBindingForCurrentUser = async ({ IDENTITY_VERSION, SESSION_KEYS, isOpaquePassengerId, logger, maskIdentifier, realtimeDb, setIdentityBinding, toRealtimeKeySegment, appSessionRef, appSessionService }, authUid, { isConnected, timeoutMs } = {}) => {
    if (!authUid || !realtimeDb) return;
    if (isConnected === false) return;
    const expectedSession = appSessionRef?.current;
    if (expectedSession?.principalType !== 'passenger') return;
    const isCurrent = () => appSessionRef.current === expectedSession;

    try {
      const snapshot = await boundedNetworkDecision(() => realtimeDb.ref(`users/${authUid}`).once('value'), timeoutMs);
      if (!isCurrent()) return;
      const userProfile = snapshot.val() || {};
      const stablePassengerId = userProfile.stablePassengerId;

      if (!isOpaquePassengerId(stablePassengerId) || userProfile.identityVersion !== IDENTITY_VERSION
        || stablePassengerId !== expectedSession.principalId) {
        logger.info('Identity', 'identity_binding_missing', { authUid: maskIdentifier(authUid) });
        return;
      }

      const hydratedBinding = {
        stablePassengerId,
        stablePassengerKey: toRealtimeKeySegment(stablePassengerId),
        identityVersion: userProfile.identityVersion || IDENTITY_VERSION,
        bookingRef: userProfile.bookingRef || null,
        normalizedPassengerEmail: userProfile.normalizedPassengerEmail || null,
        authUid,
      };

      const committed = await appSessionService.persistProjection({ expectedSession, isCurrent, entries: [
        [SESSION_KEYS.IDENTITY_BINDING, JSON.stringify(hydratedBinding)],
      ] });
      if (!committed || !isCurrent()) return;
      setIdentityBinding(hydratedBinding);
      logger.info('Identity', 'identity_binding_hydrated', {
        authUid: maskIdentifier(authUid),
        stablePassengerId: maskIdentifier(stablePassengerId),
      });
    } catch (error) {
      logger.warn('Identity', 'Failed to hydrate identity binding for auth user', {
        error: error.message,
        authUid: maskIdentifier(authUid),
      });
    }
  };
export const runPersistDriverIdentityForUser = async ({ normalizeTourId, realtimeDb }, {
  authUid,
  driverId,
  assignedTourId,
}) => {
  const normalizedDriverId = typeof driverId === 'string' ? driverId.trim().toUpperCase() : '';
  if (!authUid || !normalizedDriverId || !realtimeDb) return { profilePersisted: false };

  await realtimeDb.ref().update({
    [`drivers/${normalizedDriverId}/lastActive`]: new Date().toISOString(),
  });
  return {
    profilePersisted: true,
    driverId: normalizedDriverId,
    assignedTourId: normalizeTourId(assignedTourId) || null,
  };
};
import { boundedNetworkDecision } from '../../../services/boundedNetworkDecision';
