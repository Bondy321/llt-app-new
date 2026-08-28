'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { enforceLoginAppCheck } = require('../../infrastructure/auth/loginAppCheckGate');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { log } = require('../../infrastructure/logging/safeLogger');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const {
  ROLE_TRANSITION_CLAIM_ROOT,
  buildPassengerRoleClaimJob,
  buildVerifiedLoginGrantUpdates,
  issuePassengerAppSession,
  reconcilePassengerRoleClaimJob,
} = require('../app-sessions/public');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../../infrastructure/validation/stringNormalization');
const { buildPassengerSafeBooking, buildPassengerSafeTour } = require('./passengerProjection');
const { normalizeBookingRef, normalizeEmail } = require('./passengerSanitizer');
const {
  checkPassengerLoginRateLimits,
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
} = require('./passengerLoginSecurity');
const {
  PASSENGER_IDENTITY_VERSION,
  authorizePassengerLoginDevice,
  buildPassengerIdentitySecurityUpdates,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
} = loadLegacyLibrary('passengerIdentity');
const { buildPassengerCustomClaims } = require('./passengerRoleClaims');
const { toClientSession } = loadLegacyLibrary('appSession');

/** @param {number} status @param {string} reason */
const failure = (status, reason) => ({ ok: false, status, body: { valid: false, reason } });
const identityIncompleteFailure = () => ({
  ok: false,
  status: 200,
  body: { valid: false, reason: 'IDENTITY_INCOMPLETE' },
});
const roleTransitionInProgressFailure = () => ({
  ok: false,
  status: 503,
  body: { valid: false, reason: 'ROLE_TRANSITION_IN_PROGRESS' },
});

