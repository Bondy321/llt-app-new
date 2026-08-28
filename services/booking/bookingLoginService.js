const {
  auth,
  logBookingEvent,
  logger,
  loginDiagnosticsService,
  maskIdentifier,
  normalizePassengerBookingProjection,
  normalizePassengerTourProjection,
  realtimeDb,
  recordLoginDiagnostic,
  resolveLoginDiagnosticsContext,
  resolveTourId,
  validateAppSession,
} = require('./bookingServiceContext');
const { verifyDriverLoginIdentity, verifyPassengerLoginIdentity } = require('./bookingVerifierService');
const {
  resolveVerifiedPassengerIdentity,
  resolveVerifierTourId,
  validateBookingRef,
} = require('./bookingDomain');

const resolveDriverLoginFromDatabase = async (driverId) => {
  try {
    const driverSnapshot = await realtimeDb.ref(`drivers/${driverId}`).once('value');

    if (!driverSnapshot.exists()) {
      return null;
    }

    const driverData = driverSnapshot.val();
    const assignedTourId = resolveTourId(driverData.currentTourId);
    const assignedTourCode = driverData.currentTourCode || null;

    let resolvedTour = null;

    if (assignedTourId) {
      const driverTourSnapshot = await realtimeDb.ref(`tours/${assignedTourId}`).once('value');
      if (driverTourSnapshot.exists()) {
        const driverTourData = driverTourSnapshot.val() || {};
        resolvedTour = {
          id: assignedTourId,
          ...driverTourData,
        };
      }
    }

    logBookingEvent('info', 'Driver login reference validated via direct database fallback', {
      driverId: maskIdentifier(driverId),
      assignedTourId,
      hasResolvedTour: Boolean(resolvedTour),
      assignmentStatus: assignedTourId ? (resolvedTour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND') : 'UNASSIGNED',
    });

    return {
      valid: true,
      type: 'driver',
      driver: {
        id: driverId,
        name: driverData.name,
        assignedTourId,
        assignedTourCode,
        hasAssignedTour: Boolean(assignedTourId),
      },
      tour: resolvedTour,
      assignmentStatus: assignedTourId ? (resolvedTour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND') : 'UNASSIGNED',
    };
  } catch (error) {
    logBookingEvent('warn', 'Driver direct database fallback unavailable', {
      driverId: maskIdentifier(driverId),
      error: error?.message || String(error),
      code: error?.code || null,
    });
    return null;
  }
};

// --- EXISTING: Validate Reference ---
const validateBookingReference = async (reference, email, options = {}) => {
  const loginDiagnosticsContext = resolveLoginDiagnosticsContext(options);
  let validationPhase = 'start';
  try {
    validationPhase = 'database_available';
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const upperRef = reference.toUpperCase().trim();
    logBookingEvent('info', 'Login reference validation started', {
      reference: maskIdentifier(upperRef),
      hasEmail: Boolean(email),
    });
    recordLoginDiagnostic('booking_validation_started', {
      reference,
      email,
      hasRealtimeDb: Boolean(realtimeDb),
      hasAuthUser: Boolean(auth?.currentUser),
      authUserIsAnonymous: Boolean(auth?.currentUser?.isAnonymous),
      authCurrentUserUid: auth?.currentUser?.uid || null,
    }, loginDiagnosticsContext);

    const isDriverReference = upperRef.startsWith('D-');

    if (isDriverReference) {
      const driverVerification = await verifyDriverLoginIdentity({ driverId: upperRef });
      if (driverVerification) {
        if (!driverVerification.valid) {
          logBookingEvent('warn', 'Driver verifier rejected code', {
            driverId: maskIdentifier(upperRef),
            error: driverVerification.error || 'unknown',
          });
          return {
            valid: false,
            error: driverVerification.error || 'Unable to verify driver code. Please try again.',
          };
        }

        logBookingEvent('info', 'Driver verifier accepted code', {
          driverId: maskIdentifier(upperRef),
          assignedTourId: driverVerification.driver?.assignedTourId || null,
          assignmentStatus: driverVerification.assignmentStatus || null,
          hasResolvedTour: Boolean(driverVerification.tour),
        });
        const driverAppSession = validateAppSession(driverVerification.session);
        if (!driverAppSession || driverAppSession.principalType !== 'driver'
          || driverAppSession.driverId !== upperRef
          || driverAppSession.tourId !== (driverVerification.driver?.assignedTourId || null)) {
          return {
            valid: false,
            error: 'Secure driver session could not be established. Please reconnect and try again.',
          };
        }
        return {
          valid: true,
          type: 'driver',
          driver: driverVerification.driver,
          tour: driverVerification.tour || null,
          session: driverAppSession,
          assignmentStatus: driverVerification.assignmentStatus || (
            driverVerification.driver?.assignedTourId
              ? (driverVerification.tour ? 'ASSIGNED' : 'ASSIGNED_TOUR_NOT_FOUND')
              : 'UNASSIGNED'
          ),
        };
      }

      logBookingEvent('warn', 'Driver login reference was not validated by the secure verifier', {
        driverId: maskIdentifier(upperRef),
      });
      return { valid: false, error: 'Driver verification is temporarily unavailable. Please try again shortly.' };
    }

    // --- Passenger Booking ---
    validationPhase = 'passenger_input';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail) {
      logBookingEvent('warn', 'Passenger login validation blocked without email', {
        bookingRef: maskIdentifier(upperRef),
      });
      recordLoginDiagnostic('booking_validation_blocked_without_email', {
        bookingRef: upperRef,
      }, loginDiagnosticsContext);
      return { valid: false, error: 'Email is required for passenger login verification' };
    }

    validationPhase = 'passenger_verifier';
    const passengerVerification = await verifyPassengerLoginIdentity({
      bookingRef: upperRef,
      email: normalizedEmail,
      diagnostics: loginDiagnosticsContext,
    });

    if (!passengerVerification?.valid) {
      logBookingEvent('warn', 'Passenger login verifier rejected credentials', {
        bookingRef: maskIdentifier(upperRef),
        reason: passengerVerification?.reason || 'unknown',
      });
      recordLoginDiagnostic('booking_validation_verifier_rejected', {
        bookingRef: upperRef,
        reason: passengerVerification?.reason || 'unknown',
        authFailureReason: passengerVerification?.authFailureReason || null,
        appCheckFailureReason: passengerVerification?.appCheckFailureReason || null,
      }, loginDiagnosticsContext);
      const reasonToMessage = {
        BOOKING_NOT_FOUND: 'Booking reference not found',
        EMAIL_MISMATCH: 'Email does not match this booking reference',
        INVALID_CREDENTIALS: 'Login details could not be verified. Please check your details and try again.',
        REAUTHORIZE_REQUIRED: 'This booking is secured to another device or needs a security review. Please contact Loch Lomond Travel to restore access.',
        IDENTITY_INCOMPLETE: 'We found this booking but could not complete login. Please contact support if this keeps happening.',
        ROLE_TRANSITION_IN_PROGRESS: 'Your secure session is still being updated. Please wait a moment and try again.',
        INVALID_INPUT: 'Invalid login details provided',
        TRY_AGAIN_LATER: 'Too many verification attempts. Please wait a moment and try again.',
        INTERNAL_ERROR: 'Verification service is temporarily unavailable. Please try again shortly.',
        METHOD_NOT_ALLOWED: 'Verification service is currently unavailable. Please update the app and try again shortly.',
        VERIFIER_NOT_CONFIGURED: 'Passenger verification is temporarily unavailable. Please try again shortly.',
        VERIFIER_TIMEOUT: 'Verification is taking longer than expected. Please check your connection and try again.',
        VERIFIER_REQUEST_FAILED: 'Unable to reach the verification service. Please try again shortly.',
        VERIFIER_INVALID_RESPONSE: 'Verification service returned an unexpected response. Please try again.',
        VERIFIER_NOT_FOUND: 'Passenger verification is temporarily unavailable. Please try again shortly.',
        VERIFIER_APPCHECK_UNAVAILABLE: 'App security check could not be completed. Update the app or reconnect and try again.',
        VERIFIER_AUTH_UNAVAILABLE: 'Secure login is still starting. Please wait a moment and try again.',
        TOUR_INACTIVE: 'This tour is no longer active',
      };
      return {
        valid: false,
        error: reasonToMessage[passengerVerification?.reason] || 'Unable to verify passenger login',
      };
    }

    const resolvedBookingRef = validateBookingRef(passengerVerification.bookingRef || upperRef);

    const tourId = resolveVerifierTourId(passengerVerification);
    if (!tourId) {
      logBookingEvent('warn', 'Passenger login tour id unavailable after verifier success', {
        bookingRef: maskIdentifier(resolvedBookingRef),
      });
      recordLoginDiagnostic('booking_validation_tour_id_unavailable_after_verifier', {
        bookingRef: resolvedBookingRef,
        passengerVerification,
      }, loginDiagnosticsContext);
      return { valid: false, error: 'Tour information not available' };
    }

    validationPhase = 'passenger_safe_projection';
    const normalizedBooking = normalizePassengerBookingProjection(
      passengerVerification.booking,
      resolvedBookingRef,
    );
    const tourData = normalizePassengerTourProjection(passengerVerification.tour, tourId);
    if (!normalizedBooking || !tourData) {
      logBookingEvent('warn', 'Passenger login verifier omitted the safe trip projection', {
        bookingRef: maskIdentifier(resolvedBookingRef),
        tourId,
        hasSafeBooking: Boolean(normalizedBooking),
        hasSafeTour: Boolean(tourData),
      });
      return {
        valid: false,
        error: 'Secure trip information is temporarily unavailable. Please update the app and try again.',
      };
    }

    if (!tourData.isActive) {
      logBookingEvent('warn', 'Passenger login blocked for inactive tour', {
        bookingRef: maskIdentifier(resolvedBookingRef),
        tourId,
      });
      recordLoginDiagnostic('booking_validation_blocked_inactive_tour', {
        bookingRef: resolvedBookingRef,
        tourId,
        isActive: tourData?.isActive,
      }, loginDiagnosticsContext);
      return { valid: false, error: 'This tour is no longer active' };
    }

    const { stablePassengerId, identityVersion } = resolveVerifiedPassengerIdentity({
      stablePassengerId: passengerVerification.stablePassengerId,
      identityVersion: passengerVerification.identityVersion,
    });

    if (!stablePassengerId) {
      logBookingEvent('error', 'Passenger verifier omitted a valid opaque identity', {
        bookingRef: maskIdentifier(resolvedBookingRef),
        tourId,
      });
      return {
        valid: false,
        error: 'Secure passenger identity could not be established. Please update the app and try again.',
      };
    }
    const appSession = validateAppSession(passengerVerification.session);
    if (!appSession || appSession.principalType !== 'passenger'
      || appSession.principalId !== stablePassengerId || appSession.tourId !== tourId) {
      return {
        valid: false,
        error: 'Secure app session could not be established. Please reconnect and try again.',
      };
    }

    logBookingEvent('info', 'Passenger login reference validated', {
      bookingRef: maskIdentifier(resolvedBookingRef),
      tourId,
      hasStablePassengerId: Boolean(stablePassengerId),
      participantCount: tourData.currentParticipants,
    });
    recordLoginDiagnostic('booking_validation_succeeded', {
      bookingRef: resolvedBookingRef,
      email: normalizedEmail,
      tourId,
      hasStablePassengerId: Boolean(stablePassengerId),
      identityVersion,
      participantCount: tourData.currentParticipants,
    }, loginDiagnosticsContext);

    return {
      valid: true,
      type: 'passenger',
      session: appSession,
      booking: {
        ...normalizedBooking,
        normalizedPassengerEmail: normalizedEmail,
        stablePassengerId,
        identityVersion,
      },
      tour: {
        ...tourData,
      }
    };
  } catch (error) {
    logger?.error?.('Auth', 'Error validating booking reference', {
      reference: maskIdentifier(reference),
      phase: validationPhase,
      error: error?.message || String(error),
      code: error?.code || null,
    });
    recordLoginDiagnostic('booking_validation_threw', {
      phase: validationPhase,
      reference,
      email,
      error: loginDiagnosticsService?.summarizeError
        ? loginDiagnosticsService.summarizeError(error)
        : { code: error?.code || null, message: error?.message || String(error) },
    }, loginDiagnosticsContext);
    return { valid: false, error: 'Unable to check booking reference. Please try again.' };
  }
};

module.exports = { resolveDriverLoginFromDatabase, validateBookingReference };
