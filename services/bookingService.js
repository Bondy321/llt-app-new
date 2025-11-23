// services/bookingService.js
import { db, firebase } from '../firebase';
import { validateTourCode } from './firestoreService';

// Validate booking reference and get associated tour
export const validateBookingReference = async (bookingRef) => {
  try {
    console.log('Validating booking reference:', bookingRef);
    
    // Convert to uppercase to be case-insensitive
    const upperRef = bookingRef.toUpperCase().trim();
    
    // Look up the booking
    const bookingDoc = await db
      .collection('bookings')
      .doc(upperRef)
      .get();
    
    if (!bookingDoc.exists) {
      console.log('No booking found with reference:', upperRef);
      return { valid: false, error: 'Booking reference not found' };
    }
    
    const bookingData = bookingDoc.data();
    console.log('Booking found for tour:', bookingData.tourCode);
    
    // Now validate the associated tour
    const tourResult = await validateTourCode(bookingData.tourCode);
    
    if (!tourResult.valid) {
      console.log('Associated tour is not valid');
      return { valid: false, error: 'Tour is no longer available' };
    }
    
    // Add pickup info and seat numbers to booking data
    const enrichedBooking = {
      id: bookingDoc.id,
      ...bookingData,
      passengerNames: bookingData.passengers || [],
      seatNumbers: bookingData.seatNumbers || [],
      pickupTime: bookingData.pickupTime || 'TBA',
      pickupLocation: bookingData.pickupLocation || 'To be confirmed'
    };
    
    return {
      valid: true,
      booking: enrichedBooking,
      tour: tourResult.tour
    };
  } catch (error) {
    console.error('Error validating booking reference:', error);
    return { valid: false, error: 'Error checking booking reference' };
  }
};