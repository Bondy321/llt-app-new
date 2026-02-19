// services/bookingServiceRealtime.js
// Enhanced with comprehensive validation, transaction safety, and error handling
import { enqueueAction, generateActionId } from './offlineSyncService';
import NetInfo from '@react-native-community/netinfo';

const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;
let auth;

// Status Enums for the Manifest
const MANIFEST_STATUS = {
  PENDING: 'PENDING',
  BOARDED: 'BOARDED',
  NO_SHOW: 'NO_SHOW',
  PARTIAL: 'PARTIAL'
};

if (!isTestEnv) {
  try {
    ({ realtimeDb, auth } = require('../firebase'));
  } catch (error) {
    console.warn('Realtime database module not initialized during load:', error.message);
  }
}

// ==================== VALIDATION HELPERS ====================

/**
 * Validates tour code/ID
 */
const validateTourCode = (tourCode) => {
  if (!tourCode || typeof tourCode !== 'string' || tourCode.trim().length === 0) {
    throw new Error('Invalid tour code');
  }
  return tourCode.trim();
};

/**
 * Validates booking reference
 */
const validateBookingRef = (bookingRef) => {
  if (!bookingRef || typeof bookingRef !== 'string' || bookingRef.trim().length === 0) {
    throw new Error('Invalid booking reference');
  }
  return bookingRef.trim().toUpperCase();
};

/**
 * Validates driver ID
 */
const validateDriverId = (driverId) => {
  if (!driverId || typeof driverId !== 'string' || driverId.trim().length === 0) {
    throw new Error('Invalid driver ID');
  }
  return driverId.trim().toUpperCase();
};

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

/**
 * Validates passenger statuses array
 */
const validatePassengerStatuses = (statuses) => {
  if (!Array.isArray(statuses)) {
    throw new Error('Passenger statuses must be an array');
  }

  const validStatuses = Object.values(MANIFEST_STATUS);
  for (const status of statuses) {
    if (status && !validStatuses.includes(status)) {
      throw new Error(`Invalid passenger status: ${status}`);
    }
  }

  return statuses;
};

// --- HELPER: Sanitize Tour IDs (e.g., "5112D 8" -> "5112D_8") ---
const sanitizeTourId = (tourCode) => {
  return tourCode ? tourCode.replace(/\s+/g, '_') : null;
};

// --- HELPERS: Manifest Status Derivation ---
const deriveParentStatusFromPassengers = (passengerStatuses = []) => {
  if (!Array.isArray(passengerStatuses) || passengerStatuses.length === 0) return MANIFEST_STATUS.PENDING;

  const normalized = passengerStatuses.map((status) => status || MANIFEST_STATUS.PENDING);
  const allBoarded = normalized.every((status) => status === MANIFEST_STATUS.BOARDED);
  const allNoShow = normalized.every((status) => status === MANIFEST_STATUS.NO_SHOW);
  const allPending = normalized.every((status) => status === MANIFEST_STATUS.PENDING);

  if (allBoarded) return MANIFEST_STATUS.BOARDED;
  if (allNoShow) return MANIFEST_STATUS.NO_SHOW;
  if (allPending) return MANIFEST_STATUS.PENDING;
  return MANIFEST_STATUS.PARTIAL;
};

const normalizePassengerStatuses = (passengerStatuses, totalPax) => {
  const baseStatuses = Array.isArray(passengerStatuses) ? passengerStatuses : [];
  const padded = [...baseStatuses];

  if (typeof totalPax === 'number' && totalPax > padded.length) {
    const missing = totalPax - padded.length;
    padded.push(...Array(missing).fill(MANIFEST_STATUS.PENDING));
  } else if (typeof totalPax === 'number' && totalPax > 0 && padded.length > totalPax) {
    padded.length = totalPax;
  }

  return padded.map((status) => status || MANIFEST_STATUS.PENDING);
};