/** @type {(...args: any[]) => any} */
const buildPassengerLoginResponse = ({
  bookingRef,
  tourId,
  tourCode,
  stablePassengerId,
  session,
  booking,
  tour,
  grantExpiresAtMs,
}) => {
  const resolvedTourCode = resolveTrimmedString(tourCode);
  return {
    valid: true,
    reason: 'OK',
    bookingRef,
    tourId,
    tourCode: resolvedTourCode && resolvedTourCode.length <= 160 ? resolvedTourCode : null,
    stablePassengerId,
    identityVersion: PASSENGER_IDENTITY_VERSION,
    session,
    booking,
    tour,
    grantExpiresAtMs,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const authorizePassengerLoginRequest = async ({ req, bookingRef, email }) => {
  const requestAuth = await verifyRequestAuthUid(req);
  const networkKey = getTrustedRequestNetworkKey(req);
  const networkDimension = hashRateLimitDimension(networkKey);
  if (!requestAuth.success) {
    log.warn('Passenger login rejected: missing or invalid Firebase auth token', {
      bookingRef,
      networkDimension,
      reason: requestAuth.reason,
    });
    return failure(401, 'INVALID_CREDENTIALS');
  }
  try {
    const appCheckValid = await enforceLoginAppCheck({ req, networkDimension, loginType: 'Passenger' });
    if (!appCheckValid) {
      log.warn('Passenger login rejected: missing or invalid App Check token', { networkDimension });
      return failure(401, 'INVALID_CREDENTIALS');
    }
  } catch (configurationError) {
    log.error('Passenger login disabled by unsafe App Check configuration', configurationError, { networkDimension });
    return failure(503, 'SERVICE_UNAVAILABLE');
  }
  try {
    const rateLimit = await checkPassengerLoginRateLimits({
      authUid: requestAuth.uid,
      clientKey: networkKey,
      bookingRef,
      email,
      limiter: distributedLoginRateLimiter,
    });
    if (!rateLimit.allowed) {
      log.warn('Passenger login rate limit exceeded', {
        scope: rateLimit.scope,
        authDimension: rateLimit.authDimension,
        networkDimension: rateLimit.networkDimension,
      });
      return failure(429, 'TRY_AGAIN_LATER');
    }
  } catch (rateLimitError) {
    log.error('Passenger login disabled because distributed rate limiting failed', rateLimitError, { networkDimension });
    return failure(503, 'SERVICE_UNAVAILABLE');
  }
  return { ok: true, authUid: requestAuth.uid, networkDimension };
};

/** @type {(...args: any[]) => Promise<any>} */
const loadPassengerLoginContext = async ({ bookingRef, email, networkDimension }) => {
  const database = admin.database();
  const identitySnapshot = await database.ref(`booking_identities/${bookingRef}`).once('value');
  if (!identitySnapshot.exists()) {
    log.warn('Passenger login verification failed', { bookingRef, networkDimension, cause: 'BOOKING_NOT_FOUND' });
    return failure(401, 'INVALID_CREDENTIALS');
  }
  const identity = identitySnapshot.val() || {};
  if (normalizeEmail(identity.email) !== email) {
    log.warn('Passenger login verification failed', { bookingRef, networkDimension, cause: 'EMAIL_MISMATCH' });
    return failure(401, 'INVALID_CREDENTIALS');
  }
  const resolvedBookingRef = normalizeBookingRef(identity.bookingRef || bookingRef);
  const canonicalTourId = normalizeTourKeyForComparison(
    typeof identity.tourId === 'string' ? identity.tourId.trim() : '',
  );
  if (!resolvedBookingRef || !canonicalTourId) {
    log.warn('Booking identity missing essential identifiers', { bookingRef });
    return identityIncompleteFailure();
  }
  const [bookingSnapshot, tourSnapshot] = await Promise.all([
    database.ref(`bookings/${resolvedBookingRef}`).once('value'),
    database.ref(`tours/${canonicalTourId}`).once('value'),
  ]);
  if (!bookingSnapshot.exists() || !tourSnapshot.exists()) {
    log.warn('Booking identity points at missing booking or tour', {
      bookingRef,
      resolvedBookingRef,
      tourId: canonicalTourId,
      hasBooking: bookingSnapshot.exists(),
      hasTour: tourSnapshot.exists(),
    });
    return identityIncompleteFailure();
  }
  const tourData = tourSnapshot.val() || {};
  if (tourData.isActive === false) {
    log.warn('Passenger login rejected for inactive tour', { bookingRef, tourId: canonicalTourId });
    return failure(200, 'TOUR_INACTIVE');
  }
  return {
    ok: true,
    bookingSnapshot,
    canonicalTourId,
    database,
    identity,
    resolvedBookingRef,
    tourData,
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const authorizePassengerIdentity = async ({ authUid, context, bookingRef, networkDimension }) => {
  const { canonicalTourId, database, identity, resolvedBookingRef } = context;
  const securityRef = database.ref(`passenger_identity_security/${resolvedBookingRef}`);
  const securedIdentity = await ensureOpaquePassengerIdentity({
    securityRef,
    seed: {
      ...(isOpaquePassengerId(identity.passengerPrincipalId) ? {
        passengerPrincipalId: identity.passengerPrincipalId,
        passengerIdentityVersion: PASSENGER_IDENTITY_VERSION,
        passengerIdentityIssuedAtMs: identity.passengerIdentityIssuedAtMs || Date.now(),
      } : {}),
      ...(typeof identity.authorizedAuthUid === 'string' && identity.authorizedAuthUid.trim()
        ? { authorizedAuthUid: identity.authorizedAuthUid.trim() } : {}),
      ...(identity.loginLocked === true
        ? { loginLocked: true, loginLockReason: identity.loginLockReason || 'migration_review_required' } : {}),
    },
  });
  const stablePassengerId = securedIdentity.passengerPrincipalId;
  if (!isOpaquePassengerId(stablePassengerId)) return identityIncompleteFailure();
  try {
    await authorizePassengerLoginDevice({ securityRef, authUid });
  } catch (authorizationError) {
    const typedError = /** @type {{ code?: string }} */ (authorizationError);
    const reason = typedError?.code === 'REAUTHORIZE_REQUIRED' ? 'REAUTHORIZE_REQUIRED' : 'IDENTITY_INCOMPLETE';
    log.warn('Passenger login rejected by device-bound credential', {
      bookingRef,
      networkDimension,
      reason,
    });
    return failure(reason === 'REAUTHORIZE_REQUIRED' ? 403 : 200, reason);
  }
  return { ok: true, canonicalTourId, stablePassengerId };
};

/** @type {(...args: any[]) => Promise<any>} */
const issueVerifiedPassengerSession = async ({ authUid, context, stablePassengerId }) => {
  const { bookingSnapshot, canonicalTourId, database, resolvedBookingRef, tourData } = context;
  const sessionIssuedAtMs = Date.now();
  const grantUpdates = buildVerifiedLoginGrantUpdates({
    authUid,
    bookingRef: resolvedBookingRef,
    tourId: canonicalTourId,
    nowMs: sessionIssuedAtMs,
  });
  if (!grantUpdates) return identityIncompleteFailure();
  const userSnapshot = await database.ref(`users/${authUid}`).once('value');
  const identityUpdates = buildPassengerIdentitySecurityUpdates({
    authUid,
    bookingRef: resolvedBookingRef,
    tourId: canonicalTourId,
    passengerPrincipalId: stablePassengerId,
    previousProfile: userSnapshot.val() || {},
    nowMs: sessionIssuedAtMs,
  });
  if (!identityUpdates) return identityIncompleteFailure();
  const appSession = await issuePassengerAppSession({
    db: database,
    authUid,
    principalId: stablePassengerId,
    tourId: canonicalTourId,
    bookingRef: resolvedBookingRef,
    identityUpdates,
    grantUpdates,
    buildRoleClaimUpdates: (session) => ({
      [`${ROLE_TRANSITION_CLAIM_ROOT}/${authUid}`]: buildPassengerRoleClaimJob({
        authUid,
        session,
        privatePhotoOwnerKey: stablePassengerId,
        nowMs: sessionIssuedAtMs,
      }),
    }),
    nowMs: sessionIssuedAtMs,
  });
  try {
    const claimResult = await reconcilePassengerRoleClaimJob({
      db: database,
      auth: admin.auth(),
      authUid,
      buildClaims: buildPassengerCustomClaims,
    });
    if (!claimResult.completed) return roleTransitionInProgressFailure();
  } catch (error) {
    log.warn('Passenger role claim projection remains retryable', {
      errorCode: error?.code || 'CLAIM_RETRY',
    });
    return roleTransitionInProgressFailure();
  }
  return {
    ok: true,
    status: 200,
    body: buildPassengerLoginResponse({
      bookingRef: resolvedBookingRef,
      tourId: canonicalTourId,
      tourCode: tourData.tourCode,
      stablePassengerId,
      session: toClientSession(appSession),
      booking: buildPassengerSafeBooking(resolvedBookingRef, bookingSnapshot.val() || {}, canonicalTourId),
      tour: buildPassengerSafeTour(canonicalTourId, tourData),
      grantExpiresAtMs: grantUpdates[`tour_access_grants/${canonicalTourId}/${authUid}`].expiresAtMs,
    }),
  };
};

/** @type {(...args: any[]) => Promise<any>} */
const executePassengerLogin = async ({ req, bookingRef, email }) => {
  const requestAccess = await authorizePassengerLoginRequest({ req, bookingRef, email });
  if (!requestAccess.ok) return requestAccess;
  const context = await loadPassengerLoginContext({ bookingRef, email, networkDimension: requestAccess.networkDimension });
  if (!context.ok) return context;
  const identityAccess = await authorizePassengerIdentity({
    authUid: requestAccess.authUid,
    context,
    bookingRef,
    networkDimension: requestAccess.networkDimension,
  });
  if (!identityAccess.ok) return identityAccess;
  return issueVerifiedPassengerSession({
    authUid: requestAccess.authUid,
    context,
    stablePassengerId: identityAccess.stablePassengerId,
  });
};

module.exports = {
  authorizePassengerIdentity,
  authorizePassengerLoginRequest,
  buildPassengerCustomClaims,
  buildPassengerLoginResponse,
  executePassengerLogin,
  issueVerifiedPassengerSession,
  loadPassengerLoginContext,
};
