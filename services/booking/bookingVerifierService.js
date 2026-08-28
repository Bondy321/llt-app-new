const {
  auth,
  buildDerivedDriverLoginVerifierUrl,
  buildDerivedPassengerLoginVerifierUrl,
  buildDriverLoginVerifierUrl,
  buildLoginVerifierEndpointCandidates,
  buildPassengerLoginVerifierUrl,
  fetchWithTimeout,
  getAppCheckHeaderValue,
  getFirebaseAuthHeaderValue,
  getPassengerLoginVerifierTimeoutMs,
  logBookingEvent,
  logger,
  loginDiagnosticsService,
  maskIdentifier,
  recordLoginDiagnostic,
  shouldRequireAppCheckForPassengerVerifier,
  shouldUseAppCheckForPassengerVerifier,
} = require('./bookingServiceContext');
const {
  isDriverLoginResponse,
  isPassengerLoginResponse,
} = require('../../src/shared/api/responseBoundaries');

const mapDriverVerifierReason = (reason) => {
  const reasonToMessage = {
    ASSIGNMENT_IN_PROGRESS: 'Driver assignment is being updated. Please try again.',
    DRIVER_ALREADY_LINKED: 'This driver code is already linked to another device. Please contact dispatch if this is unexpected.',
    DRIVER_LOGIN_IN_PROGRESS: 'Another sign-in for this driver is finishing. Please try again.',
    DRIVER_NOT_FOUND: 'Driver code not found',
    DRIVER_POLICY_CHANGE_IN_PROGRESS: 'Driver sign-in settings are being updated. Please try again.',
    INVALID_CREDENTIALS: 'Secure driver sign-in is still starting. Please wait a moment and try again.',
    INVALID_INPUT: 'Invalid driver code provided',
    METHOD_NOT_ALLOWED: 'Driver verification is currently unavailable. Please update the app and try again shortly.',
    TRY_AGAIN_LATER: 'Too many driver sign-in attempts. Please wait a moment and try again.',
    INTERNAL_ERROR: 'Driver verification is temporarily unavailable. Please try again shortly.',
  };

  return reasonToMessage[reason] || 'Unable to verify driver code. Please try again shortly.';
};