// --- EXISTING: Harmonize legacy booking shapes ---
const ensureBookingSchemaConsistency = async (bookingRef, bookingData, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;
  if (!db) throw new Error('Realtime database not initialized');

  const updates = {};
  const passengerNames = Array.isArray(bookingData.passengerNames)
    ? bookingData.passengerNames
    : Array.isArray(bookingData.passengers)
      ? bookingData.passengers
      : [];

  const seatNumbers = Array.isArray(bookingData.seatNumbers) ? [...bookingData.seatNumbers] : [];

  // Ensure seat array matches passenger count
  if (passengerNames.length > seatNumbers.length) {
    const missingSeats = passengerNames.length - seatNumbers.length;
    seatNumbers.push(...Array(missingSeats).fill('TBA'));
    updates.seatNumbers = seatNumbers;
  }

  // Backfill 'passengers' field if missing but names exist
  if (!bookingData.passengers && passengerNames.length > 0) {
    updates.passengers = passengerNames;
  }

  // Normalize Pickup Points
  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [{
        location: bookingData.pickupLocation || 'To be confirmed',
        time: bookingData.pickupTime || 'TBA'
      }];

  const pickupLocation = bookingData.pickupLocation || pickupPoints?.[0]?.location || 'To be confirmed';
  const pickupTime = bookingData.pickupTime || pickupPoints?.[0]?.time || 'TBA';

  // Apply updates if schema was inconsistent
  if (!bookingData.pickupPoints || bookingData.pickupPoints.length === 0) updates.pickupPoints = pickupPoints;
  if (bookingData.pickupLocation !== pickupLocation) updates.pickupLocation = pickupLocation;
  if (bookingData.pickupTime !== pickupTime) updates.pickupTime = pickupTime;

  if (Object.keys(updates).length > 0) {
    await db.ref(`bookings/${bookingRef}`).update(updates);
  }

  return {
    normalizedBooking: {
      id: bookingRef,
      ...bookingData,
      passengerNames,
      seatNumbers,
      pickupPoints,
      pickupTime,
      pickupLocation
    },
    updated: Object.keys(updates).length > 0
  };
};

// --- UPDATED: Fetch Full Manifest with NO SHOW stats ---
const getTourManifest = async (tourCodeOriginal) => {
  try {
    // Validate inputs
    const validatedTourCode = validateTourCode(tourCodeOriginal);

    if (!realtimeDb) {
      throw new Error('Realtime database not initialized');
    }

    const tourId = sanitizeTourId(validatedTourCode);

    // Resolve the real tourCode for booking lookups (some tourIds are sanitized with underscores)
    let tourCodeForSearch = tourCodeOriginal;
    if (tourId) {
      const tourCodeSnapshot = await realtimeDb.ref(`tours/${tourId}/tourCode`).once('value');
      if (tourCodeSnapshot.exists() && tourCodeSnapshot.val()) {
        tourCodeForSearch = tourCodeSnapshot.val();
      } else if (tourCodeOriginal && tourCodeOriginal.includes('_')) {
        tourCodeForSearch = tourCodeOriginal.replace(/_/g, ' ');
      }
    } else if (tourCodeOriginal && tourCodeOriginal.includes('_')) {
      tourCodeForSearch = tourCodeOriginal.replace(/_/g, ' ');
    }

    const bookingsQuery = realtimeDb.ref('bookings')
      .orderByChild('tourCode')
      .equalTo(tourCodeForSearch);

    const manifestRef = realtimeDb.ref(`tour_manifests/${tourId}`);

    const [bookingsSnapshot, manifestSnapshot] = await Promise.all([
      bookingsQuery.once('value'),
      manifestRef.once('value')
    ]);

    const bookings = [];
    const manifestData = manifestSnapshot.val() || {};
    const bookingStatuses = manifestData.bookings || {};

    if (bookingsSnapshot.exists()) {
      const rawBookings = bookingsSnapshot.val();

      for (const [bookingRef, data] of Object.entries(rawBookings)) {
        const { normalizedBooking } = await ensureBookingSchemaConsistency(bookingRef, data);
        const liveStatus = bookingStatuses[bookingRef] || {};
        const totalPax = normalizedBooking.passengerNames.length;
        const hasPassengerStatuses = Array.isArray(liveStatus.passengers);
        const passengerStatus = normalizePassengerStatuses(liveStatus.passengers, totalPax);
        const derivedStatus = hasPassengerStatuses ? deriveParentStatusFromPassengers(passengerStatus) : null;
        const currentStatus = derivedStatus || liveStatus.status || MANIFEST_STATUS.PENDING;

        bookings.push({
          ...normalizedBooking,
          status: currentStatus,
          hasPassengerStatuses,
          passengerStatus,
          notes: liveStatus.notes || ''
        });
      }
    }

    const stats = bookings.reduce((acc, b) => {
      const paxCount = b.passengerNames.length;
      acc.totalPax += paxCount;

      if (b.hasPassengerStatuses && Array.isArray(b.passengerStatus) && b.passengerStatus.length > 0) {
        b.passengerStatus.forEach((status) => {
          if (status === MANIFEST_STATUS.BOARDED) acc.checkedIn += 1;
          if (status === MANIFEST_STATUS.NO_SHOW) acc.noShows += 1;
        });
      } else {
        if (b.status === MANIFEST_STATUS.BOARDED) {
          acc.checkedIn += paxCount;
        } else if (b.status === MANIFEST_STATUS.NO_SHOW) {
          acc.noShows += paxCount;
        }
      }
      return acc;
    }, { totalBookings: bookings.length, totalPax: 0, checkedIn: 0, noShows: 0 });

    return {
      tourId,
      bookings,
      stats
    };

  } catch (error) {
    console.error('Error fetching tour manifest:', error);
    throw error;
  }
};

