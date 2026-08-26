const {
  MANIFEST_STATUS,
  auth,
  buildDriverAssignmentEndpointUrl,
  fetchWithTimeout,
  getFirebaseAuthHeaderValue,
  logBookingEvent,
  logger,
  maskIdentifier,
  offlineSyncService,
  parseTimestampMs,
  realtimeDb,
  recordBookingDiagnostic,
  validateAppSession,
} = require('./bookingServiceContext');
const { isDriverAssignmentResponse } = require('../../src/shared/api/responseBoundaries');
const {
  deriveParentStatusFromPassengers,
  sanitizeTourId,
  validateBookingRef,
  validateDriverId,
  validatePassengerStatuses,
  validateTourCode,
} = require('./bookingDomain');

const applyManifestUpdateDirect = async (payload, dbInstance = realtimeDb) => {
  try {
    const validatedTourCode = validateTourCode(payload.tourCode);
    const validatedBookingRef = validateBookingRef(payload.bookingRef);
    validatePassengerStatuses(payload.passengerStatuses || []);
    logBookingEvent('info', 'Direct manifest update started', {
      tourCode: maskIdentifier(validatedTourCode),
      bookingRef: maskIdentifier(validatedBookingRef),
      passengerStatusCount: payload.passengerStatuses?.length || 0,
      hasIdempotencyKey: Boolean(payload.idempotencyKey),
    });
    recordBookingDiagnostic('manifest_update_direct_started', {
      tourCode: maskIdentifier(validatedTourCode),
      bookingRef: maskIdentifier(validatedBookingRef),
      passengerStatusCount: payload.passengerStatuses?.length || 0,
      hasIdempotencyKey: Boolean(payload.idempotencyKey),
      hasAuthUid: Boolean(auth?.currentUser?.uid),
    });

    const db = dbInstance || realtimeDb;
    if (!db) {
      logBookingEvent('warn', 'Direct manifest update skipped without database', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
      });
      recordBookingDiagnostic('manifest_update_skipped_no_database', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
      });
      return { success: false, error: 'Realtime database not initialized' };
    }

    const tourId = sanitizeTourId(validatedTourCode);
    const currentAuthUid = auth?.currentUser?.uid || null;
    recordBookingDiagnostic('manifest_write_identity_state', {
      tourId,
      bookingRef: maskIdentifier(validatedBookingRef),
      hasAuthUid: Boolean(currentAuthUid),
    });

    const parsedLocalUpdatedAt = parseTimestampMs(payload.lastUpdated);
    const localUpdatedAt = Number.isFinite(parsedLocalUpdatedAt) ? parsedLocalUpdatedAt : Date.now();
    const parentStatus = deriveParentStatusFromPassengers(payload.passengerStatuses || []);
    const manifestUpdate = {
      passengerStatus: payload.passengerStatuses || [],
      status: parentStatus,
      lastUpdated: payload.lastUpdated || new Date().toISOString(),
      idempotencyKey: payload.idempotencyKey || null,
    };
    const bookingManifestRef = db.ref(`tour_manifests/${tourId}/bookings/${validatedBookingRef}`);
    let observedServerValue = {};
    let duplicateDelivery = false;
    let transactionTimeoutId;
    let transactionResult;
    try {
      transactionResult = await Promise.race([
        bookingManifestRef.transaction((currentValue) => {
          const current = currentValue || {};
          observedServerValue = current;
          duplicateDelivery = Boolean(
            payload.idempotencyKey
            && current.idempotencyKey === payload.idempotencyKey
          );
          if (duplicateDelivery) return current;

          const parsedServerUpdatedAt = parseTimestampMs(current.lastUpdated);
          const serverUpdatedAt = Number.isFinite(parsedServerUpdatedAt) ? parsedServerUpdatedAt : 0;
          if (serverUpdatedAt > localUpdatedAt) return undefined;
          return manifestUpdate;
        }),
        new Promise((_, reject) => {
          transactionTimeoutId = setTimeout(() => reject(new Error('Manifest update timeout')), 15000);
        }),
      ]);
    } finally {
      if (transactionTimeoutId) clearTimeout(transactionTimeoutId);
    }
    const serverValue = transactionResult?.snapshot?.val?.() || observedServerValue || {};

    if (!transactionResult?.committed) {
      logger?.warn?.('Manifest', 'Queued update reconciled to newer server data', {
        bookingRef: maskIdentifier(validatedBookingRef),
        tourId,
        localUpdatedAt: payload.lastUpdated,
        serverUpdatedAt: serverValue.lastUpdated || null,
        serverStatus: serverValue.status || MANIFEST_STATUS.PENDING,
      });
      return {
        success: true,
        reconciled: true,
        overwrite: 'server',
        bookingRef: validatedBookingRef,
        status: serverValue.status || MANIFEST_STATUS.PENDING,
        passengerStatus: Array.isArray(serverValue.passengerStatus) ? serverValue.passengerStatus : [],
        lastUpdated: serverValue.lastUpdated || null,
        conflict: {
          reason: 'SERVER_NEWER',
          bookingRef: validatedBookingRef,
          serverStatus: serverValue.status || MANIFEST_STATUS.PENDING,
          serverPassengerStatus: Array.isArray(serverValue.passengerStatus) ? serverValue.passengerStatus : [],
          serverLastUpdated: serverValue.lastUpdated || null,
          attemptedStatus: parentStatus,
          attemptedPassengerStatus: payload.passengerStatuses || [],
          attemptedLastUpdated: payload.lastUpdated || null,
        },
      };
    }
    logBookingEvent('info', 'Direct manifest update completed', {
      tourId,
      bookingRef: maskIdentifier(validatedBookingRef),
      status: parentStatus,
      passengerStatusCount: payload.passengerStatuses?.length || 0,
      idempotencyKey: maskIdentifier(manifestUpdate.idempotencyKey),
    });
    recordBookingDiagnostic('manifest_update_direct_completed', {
      tourId,
      bookingRef: maskIdentifier(validatedBookingRef),
      status: parentStatus,
      passengerStatusCount: payload.passengerStatuses?.length || 0,
      idempotencyKey: maskIdentifier(manifestUpdate.idempotencyKey),
    });

    return {
      success: true,
      bookingRef: validatedBookingRef,
      status: parentStatus,
      passengerStatus: payload.passengerStatuses || [],
      lastUpdated: manifestUpdate.lastUpdated,
      idempotencyKey: manifestUpdate.idempotencyKey,
      duplicateDelivery,
    };
  } catch (error) {
    logBookingEvent('error', 'Direct manifest update failed', {
      tourCode: maskIdentifier(payload?.tourCode),
      bookingRef: maskIdentifier(payload?.bookingRef),
      error: error?.message || String(error),
    });
    recordBookingDiagnostic('manifest_update_direct_failed', {
      tourCode: maskIdentifier(payload?.tourCode),
      bookingRef: maskIdentifier(payload?.bookingRef),
      error: error?.message || String(error),
      code: error?.code || null,
    });
    return { success: false, error: error.message };
  }
};