const verifyDriverLoginIdentity = async ({ driverId }) => {
  const configuredEndpoint = buildDriverLoginVerifierUrl();
  const derivedEndpoint = buildDerivedDriverLoginVerifierUrl();
  logBookingEvent('info', 'Driver verifier request prepared', {
    driverId: maskIdentifier(driverId),
    configuredEndpointPresent: Boolean(configuredEndpoint),
    derivedEndpointPresent: Boolean(derivedEndpoint),
  });

  const endpointCandidates = buildLoginVerifierEndpointCandidates({
    configuredEndpoint,
    derivedEndpoint,
    expectedFunctionName: 'verifyDriverLogin',
    unexpectedFunctionName: 'verifyPassengerLogin',
    loginType: 'Driver',
  });

  if (endpointCandidates.length === 0) {
    logBookingEvent('warn', 'Driver verifier unavailable: no endpoint candidates', {
      driverId: maskIdentifier(driverId),
    });
    return null;
  }

  const firebaseAuthResult = await getFirebaseAuthHeaderValue();
  if (!firebaseAuthResult.success) {
    logBookingEvent('warn', 'Driver verifier blocked without Firebase auth token', {
      driverId: maskIdentifier(driverId),
      reason: firebaseAuthResult.reason,
      error: firebaseAuthResult.error,
    });
    return {
      valid: false,
      error: mapDriverVerifierReason('INVALID_CREDENTIALS'),
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${firebaseAuthResult.token}`,
  };

  const useAppCheck = shouldUseAppCheckForPassengerVerifier();
  const strictAppCheck = shouldRequireAppCheckForPassengerVerifier();
  const appCheckResult = useAppCheck
    ? await getAppCheckHeaderValue()
    : { success: false, reason: 'APPCHECK_DISABLED' };
  if (strictAppCheck && !appCheckResult.success) {
    return {
      valid: false,
      error: 'App security check could not be completed. Update the app or reconnect and try again.',
    };
  }
  if (appCheckResult.success) {
    headers['x-firebase-appcheck'] = appCheckResult.token;
  }

  for (const endpoint of endpointCandidates) {
    let response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ driverId }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { valid: false, error: 'Driver verification timed out. Check your connection and try again.' };
      }
      return { valid: false, error: 'Driver verification is temporarily unavailable. Please try again shortly.' };
    }
    const payload = await response.json().catch(() => null);

    if (!payload) {
      if (response.status === 404) {
        continue;
      }
      return { valid: false, error: 'Driver verification returned an unexpected response. Please try again.' };
    }
    if (!isDriverLoginResponse(payload)) {
      return { valid: false, error: 'Driver verification returned an unexpected response. Please try again.' };
    }

    if (!response.ok || payload.valid === false) {
      if (response.status === 404 && endpoint !== endpointCandidates[endpointCandidates.length - 1]) {
        continue;
      }
      return { valid: false, error: mapDriverVerifierReason(payload.reason) };
    }

    return payload;
  }

  return { valid: false, error: 'Driver verification is temporarily unavailable. Please try again shortly.' };
};

const verifyPassengerLoginIdentity = async ({ bookingRef, email, diagnostics } = {}) => {
  const configuredEndpoint = buildPassengerLoginVerifierUrl();
  const derivedEndpoint = buildDerivedPassengerLoginVerifierUrl();
  logBookingEvent('info', 'Passenger verifier request prepared', {
    bookingRef: maskIdentifier(bookingRef),
    hasEmail: Boolean(email),
    configuredEndpointPresent: Boolean(configuredEndpoint),
    derivedEndpointPresent: Boolean(derivedEndpoint),
  });

  const endpointCandidates = buildLoginVerifierEndpointCandidates({
    configuredEndpoint,
    derivedEndpoint,
    expectedFunctionName: 'verifyPassengerLogin',
    unexpectedFunctionName: 'verifyDriverLogin',
    loginType: 'Passenger',
  });

  recordLoginDiagnostic('passenger_verifier_candidates_prepared', {
    bookingRef,
    email,
    configuredEndpoint,
    derivedEndpoint,
    candidateCount: endpointCandidates.length,
    candidates: endpointCandidates,
    timeoutMs: getPassengerLoginVerifierTimeoutMs(),
    appCheckEnabled: shouldUseAppCheckForPassengerVerifier(),
    appCheckStrict: shouldRequireAppCheckForPassengerVerifier(),
    hasAuthUser: Boolean(auth?.currentUser),
    authUserIsAnonymous: Boolean(auth?.currentUser?.isAnonymous),
  }, diagnostics);

  if (endpointCandidates.length === 0) {
    logBookingEvent('warn', 'Passenger verifier unavailable: no endpoint candidates', {
      bookingRef: maskIdentifier(bookingRef),
    });
    recordLoginDiagnostic('passenger_verifier_no_endpoint_candidates', {
      bookingRef,
      configuredEndpoint,
      derivedEndpoint,
    }, diagnostics);
    return { valid: false, reason: 'VERIFIER_NOT_CONFIGURED' };
  }

  const controller = new AbortController();
  const timeoutMs = getPassengerLoginVerifierTimeoutMs();
  let timeoutHandle;

  try {
    timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const useAppCheck = shouldUseAppCheckForPassengerVerifier();
    const strictAppCheck = shouldRequireAppCheckForPassengerVerifier();
    const appCheckResult = useAppCheck
      ? await getAppCheckHeaderValue()
      : { success: false, reason: 'APPCHECK_DISABLED' };
    const firebaseAuthResult = await getFirebaseAuthHeaderValue();

    recordLoginDiagnostic('passenger_verifier_security_headers_prepared', {
      bookingRef,
      email,
      useAppCheck,
      strictAppCheck,
      appCheckSuccess: Boolean(appCheckResult.success),
      appCheckFailureReason: appCheckResult.reason || null,
      appCheckError: appCheckResult.error || null,
      firebaseAuthSuccess: Boolean(firebaseAuthResult.success),
      firebaseAuthFailureReason: firebaseAuthResult.reason || null,
      firebaseAuthError: firebaseAuthResult.error || null,
      hasFirebaseAuthToken: Boolean(firebaseAuthResult.token),
      firebaseAuthTokenLength: firebaseAuthResult.token?.length || 0,
      hasAppCheckToken: Boolean(appCheckResult.token),
      appCheckTokenLength: appCheckResult.token?.length || 0,
    }, diagnostics);

    if (!firebaseAuthResult.success) {
      logBookingEvent('warn', 'Passenger verifier blocked without Firebase auth token', {
        bookingRef: maskIdentifier(bookingRef),
        reason: firebaseAuthResult.reason,
        error: firebaseAuthResult.error,
      });
      return {
        valid: false,
        reason: 'VERIFIER_AUTH_UNAVAILABLE',
        authFailureReason: firebaseAuthResult.reason,
      };
    }

    if (useAppCheck && !appCheckResult.success && strictAppCheck) {
      logBookingEvent('warn', 'Passenger verifier blocked by strict App Check', {
        bookingRef: maskIdentifier(bookingRef),
        appCheckFailureReason: appCheckResult.reason,
      });
      return {
        valid: false,
        reason: 'VERIFIER_APPCHECK_UNAVAILABLE',
        appCheckFailureReason: appCheckResult.reason,
      };
    }

    if (useAppCheck && !appCheckResult.success) {
      logger?.warn?.('Auth', 'Passenger verifier App Check token unavailable; proceeding without header', {
        reason: appCheckResult.reason,
        error: appCheckResult.error,
      });
    }

    const headers = { 'Content-Type': 'application/json' };
    headers.Authorization = `Bearer ${firebaseAuthResult.token}`;
    if (useAppCheck && appCheckResult.success) {
      headers['x-firebase-appcheck'] = appCheckResult.token;
    }

    for (const endpoint of endpointCandidates) {
      logBookingEvent('debug', 'Passenger verifier endpoint attempt started', {
        bookingRef: maskIdentifier(bookingRef),
        endpoint,
        timeoutMs,
        useAppCheck,
      });
      const endpointStartedAt = Date.now();
      recordLoginDiagnostic('passenger_verifier_fetch_started', {
        bookingRef,
        email,
        endpoint,
        timeoutMs,
        useAppCheck,
        hasAuthorizationHeader: Boolean(headers.Authorization),
        hasAppCheckHeader: Boolean(headers['x-firebase-appcheck']),
        bodyKeys: ['bookingRef', 'email'],
      }, diagnostics);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ bookingRef, email }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => null);
      recordLoginDiagnostic('passenger_verifier_fetch_completed', {
        bookingRef,
        endpoint,
        durationMs: Date.now() - endpointStartedAt,
        status: response.status,
        ok: Boolean(response.ok),
        payloadPresent: Boolean(payload),
        payload: payload ? {
          valid: Boolean(payload.valid),
          reason: payload.reason || null,
          bookingRef: payload.bookingRef || null,
          tourId: payload.tourId || null,
          tourCode: payload.tourCode || null,
          hasGrantExpiry: Boolean(payload.grantExpiresAtMs),
          grantExpiresInMs: typeof payload.grantExpiresAtMs === 'number'
            ? payload.grantExpiresAtMs - Date.now()
            : null,
        } : null,
      }, diagnostics);
      if (!payload) {
        if (response.status === 404) {
          logger?.warn?.('Auth', 'Passenger verifier endpoint returned 404', {
            endpoint,
            status: response.status,
          });
          recordLoginDiagnostic('passenger_verifier_endpoint_404_try_next', {
            endpoint,
            status: response.status,
          }, diagnostics);
          continue;
        }
        logBookingEvent('warn', 'Passenger verifier returned invalid response', {
          bookingRef: maskIdentifier(bookingRef),
          endpoint,
          status: response.status,
        });
        return { valid: false, reason: 'VERIFIER_INVALID_RESPONSE' };
      }
      if (!isPassengerLoginResponse(payload)) {
        return { valid: false, reason: 'VERIFIER_INVALID_RESPONSE' };
      }

      if (!response.ok) {
        if (response.status === 404) {
          logger?.warn?.('Auth', 'Passenger verifier endpoint returned 404', {
            endpoint,
            status: response.status,
          });
          recordLoginDiagnostic('passenger_verifier_endpoint_404_try_next', {
            endpoint,
            status: response.status,
            payloadReason: payload?.reason || null,
          }, diagnostics);
          continue;
        }
        logBookingEvent('warn', 'Passenger verifier rejected request', {
          bookingRef: maskIdentifier(bookingRef),
          endpoint,
          status: response.status,
          reason: payload?.reason || 'VERIFIER_REQUEST_FAILED',
        });
        recordLoginDiagnostic('passenger_verifier_rejected_request', {
          bookingRef,
          endpoint,
          status: response.status,
          reason: payload?.reason || 'VERIFIER_REQUEST_FAILED',
          payload,
        }, diagnostics);
        return { valid: false, reason: payload?.reason || 'VERIFIER_REQUEST_FAILED' };
      }

      logBookingEvent('info', 'Passenger verifier accepted request', {
        bookingRef: maskIdentifier(bookingRef),
        endpoint,
        status: response.status,
        valid: Boolean(payload?.valid),
        reason: payload?.reason || null,
      });
      // The verifier may have refreshed the stable private-photo owner claim.
      // Force a token refresh before Storage is used so restored identities receive
      // their signed owner scope immediately rather than after the normal token TTL.
      if (payload?.valid === true && auth?.currentUser?.getIdToken) {
        await auth.currentUser.getIdToken(true);
      }
      return payload;
    }

    logBookingEvent('warn', 'Passenger verifier endpoint not found', {
      bookingRef: maskIdentifier(bookingRef),
      endpointCandidateCount: endpointCandidates.length,
    });
    recordLoginDiagnostic('passenger_verifier_endpoint_not_found', {
      bookingRef,
      endpointCandidateCount: endpointCandidates.length,
    }, diagnostics);
    return { valid: false, reason: 'VERIFIER_NOT_FOUND' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      logBookingEvent('warn', 'Passenger verifier timed out', {
        bookingRef: maskIdentifier(bookingRef),
        timeoutMs,
      });
      recordLoginDiagnostic('passenger_verifier_timed_out', {
        bookingRef,
        timeoutMs,
        error: loginDiagnosticsService?.summarizeError
          ? loginDiagnosticsService.summarizeError(error)
          : { message: error?.message || String(error) },
      }, diagnostics);
      return { valid: false, reason: 'VERIFIER_TIMEOUT' };
    }

    logger?.error?.('Auth', 'Passenger login verification request failed', {
      error: error?.message || String(error),
    });
    recordLoginDiagnostic('passenger_verifier_request_failed', {
      bookingRef,
      timeoutMs,
      error: loginDiagnosticsService?.summarizeError
        ? loginDiagnosticsService.summarizeError(error)
        : { code: error?.code || null, message: error?.message || String(error) },
    }, diagnostics);
    return { valid: false, reason: 'VERIFIER_REQUEST_FAILED' };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

// ==================== VALIDATION HELPERS ====================

module.exports = {
  mapDriverVerifierReason,
  verifyDriverLoginIdentity,
  verifyPassengerLoginIdentity,
};

/**
 * Validates tour code/ID
 */