// --- UPDATED: Update Booking Status with Passenger-Level granularity ---
// Enhanced with offline queueing support via offlineSyncService
const updateManifestBooking = async (tourCode, bookingRef, passengerStatuses = []) => {
  // Validate inputs (always, regardless of connectivity)
  const validatedTourCode = validateTourCode(tourCode);
  const validatedBookingRef = validateBookingRef(bookingRef);
  const validatedStatuses = validatePassengerStatuses(passengerStatuses);

  const tourId = sanitizeTourId(validatedTourCode);

  const normalizedStatuses = normalizePassengerStatuses(validatedStatuses);
  const parentStatus = deriveParentStatusFromPassengers(normalizedStatuses);

  const updates = {
    status: parentStatus,
    passengers: normalizedStatuses,
    lastUpdated: new Date().toISOString()
  };

  // Check connectivity
  let isOnline = true;
  try {
    const netState = await NetInfo.fetch();
    isOnline = Boolean(netState.isConnected);
  } catch (e) {
    isOnline = false;
  }

  if (!isOnline) {
    const actionId = generateActionId();
    await enqueueAction({
      id: actionId,
      type: 'MANIFEST_UPDATE',
      tourId,
      payload: { tourId, bookingId: validatedBookingRef, updates },
    });
    return { success: true, queued: true, localStatus: updates, actionId };
  }

  try {
    if (!realtimeDb) {
      throw new Error('Realtime database not initialized');
    }

    const bookingManifestRef = realtimeDb.ref(`tour_manifests/${tourId}/bookings/${validatedBookingRef}`);

    // Verify booking exists first
    const bookingSnapshot = await realtimeDb.ref(`bookings/${validatedBookingRef}`).once('value');
    if (!bookingSnapshot.exists()) {
      return { success: false, error: 'Booking not found' };
    }

    // Use timeout protection
    await Promise.race([
      bookingManifestRef.update(updates),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Manifest update timeout')), 10000)
      )
    ]);

    return { success: true };

  } catch (error) {
    // If network error, enqueue instead of failing
    if (error.message && (error.message.includes('network') || error.message.includes('timeout') || error.message.includes('client is offline'))) {
      const actionId = generateActionId();
      await enqueueAction({
        id: actionId,
        type: 'MANIFEST_UPDATE',
        tourId,
        payload: { tourId, bookingId: validatedBookingRef, updates },
      });
      return { success: true, queued: true, localStatus: updates, actionId };
    }
    console.error('Error updating manifest:', error);
    return { success: false, error: error.message };
  }
};

