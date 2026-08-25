// services/bookingServiceRealtime.js
// Enhanced with comprehensive validation, transaction safety, and error handling
const isTestEnv = process.env.NODE_ENV === 'test';
const IS_DEV_RUNTIME =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
let realtimeDb;
let auth;
let logger;
let recordCrashBreadcrumb;
let getCurrentAppCheckToken;
let maskIdentifier = (value) => value;
let loginDiagnosticsService = null;
const { loadOptionalService } = require('../optionalServiceLoader');
const { normalizeTourId, resolveTourId } = require('../tourIdentityService');
const {
  PASSENGER_IDENTITY_VERSION,
  isOpaquePassengerId,
} = require('../identityService');
const { normalizeItineraryDocument } = require('../itineraryService');
const {
  normalizePassengerBookingProjection,
  normalizePassengerTourProjection,
} = require('../passengerDataBoundary');
const { validateAppSession } = require('../appSessionService');

try {
  loginDiagnosticsService = require('../loginDiagnosticsService');
} catch (_error) {
  loginDiagnosticsService = null;
}

// Status Enums for the Manifest
const MANIFEST_STATUS = {
  PENDING: 'PENDING',
  BOARDED: 'BOARDED',
  NO_SHOW: 'NO_SHOW',
  PARTIAL: 'PARTIAL'
};

if (!isTestEnv) {
  try {
    const loggerModule = require('../loggerService');
    logger = loggerModule.default;
    if (typeof loggerModule.maskIdentifier === 'function') {
      maskIdentifier = loggerModule.maskIdentifier;
    }
  } catch (_error) {
    logger = null;
  }

  try {
    const crashDiagnosticsModule = require('../crashDiagnosticsService');
    recordCrashBreadcrumb = crashDiagnosticsModule.recordBreadcrumb;
  } catch (_error) {
    recordCrashBreadcrumb = null;
  }

  try {
    ({ realtimeDb, auth, getCurrentAppCheckToken } = require('../../firebase'));
  } catch (error) {
    if (logger?.warn) {
      logger.warn('BookingService', 'Realtime database module not initialized during load', { error: error.message });
    } else if (IS_DEV_RUNTIME) {
      console.warn('Realtime database module not initialized during load:', error.message);
    }
  }
}


const offlineSyncService = loadOptionalService({
  modulePath: '../offlineSyncService',
  loadModule: () => require('../offlineSyncService'),
  serviceLabel: 'BookingService',
  logger,
  isTestEnv,
});
const { parseTimestampMs } = require('../timeUtils');

const logBookingEvent = (level, message, payload = {}) => {
  try {
    const logLevel = typeof logger?.[level] === 'function' ? level : 'info';
    logger?.[logLevel]?.('BookingService', message, payload);
  } catch (_error) {
    // Diagnostics must never affect booking flows.
  }
};

const recordBookingDiagnostic = (event, payload = {}) => {
  try {
    recordCrashBreadcrumb?.('BookingService', event, payload, {
      remote: true,
      reason: `BookingService:${event}`,
    });
  } catch (_error) {
    // Diagnostics must never affect booking flows.
  }
};

const buildPassengerLoginVerifierUrl = () => {
  const explicitUrl = process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/verifyPassengerLogin`;
};

const buildDerivedPassengerLoginVerifierUrl = () => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/verifyPassengerLogin`;
};

const buildTourManifestEndpointUrl = () => {
  const explicitUrl = process.env.EXPO_PUBLIC_GET_TOUR_MANIFEST_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/getTourManifest`;
};

const buildDerivedTourManifestEndpointUrl = () => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/getTourManifest`;
};

const buildDriverLoginVerifierUrl = () => {
  const explicitUrl = process.env.EXPO_PUBLIC_VERIFY_DRIVER_LOGIN_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/verifyDriverLogin`;
};

const buildDerivedDriverLoginVerifierUrl = () => {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/verifyDriverLogin`;
};

const buildDriverAssignmentEndpointUrl = () => {
  const explicitUrl = process.env.EXPO_PUBLIC_ASSIGN_DRIVER_TO_TOUR_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;

  return `https://europe-west1-${projectId}.cloudfunctions.net/assignDriverToTour`;
};

const endpointMentionsFunction = (endpoint, functionName) => (
  typeof endpoint === 'string'
  && typeof functionName === 'string'
  && endpoint.toLowerCase().includes(functionName.toLowerCase())
);

const buildLoginVerifierEndpointCandidates = ({
  configuredEndpoint,
  derivedEndpoint,
  expectedFunctionName,
  unexpectedFunctionName,
  loginType,
}) => {
  const configured = typeof configuredEndpoint === 'string' ? configuredEndpoint.trim() : '';
  const derived = typeof derivedEndpoint === 'string' ? derivedEndpoint.trim() : '';
  const candidates = [];

  if (configured) {
    const pointsAtUnexpectedVerifier = unexpectedFunctionName
      && endpointMentionsFunction(configured, unexpectedFunctionName)
      && !endpointMentionsFunction(configured, expectedFunctionName);

    if (pointsAtUnexpectedVerifier) {
      logBookingEvent('warn', `${loginType} verifier configured endpoint points at the wrong login function`, {
        expectedFunctionName,
        unexpectedFunctionName,
        hasDerivedEndpoint: Boolean(derived),
      });
    } else {
      candidates.push(configured);
    }
  }

  if (derived && !candidates.includes(derived)) {
    candidates.push(derived);
  }

  return candidates;
};

