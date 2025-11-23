// services/bookingServiceRealtime.js
import { realtimeDb } from '../firebase';

// Validate booking reference and get associated tour
export const validateBookingReference = async (bookingRef) => {
  try {
    console.log('Validating booking reference:', bookingRef);
    
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
    
    // Check if tour is active
    if (!tourData.isActive) {
      return { valid: false, error: 'This tour is no longer active' };
    }
    
    // Add pickup info and seat numbers to booking data
    const enrichedBooking = {
      id: upperRef,
      ...bookingData,
      passengerNames: bookingData.passengers || [],
      seatNumbers: bookingData.seatNumbers || [],
      pickupPoints: bookingData.pickupPoints || [], // Array of pickup points
      // Legacy single pickup fields for backward compatibility
      pickupTime: bookingData.pickupTime || (bookingData.pickupPoints?.[0]?.time) || 'TBA',
      pickupLocation: bookingData.pickupLocation || (bookingData.pickupPoints?.[0]?.location) || 'To be confirmed'
    };
    
    return {
      valid: true,
      booking: enrichedBooking,
      tour: {
        id: tourId,
        ...tourData
      }
    };
  } catch (error) {
    console.error('Error validating booking reference:', error);
    return { valid: false, error: 'Error checking booking reference' };
  }
};

// Join tour (update participant count)
export const joinTour = async (tourId, userId) => {
  try {
    console.log('Joining tour:', tourId, 'for user:', userId);
    
    // Add user to participants
    await realtimeDb
      .ref(`tours/${tourId}/participants/${userId}`)
      .set({
        joinedAt: new Date().toISOString(),
        userId: userId
      });
    
    // Get current participant count
    const countSnapshot = await realtimeDb
      .ref(`tours/${tourId}/currentParticipants`)
      .once('value');
    
    const currentCount = countSnapshot.val() || 0;
    
    // Update count
    await realtimeDb
      .ref(`tours/${tourId}/currentParticipants`)
      .set(currentCount + 1);
    
    console.log('User joined tour successfully');
    return { success: true };
  } catch (error) {
    console.error('Error joining tour:', error);
    return { success: false, error: error.message };
  }
};

// Get tour itinerary
export const getTourItinerary = async (tourId) => {
  try {
    console.log('Getting itinerary for tour:', tourId);
    
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