// --- UPDATED: Assign Driver to Tour (Uses existing Auth) ---
const assignDriverToTour = async (driverId, tourCode) => {
  try {
    // Validate inputs
    const validatedDriverId = validateDriverId(driverId);
    const validatedTourCode = validateTourCode(tourCode);

    if (!realtimeDb) {
      throw new Error('Realtime database not initialized');
    }

    if (!auth) {
      throw new Error('Auth module not initialized');
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw new Error('You must be logged in to assign a tour');
    }

    // Ensure we have a sanitized ID
    const tourId = sanitizeTourId(validatedTourCode);

    // Verify tour exists
    const tourSnapshot = await realtimeDb.ref(`tours/${tourId}`).once('value');
    if (!tourSnapshot.exists()) {
      throw new Error('Tour not found');
    }

    // Verify driver exists
    const driverSnapshot = await realtimeDb.ref(`drivers/${validatedDriverId}`).once('value');
    if (!driverSnapshot.exists()) {
      throw new Error('Driver not found');
    }

    const updates = {};

    // 1. Update Driver's Profile
    updates[`drivers/${validatedDriverId}/currentTourId`] = tourId;
    updates[`drivers/${validatedDriverId}/currentTourCode`] = validatedTourCode;
    updates[`drivers/${validatedDriverId}/lastActive`] = new Date().toISOString();
    updates[`drivers/${validatedDriverId}/authUid`] = currentUser.uid;

    // 2. Add to Tour Manifest's assigned drivers list
    updates[`tour_manifests/${tourId}/assigned_drivers/${validatedDriverId}`] = true;
    updates[`tour_manifests/${tourId}/assigned_driver_codes/${validatedDriverId}`] = {
      tourId,
      tourCode: validatedTourCode,
      assignedAt: new Date().toISOString(),
      assignedBy: currentUser.uid,
    };

    // Use timeout protection
    await Promise.race([
      realtimeDb.ref().update(updates),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Driver assignment timeout')), 10000)
      )
    ]);

    return { success: true, tourId };

  } catch (error) {
    console.error('Error assigning driver to tour:', error);
    throw error;
  }
};

// --- EXISTING: Validate Reference ---
const validateBookingReference = async (reference) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const upperRef = reference.toUpperCase().trim();

    // --- 1. CHECK: Is it a Driver? ---
    const driverSnapshot = await realtimeDb.ref(`drivers/${upperRef}`).once('value');

    if (driverSnapshot.exists()) {
      const driverData = driverSnapshot.val();
      
      return {
        valid: true,
        type: 'driver',
        driver: {
          id: upperRef,
          name: driverData.name,
          assignedTourId: sanitizeTourId(driverData.currentTourId) || null
        }
      };
    }

    // --- 2. CHECK: Is it a Passenger Booking? ---
    const bookingSnapshot = await realtimeDb.ref(`bookings/${upperRef}`).once('value');

    if (!bookingSnapshot.exists()) {
      return { valid: false, error: 'Booking reference not found' };
    }

    const bookingData = bookingSnapshot.val();
    const { normalizedBooking } = await ensureBookingSchemaConsistency(upperRef, bookingData, realtimeDb);

    const tourId = sanitizeTourId(bookingData.tourCode);
    const tourSnapshot = await realtimeDb.ref(`tours/${tourId}`).once('value');

    if (!tourSnapshot.exists()) {
      return { valid: false, error: 'Tour information not available' };
    }

    const tourData = tourSnapshot.val();
    // We still use the public participant count for the passenger view
    const reconciledParticipantCount = await ensureTourParticipantCount(tourId, realtimeDb);

    if (!tourData.isActive) {
      return { valid: false, error: 'This tour is no longer active' };
    }

    return {
      valid: true,
      type: 'passenger',
      booking: normalizedBooking,
      tour: {
        id: tourId,
        ...tourData,
        currentParticipants: reconciledParticipantCount
      }
    };
  } catch (error) {
    console.error('Error validating booking reference:', error);
    return { valid: false, error: 'Error checking booking reference' };
  }
};

// --- EXISTING: Reconcile participant counts ---
const ensureTourParticipantCount = async (tourId, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;
  if (!db) throw new Error('Realtime database not initialized');

  const tourRef = db.ref(`tours/${tourId}`);
  const [participantsSnapshot, countSnapshot] = await Promise.all([
    tourRef.child('participants').once('value'),
    tourRef.child('currentParticipants').once('value')
  ]);

  const participantMap = participantsSnapshot.val() || {};
  const currentCount = countSnapshot.val();
  const recalculatedCount = Object.keys(participantMap).length;

  if (typeof currentCount !== 'number' || currentCount !== recalculatedCount) {
    await tourRef.update({ currentParticipants: recalculatedCount });
    return recalculatedCount;
  }
  return currentCount;
};

