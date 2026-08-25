const {
  logBookingEvent,
  logger,
  loginDiagnosticsService,
  maskIdentifier,
  normalizeItineraryDocument,
  normalizePassengerTourProjection,
  normalizeTourId,
  readRealtimeSnapshotWithLoginRetry,
  realtimeDb,
  recordLoginDiagnostic,
  resolveLoginDiagnosticsContext,
} = require('./bookingServiceContext');
const { isValidNormalizedTourId, validateTourCode, validateUserId } = require('./bookingDomain');

const getTourParticipantCount = async (tourId, dbInstance = realtimeDb, options = {}) => {
  const loginDiagnosticsContext = resolveLoginDiagnosticsContext(options);
  const db = dbInstance || realtimeDb;
  if (!db) throw new Error('Realtime database not initialized');

  const tourRef = db.ref(`tours/${tourId}`);
  const [participantsSnapshot, countSnapshot] = await Promise.all([
    readRealtimeSnapshotWithLoginRetry(tourRef.child('participants'), {
      label: 'tour_participants_count_read',
      diagnostics: loginDiagnosticsContext,
    }),
    readRealtimeSnapshotWithLoginRetry(tourRef.child('currentParticipants'), {
      label: 'tour_current_participants_read',
      diagnostics: loginDiagnosticsContext,
    })
  ]);

  const participantMap = participantsSnapshot.val() || {};
  const recalculatedCount = Object.keys(participantMap).length;
  const currentCount = countSnapshot.val();
  recordLoginDiagnostic('tour_participant_count_resolved', {
    tourId,
    currentCount,
    recalculatedCount,
    participantKeyCount: Object.keys(participantMap).length,
  }, loginDiagnosticsContext);

  // currentParticipants is the booked passenger total maintained by trusted
  // import/admin flows. The participants branch tracks app-session membership
  // and must never replace that commercial passenger count.
  return typeof currentCount === 'number' ? currentCount : recalculatedCount;
};

// Resolve the display count without mutating trusted tour capacity data.
const ensureTourParticipantCount = async (tourId, dbInstance = realtimeDb, options = {}) => {
  const loginDiagnosticsContext = resolveLoginDiagnosticsContext(options);
  const db = dbInstance || realtimeDb;
  if (!db) throw new Error('Realtime database not initialized');

  const tourRef = db.ref(`tours/${tourId}`);
  const [participantsSnapshot, countSnapshot] = await Promise.all([
    readRealtimeSnapshotWithLoginRetry(tourRef.child('participants'), {
      label: 'tour_participants_reconcile_read',
      diagnostics: loginDiagnosticsContext,
    }),
    readRealtimeSnapshotWithLoginRetry(tourRef.child('currentParticipants'), {
      label: 'tour_current_participants_reconcile_read',
      diagnostics: loginDiagnosticsContext,
    })
  ]);

  const participantMap = participantsSnapshot.val() || {};
  const currentCount = countSnapshot.val();
  const recalculatedCount = Object.keys(participantMap).length;

  if (typeof currentCount !== 'number') {
    recordLoginDiagnostic('tour_participant_count_fallback_resolved', {
      tourId,
      previousCount: currentCount,
      recalculatedCount,
      wroteCurrentParticipants: false,
    }, loginDiagnosticsContext);
    return recalculatedCount;
  }
  recordLoginDiagnostic('tour_participant_count_trusted_value_preserved', {
    tourId,
    currentCount,
    recalculatedCount,
  }, loginDiagnosticsContext);
  return currentCount;
};