const getPassengerLoginVerifierTimeoutMs = () => {
  const configured = Number(process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 1000) {
    return configured;
  }

  return 10000;
};

const fetchWithTimeout = async (endpoint, options = {}, timeoutMs = getPassengerLoginVerifierTimeoutMs()) => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const LOGIN_REALTIME_READ_RETRY_ATTEMPTS = 3;
const DEFAULT_LOGIN_REALTIME_READ_RETRY_BASE_MS = 250;

const getLoginRealtimeReadRetryBaseMs = () => {
  const configured = Number(process.env.EXPO_PUBLIC_LOGIN_REALTIME_READ_RETRY_BASE_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return DEFAULT_LOGIN_REALTIME_READ_RETRY_BASE_MS;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableRealtimeReadError = (error) => {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : String(error || '');
  const combined = `${code} ${message}`;

  return /permission[_ -]?denied|network|offline|timeout|timed? out|disconnect|unavailable|cancelled|websocket|transport/i.test(combined);
};

const readRealtimeSnapshotWithLoginRetry = async (ref, { label, attempts = LOGIN_REALTIME_READ_RETRY_ATTEMPTS, diagnostics } = {}) => {
  let lastError;
  const retryBaseMs = getLoginRealtimeReadRetryBaseMs();
  const startedAt = Date.now();

  recordLoginDiagnostic('rtdb_read_started', {
    label,
    attempts,
  }, diagnostics);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const snapshot = await ref.once('value');
      recordLoginDiagnostic('rtdb_read_succeeded', {
        label,
        attempt,
        attempts,
        durationMs: Date.now() - attemptStartedAt,
        totalDurationMs: Date.now() - startedAt,
        exists: Boolean(snapshot?.exists?.()),
      }, diagnostics);
      return snapshot;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableRealtimeReadError(error);
      if (!retryable || attempt >= attempts) {
        recordLoginDiagnostic('rtdb_read_failed_final', {
          label,
          attempt,
          attempts,
          retryable,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
          error: loginDiagnosticsService?.summarizeError
            ? loginDiagnosticsService.summarizeError(error)
            : { code: error?.code || null, message: error?.message || String(error) },
        }, diagnostics);
        throw error;
      }

      const delayMs = retryBaseMs * (2 ** (attempt - 1));
      logBookingEvent('warn', 'Realtime read failed during login; retrying', {
        label,
        attempt,
        maxAttempts: attempts,
        delayMs,
        code: error?.code || null,
        error: error?.message || String(error),
      });
      recordLoginDiagnostic('rtdb_read_failed_retrying', {
        label,
        attempt,
        attempts,
        retryable,
        delayMs,
        durationMs: Date.now() - attemptStartedAt,
        error: loginDiagnosticsService?.summarizeError
          ? loginDiagnosticsService.summarizeError(error)
          : { code: error?.code || null, message: error?.message || String(error) },
      }, diagnostics);
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  }

  throw lastError;
};

const shouldUseAppCheckForPassengerVerifier = () => {
  // Disabled by default until App Check rollout is explicitly enabled.
  return process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK === 'true';
};

const shouldRequireAppCheckForPassengerVerifier = () => {
  // Strict mode is only relevant when App Check is enabled for verifier requests.
  return process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK === 'true';
};

const getAppCheckHeaderValue = async () => {
  if (typeof getCurrentAppCheckToken !== 'function') {
    return { success: false, reason: 'APPCHECK_PROVIDER_UNAVAILABLE' };
  }

  try {
    const token = await getCurrentAppCheckToken();
    if (typeof token === 'string' && token.trim()) {
      return { success: true, token: token.trim() };
    }

    return { success: false, reason: 'APPCHECK_TOKEN_UNAVAILABLE' };
  } catch (error) {
    return {
      success: false,
      reason: 'APPCHECK_TOKEN_FETCH_FAILED',
      error: error?.message || String(error),
    };
  }
};

const resolveLoginDiagnosticsContext = (options = {}) => {
  if (options?.loginDiagnostics) return options.loginDiagnostics;
  if (options?.diagnostics) return options.diagnostics;
  if (options?.loginDiagnosticId) return { attemptId: options.loginDiagnosticId };
  return null;
};

const recordLoginDiagnostic = (event, payload = {}, context = null) => {
  try {
    if (!context || typeof loginDiagnosticsService?.recordLoginDiagnostic !== 'function') return;
    loginDiagnosticsService.recordLoginDiagnostic(event, payload, context).catch(() => {});
  } catch (_error) {
    // Diagnostics must never affect booking flows.
  }
};

const getFirebaseAuthHeaderValue = async () => {
  const currentUser = auth?.currentUser;
  if (!currentUser || typeof currentUser.getIdToken !== 'function') {
    return { success: false, reason: 'AUTH_USER_UNAVAILABLE' };
  }

  try {
    const token = await currentUser.getIdToken();
    if (typeof token === 'string' && token.trim()) {
      return { success: true, token: token.trim() };
    }

    return { success: false, reason: 'AUTH_TOKEN_UNAVAILABLE' };
  } catch (error) {
    return {
      success: false,
      reason: 'AUTH_TOKEN_FETCH_FAILED',
      error: error?.message || String(error),
    };
  }
};

const mapTourManifestFunctionReason = (reason) => {
  const reasonToMessage = {
    INVALID_CREDENTIALS: 'Secure manifest access is still starting. Please wait a moment and try again.',
    INVALID_INPUT: 'This tour manifest could not be opened. Please return to your tour and try again.',
    METHOD_NOT_ALLOWED: 'Manifest service is currently unavailable. Please update the app and try again shortly.',
    NOT_AUTHORIZED: 'You do not have access to this passenger manifest.',
    TOUR_NOT_FOUND: 'This tour manifest is no longer available.',
    TRY_AGAIN_LATER: 'Too many manifest refreshes. Please wait a moment and try again.',
    INTERNAL_ERROR: 'Manifest service is temporarily unavailable. Please try again shortly.',
  };

  return reasonToMessage[reason] || 'Manifest service is temporarily unavailable. Please try again shortly.';
};

const fetchTourManifestFromFunction = async (tourCodeOriginal) => {
  const configuredEndpoint = buildTourManifestEndpointUrl();
  const derivedEndpoint = buildDerivedTourManifestEndpointUrl();
  const endpointCandidates = [configuredEndpoint, derivedEndpoint].filter((value, index, list) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    return list.indexOf(value) === index;
  });

  if (endpointCandidates.length === 0) {
    logBookingEvent('warn', 'Tour manifest function unavailable: no endpoint candidates', {
      tourCode: maskIdentifier(tourCodeOriginal),
    });
    throw new Error('Manifest service is not configured in this app version. Please update the app and try again.');
  }

  const firebaseAuthResult = await getFirebaseAuthHeaderValue();
  if (!firebaseAuthResult.success) {
    logBookingEvent('warn', 'Tour manifest function blocked without Firebase auth token', {
      tourCode: maskIdentifier(tourCodeOriginal),
      reason: firebaseAuthResult.reason,
      error: firebaseAuthResult.error,
    });
    throw new Error('Secure manifest access is still starting. Please wait a moment and try again.');
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${firebaseAuthResult.token}`,
  };

  for (const endpoint of endpointCandidates) {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tourId: tourCodeOriginal }),
    });
    const payload = await response.json().catch(() => null);

    if (!payload) {
      if (response.status === 404) {
        continue;
      }
      throw new Error('Manifest service returned an unexpected response. Please try again.');
    }

    if (!response.ok || payload.success === false) {
      if (response.status === 404 && endpoint !== endpointCandidates[endpointCandidates.length - 1]) {
        continue;
      }
      throw new Error(mapTourManifestFunctionReason(payload.reason));
    }

      return {
        schemaVersion: payload.schemaVersion,
        complete: payload.complete === true,
        tourId: payload.tourId,
      tourCode: payload.tourCode || null,
      bookings: Array.isArray(payload.bookings) ? payload.bookings : [],
      stats: payload.stats || {},
    };
  }

throw new Error('Manifest service is temporarily unavailable. Please try again shortly.');
};

module.exports = {
  MANIFEST_STATUS,
  PASSENGER_IDENTITY_VERSION,
  auth,
  buildDriverAssignmentEndpointUrl,
  buildDerivedDriverLoginVerifierUrl,
  buildDerivedPassengerLoginVerifierUrl,
  buildDriverLoginVerifierUrl,
  buildLoginVerifierEndpointCandidates,
  buildPassengerLoginVerifierUrl,
  fetchTourManifestFromFunction,
  fetchWithTimeout,
  getAppCheckHeaderValue,
  getCurrentAppCheckToken,
  getFirebaseAuthHeaderValue,
  getPassengerLoginVerifierTimeoutMs,
  isOpaquePassengerId,
  isRetryableRealtimeReadError,
  isTestEnv,
  loginDiagnosticsService,
  logBookingEvent,
  logger,
  mapTourManifestFunctionReason,
  maskIdentifier,
  normalizeItineraryDocument,
  normalizePassengerBookingProjection,
  normalizePassengerTourProjection,
  normalizeTourId,
  offlineSyncService,
  parseTimestampMs,
  readRealtimeSnapshotWithLoginRetry,
  realtimeDb,
  recordBookingDiagnostic,
  recordLoginDiagnostic,
  resolveLoginDiagnosticsContext,
  resolveTourId,
  shouldRequireAppCheckForPassengerVerifier,
  shouldUseAppCheckForPassengerVerifier,
  validateAppSession,
};