// --- EXISTING: Join tour (Passenger View) ---
const joinTour = async (tourId, userId, dbInstance = realtimeDb) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourCode(tourId); // tourId follows same validation as tourCode
    const validatedUserId = validateUserId(userId);

    const db = dbInstance || realtimeDb;
    if (!db) {
      throw new Error('Realtime database not initialized');
    }

    // Verify tour exists and is active
    const tourSnapshot = await db.ref(`tours/${validatedTourId}`).once('value');
    if (!tourSnapshot.exists()) {
      throw new Error('Tour not found');
    }

    const tourData = tourSnapshot.val();
    if (tourData.isActive === false) {
      throw new Error('Tour is no longer active');
    }

    const participantRef = db.ref(`tours/${validatedTourId}/participants/${validatedUserId}`);
    const participantSnapshot = await participantRef.once('value');

    // User already joined - return current count
    if (participantSnapshot.exists()) {
      const reconciledCount = await ensureTourParticipantCount(validatedTourId, db);
      return { success: true, currentParticipants: reconciledCount, alreadyJoined: true };
    }

    // Join tour using transaction for safety
    const tourRef = db.ref(`tours/${validatedTourId}`);
    const transactionResult = await tourRef.transaction((tourState) => {
      const currentTour = tourState || {};
      const participants = currentTour.participants || {};

      // Double-check user hasn't joined during transaction
      if (participants[validatedUserId]) {
        return undefined; // Abort transaction
      }

      const updatedParticipants = {
        ...participants,
        [validatedUserId]: {
          joinedAt: new Date().toISOString(),
          userId: validatedUserId
        }
      };

      const currentCount = typeof currentTour.currentParticipants === 'number'
        ? currentTour.currentParticipants
        : Object.keys(participants).length;

      return {
        ...currentTour,
        participants: updatedParticipants,
        currentParticipants: currentCount + 1,
        lastUpdated: new Date().toISOString()
      };
    });

    if (!transactionResult?.committed) {
      // Transaction aborted - likely user already joined
      const reconciledCount = await ensureTourParticipantCount(validatedTourId, db);
      return { success: true, currentParticipants: reconciledCount, alreadyJoined: true };
    }

    const finalSnapshot = transactionResult.snapshot.val();
    return {
      success: true,
      currentParticipants: finalSnapshot.currentParticipants,
      alreadyJoined: false
    };
  } catch (error) {
    console.error('Error joining tour:', error);
    throw error;
  }
};

// --- Get Itinerary (day-by-day content format) ---
const getTourItinerary = async (tourId) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const tourSnapshot = await realtimeDb.ref(`tours/${tourId}`).once('value');
    if (!tourSnapshot.exists()) return null;

    const tourData = tourSnapshot.val();
    const itineraryData = tourData.itinerary;

    if (itineraryData && typeof itineraryData === 'object' && Array.isArray(itineraryData.days)) {
      return { ...itineraryData, title: itineraryData.title || tourData.name };
    }

    return {
      title: tourData.name,
      days: [{ day: 1, content: 'Itinerary to be confirmed' }]
    };
  } catch (error) {
    console.error('Error getting itinerary:', error);
    return null;
  }
};

// --- Get Driver Itinerary (unredacted text) ---
const getDriverItinerary = async (tourId) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const tourSnapshot = await realtimeDb.ref(`tours/${tourId}`).once('value');
    if (!tourSnapshot.exists()) return null;

    const tourData = tourSnapshot.val();
    return {
      driverItinerary: tourData.driver_itinerary || null,
      tourName: tourData.name || 'Tour',
      startDate: tourData.startDate || null,
      days: tourData.days || null,
    };
  } catch (error) {
    console.error('Error getting driver itinerary:', error);
    return null;
  }
};

module.exports = {
  MANIFEST_STATUS,
  ensureBookingSchemaConsistency,
  ensureTourParticipantCount,
  validateBookingReference,
  joinTour,
  getTourItinerary,
  getDriverItinerary,
  getTourManifest,
  updateManifestBooking,
  assignDriverToTour
};