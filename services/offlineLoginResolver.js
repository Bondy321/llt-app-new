const OFFLINE_LOGIN_REASONS = {
  NO_CACHED_SESSION: 'NO_CACHED_SESSION',
  CODE_MISMATCH: 'CODE_MISMATCH',
  CACHE_EXPIRED: 'CACHE_EXPIRED',
  EMAIL_MISMATCH: 'EMAIL_MISMATCH',
};

const OFFLINE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const normalizePassengerEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const resolveOfflineLoginFromCache = async ({
  reference,
  normalizedEmail,
  sessionStorage,
  sessionKeys,
  offlineSyncService,
  maskIdentifier,
  logger,
}) => {
  const normalizedReference = (reference || '').trim().toUpperCase();
  if (!normalizedReference) {
    return { success: false, error: 'Please enter your Booking Reference.' };
  }

  try {
    const [savedTourData, savedBookingData] = await sessionStorage.multiGet([
      sessionKeys.TOUR_DATA,
      sessionKeys.BOOKING_DATA,
    ]);

    const cachedTourData = savedTourData?.[1] ? JSON.parse(savedTourData[1]) : null;
    const cachedBookingData = savedBookingData?.[1] ? JSON.parse(savedBookingData[1]) : null;

    const cachedSessionId = (cachedBookingData?.id || '').toUpperCase();
    const isDriverCode = normalizedReference.startsWith('D-');
    const expectedRole = isDriverCode ? 'driver' : 'passenger';
    const cachedTourId = cachedTourData?.id || cachedBookingData?.assignedTourId || null;

    const isPassengerEmailMatch = (identity) => {
      if (expectedRole === 'driver') return true;
      const cachedNormalizedEmail = normalizePassengerEmail(identity?.normalizedPassengerEmail);
      return cachedNormalizedEmail && cachedNormalizedEmail === normalizePassengerEmail(normalizedEmail);
    };

    if (cachedSessionId && cachedSessionId === normalizedReference) {
      if (!isPassengerEmailMatch(cachedBookingData)) {
        return {
          success: false,
          reason: OFFLINE_LOGIN_REASONS.EMAIL_MISMATCH,
          error: 'Booking email does not match this cached trip.',
        };
      }

      return {
        success: true,
        source: 'session',
        type: expectedRole,
        tour: cachedTourData,
        identity: cachedBookingData,
      };
    }

    if (!cachedTourId) {
      return {
        success: false,
        reason: OFFLINE_LOGIN_REASONS.NO_CACHED_SESSION,
        error: 'No cached trip found for this code; reconnect once to verify.',
      };
    }

    const cachedPackMetaResult = await offlineSyncService.getTourPackMeta(cachedTourId, expectedRole);
    const lastSyncedAt = cachedPackMetaResult?.success ? cachedPackMetaResult?.data?.lastSyncedAt : null;
    if (lastSyncedAt) {
      const lastSyncedTime = new Date(lastSyncedAt).getTime();
      if (Number.isFinite(lastSyncedTime) && Date.now() - lastSyncedTime > OFFLINE_CACHE_TTL_MS) {
        return {
          success: false,
          reason: OFFLINE_LOGIN_REASONS.CACHE_EXPIRED,
          error: 'Offline cache expired; reconnect once to refresh your trip.',
        };
      }
    }

    const cachedPackResult = await offlineSyncService.getTourPack(cachedTourId, expectedRole);
    if (cachedPackResult?.success && cachedPackResult?.data) {
      const packIdentity = expectedRole === 'driver'
        ? cachedPackResult.data.driver
        : cachedPackResult.data.booking;
      const packIdentityId = (packIdentity?.id || '').toUpperCase();
      if (packIdentityId && packIdentityId === normalizedReference) {
        if (!isPassengerEmailMatch(packIdentity)) {
          return {
            success: false,
            reason: OFFLINE_LOGIN_REASONS.EMAIL_MISMATCH,
            error: 'Booking email does not match this cached trip.',
          };
        }

        return {
          success: true,
          source: 'tour-pack',
          type: expectedRole,
          tour: cachedPackResult.data.tour || cachedTourData,
          identity: packIdentity,
        };
      }
    }

    return {
      success: false,
      reason: OFFLINE_LOGIN_REASONS.CODE_MISMATCH,
      error: 'No cached trip found for this code; reconnect once to verify.',
    };
  } catch (error) {
    logger?.warn?.('Auth', 'Offline login check failed', {
      error: error.message,
      reference: maskIdentifier ? maskIdentifier(normalizedReference) : normalizedReference,
    });
    return {
      success: false,
      reason: OFFLINE_LOGIN_REASONS.NO_CACHED_SESSION,
      error: 'No cached trip found for this code; reconnect once to verify.',
    };
  }
};

module.exports = {
  OFFLINE_LOGIN_REASONS,
  OFFLINE_CACHE_TTL_MS,
  normalizePassengerEmail,
  resolveOfflineLoginFromCache,
};
