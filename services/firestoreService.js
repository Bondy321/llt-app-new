// services/firestoreService.js
import { db, firebase } from '../firebase';

// Validate tour code and get tour details
// Added "firestore = db" for dependency injection (testing)
export const validateTourCode = async (tourCode, firestore = db) => {
  try {
    console.log('Validating tour code:', tourCode);
    
    const upperCode = tourCode.toUpperCase();
    
    // Use the injected 'firestore' instance
    const snapshot = await firestore
      .collection('tours')
      .where('tourCode', '==', upperCode)
      .where('isActive', '==', true)
      .limit(1)
      .get();
    
    console.log('Query executed, found docs:', snapshot.size);
    
    if (snapshot.empty) {
      console.log('No tour found with code:', upperCode);
      return { valid: false, error: 'Invalid tour code' };
    }
    
    const tourDoc = snapshot.docs[0];
    const tourData = tourDoc.data();
    
    console.log('Tour found:', tourData.name);
    
    return {
      valid: true,
      tour: {
        id: tourDoc.id,
        ...tourData
      }
    };
  } catch (error) {
    console.error('Error validating tour code:', error);
    return { valid: false, error: 'Error checking tour code' };
  }
};

// Add user to tour (increment participant count)
export const joinTour = async (tourId, userId, firestore = db) => {
  try {
    console.log('Joining tour:', tourId, 'for user:', userId);
    const tourRef = firestore.collection('tours').doc(tourId);
    
    await tourRef.collection('participants').doc(userId).set({
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      userId: userId
    });
    
    await tourRef.update({
      currentParticipants: firebase.firestore.FieldValue.increment(1)
    });
    
    console.log('User joined tour successfully');
    return { success: true };
  } catch (error) {
    console.error('Error joining tour:', error);
    return { success: false, error: error.message };
  }
};

// Get tour itinerary
export const getTourItinerary = async (tourId, firestore = db) => {
  try {
    console.log('Getting itinerary for tour:', tourId);
    const itineraryRef = firestore.collection('tours').doc(tourId).collection('itinerary');
    const snapshot = await itineraryRef.orderBy('order').get();
    
    console.log('Found', snapshot.size, 'days in itinerary');
    
    const days = [];
    
    for (const dayDoc of snapshot.docs) {
      const dayData = dayDoc.data();
      
      const activitiesSnapshot = await dayDoc.ref
        .collection('activities')
        .orderBy('order')
        .get();
      
      const activities = activitiesSnapshot.docs.map(doc => doc.data());
      
      days.push({
        ...dayData,
        activities
      });
    }
    
    console.log('Loaded itinerary with', days.length, 'days');
    return days;
  } catch (error) {
    console.error('Error getting itinerary:', error);
    return [];
  }
};