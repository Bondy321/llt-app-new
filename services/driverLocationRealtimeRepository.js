import { realtimeDb } from '../firebase';

export const subscribeToDriverLocation = ({ onError, onValue, tourId }) => {
  if (!realtimeDb || !tourId) return () => {};
  const locationRef = realtimeDb.ref(`tours/${tourId}/driverLocation`);
  locationRef.on('value', onValue, onError);
  return () => locationRef.off('value', onValue);
};

export const readDriverLocation = async (tourId) => {
  if (!realtimeDb || !tourId) return null;
  return realtimeDb.ref(`tours/${tourId}/driverLocation`).once('value');
};
