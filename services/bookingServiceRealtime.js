// services/bookingServiceRealtime.js
const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;

if (!isTestEnv) {
  try {
    ({ realtimeDb } = require('../firebase'));
  } catch (error) {
    console.warn('Realtime database module not initialized during load:', error.message);
  }
}

// Harmonize legacy booking shapes (pickup points, passengers, seats)
const ensureBookingSchemaConsistency = async (bookingRef, bookingData, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db) {
    throw new Error('Realtime database not initialized');
  }

  const updates = {};
  const passengerNames = Array.isArray(bookingData.passengerNames)
    ? bookingData.passengerNames
    : Array.isArray(bookingData.passengers)
      ? bookingData.passengers
      : [];

  const seatNumbers = Array.isArray(bookingData.seatNumbers) ? [...bookingData.seatNumbers] : [];

  if (passengerNames.length > seatNumbers.length) {
    const missingSeats = passengerNames.length - seatNumbers.length;
    seatNumbers.push(...Array(missingSeats).fill('TBA'));
    updates.seatNumbers = seatNumbers;
  }

  if (!bookingData.passengers && passengerNames.length > 0) {
    updates.passengers = passengerNames;
  }

  const pickupPoints = (Array.isArray(bookingData.pickupPoints) && bookingData.pickupPoints.length > 0)
    ? bookingData.pickupPoints
    : [{
        location: bookingData.pickupLocation || 'To be confirmed',
        time: bookingData.pickupTime || 'TBA'
      }];

  const pickupLocation = bookingData.pickupLocation || pickupPoints?.[0]?.location || 'To be confirmed';
  const pickupTime = bookingData.pickupTime || pickupPoints?.[0]?.time || 'TBA';

  if (!bookingData.pickupPoints || bookingData.pickupPoints.length === 0) {
    updates.pickupPoints = pickupPoints;
  }

  if (bookingData.pickupLocation !== pickupLocation) {
    updates.pickupLocation = pickupLocation;
  }

  if (bookingData.pickupTime !== pickupTime) {
    updates.pickupTime = pickupTime;
  }

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

// Reconcile participant counts with participant list
const ensureTourParticipantCount = async (tourId, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db) {
    throw new Error('Realtime database not initialized');
  }

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

// Validate booking reference and get associated tour
const validateBookingReference = async (bookingRef) => {
  try {
    console.log('Validating booking reference:', bookingRef);

    if (!realtimeDb) {
      throw new Error('Realtime database not initialized');
    }

    // Convert to uppercase to be case-insensitive
    const upperRef = bookingRef.toUpperCase().trim();

    // Look up the booking in Realtime Database
    const bookingSnapshot = await realtimeDb
      .ref(`bookings/${upperRef}`)
      .once('value');

    if (!bookingSnapshot.exists()) {
      console.log('No booking found with reference:', upperRef);
      return { valid: false, error: 'Booking reference not found' };
    }

    const bookingData = bookingSnapshot.val();
    console.log('Booking found for tour:', bookingData.tourCode);

    const { normalizedBooking } = await ensureBookingSchemaConsistency(upperRef, bookingData, realtimeDb);

    // Now get the associated tour (tour codes with spaces are stored with underscores)
    const tourId = bookingData.tourCode.replace(/\s+/g, '_');
    const tourSnapshot = await realtimeDb
      .ref(`tours/${tourId}`)
      .once('value');

    if (!tourSnapshot.exists()) {
      console.log('Associated tour not found');
      return { valid: false, error: 'Tour information not available' };
    }

    const tourData = tourSnapshot.val();
    const reconciledParticipantCount = await ensureTourParticipantCount(tourId, realtimeDb);

    // Check if tour is active
    if (!tourData.isActive) {
      return { valid: false, error: 'This tour is no longer active' };
    }

    return {
      valid: true,
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

// Join tour (update participant count)
const joinTour = async (tourId, userId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;

    if (!db) {
      throw new Error('Realtime database not initialized');
    }

    console.log('Joining tour:', tourId, 'for user:', userId);
    const participantRef = db.ref(`tours/${tourId}/participants/${userId}`);
    const participantSnapshot = await participantRef.once('value');

    if (participantSnapshot.exists()) {
      const reconciledCount = await ensureTourParticipantCount(tourId, db);
      console.log('User already joined tour; returning existing count', { reconciledCount });
      return { success: true, currentParticipants: reconciledCount };
    }

    console.log('Adding participant and incrementing count transactionally');
    const tourRef = db.ref(`tours/${tourId}`);
    const transactionResult = await tourRef.transaction((tourState) => {
      const currentTour = tourState || {};
      const participants = currentTour.participants || {};

      if (participants[userId]) {
        return currentTour;
      }

      const updatedParticipants = {
        ...participants,
        [userId]: {
          joinedAt: new Date().toISOString(),
          userId
        }
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

    if (!transactionResult?.committed) {
      throw new Error('Participant transaction not committed');
    }

    const newState = transactionResult?.snapshot?.val?.();
    const newCount = newState?.currentParticipants ?? null;
    console.log('User joined tour successfully via transaction', { newCount });
    return { success: true, currentParticipants: newCount };
  } catch (error) {
    console.error('Error joining tour:', error);
    throw error;
  }
};

// Get tour itinerary
const getTourItinerary = async (tourId) => {
  try {
    console.log('Getting itinerary for tour:', tourId);

    if (!realtimeDb) {
      throw new Error('Realtime database not initialized');
    }
    
    const tourSnapshot = await realtimeDb
      .ref(`tours/${tourId}`)
      .once('value');
    
    if (!tourSnapshot.exists()) {
      return null;
    }
    
    const tourData = tourSnapshot.val();
    
    // Parse the itinerary text to make it more readable
    const parseItinerary = (text) => {
      if (!text) return [{ time: '', description: 'Itinerary to be confirmed' }];
      
      // For day trips, we'll format the text nicely but keep it as one block
      // since the times are embedded within the activities
      const formattedText = text
        .replace(/\. /g, '.\n\n') // Add line breaks after periods
        .replace(/(\d{4}hrs)/g, (match) => {
          // Convert military time to readable format
          const hour = parseInt(match.substring(0, 2));
          const min = match.substring(2, 4);
          const ampm = hour >= 12 ? 'PM' : 'AM';
          const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
          return `${displayHour}:${min} ${ampm}`;
        })
        .trim();
      
      return [{
        time: '',
        description: formattedText
      }];
    };
    
    const activities = parseItinerary(tourData.itinerary);
    
    return {
      title: tourData.name,
      days: [{
        day: 1,
        title: tourData.days === 1 ? 'Day Trip' : 'Day 1',
        activities: activities
      }]
    };
  } catch (error) {
    console.error('Error getting itinerary:', error);
    return null;
  }
};

module.exports = {
  ensureBookingSchemaConsistency,
  ensureTourParticipantCount,
  validateBookingReference,
  joinTour,
  getTourItinerary
};