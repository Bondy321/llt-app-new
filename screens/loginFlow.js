const OFFLINE_LOGIN_REASON_COPY = {
  NO_CACHED_SESSION: {
    headline: 'Offline login isn’t ready on this device yet.',
    details: [
      'Connect once and sign in with this exact code so we can save a verified trip on this device.',
      'After that first online check, you can use offline login for this same identity.',
    ],
  },
  CODE_MISMATCH: {
    headline: 'That code doesn’t match your saved offline trip.',
    details: [
      'Check the code for typos (including the D- prefix for drivers).',
      'If this is a different trip, reconnect once so we can verify and save it for offline use.',
    ],
  },
  CACHE_EXPIRED: {
    headline: 'Your saved offline trip needs a quick refresh.',
    details: [
      'Reconnect briefly and sign in once to refresh your saved trip data.',
      'You can then use offline login again on this device.',
    ],
  },
  EMAIL_MISMATCH: {
    headline: 'That booking email doesn’t match this saved trip.',
    details: [
      'Use the same booking email that was used when this trip was first verified.',
      'If you updated details, reconnect once and verify online to refresh offline access.',
    ],
  },
  EMAIL_NOT_CACHED: {
    headline: 'This saved trip needs one online email check first.',
    details: [
      'Reconnect once and sign in online so we can refresh secure offline email verification.',
      'After that, offline login will work again for this booking identity.',
    ],
  },
};

const OFFLINE_RETRYABLE_REASONS = ['NO_CACHED_SESSION', 'CODE_MISMATCH', 'CACHE_EXPIRED', 'EMAIL_MISMATCH', 'EMAIL_NOT_CACHED'];
const LOGIN_SUCCESS_INTERSTITIAL_MS = 1400;


const LOGIN_PRIMARY_LAYOUT_KEYS = ['code_input', 'primary_cta', 'mode_hints'];

const getLoginTransitionDurationMs = ({ alreadyHydrated } = {}) => (
  alreadyHydrated ? 700 : LOGIN_SUCCESS_INTERSTITIAL_MS
);

const LOGIN_MODE_HINTS = {
  passenger: {
    label: 'Passenger',
    hint: 'Use your booking reference (for example T12345 or ABC123).',
    placeholder: 'Booking reference (for example T12345)',
  },
  driver: {
    label: 'Driver',
    hint: 'Use your driver code starting with D- (for example D-BONDY).',
    placeholder: 'Driver code (for example D-BONDY)',
  },
};

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

const getLoginInputError = ({ trimmedReference, isDriverCode, normalizedEmail }, options = {}) => {
  const phase = options.phase || 'submit';
  const emailTouched = options.emailTouched || false;

  if (!trimmedReference) {
    return 'Please enter your Booking Reference.';
  }

  if (!isDriverCode && normalizedEmail.length === 0 && phase === 'submit') {
    return 'Please enter the booking email used for this reservation.';
  }

  if (!isDriverCode && normalizedEmail.length > 0 && !isLikelyEmailFormat(normalizedEmail)) {
    if (phase === 'submit' || emailTouched) {
      return 'Please enter a valid booking email (for example, name@example.com).';
    }
  }

  return null;
};

const createOfflineErrorState = (offlineCheck, createErrorState) => {
  const reason = offlineCheck?.reason;
  const copy = OFFLINE_LOGIN_REASON_COPY[reason];

  return createErrorState(
    copy?.headline || offlineCheck?.error || 'No cached trip found for this code; reconnect once to verify.',
    {
      title: 'Offline login unavailable',
      reason,
      showOfflineActions: OFFLINE_RETRYABLE_REASONS.includes(reason),
      recoverySteps: copy?.details || [],
    }
  );
};

const getReferencePlaceholder = (modeHintFocus) => {
  if (modeHintFocus && LOGIN_MODE_HINTS[modeHintFocus]) {
    return LOGIN_MODE_HINTS[modeHintFocus].placeholder;
  }
  return 'Booking or driver code';
};

const shouldShowEmailField = ({ modeHintFocus, normalizedReference }) => {
  if (modeHintFocus === 'driver') return false;
  if (modeHintFocus === 'passenger') return true;
  if (!normalizedReference) return false;
  return !normalizedReference.startsWith('D-');
};

const resolveLoginIdentity = (result) => (result.type === 'driver' ? result.driver : result.booking);

module.exports = {
  OFFLINE_LOGIN_REASON_COPY,
  OFFLINE_RETRYABLE_REASONS,
  LOGIN_MODE_HINTS,
  LOGIN_PRIMARY_LAYOUT_KEYS,
  LOGIN_SUCCESS_INTERSTITIAL_MS,
  getLoginTransitionDurationMs,
  isLikelyEmailFormat,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  getReferencePlaceholder,
  shouldShowEmailField,
  resolveLoginIdentity,
};