// --- EXISTING: Join tour (Passenger View) ---
const joinTour = async (tourId, userId, dbInstance = realtimeDb, options = {}) => {
  const loginDiagnosticsContext = resolveLoginDiagnosticsContext(options);
  try {
    // Validate inputs
    const validatedTourId = validateTourCode(tourId); // tourId follows same validation as tourCode
    const validatedUserId = validateUserId(userId);
    logBookingEvent('info', 'Join tour requested', {
      tourId: validatedTourId,
      userId: maskIdentifier(validatedUserId),
      hasDbOverride: Boolean(dbInstance),
    });
    recordLoginDiagnostic('join_tour_started', {
      tourId: validatedTourId,
      userId: validatedUserId,
      hasDbOverride: Boolean(dbInstance),
    }, loginDiagnosticsContext);

    const db = dbInstance || realtimeDb;
    if (!db) {
      throw new Error('Realtime database not initialized');
    }

    // Online passenger login supplies a server-built, allowlisted tour projection.
    // Legacy/internal callers may still verify the parent directly, but production
    // passenger flow never needs permission to read the complete tour document.
    const projectedTour = normalizePassengerTourProjection(options.tourProjection, validatedTourId);
    let tourData = projectedTour;
    if (!tourData) {
      const tourSnapshot = await readRealtimeSnapshotWithLoginRetry(
        db.ref(`tours/${validatedTourId}`),
        { label: 'join_tour_read', diagnostics: loginDiagnosticsContext }
      );
      tourData = tourSnapshot.exists() ? (tourSnapshot.val() || {}) : {};
      if (!tourSnapshot.exists()) {
        recordLoginDiagnostic('join_tour_missing_tour', {
          tourId: validatedTourId,
          userId: validatedUserId,
        }, loginDiagnosticsContext);
        throw new Error('Tour not found');
      }
    }

    if (tourData.isActive === false) {
      logBookingEvent('warn', 'Join tour blocked for inactive tour', {
        tourId: validatedTourId,
        userId: maskIdentifier(validatedUserId),
      });
      recordLoginDiagnostic('join_tour_blocked_inactive_tour', {
        tourId: validatedTourId,
        userId: validatedUserId,
        isActive: tourData?.isActive,
      }, loginDiagnosticsContext);
      throw new Error('Tour is no longer active');
    }

    const participantRef = db.ref(`tours/${validatedTourId}/participants/${validatedUserId}`);
    const participantSnapshot = await readRealtimeSnapshotWithLoginRetry(
      participantRef,
      { label: 'join_tour_participant_read', diagnostics: loginDiagnosticsContext }
    );

    // Membership is created atomically by verifyPassengerLogin. This wrapper is
    // retained only for compatibility and never writes participant authority.
    if (participantSnapshot.exists()) {
      const participant = participantSnapshot.val() || {};
      const appSessionService = options.appSessionService || require('../appSessionService');
      const activeSession = options.appSession || await appSessionService.readSession();
      if (!activeSession || participant.schemaVersion !== 2
        || participant.sessionId !== activeSession.sessionId
        || participant.principalId !== activeSession.principalId
        || participant.sessionExpiresAtMs <= Date.now()) {
        throw new Error('Secure tour membership does not match the active app session');
      }
      const reconciledCount = projectedTour
        ? projectedTour.currentParticipants
        : await ensureTourParticipantCount(validatedTourId, db, {
          loginDiagnostics: loginDiagnosticsContext,
        });
      logBookingEvent('info', 'Join tour skipped because user already joined', {
        tourId: validatedTourId,
        userId: maskIdentifier(validatedUserId),
        currentParticipants: reconciledCount,
      });
      recordLoginDiagnostic('join_tour_already_joined', {
        tourId: validatedTourId,
        userId: validatedUserId,
        currentParticipants: reconciledCount,
      }, loginDiagnosticsContext);
      return { success: true, currentParticipants: reconciledCount, alreadyJoined: true };
    }
    throw new Error('The server did not create secure tour membership for this session');
  } catch (error) {
    logger?.error?.('Tour', 'Error joining tour', { tourId, userId: maskIdentifier(userId), error: error?.message || String(error) });
    recordLoginDiagnostic('join_tour_threw', {
      tourId,
      userId,
      error: loginDiagnosticsService?.summarizeError
        ? loginDiagnosticsService.summarizeError(error)
        : { code: error?.code || null, message: error?.message || String(error) },
    }, loginDiagnosticsContext);
    throw error;
  }
};

// --- Get Itinerary (day-by-day content format) ---
const getTourItinerary = async (tourId, db = realtimeDb) => {
  const normalizedTourId = normalizeTourId(tourId);
  try {
    if (!db) throw new Error('Realtime database not initialized');
    if (!normalizedTourId || !isValidNormalizedTourId(normalizedTourId)) {
      throw new Error('Invalid tour identifier');
    }
    logBookingEvent('info', 'Passenger itinerary fetch started', { tourId: normalizedTourId });

    const itinerarySnapshot = await db.ref(`tours/${normalizedTourId}/itinerary`).once('value');
    if (!itinerarySnapshot.exists()) {
      logBookingEvent('warn', 'Passenger itinerary fetch returned no published itinerary', {
        tourId: normalizedTourId,
      });
      return null;
    }

    const itineraryData = itinerarySnapshot.val();
    const normalizedItinerary = normalizeItineraryDocument(itineraryData);

    if (normalizedItinerary) {
      logBookingEvent('info', 'Passenger itinerary fetch completed with stored itinerary', {
        tourId: normalizedTourId,
        dayCount: normalizedItinerary.days.length,
      });
      return normalizedItinerary;
    }

    logBookingEvent('warn', 'Passenger itinerary missing structured days', { tourId: normalizedTourId });
    return null;
  } catch (error) {
    logger?.error?.('Itinerary', 'Error getting itinerary', {
      tourId: normalizedTourId || tourId,
      error: error?.message || String(error),
    });
    throw error;
  }
};

// --- Get Driver Itinerary (unredacted text) ---
const getDriverItinerary = async (tourId) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');
    logBookingEvent('info', 'Driver itinerary fetch started', { tourId });

    const tourSnapshot = await realtimeDb.ref(`tours/${tourId}`).once('value');
    if (!tourSnapshot.exists()) {
      logBookingEvent('warn', 'Driver itinerary fetch returned missing tour', { tourId });
      return null;
    }

    const tourData = tourSnapshot.val();
    logBookingEvent('info', 'Driver itinerary fetch completed', {
      tourId,
      hasDriverItinerary: Boolean(tourData.driver_itinerary),
      hasDays: Boolean(tourData.days),
    });
    return {
      driverItinerary: tourData.driver_itinerary || null,
      tourName: tourData.name || 'Tour',
      startDate: tourData.startDate || null,
      days: tourData.days || null,
    };
  } catch (error) {
    logger?.error?.('Itinerary', 'Error getting driver itinerary', { tourId, error: error?.message || String(error) });
    return null;
  }
};

module.exports = {
  ensureTourParticipantCount,
  getDriverItinerary,
  getTourItinerary,
  getTourParticipantCount,
  joinTour,
};
