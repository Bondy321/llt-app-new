// services/bookingServiceRealtime.js
const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;
let auth;

// Status Enums for the Manifest
export const MANIFEST_STATUS = {
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
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const tourId = sanitizeTourId(tourCodeOriginal);

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
const updateManifestBooking = async (tourCode, bookingRef, passengerStatuses = []) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');
    const tourId = sanitizeTourId(tourCode);
    const bookingManifestRef = realtimeDb.ref(`tour_manifests/${tourId}/bookings/${bookingRef}`);

    const normalizedStatuses = normalizePassengerStatuses(passengerStatuses);
    const parentStatus = deriveParentStatusFromPassengers(normalizedStatuses);

    const updates = {
      status: parentStatus,
      passengers: normalizedStatuses,
      lastUpdated: new Date().toISOString()
    };

    await bookingManifestRef.update(updates);
    return { success: true };

  } catch (error) {
    console.error('Error updating manifest:', error);
    return { success: false, error: error.message };
  }
};

// --- NEW: Assign Driver to Tour (Feeder Driver Logic) ---
const assignDriverToTour = async (driverId, tourCode) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');
    const userId = auth?.currentUser?.uid;
    if (!userId) throw new Error('User not authenticated');
    const tourId = sanitizeTourId(tourCode);

    const updates = {};

    // 1. Update Driver's Profile
    updates[`drivers/${driverId}/authUid`] = userId;
    updates[`drivers/${driverId}/currentTourId`] = tourId;
    updates[`drivers/${driverId}/currentTourCode`] = tourCode;
    updates[`drivers/${driverId}/lastActive`] = new Date().toISOString();

    // 2. Add to Tour Manifest's assigned drivers list
    updates[`tour_manifests/${tourId}/assigned_drivers/${driverId}`] = true;
    updates[`tour_manifests/${tourId}/assigned_driver_codes/${driverId}`] = {
      tourId,
      tourCode,
    };

    await realtimeDb.ref().update(updates);
    console.log(`Driver ${driverId} assigned to tour ${tourId}`);
    return { success: true, tourId };

  } catch (error) {
    console.error('Error assigning driver to tour:', error);
    throw error;
  }
};

// --- EXISTING: Validate Reference (Updated for Driver Assignment) ---
const validateBookingReference = async (reference) => {
  try {
    if (!realtimeDb) throw new Error('Realtime database not initialized');

    const upperRef = reference.toUpperCase().trim();
    console.log('Validating reference:', upperRef);

    // --- 1. CHECK: Is it a Driver? ---
    const driverSnapshot = await realtimeDb.ref(`drivers/${upperRef}`).once('value');

    if (driverSnapshot.exists()) {
      const driverData = driverSnapshot.val();
      console.log('Driver login verified:', driverData.name);
      
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
    const db = dbInstance || realtimeDb;
    if (!db) throw new Error('Realtime database not initialized');

    const participantRef = db.ref(`tours/${tourId}/participants/${userId}`);
    const participantSnapshot = await participantRef.once('value');

    if (participantSnapshot.exists()) {
      const reconciledCount = await ensureTourParticipantCount(tourId, db);
      return { success: true, currentParticipants: reconciledCount };
    }

    const tourRef = db.ref(`tours/${tourId}`);
    const transactionResult = await tourRef.transaction((tourState) => {
      const currentTour = tourState || {};
      const participants = currentTour.participants || {};

      if (participants[userId]) return currentTour;

      const updatedParticipants = {
        ...participants,
        [userId]: { joinedAt: new Date().toISOString(), userId }
      };

      const currentCount = typeof currentTour.currentParticipants === 'number'
        ? currentTour.currentParticipants
        : Object.keys(updatedParticipants).length - 1;

      return {
        ...currentTour,
        participants: updatedParticipants,
        currentParticipants: currentCount + 1
      };
    });

    if (!transactionResult?.committed) throw new Error('Participant transaction not committed');
    return { success: true, currentParticipants: transactionResult.snapshot.val().currentParticipants };
  } catch (error) {
    console.error('Error joining tour:', error);
    throw error;
  }
};

// --- EXISTING: Get Itinerary ---
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
    
    const parseItinerary = (text) => {
      if (!text || typeof text !== 'string') return [{ time: '', description: 'Itinerary to be confirmed' }];
      const formattedText = text
        .replace(/\. /g, '.\n\n')
        .replace(/(\d{4}hrs)/g, (match) => {
          const hour = parseInt(match.substring(0, 2));
          const min = match.substring(2, 4);
          const ampm = hour >= 12 ? 'PM' : 'AM';
          const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
          return `${displayHour}:${min} ${ampm}`;
        })
        .trim();
      return [{ time: '', description: formattedText }];
    };
    
    return {
      title: tourData.name,
      days: [{ day: 1, title: tourData.days === 1 ? 'Day Trip' : 'Day 1', activities: parseItinerary(itineraryData) }]
    };
  } catch (error) {
    console.error('Error getting itinerary:', error);
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
  getTourManifest,
  updateManifestBooking,
  assignDriverToTour
};