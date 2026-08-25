import { realtimeDb } from '../firebase';

export const subscribeToItinerary = ({ onError, onValue, tourId }) => {
  if (!realtimeDb || !tourId) return () => {};
  const itineraryRef = realtimeDb.ref(`tours/${tourId}/itinerary`);
  itineraryRef.on('value', onValue, onError);
  return () => itineraryRef.off('value', onValue);
};
