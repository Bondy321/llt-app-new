const OFFLINE_LOGIN_REASON_COPY = {
  NO_CACHED_SESSION: 'This device has no verified offline trip for this code yet. Connect once to verify this booking/driver code on this device, then offline login will work next time.',
  CODE_MISMATCH: 'The code you entered does not match the trip cached on this device. Check for typing errors, or reconnect so we can verify the correct code online.',
  CACHE_EXPIRED: 'Your offline trip cache has expired. Reconnect briefly once to verify, then offline mode will work next time.',
  EMAIL_MISMATCH: 'The booking email entered does not match the cached trip on this device. Use the original booking email or reconnect to verify online.',
  EMAIL_NOT_CACHED: 'This trip was cached before email verification was enabled. Reconnect once to refresh secure offline access.',
};

const OFFLINE_RETRYABLE_REASONS = ['NO_CACHED_SESSION', 'CODE_MISMATCH', 'CACHE_EXPIRED', 'EMAIL_MISMATCH', 'EMAIL_NOT_CACHED'];

const isLikelyEmailFormat = (value) => {
  const atIndex = value.indexOf('@');
  const dotAfterAt = value.indexOf('.', atIndex + 2);
  return atIndex > 0 && dotAfterAt > atIndex + 1 && dotAfterAt < value.length - 1;
};

const normalizeLoginFields = ({ bookingReference, email }) => {
  const trimmedReference = (bookingReference || '').trim();
  const normalizedReference = trimmedReference.toUpperCase();
  const isDriverCode = normalizedReference.startsWith('D-');
  const normalizedEmail = (email || '').trim().toLowerCase();

  return {
    trimmedReference,
    normalizedReference,
    isDriverCode,
    normalizedEmail,
  };
};

const getLoginInputError = ({ trimmedReference, isDriverCode, normalizedEmail }) => {
  if (!trimmedReference) {
    return 'Please enter your Booking Reference.';
  }

  if (!isDriverCode && normalizedEmail.length === 0) {
    return 'Please enter the booking email used for this reservation.';
  }

  if (!isDriverCode && !isLikelyEmailFormat(normalizedEmail)) {
    return 'Please enter a valid booking email (for example, name@example.com).';
  }

  return null;
};

const createOfflineErrorState = (offlineCheck, createErrorState) => {
  const reason = offlineCheck?.reason;
  return createErrorState(
    OFFLINE_LOGIN_REASON_COPY[reason] || offlineCheck?.error || 'No cached trip found for this code; reconnect once to verify.',
    {
      title: 'Offline login unavailable',
      reason,
      showOfflineActions: OFFLINE_RETRYABLE_REASONS.includes(reason),
    }
  );
};

const resolveLoginIdentity = (result) => (result.type === 'driver' ? result.driver : result.booking);

module.exports = {
  OFFLINE_LOGIN_REASON_COPY,
  OFFLINE_RETRYABLE_REASONS,
  isLikelyEmailFormat,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  resolveLoginIdentity,
};

