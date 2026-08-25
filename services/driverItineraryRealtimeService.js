import { realtimeDb } from '../firebase';

export const subscribeToDriverItinerary = ({ tourId, onError, onValue }) => {
  if (!tourId) return () => undefined;
  const itineraryRef = realtimeDb.ref(`tours/${tourId}/driver_itinerary`);
  itineraryRef.on('value', onValue, onError);
  return () => itineraryRef.off('value', onValue);
};