const updateManifestBooking = async (tourCode, bookingRef, passengerStatuses = [], options = {}) => {
  try {
    const validatedTourCode = validateTourCode(tourCode);
    const validatedBookingRef = validateBookingRef(bookingRef);
    validatePassengerStatuses(passengerStatuses);
    logBookingEvent('info', 'Manifest update requested', {
      tourCode: maskIdentifier(validatedTourCode),
      bookingRef: maskIdentifier(validatedBookingRef),
      passengerStatusCount: passengerStatuses.length,
      onlineOption: options.online,
      hasDbOverride: Boolean(options.db),
    });

    const parentStatus = deriveParentStatusFromPassengers(passengerStatuses);
    const nowIso = new Date().toISOString();
    const idempotencyKey = options.idempotencyKey || `manifest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const directPayload = {
      tourCode: validatedTourCode,
      bookingRef: validatedBookingRef,
      passengerStatuses,
      lastUpdated: nowIso,
      idempotencyKey,
    };

    const explicitlyOffline = options.online === false;
    const onlineResult = explicitlyOffline
      ? { success: false, error: 'Device reported offline' }
      : await applyManifestUpdateDirect(directPayload, options.db || realtimeDb);
    if (explicitlyOffline) {
      logBookingEvent('info', 'Direct manifest update skipped while offline', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
      });
    }
    if (onlineResult.success) {
      logBookingEvent('info', 'Manifest update completed online', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
        status: parentStatus,
        reconciled: Boolean(onlineResult.reconciled),
      });
      return {
        success: true,
        queued: false,
        bookingRef: validatedBookingRef,
        status: onlineResult.status || parentStatus,
        passengerStatus: onlineResult.passengerStatus || passengerStatuses,
        idempotencyKey,
        reconciled: Boolean(onlineResult.reconciled),
        conflict: onlineResult.conflict || null,
        conflictMessage: onlineResult.reconciled
          ? `The server kept the newer ${String(onlineResult.status || MANIFEST_STATUS.PENDING).replace('_', ' ').toLowerCase()} status for booking ${validatedBookingRef}.`
          : null,
      };
    }

    const shouldQueue = explicitlyOffline || /timeout|network|unavailable/i.test(onlineResult.error || '');
    if (!shouldQueue || !offlineSyncService?.enqueueAction) {
      logBookingEvent('warn', 'Manifest update failed without queue fallback', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
        error: onlineResult.error || 'unknown',
        shouldQueue,
        hasOfflineSync: Boolean(offlineSyncService?.enqueueAction),
      });
      throw new Error(onlineResult.error || 'Failed to update manifest');
    }

    const queued = await offlineSyncService.enqueueAction({
      id: idempotencyKey,
      type: 'MANIFEST_UPDATE',
      tourId: sanitizeTourId(validatedTourCode),
      scope: {
        tourId: sanitizeTourId(validatedTourCode),
        principalId: options.actorPrincipalId,
        role: 'driver',
        authUid: options.authUid || auth?.currentUser?.uid || null,
      },
      createdAt: nowIso,
      payload: directPayload,
      attempts: 0,
      status: 'queued',
      lastError: onlineResult.error || null,
    });

    if (!queued.success) {
      logBookingEvent('warn', 'Manifest update queue enqueue failed', {
        tourCode: maskIdentifier(validatedTourCode),
        bookingRef: maskIdentifier(validatedBookingRef),
        error: queued.error || 'unknown',
      });
      throw new Error(queued.error || 'Failed to queue manifest update');
    }

    logBookingEvent('info', 'Manifest update queued for replay', {
      tourCode: maskIdentifier(validatedTourCode),
      bookingRef: maskIdentifier(validatedBookingRef),
      status: parentStatus,
      idempotencyKey: maskIdentifier(idempotencyKey),
      originalError: onlineResult.error || null,
    });
    return {
      success: true,
      queued: true,
      localStatus: parentStatus,
      bookingRef: validatedBookingRef,
      passengerStatus: passengerStatuses,
      idempotencyKey,
    };
  } catch (error) {
    logger?.error?.('Manifest', 'Error updating manifest', {
      tourCode,
      bookingRef: maskIdentifier(bookingRef),
      error: error?.message || String(error),
    });
    throw error;
  }
};

const mapDriverAssignmentReason = (reason) => {
  const reasonToMessage = {
    ASSIGNMENT_IN_PROGRESS: 'Another assignment is being processed. Please wait a moment and try again.',
    DRIVER_NOT_FOUND: 'Your driver profile could not be found. Please contact dispatch.',
    INTERNAL_ERROR: 'The assignment service is temporarily unavailable. Please try again shortly.',
    INVALID_CREDENTIALS: 'Secure driver access is still starting. Please wait a moment and try again.',
    INVALID_INPUT: 'Enter a valid tour code.',
    METHOD_NOT_ALLOWED: 'The assignment service is unavailable in this app version. Please update the app.',
    NOT_AUTHORIZED: 'This device is not linked to that driver profile. Please sign in again or contact dispatch.',
    SESSION_CHANGED: 'Your secure driver session changed. Sign in again before assigning a tour.',
    SESSION_INACTIVE: 'Your secure driver session has ended. Sign in again before assigning a tour.',
    SESSION_IN_PROGRESS: 'Another secure session action is still finishing. Please wait a moment and try again.',
    TOUR_ALREADY_ASSIGNED: 'That tour already has another driver assigned. Contact dispatch before changing it.',
    TOUR_INACTIVE: 'That tour is no longer active. Contact dispatch if this is unexpected.',
    TOUR_NOT_FOUND: 'Tour not found. Check the code on your paperwork and try again.',
    TRY_AGAIN_LATER: 'Too many assignment attempts. Please wait a moment and try again.',
  };
  return reasonToMessage[reason] || 'The assignment could not be completed. Please try again shortly.';
};

// Driver assignment is server-authorized so every related tour, driver, profile,
// and manifest path changes atomically under one trusted operation.
const assignDriverToTour = async (driverId, tourCode, options = {}) => {
  try {
    const validatedDriverId = validateDriverId(driverId);
    const validatedTourCode = validateTourCode(tourCode);
    logBookingEvent('info', 'Driver assignment requested', {
      driverId: maskIdentifier(validatedDriverId),
      tourCode: maskIdentifier(validatedTourCode),
    });

    if (!auth) {
      throw new Error('Auth module not initialized');
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      logBookingEvent('warn', 'Driver assignment blocked without authenticated user', {
        driverId: maskIdentifier(validatedDriverId),
        tourCode: maskIdentifier(validatedTourCode),
      });
      throw new Error('You must be logged in to assign a tour');
    }
    const endpoint = buildDriverAssignmentEndpointUrl();
    if (!endpoint) {
      throw new Error('The assignment service is not configured. Please update the app or contact dispatch.');
    }
    const firebaseAuthResult = await getFirebaseAuthHeaderValue();
    if (!firebaseAuthResult.success) {
      throw new Error(mapDriverAssignmentReason('INVALID_CREDENTIALS'));
    }

    const appSessionService = options.appSessionService || require('../appSessionService');
    const currentAppSession = options.appSession || await appSessionService.readSession();
    if (!currentAppSession || currentAppSession.principalType !== 'driver'
      || currentAppSession.driverId !== validatedDriverId) {
      throw new Error('Your secure driver session has ended. Sign in again before assigning a tour.');
    }

    let response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${firebaseAuthResult.token}`,
        },
        body: JSON.stringify({
          driverId: validatedDriverId,
          tourCode: validatedTourCode,
          expectedSessionId: currentAppSession.sessionId,
        }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The assignment request timed out. Check your connection and try again.');
      }
      throw new Error('The assignment service could not be reached. Check your connection and try again.');
    }

    const payload = await response.json().catch(() => null);
    if (!payload) {
      throw new Error('The assignment service returned an unexpected response. Please try again.');
    }
    if (!isDriverAssignmentResponse(payload)) {
      throw new Error('The assignment service returned an unexpected response. Please try again.');
    }
    if (!response.ok || payload.success !== true) {
      throw new Error(mapDriverAssignmentReason(payload.reason));
    }

    logBookingEvent('info', 'Driver assignment completed', {
      driverId: maskIdentifier(validatedDriverId),
      tourId: payload.tourId,
      previousTourId: payload.previousTourId || null,
    });
    const updatedSession = validateAppSession(payload.session);
    if (!updatedSession || updatedSession.sessionId !== currentAppSession.sessionId
      || updatedSession.sessionRevision <= currentAppSession.sessionRevision
      || updatedSession.tourId !== payload.tourId) {
      throw new Error('The assignment completed but its secure session response was invalid. Sign in again.');
    }
    await appSessionService.persistSession(updatedSession);

    return {
      success: true,
      tourId: payload.tourId,
      tourCode: payload.tourCode || validatedTourCode,
      previousTourId: payload.previousTourId || null,
      session: updatedSession,
    };

  } catch (error) {
    logger?.error?.('Auth', 'Error assigning driver to tour', {
      driverId: maskIdentifier(driverId),
      tourCode: maskIdentifier(tourCode),
      error: error?.message || String(error),
    });
    throw error;
  }
};

module.exports = {
  applyManifestUpdateDirect,
  assignDriverToTour,
  mapDriverAssignmentReason,
  updateManifestBooking,
};
